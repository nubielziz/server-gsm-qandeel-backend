// Reads of the manual wallet adjustments (money module, decision 049): what one staff member credited within a window, the credit-limit
// raises and transfer-receipt approvals that are judged the same way, and the lock that makes one staff member's requests run one after
// the other.
import { sql } from 'drizzle-orm';
import { Money } from '../../../common/money';
import type { DbExecutor } from '../../../infra/db';
import { creditLimitRaises } from '../db/schema';

/** Which wallets an adjustment credits: merchant wallets (ref type `client`) or customer store balances (ref type `customer`). */
export type AdjustmentPool = 'client' | 'customer';

const WALLET_KIND: Readonly<Record<AdjustmentPool, string>> = { client: 'client_wallet', customer: 'customer_wallet' };

/**
 * Serialises the manual adjustments, credit-limit raises and transfer-receipt approvals of one staff member until the transaction ends.
 *
 * Why: decision 049: the 24-hour sums of a staff member are read and extended under this lock, so two requests at once cannot both pass
 * them. Taken before any row lock, by the adjustments, the credit-limit route, the merchant invitation and the payment approval.
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

/**
 * Sums what one staff member raised merchant credit limits by after a moment.
 *
 * Why: decision 049: the raised part of a credit limit counts with the staff member's credit adjustments to merchant wallets.
 *
 * @param db the caller's transaction
 * @param staffId the staff member
 * @param since the start of the window (the clock's time minus 24 hours)
 * @returns the sum, zero when none
 */
export async function staffCreditLimitRaisesSince(db: DbExecutor, staffId: number, since: Date): Promise<Money> {
  const result = await db.execute<{ total: string }>(sql`
    select coalesce(sum(amount), 0)::numeric(20,4)::text as total
    from credit_limit_raises
    where staff_id = ${staffId} and created_at > ${since}`);
  return Money.of(result.rows[0]?.total ?? '0');
}

/**
 * Sums what one staff member made spendable on merchant wallets after a moment: their credit adjustments and their credit-limit raises.
 *
 * Why: decision 049: both are money a merchant can spend, so one 24-hour sum against `wallet.adjust_approval_limit` covers them.
 *
 * @param db the caller's transaction, holding the staff member's lock ({@link lockStaffAdjustments})
 * @param staffId the staff member
 * @param since the start of the window (the clock's time minus 24 hours)
 * @returns the sum, zero when none
 */
export async function staffMerchantCreditSince(db: DbExecutor, staffId: number, since: Date): Promise<Money> {
  const credited = await staffCreditsSince(db, staffId, 'client', since);
  return credited.add(await staffCreditLimitRaisesSince(db, staffId, since));
}

/** What {@link recordCreditLimitRaise} writes. */
export interface CreditLimitRaiseInput {
  readonly clientId: number;
  readonly staffId: number;
  /** The part by which the new limit exceeds the one it replaced; above zero. */
  readonly amount: Money;
  /** The clock's time. */
  readonly at: Date;
}

/**
 * Records a credit-limit raise for the staff member's 24-hour sum.
 *
 * Side effects: inserts one `credit_limit_raises` row.
 *
 * @param db the transaction that writes the new limit
 * @param input the merchant, the staff member, the raised part and the time
 */
export async function recordCreditLimitRaise(db: DbExecutor, input: CreditLimitRaiseInput): Promise<void> {
  await db.insert(creditLimitRaises).values({
    clientId: input.clientId,
    staffId: input.staffId,
    amount: input.amount.toWire(),
    createdAt: input.at,
  });
}

/**
 * Sums what one staff member's approvals of transfer top-ups credited after a moment.
 *
 * Why: decision 049: approving a receipt on a top-up that a merchant or customer made through a manual method credits a wallet on one
 * person's word, so those approvals are capped per staff member over 24 hours (`wallet.receipt_approval_limit`). The amount is what was
 * credited (the payment net of its fee); an automatic gateway's top-up and the payment of a staff-issued invoice are not counted (the
 * same rule as `isTransferTopUp`). An approved top-up stays approved, so the sum never shrinks within the window.
 *
 * @param db the caller's transaction, holding the staff member's lock ({@link lockStaffAdjustments})
 * @param staffId the staff member
 * @param since the start of the window (the clock's time minus 24 hours)
 * @returns the sum, zero when none
 */
export async function staffReceiptApprovalsSince(db: DbExecutor, staffId: number, since: Date): Promise<Money> {
  const result = await db.execute<{ total: string }>(sql`
    select coalesce(sum(p.amount - p.fee_amount), 0)::numeric(20,4)::text as total
    from payments p
    join payment_gateways g on g.id = p.gateway_id
    join invoices i on i.id = p.invoice_id
    where p.reviewed_by = ${staffId} and p.purpose = 'topup' and p.status = 'approved' and p.reviewed_at > ${since}
      and g.is_manual and i.kind = 'topup'`);
  return Money.of(result.rows[0]?.total ?? '0');
}
