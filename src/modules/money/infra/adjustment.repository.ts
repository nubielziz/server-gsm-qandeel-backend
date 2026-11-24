// Reads and writes of the staff wallet actions (money module, decision 049 and 064): what one staff member credited within a window, the
// credit-limit raises and transfer-receipt approvals that are judged the same way, the lock that makes one staff member's requests run one
// after the other, and the rows a freeze, an unfreeze and a credit limit read and change.
import { and, eq, inArray, sql } from 'drizzle-orm';
import { Money } from '../../../common/money';
import type { DbExecutor } from '../../../infra/db';
import { creditLimitRaises, disputes, ledgerAccounts, payments } from '../db/schema';
import { BASE_CURRENCY } from '../domain/accounts';
import type { WalletLedgerKind } from '../domain/wallet-kinds';
import type { WalletPool } from '../domain/wallet-rules';

/** Which wallets an adjustment credits: merchant wallets or store balances (the pool follows the wallet kind, decision 064). */
export type AdjustmentPool = WalletPool;

const WALLET_KIND: Readonly<Record<AdjustmentPool, string>> = {
  merchant: 'client_wallet',
  store: 'customer_wallet',
};

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
 * journal the staff member posted, with the ledger account kind of the pool's wallet; a rank change (`wallet_transfer`) and an order
 * reversal (kind `adjustment`, ref type `order`) are never counted. The reference type is `account` since decision 064, and the old words
 * `client` and `customer` still count : a credit made before the release is part of the same 24 hours. The kind index
 * (`ledger_transactions_kind_idx`) serves the window.
 *
 * @param db the adjustment's transaction
 * @param staffId the staff member
 * @param pool merchant wallets or store balances (the wallet kind of the account)
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
    where lt.kind = 'adjustment' and lt.ref_type in ('account', 'client', 'customer')
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
  const credited = await staffCreditsSince(db, staffId, 'merchant', since);
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

/** A wallet ledger account as the staff actions read it. */
export interface LiveWalletRow {
  readonly id: number;
  /** The balance in the account's own sign (positive is the account's money). */
  readonly balance: string;
  readonly overdraftLimit: string;
  readonly frozenAt: Date | null;
  readonly frozenReason: string;
}

/**
 * Reads the wallet account of an account for one ledger kind.
 *
 * Why: the staff freeze, unfreeze and credit limit work on the live wallet, whose kind they read after the account row lock. Balances
 * and the hold are never cached (decision 022).
 *
 * @param db the database or a transaction
 * @param accountId the account
 * @param kind `client_wallet` or `customer_wallet`
 * @param lock lock the row `FOR UPDATE` until the transaction ends
 * @returns the wallet row, or `undefined` while the account has none of this kind
 */
export async function readWalletRow(
  db: DbExecutor,
  accountId: number,
  kind: WalletLedgerKind,
  lock = false,
): Promise<LiveWalletRow | undefined> {
  const query = db
    .select({
      id: ledgerAccounts.id,
      balance: ledgerAccounts.balance,
      overdraftLimit: ledgerAccounts.overdraftLimit,
      frozenAt: ledgerAccounts.frozenAt,
      frozenReason: ledgerAccounts.frozenReason,
    })
    .from(ledgerAccounts)
    .where(
      and(
        eq(ledgerAccounts.kind, kind),
        eq(ledgerAccounts.ownerType, 'account'),
        eq(ledgerAccounts.ownerId, accountId),
        eq(ledgerAccounts.currency, BASE_CURRENCY),
      ),
    )
    .limit(1);
  const [row] = await (lock ? query.for('update') : query);
  return row;
}

/**
 * Sets or clears the hold of a wallet row the transaction already holds.
 *
 * Side effects: updates `frozen_at`, `frozen_reason`, `version` and `updated_at` of one `ledger_accounts` row.
 *
 * @param tx the transaction that holds the row lock
 * @param ledgerAccountId the wallet account
 * @param frozen the hold time and reason, or `null` to clear both
 * @param now the clock's time
 */
export async function writeWalletHold(
  tx: DbExecutor,
  ledgerAccountId: number,
  frozen: { at: Date; reason: string } | null,
  now: Date,
): Promise<void> {
  await tx
    .update(ledgerAccounts)
    .set({
      frozenAt: frozen?.at ?? null,
      frozenReason: frozen?.reason ?? '',
      version: sql`${ledgerAccounts.version} + 1`,
      updatedAt: now,
    })
    .where(eq(ledgerAccounts.id, ledgerAccountId));
}

/**
 * Counts the open disputes of an account's card top-ups, whatever the kind of its wallet.
 *
 * Why: a top-up dispute opened freezes the live wallet of either kind, and staff cannot lift that hold while the dispute is open.
 *
 * @param db the database or a transaction
 * @param accountId the account
 * @returns how many top-up disputes are `needs_response` or `under_review`
 */
export async function countOpenWalletDisputes(db: DbExecutor, accountId: number): Promise<number> {
  const [row] = await db
    .select({ total: sql<number>`count(*)::int` })
    .from(disputes)
    .innerJoin(payments, eq(payments.id, disputes.paymentId))
    .where(
      and(
        eq(payments.purpose, 'topup'),
        eq(payments.accountId, accountId),
        inArray(disputes.status, ['needs_response', 'under_review']),
      ),
    );
  return row?.total ?? 0;
}
