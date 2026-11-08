// The reads of the money integrity check (job `ledger_integrity`, feature 12b) on tables other modules own: the ledger (`ledger_transactions`,
// `ledger_entries`, `ledger_accounts`, money), the orders and merchants a hold belongs to, and the payments and gateways. All read-only, with plain SQL in
// this one file.
//
// DEVIATION to resolve when money exports readers: decision 016 wants these through the owning module's public service. The account
// comparison does come from money (`ReconcileService.compare`, which the job calls); the per-entry zero-sum rule, the stuck holds and the
// payments without an entry have no public read, so they are read here, like `foreign-reads.repository.ts`. Replace the bodies when readers
// exist; nothing outside this file knows. Every statement counts all findings with a window function and returns only the first rows, so
// a broken ledger with thousands of findings still costs one pass.
import { sql } from 'drizzle-orm';
import type { DbExecutor } from '../../../infra/db';
import { MAX_FINDINGS, STUCK_HOLD_HOURS } from '../domain/integrity';

/** What one check read: how many problems exist in all, the sum of their differences and the first rows. */
export interface FoundRows<T> {
  readonly total: number;
  readonly difference: string;
  readonly rows: T[];
}

const toNumber = (value: string | number): number => Number(value);

/** An entry (ledger transaction) whose lines do not add up to zero. */
export interface UnbalancedEntry {
  readonly id: number;
  readonly kind: string;
  readonly refType: string;
  readonly refId: number;
  /** The sum of its lines (debit positive), 4 decimals. */
  readonly difference: string;
}

/**
 * The ledger transactions whose lines do not sum to zero.
 *
 * Why: decision 024's per-entry rule (Σ amount = 0 per transaction) is enforced by a deferred trigger, so a finding means the trigger was
 * bypassed or dropped; the integrity check proves the rule holds in the data, it never repairs it.
 *
 * @param db the database
 * @returns the count, the summed difference and the first {@link MAX_FINDINGS} (by id)
 */
export async function unbalancedEntries(db: DbExecutor): Promise<FoundRows<UnbalancedEntry>> {
  const result = await db.execute<{
    id: string;
    kind: string;
    ref_type: string;
    ref_id: string;
    difference: string;
    total: number;
    total_difference: string;
  }>(sql`
    with bad as (
      select t.id, t.kind, t.ref_type, t.ref_id, sum(e.amount) as difference
      from ledger_transactions t
      join ledger_entries e on e.transaction_id = t.id
      group by t.id
      having sum(e.amount) <> 0
    )
    select id::text, kind, ref_type, ref_id::text, difference::numeric(18,4)::text as difference,
           (count(*) over ())::int as total, (sum(difference) over ())::numeric(18,4)::text as total_difference
    from bad
    order by id
    limit ${MAX_FINDINGS}`);
  return {
    total: result.rows[0]?.total ?? 0,
    difference: result.rows[0]?.total_difference ?? '0.0000',
    rows: result.rows.map((row) => ({
      id: toNumber(row.id),
      kind: row.kind,
      refType: row.ref_type,
      refId: toNumber(row.ref_id),
      difference: row.difference,
    })),
  };
}

/**
 * How many ledger transactions exist.
 *
 * @param db the database
 * @returns the number of journals the per-entry check looked at
 */
export async function countTransactions(db: DbExecutor): Promise<number> {
  const result = await db.execute<{ n: number }>(sql`select count(*)::int as n from ledger_transactions`);
  return result.rows[0]?.n ?? 0;
}

/** What the account finding adds to the comparison's difference: the owner and the time of the last line. */
export interface AccountFacts {
  readonly ownerId: number | null;
  readonly lastEntryAt: Date | null;
}

/**
 * The owner and the last entry time of some accounts.
 *
 * @param db the database
 * @param ids the account ids
 * @returns the facts by account id
 */
export async function accountFacts(db: DbExecutor, ids: readonly number[]): Promise<Map<number, AccountFacts>> {
  if (ids.length === 0) return new Map();
  const result = await db.execute<{ id: string; owner_id: string | null; last_entry_at: Date | null }>(sql`
    select a.id::text, a.owner_id::text, max(e.created_at) as last_entry_at
    from ledger_accounts a
    left join ledger_entries e on e.account_id = a.id
    where a.id in (${sql.join(
      ids.map((id) => sql`${id}`),
      sql`, `,
    )})
    group by a.id`);
  return new Map(
    result.rows.map((row) => [
      toNumber(row.id),
      {
        ownerId: row.owner_id === null ? null : toNumber(row.owner_id),
        lastEntryAt: row.last_entry_at === null ? null : new Date(row.last_entry_at),
      },
    ]),
  );
}

/** A hold that has not been released or settled for more than 24 hours. */
export interface StuckHold {
  readonly orderId: number;
  readonly merchantName: string;
  readonly heldAt: Date;
}

/**
 * The merchant orders whose hold is older than 24 hours and still open.
 *
 * Why: holds live on `client_hold` through `order_hold` transactions (there is no holds table), so the order is the natural id
 * (RESOLUTIONS health-commissions-9). The order's latest hold (`order_hold`, or the reopen adjustment that puts a completed order back on
 * hold) is stuck when it is older than the cut-off, nothing released or settled the order after it, and the order is still pending or
 * processing. Storefront orders (no merchant) hold no wallet money and are not listed.
 *
 * @param db the database
 * @param now the clock's time
 * @returns the count and the first {@link MAX_FINDINGS}, oldest hold first
 */
export async function stuckHolds(db: DbExecutor, now: Date): Promise<FoundRows<StuckHold>> {
  const cutoff = new Date(now.getTime() - STUCK_HOLD_HOURS * 3_600_000);
  const result = await db.execute<{ order_id: string; merchant_name: string; held_at: Date; total: number }>(sql`
    select o.id::text as order_id, c.name as merchant_name, h.created_at as held_at, (count(*) over ())::int as total
    from orders o
    join clients c on c.id = o.client_id
    join lateral (
      select t.id, t.created_at from ledger_transactions t
      where t.ref_type = 'order' and t.ref_id = o.id and (t.kind = 'order_hold' or t.kind = 'adjustment')
      order by t.id desc limit 1
    ) h on true
    where o.status in ('pending', 'processing')
      and h.created_at < ${cutoff}
      and not exists (
        select 1 from ledger_transactions r
        where r.ref_type = 'order' and r.ref_id = o.id and r.kind in ('order_settle', 'order_release') and r.id > h.id
      )
    order by h.created_at, o.id
    limit ${MAX_FINDINGS}`);
  return {
    total: result.rows[0]?.total ?? 0,
    difference: '0.0000',
    rows: result.rows.map((row) => ({
      orderId: toNumber(row.order_id),
      merchantName: row.merchant_name,
      heldAt: new Date(row.held_at),
    })),
  };
}

/** A confirmed payment that has no ledger entry. */
export interface UnpostedPayment {
  readonly id: number;
  readonly gatewayTxnId: string | null;
  readonly gatewayName: string;
  readonly amount: string;
}

/**
 * The confirmed payments that have no ledger entry.
 *
 * Why: a top-up is confirmed when staff or the automatic credit approve it, and its `deposit` entry points at the payment; a storefront
 * payment is confirmed once the gateway captured it (and stays so through refunds and disputes), and its `b2c_payment` entry points at the
 * order (resolution money-2). A confirmed payment with no entry is money the books never saw.
 *
 * @param db the database
 * @returns the count, the summed amount and the first {@link MAX_FINDINGS} (by id)
 */
export async function paymentsWithoutEntry(db: DbExecutor): Promise<FoundRows<UnpostedPayment>> {
  const result = await db.execute<{
    id: string;
    gateway_txn_id: string | null;
    gateway_name: string;
    amount: string;
    total: number;
    total_amount: string;
  }>(sql`
    select p.id::text, p.gateway_txn_id, g.name as gateway_name, p.amount::numeric(18,4)::text as amount,
           (count(*) over ())::int as total, (sum(p.amount) over ())::numeric(18,4)::text as total_amount
    from payments p
    join payment_gateways g on g.id = p.gateway_id
    where (p.purpose = 'topup' and p.status = 'approved'
             and not exists (select 1 from ledger_transactions t where t.ref_type = 'payment' and t.ref_id = p.id))
       or (p.purpose = 'order' and p.status in ('captured', 'refunded', 'partial_refund', 'disputed', 'chargeback')
             and not exists (select 1 from ledger_transactions t
                             where t.ref_type = 'order' and t.ref_id = p.order_id and t.kind = 'b2c_payment'))
    order by p.id
    limit ${MAX_FINDINGS}`);
  return {
    total: result.rows[0]?.total ?? 0,
    difference: result.rows[0]?.total_amount ?? '0.0000',
    rows: result.rows.map((row) => ({
      id: toNumber(row.id),
      gatewayTxnId: row.gateway_txn_id,
      gatewayName: row.gateway_name,
      amount: row.amount,
    })),
  };
}
