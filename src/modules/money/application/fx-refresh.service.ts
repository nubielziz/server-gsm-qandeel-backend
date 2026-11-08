// The exchange-rate refresh (map route POST /admin/currencies/refresh-fx, decision 029, resolution money-9): fetch the latest
// rates from the configured provider for every active non-base currency, store them and say what changed and what did not.
import { Inject, Injectable } from '@nestjs/common';
import { CLOCK, type Clock } from '../../../common/clock';
import { AppError } from '../../../common/errors';
import { DbService } from '../../../infra/db';
import { AuditService } from '../../platform';
import { FX_PROVIDER, type FxProvider, FxProviderUnavailableError } from '../domain/fx-provider';
import { checkRate, formatRate } from '../domain/currency-rules';
import { listRefreshable, writeRefreshedRate } from '../infra/fx-currency.repository';

/** The message of a currency the provider did not offer (decision 029). */
export const NOT_OFFERED_MESSAGE = 'Not offered by the provider';

/** What the refresh answers. */
export interface RefreshResult {
  readonly refreshed: Array<{ code: string; rateToBase: string; rateUpdatedAt: string }>;
  readonly failed: Array<{ code: string; message: string }>;
  /** The driver name (`openexchangerates`). */
  readonly source: string;
}

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
 * Side effects: one outbound call; updates `currencies`; writes one `audit_logs` row.
 *
 * @see docs/decisions/029-fx-provider.md
 */
@Injectable()
export class FxRefreshService {
  constructor(
    private readonly db: DbService,
    private readonly audit: AuditService,
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
   * @param options `auditEmpty: false` (the hourly job) ends a refresh with no active non-base currency before any call or transaction,
   *   so no audit row is written for nothing; the default (the admin route) audits even an empty refresh, because every staff write is audited
   * @returns what was refreshed, what failed and where the rates came from
   * @throws {AppError} `FX_PROVIDER_DOWN` (502) when no rate could be fetched at all
   */
  async refresh(options: { readonly auditEmpty?: boolean } = {}): Promise<RefreshResult> {
    const codes = (await listRefreshable(this.db.db)).map((currency) => currency.code);
    if (codes.length === 0 && this.provider.configured && options.auditEmpty === false) {
      return { refreshed: [], failed: [], source: this.provider.name };
    }
    // An unconfigured driver refuses even with nothing to refresh, so a missing provider is never hidden; the wording is the
    // driver's, decision 029's in one place.
    const quote =
      codes.length === 0 && this.provider.configured ? { rates: new Map<string, string>() } : await this.fetch(codes);

    return this.db.runInTransaction(async ({ tx }) => {
      const now = this.clock.now();
      const refreshed: Array<{ code: string; rateToBase: string; rateUpdatedAt: string }> = [];
      const failed: Array<{ code: string; message: string }> = [];
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
        const row = await writeRefreshedRate(tx, currency.id, offered, now);
        before[row.code] = formatRate(currency.rateToBase);
        after[row.code] = formatRate(row.rateToBase);
        refreshed.push({ code: row.code, rateToBase: formatRate(row.rateToBase), rateUpdatedAt: now.toISOString() });
      }
      if (refreshed.length === 0 && failed.length > 0) {
        throw new AppError('FX_PROVIDER_DOWN', {
          detail: 'The exchange-rate provider offered none of our currencies.',
        });
      }
      await this.audit.record(tx, {
        action: 'refreshed exchange rate',
        entityType: 'currency',
        entityLabel: refreshed.length > 0 ? refreshed.map((rate) => rate.code).join(', ') : 'no currency',
        before,
        after,
      });
      return { refreshed, failed, source: this.provider.name };
    });
  }

  private fetch(codes: readonly string[]) {
    return this.provider.fetchRates(codes).catch(down);
  }
}

/** Turns a provider failure into `502 FX_PROVIDER_DOWN` with the driver's message as the detail. */
function down(error: unknown): never {
  if (error instanceof FxProviderUnavailableError) throw new AppError('FX_PROVIDER_DOWN', { detail: error.message });
  throw error;
}
