// ReportService: the four JSON reports of `/admin/reports/*` (stage 11): profit, wallet exposure, supplier performance and top merchants.
// Read-only and never cached (money figures are never cached, decision 022). A report that reads more than once (exposure totals and rows,
// supplier orders and calls, ranked merchants and their balances) does it in one read-only REPEATABLE READ transaction, so its parts
// describe the same moment. The fifth report, the client statement PDF, is in client-statement.service.ts.
import { Inject, Injectable } from '@nestjs/common';
import { CLOCK, type Clock } from '../../../common/clock';
import { AppError } from '../../../common/errors';
import { Money } from '../../../common/money';
import { DbService } from '../../../infra/db';
import {
  type ProfitGroup,
  type ProfitRowFigures,
  dayWindow,
  defaultProfitRange,
  isOrderedRange,
  overdraftUsed,
  profitRows,
  rejectionRate,
  roundSeconds,
} from '../domain/report-figures';
import {
  exposureTotals,
  largestWallets,
  profitSums,
  supplierCallFigures,
  supplierOrderFigures,
  topClientFigures,
  walletBalances,
} from '../infra/report.repository';

const DAY_MS = 86_400_000;
/** How a report with more than one query reads: one snapshot of the database, and no write possible. */
const SNAPSHOT = { isolation: 'repeatable read', readOnly: true } as const;
/** How many wallets the exposure report lists (the totals always cover every merchant). */
export const EXPOSURE_ROW_LIMIT = 50;
/** The base currency every report amount is in (decision 011). */
const CURRENCY = 'USD';

/** `GET /admin/reports/profit`. */
export interface ProfitReport {
  readonly groupBy: ProfitGroup;
  readonly from: string;
  readonly to: string;
  readonly currency: string;
  readonly rows: ProfitRowFigures[];
  readonly totals: {
    readonly orders: number;
    readonly revenue: string;
    readonly cost: string;
    readonly profit: string;
  };
}

/** `GET /admin/reports/wallet-exposure`. */
export interface ExposureReport {
  readonly currency: string;
  readonly totals: {
    readonly clients: number;
    readonly balance: string;
    readonly reserved: string;
    readonly overdraftLimit: string;
    readonly overdraftUsed: string;
    readonly inOverdraft: number;
  };
  readonly rows: Array<{
    readonly clientId: number;
    readonly name: string;
    readonly balance: string;
    readonly reserved: string;
    readonly overdraftLimit: string;
    readonly overdraftUsed: string;
  }>;
}

/** One supplier of `GET /admin/reports/suppliers`, with the call log's figures as extra fields. */
export interface SupplierReportRow {
  readonly supplierId: number;
  readonly supplierName: string;
  readonly orders: number;
  readonly completed: number;
  readonly rejected: number;
  readonly spend: string;
  readonly rejectionRate: number | null;
  readonly averageSeconds: number | null;
  readonly calls: number;
  readonly errorCalls: number;
  readonly timeoutCalls: number;
}

/** One merchant of `GET /admin/reports/top-clients`. */
export interface TopClientRow {
  readonly id: number;
  readonly name: string;
  readonly country: string;
  readonly orders: number;
  readonly spend: string;
  readonly profit: string;
  readonly walletBalance: string;
}

/**
 * Builds the money reports.
 *
 * Why: the console's Reports tab (profit by day, service, supplier or merchant; wallet exposure), the Suppliers page (spend, rejection
 * rate and speed) and the dashboard (top merchants, wallet exposure). The server adds everything up; the console shows the figures.
 * Days are UTC days (no business time-zone setting exists yet) and every window ends at the clock's time (decision 031). The reports
 * with several queries run them in one read-only repeatable-read transaction: the exposure totals and rows, the supplier orders and
 * calls, and the ranked merchants with their balances are read from one snapshot, so the figures cannot disagree with each other
 * because a posting or an order landed between two queries. The profit report is a single query, which is one snapshot already.
 *
 * Side effects: none (reads only).
 */
@Injectable()
export class ReportService {
  constructor(
    private readonly db: DbService,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  /**
   * Profit of the completed orders of a range of days.
   *
   * @param query the split and the range; a missing range is the last 30 days ending today, a missing split is `day`
   * @returns the rows (days oldest first, other splits by profit) and the totals, with the dates used echoed back
   * @throws {AppError} `VALIDATION_FAILED` (422 on `from`) when `from` is after `to`
   */
  async profit(query: {
    groupBy?: ProfitGroup | undefined;
    from?: string | undefined;
    to?: string | undefined;
  }): Promise<ProfitReport> {
    const groupBy = query.groupBy ?? 'day';
    const defaults = defaultProfitRange(this.clock.now(), query.to);
    const from = query.from ?? defaults.from;
    const to = defaults.to;
    if (!isOrderedRange(from, to)) {
      throw new AppError('VALIDATION_FAILED', {
        errors: [{ field: 'from', code: 'invalid_range', message: 'The first day must not be after the last day.' }],
      });
    }
    const { start, end } = dayWindow(from, to);
    const buckets = (await profitSums(this.db.db, groupBy, start, end)).map((row) => ({
      key: row.key,
      label: row.label,
      orders: row.orders,
      revenue: Money.of(row.revenue),
      cost: Money.of(row.cost),
    }));
    return { groupBy, from, to, currency: CURRENCY, ...profitRows(groupBy, buckets) };
  }

  /**
   * What the merchants' wallets hold and owe.
   *
   * @returns the totals over every merchant with a wallet and the 50 largest wallets
   */
  async walletExposure(): Promise<ExposureReport> {
    const { totals, wallets } = await this.db.runInTransaction(
      async ({ tx }) => ({
        totals: await exposureTotals(tx),
        wallets: await largestWallets(tx, EXPOSURE_ROW_LIMIT),
      }),
      SNAPSHOT,
    );
    return {
      currency: CURRENCY,
      totals,
      rows: wallets.map((wallet) => ({
        ...wallet,
        overdraftUsed: overdraftUsed(Money.of(wallet.balance)).toWire(),
      })),
    };
  }

  /**
   * How each supplier did over the last days.
   *
   * @param days the window in days
   * @returns one row per supplier (suppliers with no orders included), by supplier id
   */
  async suppliers(days: number): Promise<SupplierReportRow[]> {
    const since = new Date(this.clock.nowMs() - days * DAY_MS);
    const { orders, calls } = await this.db.runInTransaction(
      async ({ tx }) => ({
        orders: await supplierOrderFigures(tx, since),
        calls: await supplierCallFigures(tx, since),
      }),
      SNAPSHOT,
    );
    return orders.map((row) => ({
      supplierId: row.supplierId,
      supplierName: row.supplierName,
      orders: row.orders,
      completed: row.completed,
      rejected: row.rejected,
      spend: row.spend,
      rejectionRate: rejectionRate(row.completed, row.rejected),
      averageSeconds: roundSeconds(row.averageSeconds),
      calls: calls.get(row.supplierId)?.calls ?? 0,
      errorCalls: calls.get(row.supplierId)?.errorCalls ?? 0,
      timeoutCalls: calls.get(row.supplierId)?.timeoutCalls ?? 0,
    }));
  }

  /**
   * The merchants that spent the most over the last days.
   *
   * @param days the window in days (the last `days x 24` hours)
   * @param limit how many merchants to return
   * @returns the ranked merchants with their wallet balance
   */
  async topClients(days: number, limit: number): Promise<TopClientRow[]> {
    const since = new Date(this.clock.nowMs() - days * DAY_MS);
    const { ranked, balances } = await this.db.runInTransaction(async ({ tx }) => {
      const top = await topClientFigures(tx, since, limit);
      return {
        ranked: top,
        balances: await walletBalances(
          tx,
          top.map((row) => row.id),
        ),
      };
    }, SNAPSHOT);
    return ranked.map((row) => ({ ...row, walletBalance: balances.get(row.id) ?? Money.zero().toWire() }));
  }
}
