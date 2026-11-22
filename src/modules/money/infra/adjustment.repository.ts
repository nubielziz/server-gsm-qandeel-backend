// Reads of the manual wallet adjustments (money module, decision 049): what one staff member credited within a window, and the lock that
// makes one staff member's adjustments run one after the other.
import { sql } from 'drizzle-orm';
import { Money } from '../../../common/money';
import type { DbExecutor } from '../../../infra/db';

/** Which wallets an adjustment credits: merchant wallets (ref type `client`) or customer store balances (ref type `customer`). */
export type AdjustmentPool = 'client' | 'customer';

const WALLET_KIND: Readonly<Record<AdjustmentPool, string>> = { client: 'client_wallet', customer: 'customer_wallet' };

/**
 * Serialises the manual adjustments of one staff member until the transaction ends.
 *
 * Why: decision 049: the 24-hour sum of a staff member's credits is read and extended under this lock, so two adjustments at once cannot
 * both pass it. Taken before any row lock; no other path takes it.
 *
 * Side effects: takes `pg_advisory_xact_lock(hashtextextended('wallet-adjust:staff:<staffId>', 0))`.
 *
 * @param tx the adjustment's transaction
 * @param staffId the staff member
 */
export async function lockStaffAdjustments(tx: DbExecutor, staffId: number): Promise<void> {
  await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`wallet-adjust:staff:${staffId}`}, 0))`);
}

/**
 * Sums what one staff member credited by manual adjustment to wallets of one pool after a moment.
 *
 * Why: decision 049: the approval limit caps the credits of a rolling 24 hours. A credit is the negative wallet line of an `adjustment`
 * journal the staff member posted with ref type `client` or `customer`; an order reversal (kind `adjustment`, ref type `order`) is
 * never counted. The kind index (`ledger_transactions_kind_idx`) serves the window.
 *
 * @param db the adjustment's transaction
 * @param staffId the staff member
 * @param pool merchant wallets or customer balances
 * @param since the start of the window (the clock's time minus 24 hours)
 * @returns the sum, zero when none
 */
export async function staffCreditsSince(
  db: DbExecutor,
  staffId: number,
  pool: AdjustmentPool,
  since: Date,
): Promise<Money> {
  const result = await db.execute<{ total: string }>(sql`
    select coalesce(sum(-le.amount), 0)::numeric(20,4)::text as total
    from ledger_transactions lt
    join ledger_entries le on le.transaction_id = lt.id
    join ledger_accounts la on la.id = le.account_id
    where lt.kind = 'adjustment' and lt.ref_type = ${pool}
      and lt.created_by_type = 'staff' and lt.created_by_id = ${staffId}
      and lt.created_at > ${since}
      and la.kind = ${WALLET_KIND[pool]} and le.amount < 0`);
  return Money.of(result.rows[0]?.total ?? '0');
}
