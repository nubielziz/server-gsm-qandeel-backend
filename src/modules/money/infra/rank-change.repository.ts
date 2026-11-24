// Drizzle queries of the rank change (decision 064): the history table, the ledger accounts of an account's wallets (open them, lock them, clear
// a credit limit) and the reads behind the blockers money owns. Only the rank change use case calls them, always inside its transaction.
import { and, eq, exists, gt, inArray, or, sql } from 'drizzle-orm';
import type { DbExecutor } from '../../../infra/db';
import {
  type AccountRankChange,
  type LedgerAccountKind,
  type NewAccountRankChange,
  accountRankChanges,
  disputes,
  invoices,
  ledgerAccounts,
  paymentGateways,
  payments,
  refunds,
} from '../db/schema';
import { AUTOMATIC_TOPUP_LIVE_HOURS } from '../domain/customer-wallet-policy';

/** The ledger account kinds that make an account's wallets: the merchant wallet and its hold, and the store balance. */
export const WALLET_KINDS = [
  'client_wallet',
  'client_hold',
  'customer_wallet',
] as const satisfies readonly LedgerAccountKind[];

/** One locked wallet row of an account. */
export interface RankWalletRow {
  readonly id: number;
  readonly kind: LedgerAccountKind;
  /** The balance in the account's normal sign (a liability: the account's own money). */
  readonly balance: string;
  readonly overdraftLimit: string;
  readonly frozen: boolean;
}

/**
 * Finds the change a key already made for an account.
 *
 * @param db the transaction (the account row is locked by the caller)
 * @param accountId the account
 * @param idempotencyKey the request's `Idempotency-Key`
 * @returns the stored change, or `undefined` when the key is new for the account
 */
export async function findRankChange(
  db: DbExecutor,
  accountId: number,
  idempotencyKey: string,
): Promise<AccountRankChange | undefined> {
  const [row] = await db
    .select()
    .from(accountRankChanges)
    .where(and(eq(accountRankChanges.accountId, accountId), eq(accountRankChanges.idempotencyKey, idempotencyKey)))
    .limit(1);
  return row;
}

/**
 * Writes the history row of a change.
 *
 * Side effects: inserts one `account_rank_changes` row (append-only).
 *
 * @param db the transaction
 * @param values the row: both ranks' ids, names and kinds, the money moved, the counts and the staff member
 * @returns the stored row
 */
export async function insertRankChange(db: DbExecutor, values: NewAccountRankChange): Promise<AccountRankChange> {
  const [row] = await db.insert(accountRankChanges).values(values).returning();
  return row!;
}

/**
 * Opens ledger accounts of an account that do not exist yet.
 *
 * Why: the rank change locks every wallet of the account before it reads or posts, so the ones the new kind needs must exist first; two
 * racing changes (or a posting that opens the same account) open one row (`ON CONFLICT DO NOTHING`).
 *
 * Side effects: inserts `ledger_accounts` rows owned by `('account', accountId)`.
 *
 * @param db the transaction
 * @param accountId the account
 * @param kinds the wallet kinds to open
 * @param currency the ledger currency
 */
export async function openWalletAccounts(
  db: DbExecutor,
  accountId: number,
  kinds: readonly LedgerAccountKind[],
  currency: string,
): Promise<void> {
  if (kinds.length === 0) return;
  await db
    .insert(ledgerAccounts)
    .values(kinds.map((kind) => ({ kind, ownerType: 'account' as const, ownerId: accountId, currency })))
    .onConflictDoNothing();
}

/**
 * Locks the wallet accounts of an account `FOR UPDATE`, in id order, and reads their figures.
 *
 * Why: decision 064: the rank change takes the account row, then the ledger accounts by id, then `topup:<accountId>`. Every other path that
 * posts to these accounts takes the account row first (a key share), so none can be holding one of them while it waits for the account row.
 *
 * @param db the transaction (the account row is locked by the caller)
 * @param accountId the account
 * @param currency the ledger currency
 * @returns the account's merchant wallet, merchant hold and store balance that exist, ascending by id
 */
export async function lockWalletAccounts(
  db: DbExecutor,
  accountId: number,
  currency: string,
): Promise<RankWalletRow[]> {
  const rows = await db
    .select({
      id: ledgerAccounts.id,
      kind: ledgerAccounts.kind,
      balance: ledgerAccounts.balance,
      overdraftLimit: ledgerAccounts.overdraftLimit,
      frozenAt: ledgerAccounts.frozenAt,
    })
    .from(ledgerAccounts)
    .where(
      and(
        eq(ledgerAccounts.ownerType, 'account'),
        eq(ledgerAccounts.ownerId, accountId),
        inArray(ledgerAccounts.kind, [...WALLET_KINDS]),
        eq(ledgerAccounts.currency, currency),
      ),
    )
    .orderBy(ledgerAccounts.id)
    .for('update');
  return rows.map((row) => ({
    id: row.id,
    kind: row.kind,
    balance: row.balance,
    overdraftLimit: row.overdraftLimit,
    frozen: row.frozenAt !== null,
  }));
}

/**
 * Reads the credit limit of an account's merchant wallet without locking it.
 *
 * Why: a rank change inside the merchant kind needs only the limit; every writer of the limit takes the account row first, which the caller
 * holds `FOR UPDATE`, so the value cannot change under it.
 *
 * @param db the transaction
 * @param accountId the account
 * @param currency the ledger currency
 * @returns the limit as the database prints it (`'0.0000'` when the account has no merchant wallet)
 */
export async function readCreditLimit(db: DbExecutor, accountId: number, currency: string): Promise<string> {
  const [row] = await db
    .select({ limit: ledgerAccounts.overdraftLimit })
    .from(ledgerAccounts)
    .where(
      and(
        eq(ledgerAccounts.kind, 'client_wallet'),
        eq(ledgerAccounts.ownerType, 'account'),
        eq(ledgerAccounts.ownerId, accountId),
        eq(ledgerAccounts.currency, currency),
      ),
    );
  return row?.limit ?? '0.0000';
}

/**
 * Sets the credit limit of a locked merchant wallet to zero.
 *
 * Why: a store balance never has credit, so leaving the merchant kind drops the limit. A lowering records nothing in `credit_limit_raises`.
 *
 * Side effects: updates `overdraft_limit`, `version` and `updated_at` of one `ledger_accounts` row.
 *
 * @param db the transaction that holds the row lock
 * @param ledgerAccountId the merchant wallet's ledger account
 * @param now the clock's time
 */
export async function clearCreditLimit(db: DbExecutor, ledgerAccountId: number, now: Date): Promise<void> {
  await db
    .update(ledgerAccounts)
    .set({ overdraftLimit: '0', version: sql`${ledgerAccounts.version} + 1`, updatedAt: now })
    .where(eq(ledgerAccounts.id, ledgerAccountId));
}

/**
 * Tells whether a top-up of the account is still open.
 *
 * Why: the `open_topup` blocker (decision 064): an open top-up or manual invoice still counts when its gateway is manual (staff review it, it
 * never expires), it is a manual invoice, a payment of it waits, or an automatic one is younger than the live window (the same rule as the
 * top-up limits' `isLiveTopUp`); an older automatic page nobody paid does not block. Any top-up payment that is pending blocks too.
 *
 * @param db the transaction
 * @param accountId the account
 * @param now the clock's time
 * @returns true when a live top-up exists
 */
export async function hasOpenTopUp(db: DbExecutor, accountId: number, now: Date): Promise<boolean> {
  const since = new Date(now.getTime() - AUTOMATIC_TOPUP_LIVE_HOURS * 3_600_000);
  const [invoice] = await db
    .select({ id: invoices.id })
    .from(invoices)
    .leftJoin(paymentGateways, eq(paymentGateways.id, invoices.gatewayId))
    .where(
      and(
        eq(invoices.accountId, accountId),
        inArray(invoices.kind, ['topup', 'manual']),
        eq(invoices.status, 'open'),
        or(
          eq(invoices.kind, 'manual'),
          eq(paymentGateways.isManual, true),
          gt(invoices.createdAt, since),
          exists(
            db
              .select({ one: sql`1` })
              .from(payments)
              .where(and(eq(payments.invoiceId, invoices.id), eq(payments.status, 'pending'))),
          ),
        ),
      ),
    )
    .limit(1);
  if (invoice) return true;
  const [pending] = await db
    .select({ id: payments.id })
    .from(payments)
    .where(and(eq(payments.accountId, accountId), eq(payments.purpose, 'topup'), eq(payments.status, 'pending')))
    .limit(1);
  return pending !== undefined;
}

/**
 * Tells whether a dispute of one of the account's top-up payments is still open.
 *
 * @param db the transaction
 * @param accountId the account
 * @returns true when a dispute of a top-up payment needs a response or is under review
 */
export async function hasOpenTopUpDispute(db: DbExecutor, accountId: number): Promise<boolean> {
  const [row] = await db
    .select({ id: disputes.id })
    .from(disputes)
    .innerJoin(payments, eq(payments.id, disputes.paymentId))
    .where(
      and(
        eq(disputes.accountId, accountId),
        eq(payments.purpose, 'topup'),
        inArray(disputes.status, ['needs_response', 'under_review']),
      ),
    )
    .limit(1);
  return row !== undefined;
}

/**
 * Tells whether a refund to the account's store balance is still requested or processing.
 *
 * Why: such a refund can still post to the balance; the change waits until staff approve or decline it.
 *
 * @param db the transaction
 * @param accountId the account
 * @returns true when a refund of a payment made from the store balance is open
 */
export async function hasOpenBalanceRefund(db: DbExecutor, accountId: number): Promise<boolean> {
  const [row] = await db
    .select({ id: refunds.id })
    .from(refunds)
    .innerJoin(payments, eq(payments.id, refunds.paymentId))
    .where(
      and(
        eq(refunds.accountId, accountId),
        eq(payments.methodType, 'balance'),
        inArray(refunds.status, ['requested', 'processing']),
      ),
    )
    .limit(1);
  return row !== undefined;
}
