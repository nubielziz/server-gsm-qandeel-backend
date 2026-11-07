// Tax rates by country (map routes /admin/tax-rates, stage 14, built ahead of feature 14b): list, read, add and change a
// window, each write audited. Storefront checkout (14a) reads the rate in force from the same rows.
import { Inject, Injectable } from '@nestjs/common';
import type { z } from 'zod';
import { CLOCK, type Clock } from '../../../common/clock';
import type { ParsedListQuery } from '../../../common/contract';
import { AppError, type FieldError } from '../../../common/errors';
import { DbService, type DbExecutor } from '../../../infra/db';
import { AuditService } from '../../platform';
import type { TaxRateSchema } from '../contracts/tax-rates.contracts';
import type { TaxRate } from '../db/schema';
import {
  type TaxWindow,
  checkCountry,
  checkRatePercent,
  checkTaxText,
  checkTaxType,
  checkWindow,
  windowsOverlap,
} from '../domain/tax-rate-rules';
import {
  type TaxRateSortField,
  findTaxRateRow,
  insertTaxRateRow,
  listTaxRateRows,
  lockTaxWindows,
  otherTaxWindows,
  updateTaxRateRow,
} from '../infra/tax-rate.repository';

/** A tax rate on the wire (`TaxRateRow` of the console). */
export type WireTaxRate = z.output<typeof TaxRateSchema>;

/** The fields of a new window, as the request carries them (trimmed by the contract). */
export interface CreateTaxRateInput {
  readonly country: string;
  readonly region: string;
  readonly ratePercent: string;
  readonly taxType: string;
  readonly appliesTo: string;
  readonly validFrom: string | null;
  readonly validTo: string | null;
  readonly label: string;
  readonly ossScheme: string;
}

/** The fields a change may carry; `validTo: null` clears the end. */
export type UpdateTaxRateInput = Partial<CreateTaxRateInput>;

const refuse = (...errors: FieldError[]) => new AppError('VALIDATION_FAILED', { errors });
const notFound = () => new AppError('NOT_FOUND', { detail: 'No tax rate with this id.' });

/** The audit snapshot of a window: what an admin changes. */
function snapshotOf(row: TaxRate): Record<string, unknown> {
  return {
    country: row.country,
    region: row.region,
    ratePercent: row.ratePercent,
    taxType: row.taxType,
    appliesTo: row.appliesTo,
    validFrom: row.validFrom.toISOString(),
    validTo: row.validTo?.toISOString() ?? null,
    label: row.label,
    ossScheme: row.ossScheme,
  };
}

/** The label the audit log shows: the row's label, else its country. */
const labelOf = (row: TaxRate) => row.label || row.country;

/** The text-field problems of an input, for the fields it carries. */
function textProblems(input: UpdateTaxRateInput): FieldError[] {
  const problems: (FieldError | undefined)[] = [
    input.region === undefined ? undefined : checkTaxText('region', input.region),
    input.appliesTo === undefined ? undefined : checkTaxText('appliesTo', input.appliesTo),
    input.label === undefined ? undefined : checkTaxText('label', input.label),
    input.ossScheme === undefined ? undefined : checkTaxText('ossScheme', input.ossScheme),
  ];
  return problems.filter((problem): problem is FieldError => problem !== undefined);
}

/**
 * Reads and changes tax rates.
 *
 * Why: the Settings page shows the rate added to the price per country with its reporting scheme and history (M163: no
 * delete, a rate that stops applying gets an end date). One window at a time per country and region, so the rate in force
 * is never ambiguous; changes of one country and region are serialised by an advisory lock.
 *
 * Side effects: `create` and `update` write `tax_rates` and one audit row each.
 */
@Injectable()
export class TaxRateService {
  constructor(
    private readonly db: DbService,
    private readonly audit: AuditService,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  /**
   * Lists tax rates.
   *
   * @param query the parsed list request
   * @returns the page and the number matching the search
   */
  async list(query: ParsedListQuery<TaxRateSortField>): Promise<{ rows: WireTaxRate[]; total: number }> {
    const { rows, total } = await listTaxRateRows(this.db.db, query);
    return { rows: rows.map(toWire), total };
  }

  /**
   * Reads one tax rate.
   *
   * @param id the row id
   * @returns the row
   * @throws {AppError} `NOT_FOUND`
   */
  async get(id: number): Promise<WireTaxRate> {
    const row = await findTaxRateRow(this.db.db, id);
    if (!row) throw notFound();
    return toWire(row);
  }

  /**
   * Adds a window.
   *
   * @param input the request body
   * @returns the new row
   * @throws {AppError} `VALIDATION_FAILED` for a bad country, rate, type, text, a missing start, an end not after the
   *   start, or a window that overlaps another of the same country and region (on `validFrom`)
   */
  async create(input: CreateTaxRateInput): Promise<WireTaxRate> {
    const country = input.country.toUpperCase();
    const errors = [
      checkCountry(country),
      checkRatePercent(input.ratePercent),
      checkTaxType(input.taxType),
      ...textProblems(input),
    ].filter((problem): problem is FieldError => problem !== undefined);
    if (input.validFrom === null) {
      errors.push({ field: 'validFrom', code: 'required', message: 'Choose the date the rate starts.' });
    }
    if (errors.length > 0) throw refuse(...errors);
    const window = { from: new Date(input.validFrom!), to: input.validTo === null ? null : new Date(input.validTo) };
    const order = checkWindow(window.from, window.to);
    if (order) throw refuse(order);

    return this.db.runInTransaction(async ({ tx }) => {
      await lockTaxWindows(tx, country, input.region);
      await this.assertNoOverlap(tx, country, input.region, window);
      const now = this.clock.now();
      const row = await insertTaxRateRow(tx, {
        country,
        region: input.region,
        ratePercent: input.ratePercent,
        taxType: input.taxType,
        appliesTo: input.appliesTo,
        validFrom: window.from,
        validTo: window.to,
        label: input.label,
        ossScheme: input.ossScheme,
        // The console shows it: written from the clock, not the column default (decision 031).
        createdAt: now,
        updatedAt: now,
      });
      await this.audit.record(tx, {
        action: 'added tax rate',
        entityType: 'tax_rate',
        entityId: row.id,
        entityLabel: labelOf(row),
        after: snapshotOf(row),
      });
      return toWire(row);
    });
  }

  /**
   * Changes a window.
   *
   * @param id the row id
   * @param input the fields to change
   * @returns the changed row
   * @throws {AppError} `NOT_FOUND`; `VALIDATION_FAILED` for a country change, a bad field, an end not after the start, or a
   *   window that overlaps another of the same country and region (on `validFrom`)
   */
  async update(id: number, input: UpdateTaxRateInput): Promise<WireTaxRate> {
    return this.db.runInTransaction(async ({ tx }) => {
      const current = await findTaxRateRow(tx, id, true);
      if (!current) throw notFound();
      const errors = [
        input.ratePercent === undefined ? undefined : checkRatePercent(input.ratePercent),
        input.taxType === undefined ? undefined : checkTaxType(input.taxType),
        ...textProblems(input),
      ].filter((problem): problem is FieldError => problem !== undefined);
      if (input.country !== undefined && input.country.toUpperCase() !== current.country) {
        errors.push({
          field: 'country',
          code: 'immutable',
          message: 'The country of a rate cannot change; add a rate.',
        });
      }
      if (input.validFrom === null) {
        errors.push({ field: 'validFrom', code: 'required', message: 'A rate needs a start date.' });
      }
      if (errors.length > 0) throw refuse(...errors);

      const region = input.region ?? current.region;
      const window: TaxWindow = {
        from: input.validFrom ? new Date(input.validFrom) : current.validFrom,
        to: input.validTo === undefined ? current.validTo : input.validTo === null ? null : new Date(input.validTo),
      };
      const order = checkWindow(window.from, window.to);
      if (order) throw refuse(order);
      // Both pairs when the region changes, in one order, so two moves the other way round cannot deadlock.
      for (const key of [...new Set([current.region, region])].sort()) await lockTaxWindows(tx, current.country, key);
      await this.assertNoOverlap(tx, current.country, region, window, id);

      const row = await updateTaxRateRow(tx, id, {
        region,
        ratePercent: input.ratePercent ?? current.ratePercent,
        taxType: input.taxType ?? current.taxType,
        appliesTo: input.appliesTo ?? current.appliesTo,
        validFrom: window.from,
        validTo: window.to,
        label: input.label ?? current.label,
        ossScheme: input.ossScheme ?? current.ossScheme,
        updatedAt: this.clock.now(),
      });
      await this.audit.record(tx, {
        action: 'changed tax rate',
        entityType: 'tax_rate',
        entityId: id,
        entityLabel: labelOf(row),
        before: snapshotOf(current),
        after: snapshotOf(row),
      });
      return toWire(row);
    });
  }

  /** Refuses a window that shares an instant with another window of the same country and region (422 on `validFrom`). */
  private async assertNoOverlap(
    tx: DbExecutor,
    country: string,
    region: string,
    window: TaxWindow,
    exceptId?: number,
  ): Promise<void> {
    const others = await otherTaxWindows(tx, country, region, exceptId);
    const clash = others.find((other) => windowsOverlap(window, { from: other.validFrom, to: other.validTo }));
    if (clash) {
      const until = clash.validTo ? ` to ${clash.validTo.toISOString().slice(0, 10)}` : ' with no end';
      throw refuse({
        field: 'validFrom',
        code: 'overlap',
        message: `Overlaps the rate from ${clash.validFrom.toISOString().slice(0, 10)}${until}. End that one first.`,
      });
    }
  }
}

/** A row on the wire: dates as ISO instants, the rate as stored (4 decimals). */
function toWire(row: TaxRate): WireTaxRate {
  return {
    id: row.id,
    country: row.country,
    region: row.region,
    ratePercent: row.ratePercent,
    taxType: row.taxType,
    appliesTo: row.appliesTo,
    validFrom: row.validFrom.toISOString(),
    validTo: row.validTo?.toISOString() ?? null,
    label: row.label,
    ossScheme: row.ossScheme,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}
