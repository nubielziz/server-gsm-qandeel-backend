// The exchange-rate refresh (map route POST /admin/currencies/refresh-fx, decision 029, resolution money-9): fetch the latest
// rates from the configured provider for every active non-base currency, store them and say what changed and what did not. A rate that
// moved more than a bound is held for staff instead (decision 049).
import { Inject, Injectable, Logger } from '@nestjs/common';
import { CLOCK, type Clock } from '../../../common/clock';
import { AppError } from '../../../common/errors';
import { DbService } from '../../../infra/db';
import { type ErrorContext, ErrorReporter } from '../../../infra/observability';
import { AuditService, FX_GUARD_SETTINGS, SettingsReader } from '../../platform';
import { FX_PROVIDER, type FxProvider, FxProviderUnavailableError } from '../domain/fx-provider';
import { checkRate, formatRate, heldRateMessage, rateMovedTooFar } from '../domain/currency-rules';
import { holdRefreshedRate, listRefreshable, writeRefreshedRate } from '../infra/fx-currency.repository';

/** The message of a currency the provider did not offer (decision 029). */
export const NOT_OFFERED_MESSAGE = 'Not offered by the provider';

/** A currency whose refreshed rate moved more than `fx.max_refresh_move_percent` and was not stored (decision 049). */
export interface HeldRate {
  readonly code: string;
  /** The stored rate, kept (wire form). */
  readonly stored: string;
  /** The provider's rate, not stored (wire form). */
  readonly offered: string;
  /** True when this refresh held it first (it was not held before): reported once. */
  readonly newly: boolean;
}

/** What the refresh answers. */
export interface RefreshResult {
  readonly refreshed: Array<{ code: string; rateToBase: string; rateUpdatedAt: string }>;
  readonly failed: Array<{ code: string; message: string }>;
  /** The driver name (`openexchangerates`). */
  readonly source: string;
  /** The currencies whose rate moved too far: also in `failed`; not part of the route's answer, the response schema drops it. */
  readonly held: HeldRate[];
}

/** What a caller of {@link FxRefreshService.refresh} may set. */
export interface RefreshOptions {
  /**
   * `false` (the hourly job) ends a refresh with no active non-base currency before any call or transaction, so no audit row is
   * written for nothing; the default (the admin route) audits even an empty refresh, because every staff write is audited.
   */
  readonly auditEmpty?: boolean;
  /** Where the refresh runs, for the report of a newly held rate; the default is the admin route in the API process. */
  readonly reportAs?: ErrorContext;
}

/** The report context of a refresh asked for through the admin route. */
const ROUTE_CONTEXT: ErrorContext = { process: 'api', method: 'POST', route: '/admin/currencies/refresh-fx' };

/**
 * Refreshes the exchange rates.
 *
 * Why: decision 029 and money-9. The answer is `{refreshed, failed, source}`: a currency the provider does not offer, or sends
 * an unusable rate for, goes to `failed[]` and the route still answers `200`; only when nothing could be fetched at all (no
 * provider configured, a timeout, a refusal, an unreadable answer, or none of our currencies offered) is it `502
 * FX_PROVIDER_DOWN`, and the old rates stay in place (the console shows them as stale after 24 hours). Refreshed rows get
 * `rate_updated_at` from the clock (decision 031). The provider is called before the transaction, so no database lock is held
 * across the network.
 *
 * Decision 049: a provider rate that moved more than `fx.max_refresh_move_percent` (default 20, judged in both directions) from the
 * stored one is held: not stored, listed in `failed` with the provider's rate, the currency marked (`rate_held_at`, the first time)
 * so it shows as stale and the shop stops offering it until staff confirm a rate. A refresh that held a rate is never `502` (the
 * provider answered; the hold must commit). Each newly held currency is reported once, whoever ran the refresh: one error log line
 * and one `ErrorReporter` event after the commit.
 *
 * Side effects: one outbound call; updates `currencies` (rates, `rate_held_at`); writes one `audit_logs` row; after the commit, an
 * error log line and an error report when a currency was newly held.
 *
 * @see docs/decisions/029-fx-provider.md, docs/decisions/049-manual-money-and-fx.md
 */
@Injectable()
export class FxRefreshService {
  private readonly logger = new Logger(FxRefreshService.name);

  constructor(
    private readonly db: DbService,
    private readonly audit: AuditService,
    private readonly settings: SettingsReader,
    private readonly reporter: ErrorReporter,
    @Inject(FX_PROVIDER) private readonly provider: FxProvider,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  /**
   * Tells whether a provider is set up to answer.
   *
   * Why: the hourly job has nothing to do (and nothing to fail) with the `manual` driver, or `openexchangerates` without a key.
   *
   * @returns false when the driver fetches nothing
   */
  get configured(): boolean {
    return this.provider.configured;
  }

  /**
   * Fetches and stores the latest rates.
   *
   * @param options `auditEmpty` and where a newly held rate is reported from (see {@link RefreshOptions})
   * @returns what was refreshed, what failed (held rates included), where the rates came from and what was held
   * @throws {AppError} `FX_PROVIDER_DOWN` (502) when no rate could be fetched at all and nothing was held
   */
  async refresh(options: RefreshOptions = {}): Promise<RefreshResult> {
    const codes = (await listRefreshable(this.db.db)).map((currency) => currency.code);
    if (codes.length === 0 && this.provider.configured && options.auditEmpty === false) {
      return { refreshed: [], failed: [], source: this.provider.name, held: [] };
    }
    // An unconfigured driver refuses even with nothing to refresh, so a missing provider is never hidden; the wording is the
    // driver's, decision 029's in one place.
    const quote =
      codes.length === 0 && this.provider.configured ? { rates: new Map<string, string>() } : await this.fetch(codes);
    const bound = FX_GUARD_SETTINGS.maxRefreshMovePercent;
    const maxMove = await this.settings.integer(bound.key, bound.fallback, bound);

    return this.db.runInTransaction(async (work) => {
      const tx = work.tx;
      const now = this.clock.now();
      const refreshed: Array<{ code: string; rateToBase: string; rateUpdatedAt: string }> = [];
      const failed: Array<{ code: string; message: string }> = [];
      const held: HeldRate[] = [];
      const before: Record<string, string> = {};
      const after: Record<string, string> = {};
      // Locked in code order: two refreshes at once cannot interleave their writes.
      for (const currency of await listRefreshable(tx, true)) {
        const offered = quote.rates.get(currency.code);
        if (offered === undefined) {
          failed.push({ code: currency.code, message: NOT_OFFERED_MESSAGE });
          continue;
        }
        if (checkRate(offered)) {
          failed.push({ code: currency.code, message: 'The provider sent a rate that cannot be used' });
          continue;
        }
        // Decision 049: a rate that moved more than the bound is not stored; the currency is held until staff type a rate.
        if (rateMovedTooFar(currency.rateToBase, offered, maxMove)) {
          failed.push({ code: currency.code, message: heldRateMessage(currency.rateToBase, offered, maxMove) });
          const newly = await holdRefreshedRate(tx, currency.id, now);
          held.push({
            code: currency.code,
            stored: formatRate(currency.rateToBase),
            offered: formatRate(offered),
            newly,
          });
          continue;
        }
        const row = await writeRefreshedRate(tx, currency.id, offered, now);
        before[row.code] = formatRate(currency.rateToBase);
        after[row.code] = formatRate(row.rateToBase);
        refreshed.push({ code: row.code, rateToBase: formatRate(row.rateToBase), rateUpdatedAt: now.toISOString() });
      }
      if (refreshed.length === 0 && held.length === 0 && failed.length > 0) {
        throw new AppError('FX_PROVIDER_DOWN', {
          detail: 'The exchange-rate provider offered none of our currencies.',
        });
      }
      await this.audit.record(tx, {
        action: 'refreshed exchange rate',
        entityType: 'currency',
        entityLabel: refreshed.length > 0 ? refreshed.map((rate) => rate.code).join(', ') : 'no currency',
        before,
        after:
          held.length > 0
            ? { ...after, held: Object.fromEntries(held.map((rate) => [rate.code, rate.offered])) }
            : after,
      });
      const newly = held.filter((rate) => rate.newly);
      if (newly.length > 0) work.afterCommit(() => this.reportHeld(newly, options.reportAs ?? ROUTE_CONTEXT));
      return { refreshed, failed, source: this.provider.name, held };
    });
  }

  private fetch(codes: readonly string[]) {
    return this.provider.fetchRates(codes).catch(down);
  }

  /** Tells staff once that rates were held: one error line and one error report (decision 049). */
  private reportHeld(newly: readonly HeldRate[], context: ErrorContext): void {
    const list = newly.map((rate) => `${rate.code} ${rate.stored} -> ${rate.offered}`).join(', ');
    const text = `Exchange rates held for staff: ${list}. Confirm a rate on the Currencies page.`;
    this.logger.error(text);
    this.reporter.capture(new Error(text), context);
  }
}

/** Turns a provider failure into `502 FX_PROVIDER_DOWN` with the driver's message as the detail. */
function down(error: unknown): never {
  if (error instanceof FxProviderUnavailableError) throw new AppError('FX_PROVIDER_DOWN', { detail: error.message });
  throw error;
}
