// SQL behind the storefront money reports (feature 16): the VAT report from the ledger's `vat_payable` lines and the payments report by
// method. Read only. Money is converted to USD per row at the checkout's locked rate (RESOLUTIONS money-5, B111).
import { type SQL, sql } from 'drizzle-orm';
import type { DbExecutor } from '../../../infra/db';

/** One row of the VAT report. */
export interface VatRowRecord {
  readonly country: string;
  readonly period: string;
  readonly rate: string;
  readonly orders: number;
  readonly taxable: string;
  readonly vat: string;
}

/**
 * VAT per country and month from the ledger.
 *
 * Why: RESOLUTIONS money-4 and the endpoint doc: the report is worked out from the posted `vat_payable` lines of the storefront's
 * `b2c_pay` journals minus its `b2c_refund` journals, never from invoices, so it matches the books. One row per tax country and month
 * (UTC), newest month first, then country; `taxable` is the net sales, `orders` the paid orders of the month, `rate` the rate of the
 * latest order of the month.
 *
 * @param db the database or a transaction
 * @param from the start (inclusive)
 * @param to the end (exclusive)
 * @returns the rows
 */
export async function vatRows(db: DbExecutor, from: Date, to: Date): Promise<VatRowRecord[]> {
  const result = await db.execute<{
    country: string;
    period: string;
    rate: string;
    orders: number;
    taxable: string;
    vat: string;
  }>(sql`
    with tx as (
      select lt.id, lt.kind, lt.ref_id as order_id, lt.created_at,
        abs(coalesce(sum(le.amount) filter (where la.kind = 'vat_payable'), 0)) as vat,
        abs(coalesce(sum(le.amount) filter (where la.kind = 'gateway_clearing'), 0)) as gross
      from ledger_transactions lt
      join ledger_entries le on le.transaction_id = lt.id
      join ledger_accounts la on la.id = le.account_id
      where lt.ref_type = 'order' and lt.kind in ('b2c_payment', 'refund')
        and lt.created_at >= ${from} and lt.created_at < ${to}
      group by lt.id)
    select coalesce(o.tax_country, '') as country,
      to_char(tx.created_at at time zone 'UTC', 'YYYY-MM') as period,
      coalesce((array_agg(cs.tax_rate order by tx.created_at desc, tx.id desc))[1], 0)::text as rate,
      (count(distinct tx.order_id) filter (where tx.kind = 'b2c_payment'))::int as orders,
      coalesce(sum(case when tx.kind = 'b2c_payment' then tx.gross - tx.vat else -(tx.gross - tx.vat) end), 0)::numeric(20,4)::text as taxable,
      coalesce(sum(case when tx.kind = 'b2c_payment' then tx.vat else -tx.vat end), 0)::numeric(20,4)::text as vat
    from tx
    join orders o on o.id = tx.order_id and o.customer_id is not null
    left join checkout_sessions cs on cs.id = o.checkout_session_id
    group by 1, 2
    order by period desc, country asc`);
  return result.rows.map((row) => ({ ...row, orders: Number(row.orders) }));
}

/** The sort keys of the payments report and the SQL each means (whitelisted: never user text). */
const PAYMENT_SORTS = {
  orderId: 'pay.order_id',
  method: 'pay.method_type',
  amount: 'pay.usd_amount',
  feeAmount: 'pay.usd_fee',
  status: 'pay.status',
  createdAt: 'pay.paid_at',
} as const;

/** A sort key of the payments report. */
export type PaymentReportSort = keyof typeof PAYMENT_SORTS;

/** One payment of the report, amounts in USD. */
export interface PaymentLineRecord {
  readonly id: number;
  readonly orderId: number;
  readonly amount: string;
  readonly feeAmount: string;
  readonly paidAt: Date;
  readonly method: string;
  readonly brand: string;
  readonly status: string;
  readonly currency: string;
  readonly fx: string;
  readonly customerId: number | null;
}

/** The figures of one method. */
export interface MethodFigures {
  readonly method: string;
  readonly payments: number;
  readonly volume: string;
  readonly fees: string;
  readonly refunds: number;
  readonly disputes: number;
}

/** The strip's totals, in USD. */
export interface ReportTotals {
  readonly refundedCount: number;
  readonly refundedAmount: string;
  readonly sales: string;
  readonly awaitingAmount: string;
  readonly chargebackLoss: string;
}

/**
 * The USD the ledger posted on the `gateway_clearing` line of a transaction (the gross of a payment or a refund, the amount and fee of a
 * chargeback, the fee of a gateway fee journal), as a correlated subquery over the transaction id the SQL passes in.
 */
const clearingOf = (transactionId: SQL): SQL => sql`(
  select abs(sum(le.amount)) from ledger_entries le
  join ledger_accounts la on la.id = le.account_id and la.kind = 'gateway_clearing'
  where le.transaction_id = ${transactionId})`;

/**
 * The payments the report counts: money was received, whatever happened to it after.
 *
 * The USD figures are the books': the session's locked gross, and the fee journal's amount, so the report ties to the ledger and to the
 * refund and dispute screens to the cent; only a payment without a session or a journal falls back to converting its own currency.
 */
const PAY = sql`
  select p.id, p.order_id, p.customer_id, p.method_type, p.brand, p.status, p.currency, p.amount, p.fee_amount,
    coalesce(cs.fx_rate, 1) as fx,
    coalesce(cs.gross_amount, round(p.amount / coalesce(cs.fx_rate, 1), 4)) as usd_amount,
    coalesce(
      ${clearingOf(sql`(select lt.id from ledger_transactions lt where lt.idempotency_key = 'payment:' || p.id || ':fee')`)},
      round(p.fee_amount / coalesce(cs.fx_rate, 1), 4)) as usd_fee,
    coalesce(p.captured_at, p.created_at) as paid_at
  from payments p left join checkout_sessions cs on cs.id = p.checkout_session_id
  where p.purpose = 'order' and p.status in ('captured', 'refunded', 'partial_refund', 'disputed', 'chargeback')`;

/** What a refund is in USD: its journal when it has one, the whole session gross when it refunds the whole payment, else converted. */
const REFUND_USD = sql`coalesce(
  ${clearingOf(sql`r.ledger_tx_id`)},
  case when r.amount = p.amount then cs.gross_amount end,
  round(r.amount / coalesce(cs.fx_rate, 1), 4))`;

/** What a dispute cost in USD: its chargeback journal when it has one (amount and fee), else converted. */
const DISPUTE_LOSS_USD = sql`coalesce(
  ${clearingOf(sql`d.ledger_tx_id`)},
  round((d.amount + d.fee) / coalesce(cs.fx_rate, 1), 4))`;

/**
 * The method comparison, a page of payments and the strip's totals.
 *
 * Why: RESOLUTIONS money-5: only payments with money received are listed or counted (pending and failed never are); every amount is
 * converted per row at the session's locked rate and summed in SQL.
 *
 * @param db the database or a transaction
 * @param query the method filter, the range and the sort
 * @param since the start of the 30-day window of the strip (the clock's time minus 30 days)
 * @returns the three parts of the report
 */
export async function paymentsReport(
  db: DbExecutor,
  query: { method: string | undefined; start: number; limit: number; sort: PaymentReportSort; order: 'asc' | 'desc' },
  since: Date,
): Promise<{ methods: MethodFigures[]; lines: PaymentLineRecord[]; total: number; totals: ReportTotals }> {
  const orderBy = sql.raw(`${PAYMENT_SORTS[query.sort]} ${query.order} nulls last, pay.id ${query.order}`);
  const methodFilter = query.method === undefined ? sql`true` : sql`pay.method_type = ${query.method}`;
  const [methods, lines, counted, totals] = await Promise.all([
    db.execute<{
      method: string;
      payments: number;
      volume: string;
      fees: string;
      refunds: number;
      disputes: number;
    }>(sql`
      with pay as (${PAY})
      select pay.method_type as method, count(*)::int as payments,
        coalesce(sum(pay.usd_amount), 0)::numeric(20,4)::text as volume,
        coalesce(sum(pay.usd_fee), 0)::numeric(20,4)::text as fees,
        (select count(*) from refunds r where r.payment_id in (select id from pay p2 where p2.method_type = pay.method_type)
          and r.status in ('processing', 'completed'))::int as refunds,
        (select count(*) from disputes d where d.payment_id in (select id from pay p3 where p3.method_type = pay.method_type))::int as disputes
      from pay group by pay.method_type`),
    db.execute<{
      id: number;
      order_id: number;
      usd_amount: string;
      usd_fee: string;
      paid_at: Date;
      method_type: string;
      brand: string;
      status: string;
      currency: string;
      fx: string;
      customer_id: number | null;
    }>(sql`
      with pay as (${PAY})
      select * from pay where ${methodFilter}
      order by ${orderBy} limit ${query.limit} offset ${query.start}`),
    db.execute<{ n: number }>(sql`with pay as (${PAY}) select count(*)::int as n from pay where ${methodFilter}`),
    db.execute<{ refunded_count: number; refunded_amount: string; sales: string; awaiting: string; loss: string }>(sql`
      with pay as (${PAY})
      select
        (select count(*) from refunds r where r.status = 'completed' and r.customer_id is not null and r.completed_at >= ${since})::int as refunded_count,
        (select coalesce(sum(${REFUND_USD}), 0)::numeric(20,4)::text
           from refunds r join payments p on p.id = r.payment_id left join checkout_sessions cs on cs.id = p.checkout_session_id
           where r.status = 'completed' and r.customer_id is not null and r.completed_at >= ${since}) as refunded_amount,
        (select coalesce(sum(usd_amount), 0)::numeric(20,4)::text from pay where paid_at >= ${since}) as sales,
        (select coalesce(sum(${REFUND_USD}), 0)::numeric(20,4)::text
           from refunds r join payments p on p.id = r.payment_id left join checkout_sessions cs on cs.id = p.checkout_session_id
           where r.status in ('requested', 'failed') and r.customer_id is not null) as awaiting,
        (select coalesce(sum(${DISPUTE_LOSS_USD}), 0)::numeric(20,4)::text
           from disputes d join payments p on p.id = d.payment_id left join checkout_sessions cs on cs.id = p.checkout_session_id
           where d.status = 'lost') as loss`),
  ]);
  const t = totals.rows[0];
  return {
    methods: methods.rows.map((row) => ({
      ...row,
      payments: Number(row.payments),
      refunds: Number(row.refunds),
      disputes: Number(row.disputes),
    })),
    lines: lines.rows.map((row) => ({
      id: Number(row.id),
      orderId: Number(row.order_id),
      amount: row.usd_amount,
      feeAmount: row.usd_fee,
      paidAt: new Date(row.paid_at),
      method: row.method_type,
      brand: row.brand,
      status: row.status,
      currency: row.currency,
      fx: row.fx,
      customerId: row.customer_id === null ? null : Number(row.customer_id),
    })),
    total: counted.rows[0]?.n ?? 0,
    totals: {
      refundedCount: Number(t?.refunded_count ?? 0),
      refundedAmount: t?.refunded_amount ?? '0.0000',
      sales: t?.sales ?? '0.0000',
      awaitingAmount: t?.awaiting ?? '0.0000',
      chargebackLoss: t?.loss ?? '0.0000',
    },
  };
}
