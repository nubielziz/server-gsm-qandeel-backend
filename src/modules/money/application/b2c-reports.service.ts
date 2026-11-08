// B2cReportsService: the use cases of the storefront money reports (map stage 16): the VAT report and the payments report.
import { Inject, Injectable } from '@nestjs/common';
import { Decimal } from 'decimal.js';
import { CLOCK, type Clock } from '../../../common/clock';
import type { QueryOf, ResultOf } from '../../../common/contract';
import { AppError } from '../../../common/errors';
import { Money } from '../../../common/money';
import { DbService } from '../../../infra/db';
import { BASE_CURRENCY } from '../domain/accounts';
import { type PaymentReportSort, paymentsReport, vatRows } from '../infra/b2c-reports.repository';
import { loadBillingCustomers } from '../infra/foreign-directory.repository';
import { b2cPaymentMethod } from '../domain/b2c-money';
import { REPORT_SORTS, type getPaymentsReport, type getVatReport } from '../contracts/b2c-reports.contracts';

const DAY_MS = 86_400_000;
const METHODS = ['card', 'wallet', 'crypto'] as const;
const DEFAULT_PAGE = 12;
const MAX_PAGE = 100;

/** A percent with two decimals: `part / whole x 100`, `0.00` when there is nothing to divide by. */
function percent(part: string, whole: string): string {
  const divisor = new Decimal(whole);
  return divisor.isZero()
    ? '0.00'
    : new Decimal(part).div(divisor).times(100).toDecimalPlaces(2, Decimal.ROUND_HALF_UP).toFixed(2);
}

/**
 * Builds the storefront money reports.
 *
 * Why: RESOLUTIONS money-4 and money-5, ANSWERS refunds Q2: the console's two report routes read the ledger and the payments table; every
 * figure is computed in SQL, never in the browser, in USD at each checkout's locked rate.
 *
 * Side effects: none (reads only).
 */
@Injectable()
export class B2cReportsService {
  constructor(
    private readonly db: DbService,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  /**
   * The VAT report.
   *
   * @param query the two days (inclusive)
   * @returns the report
   * @throws {AppError} `VALIDATION_FAILED` when `from` is after `to` (field `from`)
   */
  async vat(query: QueryOf<typeof getVatReport>): Promise<ResultOf<typeof getVatReport>> {
    if (query.from > query.to) {
      throw new AppError('VALIDATION_FAILED', {
        errors: [{ field: 'from', code: 'range', message: 'The start must not be after the end.' }],
      });
    }
    const from = new Date(`${query.from}T00:00:00.000Z`);
    const to = new Date(new Date(`${query.to}T00:00:00.000Z`).getTime() + DAY_MS);
    const rows = await vatRows(this.db.db, from, to);
    return {
      from: query.from,
      to: query.to,
      currency: BASE_CURRENCY,
      rows: rows.map((row) => ({
        country: row.country,
        period: row.period,
        rate: row.rate,
        orders: row.orders,
        taxable: Money.of(row.taxable).toWire(),
        vat: Money.of(row.vat).toWire(),
      })),
      totals: {
        orders: rows.reduce((total, row) => total + row.orders, 0),
        taxable: Money.sum(rows.map((row) => Money.of(row.taxable))).toWire(),
        vat: Money.sum(rows.map((row) => Money.of(row.vat))).toWire(),
      },
    };
  }

  /**
   * The payments report.
   *
   * @param query the method filter, the range and the sort
   * @returns the method comparison, a page of payments, the match count and the strip's totals
   */
  async payments(query: QueryOf<typeof getPaymentsReport>): Promise<ResultOf<typeof getPaymentsReport>> {
    const start = query._start ?? query.start ?? 0;
    const end = query._end ?? query.end ?? start + DEFAULT_PAGE;
    const limit = Math.max(0, Math.min(end - start, MAX_PAGE));
    const wanted = query._sort ?? query.sort ?? 'createdAt';
    if (!(REPORT_SORTS as readonly string[]).includes(wanted)) {
      throw new AppError('VALIDATION_FAILED', {
        errors: [{ field: 'sort', code: 'invalid', message: `Sort by one of: ${REPORT_SORTS.join(', ')}.` }],
      });
    }
    const sort = wanted as PaymentReportSort;
    const since = new Date(this.clock.now().getTime() - 30 * DAY_MS);
    const report = await paymentsReport(
      this.db.db,
      { method: query.method, start, limit, sort, order: query._order ?? query.order ?? 'desc' },
      since,
    );
    const customers = await loadBillingCustomers(
      this.db.db,
      report.lines.flatMap((line) => (line.customerId === null ? [] : [line.customerId])),
    );
    const figures = new Map(report.methods.map((row) => [b2cPaymentMethod(row.method), row]));
    return {
      methods: METHODS.map((method) => {
        const row = figures.get(method);
        return {
          method,
          payments: row?.payments ?? 0,
          volume: Money.of(row?.volume ?? '0').toWire(),
          fees: Money.of(row?.fees ?? '0').toWire(),
          feeRate: percent(row?.fees ?? '0', row?.volume ?? '0'),
          refunds: row?.refunds ?? 0,
          disputes: row?.disputes ?? 0,
        };
      }),
      payments: report.lines.map((line) => {
        const customer = line.customerId === null ? undefined : customers.get(line.customerId);
        return {
          id: line.id,
          orderId: line.orderId,
          amount: Money.of(line.amount).toWire(),
          feeAmount: Money.of(line.feeAmount).toWire(),
          createdAt: line.paidAt.toISOString(),
          method: b2cPaymentMethod(line.method),
          brand: line.brand,
          status: line.status as 'captured',
          currency: line.currency,
          fx: line.fx,
          customer: customer ? { id: customer.id, name: customer.name || customer.email } : null,
        };
      }),
      total: report.total,
      totals: {
        refundedCount: report.totals.refundedCount,
        refundedAmount: Money.of(report.totals.refundedAmount).toWire(),
        refundedPercentOfSales: percent(report.totals.refundedAmount, report.totals.sales),
        awaitingAmount: Money.of(report.totals.awaitingAmount).toWire(),
        chargebackLoss: Money.of(report.totals.chargebackLoss).toWire(),
      },
    };
  }
}
