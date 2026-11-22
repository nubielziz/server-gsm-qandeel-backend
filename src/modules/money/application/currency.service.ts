// Currencies and exchange rates (map routes /admin/currencies, stage 3): list, read, create and change, each write audited.
// The ledger itself stays in the base currency; this table feeds the storefront display and the FX screens.
import { Inject, Injectable } from '@nestjs/common';
import type { z } from 'zod';
import { CLOCK, type Clock } from '../../../common/clock';
import type { ParsedListQuery } from '../../../common/contract';
import { AppError, type FieldError } from '../../../common/errors';
import { Money } from '../../../common/money';
import { DbService, type DbExecutor } from '../../../infra/db';
import { type PermissionHolder, requirePermission } from '../../identity';
import { AuditService } from '../../platform';
import type { CurrencySchema } from '../contracts/currencies.contracts';
import type { Currency } from '../db/schema';
import { BASE_CURRENCY } from '../domain/accounts';
import {
  chargeDecimalsProblem,
  checkDecimals,
  checkMarkup,
  checkRate,
  formatRate,
  isRateStale,
  normalizeDecimal,
} from '../domain/currency-rules';
import { driverFor } from '../infra/gateway-drivers/drivers';
import { findStorefrontGateways } from '../infra/storefront-money.repository';
import {
  type CurrencySortField,
  findCurrenciesByCode,
  findCurrency,
  insertCurrency,
  listCurrencies,
  updateCurrency,
} from '../infra/currency.repository';

/** A currency on the wire (`Currency` of the console). */
export type WireCurrency = z.output<typeof CurrencySchema>;

/** The fields of a new currency, as the request carries them. */
export interface CreateCurrencyInput {
  readonly code: string;
  readonly name: string;
  readonly rateToBase: string;
  readonly markupPercent: string;
  readonly charmRounding: boolean;
  readonly isStorefront: boolean;
  readonly decimals: number;
}

/** The fields a change may carry. */
export type UpdateCurrencyInput = Partial<CreateCurrencyInput> & { readonly isActive?: boolean };

const CODE = /^[A-Z]{3}$/;

const refuse = (...errors: FieldError[]) => new AppError('VALIDATION_FAILED', { errors });
/**
 * The refusal of decimals the card method cannot charge: the detail repeats the field message, because the console's storefront switch
 * sends `PATCH { isStorefront }` from a list row that has no decimals field to show it under (decision 048).
 */
const notChargeable = (problem: FieldError) =>
  new AppError('VALIDATION_FAILED', { detail: problem.message, errors: [problem] });
const notFound = () => new AppError('NOT_FOUND', { detail: 'No currency with this id.' });

/** The audit snapshot of a currency: what an admin changes. */
function snapshotOf(row: Currency): Record<string, unknown> {
  return {
    code: row.code,
    name: row.name,
    rateToBase: formatRate(row.rateToBase),
    markupPercent: row.markupPercent,
    charmRounding: row.charmRounding,
    isStorefront: row.isStorefront,
    decimals: row.decimals,
    isActive: row.isActive,
    held: row.rateHeldAt !== null,
  };
}

/**
 * Reads and changes currencies.
 *
 * Why: the Settings page lists currencies with their rate, markup and storefront switch (RULES settings 7); the storefront
 * prices come from the same rows. `rateToBase` is units of the currency per 1 USD (M167); USD is the base (rate 1, no markup).
 *
 * Decision 048: while an active storefront card method exists, a currency's decimals may not exceed what it charges exactly.
 *
 * Side effects: `create` and `update` write `currencies` and one audit row each.
 */
@Injectable()
export class CurrencyService {
  constructor(
    private readonly db: DbService,
    private readonly audit: AuditService,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  /**
   * Lists currencies.
   *
   * @param query the parsed list request
   * @returns the page and the number matching the filters
   */
  async list(query: ParsedListQuery<CurrencySortField>): Promise<{ rows: WireCurrency[]; total: number }> {
    const { rows, total } = await listCurrencies(this.db.db, query);
    const nowMs = this.clock.nowMs();
    return { rows: rows.map((row) => this.toWire(row, nowMs)), total };
  }

  /**
   * Reads one currency.
   *
   * @param id the currency id
   * @returns the currency
   * @throws {AppError} `NOT_FOUND` when there is none
   */
  async get(id: number): Promise<WireCurrency> {
    const row = await findCurrency(this.db.db, id);
    if (!row) throw notFound();
    return this.toWire(row, this.clock.nowMs());
  }

  /**
   * Adds a currency.
   *
   * @param caller the signed-in staff member (a currency always sets a rate, so `currencies:update` too, decision 046)
   * @param input the request body
   * @returns the new currency
   * @throws {AppError} `FORBIDDEN` (403) when the caller lacks `currencies:update`; `VALIDATION_FAILED` for a bad code (format or already listed), a blank name, a rate that is not above
   *   zero, a markup outside 0 to 10 or decimals outside 0 to 4, and on `decimals` (`not_chargeable`) for more decimals than an active
   *   storefront card method charges exactly (decision 048)
   */
  async create(caller: PermissionHolder, input: CreateCurrencyInput): Promise<WireCurrency> {
    // An exchange rate and its markup move money: they need the permission of the rate refresh (decision 046).
    requirePermission(caller, 'currencies:update');
    const code = input.code.toUpperCase();
    const name = input.name.trim();
    const errors: FieldError[] = [];
    if (!CODE.test(code))
      errors.push({ field: 'code', code: 'format', message: 'Enter the three-letter code, such as GBP.' });
    if (name === '') errors.push({ field: 'name', code: 'required', message: 'Enter a name.' });
    for (const problem of [
      checkRate(input.rateToBase),
      checkMarkup(input.markupPercent),
      checkDecimals(input.decimals),
    ]) {
      if (problem) errors.push(problem);
    }
    if (errors.length > 0) throw refuse(...errors);

    return this.db.runInTransaction(async ({ tx }) => {
      if ((await findCurrenciesByCode(tx, [code])).length > 0) {
        throw refuse({ field: 'code', code: 'taken', message: 'This currency is already in the list.' });
      }
      // Checked whatever `isStorefront` says: a currency switched on for the shop later keeps its decimals (decision 048).
      const chargeable = chargeDecimalsProblem(code, input.decimals, await this.chargeDecimalsOf(tx, code));
      if (chargeable) throw notChargeable(chargeable);
      const now = this.clock.now();
      const row = await insertCurrency(tx, {
        code,
        name,
        rateToBase: input.rateToBase,
        rateUpdatedAt: now,
        markupPercent: input.markupPercent,
        charmRounding: input.charmRounding,
        isStorefront: input.isStorefront,
        decimals: input.decimals,
        isActive: true,
        createdAt: now,
      }).catch((error: unknown) => {
        // Two requests adding the same code at once: the unique constraint is the last word.
        if ((error as { cause?: { code?: string } }).cause?.code === '23505') {
          throw refuse({ field: 'code', code: 'taken', message: 'This currency is already in the list.' });
        }
        throw error;
      });
      await this.audit.record(tx, {
        action: 'added currency',
        entityType: 'currency',
        entityId: row.id,
        entityLabel: row.code,
        after: snapshotOf(row),
      });
      return this.toWire(row, now.getTime());
    });
  }

  /**
   * Changes a currency.
   *
   * Why: a sent `rateToBase` (even the same number) is staff's confirmation: it restarts the rate's age and ends a hold of the
   * refresh, so the shop offers the currency again (decision 049).
   *
   * @param caller the signed-in staff member (`rateToBase` and `markupPercent` also need `currencies:update`, decision 046)
   * @param id the currency id
   * @param input the fields to change
   * @returns the changed currency
   * @throws {AppError} `FORBIDDEN` (403) when a rate or markup is sent without `currencies:update`; `NOT_FOUND`; `VALIDATION_FAILED` for a bad rate, markup, decimals or name, a code change, or a change
   *   of rate, markup or activity on the base currency; on `decimals` (`not_chargeable`) when `decimals` is sent or `isStorefront` or
   *   `isActive` is switched on and the decimals exceed what an active storefront card method charges exactly (decision 048)
   */
  async update(caller: PermissionHolder, id: number, input: UpdateCurrencyInput): Promise<WireCurrency> {
    // An exchange rate and its markup move money: they need the permission of the rate refresh (decision 046).
    if (input.rateToBase !== undefined || input.markupPercent !== undefined) {
      requirePermission(caller, 'currencies:update');
    }
    return this.db.runInTransaction(async ({ tx }) => {
      const current = await findCurrency(tx, id, true);
      if (!current) throw notFound();
      const now = this.clock.now();
      const changes: Partial<Currency> = {};
      const errors: FieldError[] = [];
      const isBase = current.code === BASE_CURRENCY;

      if (input.code !== undefined && input.code.toUpperCase() !== current.code) {
        errors.push({ field: 'code', code: 'immutable', message: 'The currency code cannot be changed.' });
      }
      if (input.name !== undefined) {
        if (input.name.trim() === '') errors.push({ field: 'name', code: 'required', message: 'Enter a name.' });
        else changes.name = input.name.trim();
      }
      if (input.rateToBase !== undefined) {
        const problem = checkRate(input.rateToBase);
        if (problem) errors.push(problem);
        else if (isBase && normalizeDecimal(input.rateToBase) !== normalizeDecimal(current.rateToBase)) {
          errors.push({ field: 'rateToBase', code: 'base', message: 'The base currency rate cannot be changed.' });
        } else {
          changes.rateToBase = input.rateToBase;
          // Sending a rate sets it: the stale clock restarts even when staff confirm the same number.
          changes.rateUpdatedAt = now;
          // Decision 049: a typed rate is staff's confirmation: it ends a hold of the refresh.
          changes.rateHeldAt = null;
        }
      }
      if (input.markupPercent !== undefined) {
        const problem = checkMarkup(input.markupPercent);
        if (problem) errors.push(problem);
        else if (isBase && !Money.of(input.markupPercent).eq(Money.of(current.markupPercent))) {
          errors.push({ field: 'markupPercent', code: 'base', message: 'The base currency has no markup.' });
        } else changes.markupPercent = input.markupPercent;
      }
      if (input.decimals !== undefined) {
        const problem = checkDecimals(input.decimals);
        if (problem) errors.push(problem);
        else changes.decimals = input.decimals;
      }
      if (input.isActive === false && isBase) {
        errors.push({ field: 'isActive', code: 'base', message: 'The base currency cannot be switched off.' });
      } else if (input.isActive !== undefined) changes.isActive = input.isActive;
      if (input.charmRounding !== undefined) changes.charmRounding = input.charmRounding;
      if (input.isStorefront !== undefined) changes.isStorefront = input.isStorefront;
      // Decision 048: new decimals, or a currency switched on for the shop, must be chargeable by the storefront card method.
      const decimalsSent = input.decimals !== undefined && checkDecimals(input.decimals) === undefined;
      if (
        decimalsSent ||
        (input.isStorefront === true && !current.isStorefront) ||
        (input.isActive === true && !current.isActive)
      ) {
        const chargeable = chargeDecimalsProblem(
          current.code,
          changes.decimals ?? current.decimals,
          await this.chargeDecimalsOf(tx, current.code),
        );
        if (chargeable) {
          if (errors.length === 0) throw notChargeable(chargeable);
          errors.push(chargeable);
        }
      }
      if (errors.length > 0) throw refuse(...errors);

      const row =
        Object.keys(changes).length > 0 ? await updateCurrency(tx, id, { ...changes, updatedAt: now }) : current;
      await this.audit.record(tx, {
        action: 'changed currency',
        entityType: 'currency',
        entityId: id,
        entityLabel: row.code,
        before: snapshotOf(current),
        after: snapshotOf(row),
      });
      return this.toWire(row, now.getTime());
    });
  }

  /**
   * The most decimals an active storefront card method charges exactly in a currency: the smallest over the automatic storefront gateways
   * whose driver says (decision 048).
   */
  private async chargeDecimalsOf(tx: DbExecutor, code: string): Promise<number | undefined> {
    const limits = (await findStorefrontGateways(tx)).flatMap((gateway) => {
      const limit = gateway.isManual ? undefined : driverFor(gateway.driver)?.maxChargeDecimals?.(code);
      return limit === undefined ? [] : [limit];
    });
    return limits.length === 0 ? undefined : Math.min(...limits);
  }

  private toWire(row: Currency, nowMs: number): WireCurrency {
    return {
      id: row.id,
      code: row.code,
      name: row.name,
      rateToBase: formatRate(row.rateToBase),
      rateUpdatedAt: row.rateUpdatedAt.toISOString(),
      markupPercent: row.markupPercent,
      charmRounding: row.charmRounding,
      isStorefront: row.isStorefront,
      decimals: row.decimals,
      isActive: row.isActive,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
      isStale: isRateStale(row.code, row.rateUpdatedAt.getTime(), nowMs, row.rateHeldAt?.getTime() ?? null),
    };
  }
}
