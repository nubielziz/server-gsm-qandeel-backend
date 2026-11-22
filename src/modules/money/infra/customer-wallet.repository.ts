// Drizzle queries of the customer store balance (feature 21, plan § 5.6.1 and § 5.6.3): the wallet account row and its freeze state, the
// aggregates of the customer's top-ups (pending and trailing 24 hours), open top-up disputes, and the staff list of wallets.
import { type SQL, and, asc, desc, eq, gte, inArray, lte, or, sql } from 'drizzle-orm';
import type { ParsedListQuery } from '../../../common/contract';
import type { DbExecutor } from '../../../infra/db';
import { AUTOMATIC_TOPUP_LIVE_HOURS } from '../domain/customer-wallet-policy';
import {
  disputes,
  invoices,
  ledgerAccounts,
  ledgerEntries,
  ledgerTransactions,
  paymentGateways,
  payments,
  refunds,
} from '../db/schema';
import { BASE_CURRENCY } from '../domain/accounts';
import { openAccounts } from './ledger-accounts.repository';

/** A customer wallet account as the use cases read it. */
export interface CustomerWalletRow {
  readonly id: number;
  readonly ownerId: number;
  /** Customer side (positive is the customer's money). */
  readonly balance: string;
  readonly frozenAt: Date | null;
  readonly frozenReason: string;
  readonly updatedAt: Date;
}

const walletColumns = {
  id: ledgerAccounts.id,
  ownerId: sql<number>`${ledgerAccounts.ownerId}`.mapWith(Number),
  balance: ledgerAccounts.balance,
  frozenAt: ledgerAccounts.frozenAt,
  frozenReason: ledgerAccounts.frozenReason,
  updatedAt: ledgerAccounts.updatedAt,
};

const walletOf = (customerId: number) =>
  and(
    eq(ledgerAccounts.kind, 'customer_wallet'),
    eq(ledgerAccounts.ownerType, 'customer'),
    eq(ledgerAccounts.ownerId, customerId),
    eq(ledgerAccounts.currency, BASE_CURRENCY),
  );

/**
 * Reads a customer's wallet account.
 *
 * Why: plan 21 § 5.3: the wallet is opened by its first posting or freeze, so reads answer zeros while it does not exist. Balances are
 * never cached (decision 022).
 *
 * @param db the database or a transaction
 * @param customerId the customer
 * @param lock lock the row `FOR UPDATE` (only the freeze use cases, which post nothing afterwards: plan § 5.7)
 * @returns the account, or `undefined` while it does not exist
 */
export async function readCustomerWallet(
  db: DbExecutor,
  customerId: number,
  lock = false,
): Promise<CustomerWalletRow | undefined> {
  const query = db.select(walletColumns).from(ledgerAccounts).where(walletOf(customerId)).limit(1);
  const [row] = await (lock ? query.for('update') : query);
  return row;
}

/**
 * Opens a customer's wallet when it does not exist, then locks and reads it.
 *
 * Why: a freeze may come before any money (a top-up dispute of a payment never credited; a staff hold): the row must exist to hold
 * the state. `ON CONFLICT DO NOTHING` lets two racing freezes open one account.
 *
 * Side effects: may insert a `ledger_accounts` row; locks it `FOR UPDATE` until the transaction ends.
 *
 * @param tx the transaction
 * @param customerId the customer
 * @returns the locked account
 */
export async function ensureLockedCustomerWallet(tx: DbExecutor, customerId: number): Promise<CustomerWalletRow> {
  const found = await readCustomerWallet(tx, customerId, true);
  if (found) return found;
  await openAccounts(tx, [
    { kind: 'customer_wallet', ownerType: 'customer', ownerId: customerId, currency: BASE_CURRENCY },
  ]);
  const opened = await readCustomerWallet(tx, customerId, true);
  if (!opened) throw new Error(`The wallet of customer ${customerId} could not be opened.`);
  return opened;
}

/**
 * Sets or clears the freeze of a wallet row the transaction already holds.
 *
 * Side effects: updates `frozen_at`, `frozen_reason`, `version` and `updated_at` of one `ledger_accounts` row.
 *
 * @param tx the transaction that holds the row lock
 * @param accountId the wallet account
 * @param frozen the freeze time and reason, or `null` to clear both
 * @param now the clock's time
 */
export async function writeWalletFreeze(
  tx: DbExecutor,
  accountId: number,
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
    .where(eq(ledgerAccounts.id, accountId));
}

/** SQL: an open customer top-up still counts as unpaid (plan § 5.6.4 e, mirrored by the pure `isLiveTopUp`). */
function liveOpenTopUp(now: Date): SQL {
  const since = new Date(now.getTime() - AUTOMATIC_TOPUP_LIVE_HOURS * 3_600_000);
  return sql`(${invoices.status} = 'open' and (
    ${paymentGateways.isManual}
    or ${invoices.createdAt} > ${since}
    or exists (select 1 from ${payments} p where p.invoice_id = ${invoices.id} and p.status = 'pending')
  ))`;
}

/** The top-up figures of one customer. */
export interface TopUpFigures {
  /** Live unpaid top-ups and the net they would add. */
  readonly pendingCount: number;
  readonly pendingNet: string;
  /** Top-ups of the trailing 24 hours that count against the daily limits (live open or paid). */
  readonly dayCount: number;
  readonly dayAmount: string;
}

/**
 * Reads the customer's pending and daily top-up figures in one statement.
 *
 * Why: plan 21 § 5.6.1 and § 5.6.4 e: the wallet view shows them, and the create use case checks the limits with them under the
 * customer's advisory lock. The 24 hour window takes the clock's time (decision 031).
 *
 * @param db the database or a transaction
 * @param customerId the customer
 * @param now the clock's time
 * @returns the figures (zeros when the customer has no top-up)
 */
export async function readTopUpFigures(db: DbExecutor, customerId: number, now: Date): Promise<TopUpFigures> {
  const live = liveOpenTopUp(now);
  const since = new Date(now.getTime() - 24 * 3_600_000);
  const counted = sql`(${live} or ${invoices.status} = 'paid')`;
  const [row] = await db
    .select({
      pendingCount: sql<number>`count(*) filter (where ${live})::int`,
      pendingNet: sql<string>`coalesce(sum(${invoices.netAmount}) filter (where ${live}), 0)::numeric(18,4)::text`,
      dayCount: sql<number>`count(*) filter (where ${invoices.createdAt} > ${since} and ${counted})::int`,
      dayAmount: sql<string>`coalesce(sum(${invoices.amount}) filter (where ${invoices.createdAt} > ${since} and ${counted}), 0)::numeric(18,4)::text`,
    })
    .from(invoices)
    .leftJoin(paymentGateways, eq(paymentGateways.id, invoices.gatewayId))
    .where(and(eq(invoices.customerId, customerId), eq(invoices.kind, 'topup')));
  return row ?? { pendingCount: 0, pendingNet: '0.0000', dayCount: 0, dayAmount: '0.0000' };
}

/**
 * Counts the customer's open top-up disputes.
 *
 * Why: plan 21 § 5.6.3: staff cannot unfreeze a wallet while a dispute of one of its top-ups is open; the admin view shows the count.
 *
 * @param db the database or a transaction
 * @param customerId the customer
 * @returns how many top-up disputes are `needs_response` or `under_review`
 */
export async function countOpenTopUpDisputes(db: DbExecutor, customerId: number): Promise<number> {
  const [row] = await db
    .select({ total: sql<number>`count(*)::int` })
    .from(disputes)
    .innerJoin(payments, eq(payments.id, disputes.paymentId))
    .where(
      and(
        eq(payments.purpose, 'topup'),
        eq(payments.customerId, customerId),
        inArray(disputes.status, ['needs_response', 'under_review']),
      ),
    );
  return row?.total ?? 0;
}

/**
 * Tells whether a top-up payment of the customer still waits for staff or the automatic credit.
 *
 * @param db the database or a transaction
 * @param customerId the customer
 * @returns true when one is `pending`
 */
export async function hasPendingTopUpPayment(db: DbExecutor, customerId: number): Promise<boolean> {
  const [row] = await db
    .select({ id: payments.id })
    .from(payments)
    .where(and(eq(payments.purpose, 'topup'), eq(payments.customerId, customerId), eq(payments.status, 'pending')))
    .limit(1);
  return row !== undefined;
}

/**
 * Reads the orders the customer paid from the store balance whose payment can still give money back.
 *
 * Why: O12 and risk K11: a refund of such an order goes back to the balance (plan 21 § 5.6.7), so the anonymize guard asks the orders
 * module which of them are still open. A payment that was refunded in full has nothing left to give back.
 *
 * @param db the database or a transaction
 * @param customerId the customer
 * @returns the order ids, in id order
 */
export async function balancePaidOrderIds(db: DbExecutor, customerId: number): Promise<number[]> {
  const rows = await db
    .selectDistinct({ orderId: payments.orderId })
    .from(payments)
    .where(
      and(
        eq(payments.purpose, 'order'),
        eq(payments.methodType, 'balance'),
        eq(payments.customerId, customerId),
        inArray(payments.status, ['captured', 'partial_refund']),
      ),
    )
    .orderBy(asc(payments.orderId));
  return rows.flatMap((row) => (row.orderId === null ? [] : [row.orderId]));
}

/**
 * Finds a refund to the store balance of the customer that is still open.
 *
 * Why: O12 and risk K11: a `requested` or `processing` refund of a balance payment can still post to the balance, so the customer is
 * not anonymized before staff approve or decline it.
 *
 * @param db the database or a transaction
 * @param customerId the customer
 * @returns the id of the oldest such refund, or `undefined` when there is none
 */
export async function openBalanceRefundId(db: DbExecutor, customerId: number): Promise<number | undefined> {
  const [row] = await db
    .select({ id: refunds.id })
    .from(refunds)
    .innerJoin(payments, eq(payments.id, refunds.paymentId))
    .where(
      and(
        eq(payments.methodType, 'balance'),
        eq(payments.customerId, customerId),
        inArray(refunds.status, ['requested', 'processing']),
      ),
    )
    .orderBy(asc(refunds.id))
    .limit(1);
  return row?.id;
}

/**
 * Voids the customer's open top-ups that have no payment.
 *
 * Why: plan 21 § 5.6.10: anonymizing a customer closes the top-ups nobody can pay any more.
 *
 * Side effects: updates `invoices.status` to `void` and clears their `idempotency_key`.
 *
 * @param tx the transaction
 * @param customerId the customer
 * @param now the clock's time
 * @returns how many were voided
 */
export async function voidUnpaidTopUps(tx: DbExecutor, customerId: number, now: Date): Promise<number> {
  const rows = await tx
    .update(invoices)
    .set({ status: 'void', idempotencyKey: null, updatedAt: now })
    .where(
      and(
        eq(invoices.customerId, customerId),
        eq(invoices.kind, 'topup'),
        eq(invoices.status, 'open'),
        sql`not exists (select 1 from ${payments} p where p.invoice_id = ${invoices.id})`,
      ),
    )
    .returning({ id: invoices.id });
  return rows.length;
}

/** The state filter of the staff wallet list. */
export type WalletState = 'positive' | 'zero' | 'negative' | 'frozen';

const STATE_CONDITION: Readonly<Record<WalletState, SQL>> = {
  positive: sql`${ledgerAccounts.balance} > 0`,
  zero: sql`${ledgerAccounts.balance} = 0`,
  negative: sql`${ledgerAccounts.balance} < 0`,
  frozen: sql`${ledgerAccounts.frozenAt} is not null`,
};

const SORT_COLUMNS = { balance: ledgerAccounts.balance, updatedAt: ledgerAccounts.updatedAt } as const;

/**
 * Lists customer wallets for staff.
 *
 * Why: plan 21 § 5.6.1 and risk K11: `GET /admin/customer-wallets` lists every wallet with its state filter, sorts by balance or last
 * change, searches through the customers matching the name or email, with an exact count.
 *
 * @param db the database or a transaction
 * @param query the parsed list request (`state` filter, `balance`/`updatedAt` sorts, the range)
 * @param customerIds when searching, the customers that match (`[]` finds nothing); `undefined` without a search
 * @returns the page and the total
 */
export async function listCustomerWallets(
  db: DbExecutor,
  query: ParsedListQuery<'balance' | 'updatedAt'>,
  customerIds: readonly number[] | undefined,
): Promise<{ rows: CustomerWalletRow[]; total: number }> {
  const states = query.filters
    .filter((filter) => filter.field === 'state')
    .flatMap((filter) => filter.values.map((value) => STATE_CONDITION[value as WalletState]));
  const where = and(
    eq(ledgerAccounts.kind, 'customer_wallet'),
    states.length === 0 ? undefined : or(...states),
    customerIds === undefined
      ? undefined
      : customerIds.length === 0
        ? sql`false`
        : inArray(ledgerAccounts.ownerId, [...customerIds]),
  );
  const sort = query.sort[0] ?? { field: 'updatedAt' as const, order: 'desc' as const };
  const direction = sort.order === 'asc' ? asc : desc;
  const [rows, [counted]] = await Promise.all([
    db
      .select(walletColumns)
      .from(ledgerAccounts)
      .where(where)
      .orderBy(direction(SORT_COLUMNS[sort.field]), direction(ledgerAccounts.id))
      .limit(query.range.limit)
      .offset(query.range.start),
    db
      .select({ total: sql<number>`count(*)::int` })
      .from(ledgerAccounts)
      .where(where),
  ]);
  return { rows, total: counted?.total ?? 0 };
}

/**
 * Reads the balances of several customers' wallets (no lock).
 *
 * @param db the database or a transaction
 * @param customerIds the customers
 * @returns balance (customer side) by customer id; a customer without a wallet has no entry
 */
export async function readCustomerBalances(
  db: DbExecutor,
  customerIds: readonly number[],
): Promise<Map<number, string>> {
  const unique = [...new Set(customerIds)];
  if (unique.length === 0) return new Map();
  const rows = await db
    .select({ ownerId: walletColumns.ownerId, balance: ledgerAccounts.balance })
    .from(ledgerAccounts)
    .where(
      and(
        eq(ledgerAccounts.kind, 'customer_wallet'),
        eq(ledgerAccounts.ownerType, 'customer'),
        inArray(ledgerAccounts.ownerId, unique),
      ),
    );
  return new Map(rows.map((row) => [row.ownerId, row.balance]));
}

/** One line of a customer wallet statement as stored. */
export interface WalletEntryRow {
  readonly id: number;
  readonly transactionId: number;
  readonly kind: string;
  readonly memo: string;
  /** Debit positive (a credit to the wallet is negative). */
  readonly amount: string;
  readonly balanceAfter: string;
  readonly refType: string;
  readonly refId: number;
  readonly createdAt: Date;
}

/**
 * Lists the lines of a customer wallet, newest first by default, within an optional posting-time window.
 *
 * Why: plan 21 § 5.6.1: the statement is ordered by the entry id (the posting order) and filtered on `ledger_entries.created_at`, so the
 * index `ledger_entries_account_idx (account_id, id)` serves it; the count is exact.
 *
 * @param db the database or a transaction
 * @param accountId the wallet account
 * @param options the direction, the page and the window (`from` and `to` inclusive)
 * @returns the page and the number of lines in the window
 */
export async function listWalletEntries(
  db: DbExecutor,
  accountId: number,
  options: {
    readonly order: 'asc' | 'desc';
    readonly range: { readonly start: number; readonly limit: number };
    readonly from?: Date | undefined;
    readonly to?: Date | undefined;
  },
): Promise<{ rows: WalletEntryRow[]; total: number }> {
  const where = and(
    eq(ledgerEntries.accountId, accountId),
    options.from === undefined ? undefined : gte(ledgerEntries.createdAt, options.from),
    options.to === undefined ? undefined : lte(ledgerEntries.createdAt, options.to),
  );
  const direction = options.order === 'asc' ? asc : desc;
  // One after the other: `db` may be a transaction (the data export), whose connection runs one query at a time.
  const rows = await db
    .select({
      id: ledgerEntries.id,
      transactionId: ledgerEntries.transactionId,
      kind: ledgerTransactions.kind,
      memo: ledgerTransactions.memo,
      amount: ledgerEntries.amount,
      balanceAfter: ledgerEntries.balanceAfter,
      refType: ledgerTransactions.refType,
      refId: ledgerTransactions.refId,
      createdAt: ledgerEntries.createdAt,
    })
    .from(ledgerEntries)
    .innerJoin(ledgerTransactions, eq(ledgerTransactions.id, ledgerEntries.transactionId))
    .where(where)
    .orderBy(direction(ledgerEntries.id))
    .limit(options.range.limit)
    .offset(options.range.start);
  const [counted] = await db
    .select({ total: sql<number>`count(*)::int` })
    .from(ledgerEntries)
    .where(where);
  return { rows, total: counted?.total ?? 0 };
}
