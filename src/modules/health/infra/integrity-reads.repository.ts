// The reads of the money integrity check (job `ledger_integrity`, feature 12b) on tables other modules own: the ledger (`ledger_transactions`,
// `ledger_entries`, `ledger_accounts`, money), the orders and accounts a hold belongs to, the ranks of the accounts, and the payments and
// gateways. All read-only, with plain SQL in this one file.
//
// DEVIATION to resolve when money exports readers: decision 016 wants these through the owning module's public service. The account
// comparison does come from money (`ReconcileService.compare`, which the job calls); the per-entry zero-sum rule, the stuck holds and the
// payments without an entry have no public read, so they are read here, like `foreign-reads.repository.ts`. Replace the bodies when readers
// exist; nothing outside this file knows. Every statement counts all findings with a window function and returns only the first rows, so
// a broken ledger with thousands of findings still costs one pass.
import { sql } from 'drizzle-orm';
import type { DbExecutor } from '../../../infra/db';
import { MAX_FINDINGS, STUCK_HOLD_HOURS, type RankProblem } from '../domain/integrity';
import { orders } from './sibling-modules';

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
  /** The name of the account that placed the order. */
  readonly accountName: string;
  readonly heldAt: Date;
}

/**
 * The orders of the merchant doors whose hold is older than 24 hours and still open.
 *
 * Why: holds live on `client_hold` through `order_hold` transactions (there is no holds table), so the order is the natural id
 * (RESOLUTIONS health-commissions-9). The order's latest hold (`order_hold`, or the reopen adjustment that puts a completed order back on
 * hold) is stuck when it is older than the cut-off, nothing released or settled the order after it, and the order is still pending or
 * processing. Orders of the shop's door (`source` `store`: paid first) hold no wallet money and are not listed; the door is read from
 * `orders.source`, never from a null column, so an account that crossed ranks keeps its old hold-and-settle orders in the list.
 *
 * @param db the database
 * @param now the clock's time
 * @returns the count and the first {@link MAX_FINDINGS}, oldest hold first
 */
export async function stuckHolds(db: DbExecutor, now: Date): Promise<FoundRows<StuckHold>> {
  const cutoff = new Date(now.getTime() - STUCK_HOLD_HOURS * 3_600_000);
  const { prepaidOrderSql } = await orders();
  const shop = prepaidOrderSql(sql`o.source`);
  const result = await db.execute<{ order_id: string; account_name: string; held_at: Date; total: number }>(sql`
    select o.id::text as order_id, c.name as account_name, h.created_at as held_at, (count(*) over ())::int as total
    from orders o
    join clients c on c.id = o.account_id
    join lateral (
      select t.id, t.created_at from ledger_transactions t
      where t.ref_type = 'order' and t.ref_id = o.id and (t.kind = 'order_hold' or t.kind = 'adjustment')
      order by t.id desc limit 1
    ) h on true
    where o.status in ('pending', 'processing')
      and not (${shop})
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
      accountName: row.account_name,
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
 * order (resolution money-2). A confirmed payment with no entry is money the books never saw. A payment from the store balance (feature
 * 21) has no gateway and is named `Store balance`; a customer's top-up posts `deposit` on the payment like a merchant's. A storefront
 * payment the gateway confirmed that is held for staff counts until its money is sent back (a refund of it `processing` or `completed`,
 * decision 048).
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
    select p.id::text, p.gateway_txn_id, coalesce(g.name, 'Store balance') as gateway_name,
           p.amount::numeric(18,4)::text as amount,
           (count(*) over ())::int as total, (sum(p.amount) over ())::numeric(18,4)::text as total_amount
    from payments p
    -- A payment from the store balance has no gateway (feature 21, defect D3): it must still be found.
    left join payment_gateways g on g.id = p.gateway_id
    where (p.purpose = 'topup' and p.status = 'approved'
             and not exists (select 1 from ledger_transactions t where t.ref_type = 'payment' and t.ref_id = p.id))
       or (p.purpose = 'order' and p.status in ('captured', 'refunded', 'partial_refund', 'disputed', 'chargeback')
             and not exists (select 1 from ledger_transactions t
                             where t.ref_type = 'order' and t.ref_id = p.order_id and t.kind = 'b2c_payment'))
       -- A held storefront payment (decision 048): the gateway confirmed it, the books never saw it, and it was not sent back.
       or (p.purpose = 'order' and p.status = 'pending' and p.review_required
             and not exists (select 1 from refunds r where r.payment_id = p.id and r.status in ('processing', 'completed')))
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

/** A wallet or hold that does not follow the rank of its account. */
export interface OffRankWallet {
  readonly id: number;
  readonly kind: string;
  /** The owner's id, or `null` when the account has none. */
  readonly ownerId: number | null;
  /** The account's name, or `null` when no account row is behind the ledger account. */
  readonly ownerName: string | null;
  readonly problem: RankProblem;
  /** The amount out of place: the balance when there is one, else the credit limit; the balance for an account with no owner. */
  readonly difference: string;
}

/**
 * The wallets that do not follow the rank of their account.
 *
 * Why: the fifth check (decision 064): the kind of the live wallet follows the kind of the rank (a merchant rank uses
 * `client_wallet` and `client_hold`, any other rank `customer_wallet`). Three things are wrong: (1) a wallet of the other kind (`inactive_wallet`)
 * that holds money, carries a credit limit or is on hold, because a rank change leaves it at zero and unfrozen; (2) a merchant wallet with a
 * credit limit on a rank that allows no credit (`credit_without_rank`); (3) a ledger account whose owner type is not `account` or
 * `supplier`, or whose account row is missing (`no_account`). The check only reads: a wallet that does not follow its rank is put right by a
 * staff member (a reversing entry, a rank change), never by this job. The rank kind is `b2b` for a merchant and anything else for retail,
 * as `rankKindOf` says (it fails closed).
 *
 * @param db the database
 * @returns the count, the summed amount out of place and the first {@link MAX_FINDINGS} (by ledger account id)
 */
export async function walletsOffRank(db: DbExecutor): Promise<FoundRows<OffRankWallet>> {
  const result = await db.execute<{
    id: string;
    kind: string;
    owner_id: string | null;
    owner_name: string | null;
    problem: RankProblem;
    difference: string;
    total: number;
    total_difference: string;
  }>(sql`
    with found as (
      select a.id, a.kind, a.owner_id, c.name as owner_name,
        (case
          when (a.owner_type is not null and a.owner_type not in ('account', 'supplier'))
            or (a.owner_type = 'account' and c.id is null) then 'no_account'
          when a.kind in ('client_wallet', 'client_hold', 'customer_wallet') and ((a.kind = 'customer_wallet') = (coalesce(g.kind, '') = 'b2b'))
            and (a.balance <> 0 or a.overdraft_limit > 0 or a.frozen_at is not null) then 'inactive_wallet'
          when a.kind = 'client_wallet' and coalesce(g.kind, '') = 'b2b' and not g.overdraft_allowed and a.overdraft_limit > 0 then 'credit_without_rank'
        end) as problem,
        a.balance, a.overdraft_limit
      from ledger_accounts a
      left join clients c on a.owner_type = 'account' and c.id = a.owner_id
      left join client_groups g on g.id = c.group_id
    ), bad as (
      select id, kind, owner_id, owner_name, problem,
        (case when problem = 'credit_without_rank' then overdraft_limit when balance <> 0 or problem = 'no_account' then balance else overdraft_limit end) as difference
      from found where problem is not null
    )
    select id::text, kind, owner_id::text, owner_name, problem, difference::numeric(18,4)::text as difference,
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
      ownerId: row.owner_id === null ? null : toNumber(row.owner_id),
      ownerName: row.owner_name,
      problem: row.problem,
      difference: row.difference,
    })),
  };
}
