// Drizzle queries of the store balance of an account (feature 21, plan § 5.6.1 and § 5.6.3, decision 064): the wallet account row and its
// freeze state, the aggregates of the account's store top-ups (pending and trailing 24 hours), open top-up disputes, and the staff list of
// store wallets. The owner of every wallet row is `('account', id)`.
import { type SQL, and, asc, desc, eq, gte, ilike, inArray, lte, ne, or, sql } from 'drizzle-orm';
import type { ParsedListQuery } from '../../../common/contract';
import { type DbExecutor, schema as s } from '../../../infra/db';
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

/** The store wallet of an account as the use cases read it. */
export interface CustomerWalletRow {
  readonly id: number;
  /** The account that owns the wallet. */
  readonly ownerId: number;
  /** The owner's side (positive is the account's money). */
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

const walletOf = (accountId: number) =>
  and(
    eq(ledgerAccounts.kind, 'customer_wallet'),
    eq(ledgerAccounts.ownerType, 'account'),
    eq(ledgerAccounts.ownerId, accountId),
    eq(ledgerAccounts.currency, BASE_CURRENCY),
  );

/**
 * Reads the store wallet of an account.
 *
 * Why: plan 21 § 5.3: the wallet is opened by its first posting or freeze, so reads answer zeros while it does not exist. Balances are
 * never cached (decision 022). The row is the `customer_wallet` ledger account owned by `('account', accountId)`: at most one per account
 * (`ledger_accounts_identity_uq`), whatever the account's rank is now.
 *
 * @param db the database or a transaction
 * @param accountId the account
 * @param lock lock the row `FOR UPDATE` (only the freeze use cases, which post nothing afterwards: plan § 5.7)
 * @returns the ledger account, or `undefined` while it does not exist
 */
export async function readCustomerWallet(
  db: DbExecutor,
  accountId: number,
  lock = false,
): Promise<CustomerWalletRow | undefined> {
  const query = db.select(walletColumns).from(ledgerAccounts).where(walletOf(accountId)).limit(1);
  const [row] = await (lock ? query.for('update') : query);
  return row;
}

/**
 * Opens the store wallet of an account when it does not exist, then locks and reads it.
 *
 * Why: a freeze may come before any money (a top-up dispute of a payment never credited; a staff hold): the row must exist to hold
 * the state. `ON CONFLICT DO NOTHING` lets two racing freezes open one account.
 *
 * Side effects: may insert a `ledger_accounts` row; locks it `FOR UPDATE` until the transaction ends.
 *
 * @param tx the transaction
 * @param accountId the account
 * @returns the locked ledger account
 */
export async function ensureLockedCustomerWallet(tx: DbExecutor, accountId: number): Promise<CustomerWalletRow> {
  const found = await readCustomerWallet(tx, accountId, true);
  if (found) return found;
  await openAccounts(tx, [
    { kind: 'customer_wallet', ownerType: 'account', ownerId: accountId, currency: BASE_CURRENCY },
  ]);
  const opened = await readCustomerWallet(tx, accountId, true);
  if (!opened) throw new Error(`The store wallet of account ${accountId} could not be opened.`);
  return opened;
}

/**
 * Sets or clears the freeze of a wallet row the transaction already holds.
 *
 * Side effects: updates `frozen_at`, `frozen_reason`, `version` and `updated_at` of one `ledger_accounts` row.
 *
 * @param tx the transaction that holds the row lock
 * @param ledgerAccountId the id of the wallet's ledger account
 * @param frozen the freeze time and reason, or `null` to clear both
 * @param now the clock's time
 */
export async function writeWalletFreeze(
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

/** SQL: an open customer top-up still counts as unpaid (plan § 5.6.4 e, mirrored by the pure `isLiveTopUp`). */
function liveOpenTopUp(now: Date): SQL {
  const since = new Date(now.getTime() - AUTOMATIC_TOPUP_LIVE_HOURS * 3_600_000);
  return sql`(${invoices.status} = 'open' and (
    ${paymentGateways.isManual}
    or ${invoices.createdAt} > ${since}
    or exists (select 1 from ${payments} p where p.invoice_id = ${invoices.id} and p.status = 'pending')
  ))`;
}

/** The store top-up figures of one account. */
export interface TopUpFigures {
  /** Live unpaid top-ups and the net they would add. */
  readonly pendingCount: number;
  readonly pendingNet: string;
  /** Top-ups of the trailing 24 hours that count against the daily limits (live open or paid). */
  readonly dayCount: number;
  readonly dayAmount: string;
}

/**
 * Reads the account's pending and daily store top-up figures in one statement.
 *
 * Why: plan 21 § 5.6.1 and § 5.6.4 e: the wallet view shows them, and the create use case checks the limits with them under the
 * account's advisory lock `topup:<accountId>`. The 24 hour window takes the clock's time (decision 031). Only top-ups of the store wallet
 * count (`invoices.wallet_kind = 'customer_wallet'`): the eight store settings limit the store balance, not a merchant wallet the account
 * may have had before a rank change.
 *
 * @param db the database or a transaction
 * @param accountId the account
 * @param now the clock's time
 * @returns the figures (zeros when the account has no store top-up)
 */
export async function readTopUpFigures(db: DbExecutor, accountId: number, now: Date): Promise<TopUpFigures> {
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
    .where(
      and(eq(invoices.accountId, accountId), eq(invoices.kind, 'topup'), eq(invoices.walletKind, 'customer_wallet')),
    );
  return row ?? { pendingCount: 0, pendingNet: '0.0000', dayCount: 0, dayAmount: '0.0000' };
}

/**
 * Counts the account's open top-up disputes, of either wallet kind.
 *
 * Why: plan 21 § 5.6.3: staff cannot unfreeze a wallet while a dispute of one of its top-ups is open; the admin view shows the count. A
 * dispute opened on any card top-up of the account freezes the live wallet whatever its kind (decision 064), so every top-up payment of
 * the account counts here, not only the store ones.
 *
 * @param db the database or a transaction
 * @param accountId the account
 * @returns how many top-up disputes are `needs_response` or `under_review`
 */
export async function countOpenTopUpDisputes(db: DbExecutor, accountId: number): Promise<number> {
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

/**
 * Tells whether a top-up payment of the account still waits for staff or the automatic credit.
 *
 * @param db the database or a transaction
 * @param accountId the account
 * @returns true when one is `pending`
 */
export async function hasPendingTopUpPayment(db: DbExecutor, accountId: number): Promise<boolean> {
  const [row] = await db
    .select({ id: payments.id })
    .from(payments)
    .where(and(eq(payments.purpose, 'topup'), eq(payments.accountId, accountId), eq(payments.status, 'pending')))
    .limit(1);
  return row !== undefined;
}

/**
 * Reads the orders the account paid from the store balance whose payment can still give money back.
 *
 * Why: O12 and risk K11: a refund of such an order goes back to the balance (plan 21 § 5.6.7), so the anonymize guard asks the orders
 * module which of them are still open. A payment that was refunded in full has nothing left to give back.
 *
 * @param db the database or a transaction
 * @param accountId the account
 * @returns the order ids, in id order
 */
export async function balancePaidOrderIds(db: DbExecutor, accountId: number): Promise<number[]> {
  const rows = await db
    .selectDistinct({ orderId: payments.orderId })
    .from(payments)
    .where(
      and(
        eq(payments.purpose, 'order'),
        eq(payments.methodType, 'balance'),
        eq(payments.accountId, accountId),
        inArray(payments.status, ['captured', 'partial_refund']),
      ),
    )
    .orderBy(asc(payments.orderId));
  return rows.flatMap((row) => (row.orderId === null ? [] : [row.orderId]));
}

/**
 * Finds a refund to the store balance of the account that is still open.
 *
 * Why: O12 and risk K11: a `requested` or `processing` refund of a balance payment can still post to the balance, so the account is
 * not anonymized before staff approve or decline it.
 *
 * @param db the database or a transaction
 * @param accountId the account
 * @returns the id of the oldest such refund, or `undefined` when there is none
 */
export async function openBalanceRefundId(db: DbExecutor, accountId: number): Promise<number | undefined> {
  const [row] = await db
    .select({ id: refunds.id })
    .from(refunds)
    .innerJoin(payments, eq(payments.id, refunds.paymentId))
    .where(
      and(
        eq(payments.methodType, 'balance'),
        eq(payments.accountId, accountId),
        inArray(refunds.status, ['requested', 'processing']),
      ),
    )
    .orderBy(asc(refunds.id))
    .limit(1);
  return row?.id;
}

/** One wallet-kind ledger account of an account, locked for the erasure check. */
export interface OwnedWalletRow {
  readonly id: number;
  /** `client_wallet`, `client_hold` or `customer_wallet`. */
  readonly kind: string;
  /** In the account's normal sign. */
  readonly balance: string;
  readonly frozenAt: Date | null;
}

/**
 * Locks every wallet-kind ledger account of an account, in id order, and reads it.
 *
 * Why: decision 064: the erasure of an account looks at both wallet kinds and the hold (the inactive kind may linger at zero after a
 * rank change), and money rows are locked in id order (decision 024), after every other row of the erasure (plan 21 § 5.7).
 *
 * Side effects: locks the rows `FOR UPDATE` until the transaction ends.
 *
 * @param tx the erasure's transaction
 * @param accountId the account
 * @returns the wallet, hold and store wallet rows the account has (none for an account that never had money)
 */
export async function lockWalletsOf(tx: DbExecutor, accountId: number): Promise<OwnedWalletRow[]> {
  return tx
    .select({
      id: ledgerAccounts.id,
      kind: ledgerAccounts.kind,
      balance: ledgerAccounts.balance,
      frozenAt: ledgerAccounts.frozenAt,
    })
    .from(ledgerAccounts)
    .where(
      and(
        eq(ledgerAccounts.ownerType, 'account'),
        eq(ledgerAccounts.ownerId, accountId),
        inArray(ledgerAccounts.kind, ['client_wallet', 'client_hold', 'customer_wallet']),
      ),
    )
    .orderBy(asc(ledgerAccounts.id))
    .for('update');
}

/**
 * Voids the account's open top-ups that have no payment, of either wallet kind.
 *
 * Why: plan 21 § 5.6.10: anonymizing an account closes the top-ups nobody can pay any more.
 *
 * Side effects: updates `invoices.status` to `void` and clears their `idempotency_key`.
 *
 * @param tx the transaction
 * @param accountId the account
 * @param now the clock's time
 * @returns how many were voided
 */
export async function voidUnpaidTopUps(tx: DbExecutor, accountId: number, now: Date): Promise<number> {
  const rows = await tx
    .update(invoices)
    .set({ status: 'void', idempotencyKey: null, updatedAt: now })
    .where(
      and(
        eq(invoices.accountId, accountId),
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
 * The one stored rank kind that gives merchant rights; every other kind is a retail rank.
 *
 * Why: the same rule as `rankKindOf` of the identity module (decision 064: only `b2b` is a merchant, so an unknown kind fails closed to
 * retail). The list reads the stored kind in SQL, where the function cannot be called.
 */
const MERCHANT_GROUP_KIND = 'b2b';

/** A store wallet of the staff list, with the account that owns it. */
export interface StoreWalletListRow extends CustomerWalletRow {
  /** The owner's name. */
  readonly name: string;
  /** The owner's address (masked by the caller's use case, decision 047). */
  readonly email: string;
  /** The owner's status: `active`, `suspended`, `blocked` or `anonymized`. */
  readonly status: string;
}

/** A text search of the staff list: a `LIKE` pattern over the owner's name and, for a caller who may read accounts, address. */
export interface WalletListSearch {
  /** The escaped pattern with its wildcards. */
  readonly pattern: string;
  /** Whether the address is searched too (decision 047). */
  readonly matchEmail: boolean;
}

/**
 * Lists the store wallets of accounts for staff.
 *
 * Why: plan 21 § 5.6.1, risk K11 and decision 064: `GET /admin/customer-wallets` lists the live store wallets of accounts: a `customer_wallet`
 * is live when its owner's rank is not a merchant rank, so the zero wallet a merchant keeps from before a rank change is not listed. The
 * state filter, the `balance` and `updatedAt` sorts and the search over the owner's name (and address) run in one statement with an exact
 * count.
 *
 * @param db the database or a transaction
 * @param query the parsed list request (`state` filter, `balance`/`updatedAt` sorts, the range)
 * @param search the text search, or `undefined` without one
 * @returns the page and the total
 */
export async function listCustomerWallets(
  db: DbExecutor,
  query: ParsedListQuery<'balance' | 'updatedAt'>,
  search: WalletListSearch | undefined,
): Promise<{ rows: StoreWalletListRow[]; total: number }> {
  const states = query.filters
    .filter((filter) => filter.field === 'state')
    .flatMap((filter) => filter.values.map((value) => STATE_CONDITION[value as WalletState]));
  const where = and(
    eq(ledgerAccounts.kind, 'customer_wallet'),
    eq(ledgerAccounts.ownerType, 'account'),
    ne(s.clientGroups.kind, MERCHANT_GROUP_KIND),
    states.length === 0 ? undefined : or(...states),
    search === undefined
      ? undefined
      : search.matchEmail
        ? or(ilike(s.clients.name, search.pattern), ilike(s.clients.email, search.pattern))
        : ilike(s.clients.name, search.pattern),
  );
  const sort = query.sort[0] ?? { field: 'updatedAt' as const, order: 'desc' as const };
  const direction = sort.order === 'asc' ? asc : desc;
  const [rows, [counted]] = await Promise.all([
    db
      .select({ ...walletColumns, name: s.clients.name, email: s.clients.email, status: s.clients.status })
      .from(ledgerAccounts)
      .innerJoin(s.clients, eq(s.clients.id, ledgerAccounts.ownerId))
      .innerJoin(s.clientGroups, eq(s.clientGroups.id, s.clients.groupId))
      .where(where)
      .orderBy(direction(SORT_COLUMNS[sort.field]), direction(ledgerAccounts.id))
      .limit(query.range.limit)
      .offset(query.range.start),
    db
      .select({ total: sql<number>`count(*)::int` })
      .from(ledgerAccounts)
      .innerJoin(s.clients, eq(s.clients.id, ledgerAccounts.ownerId))
      .innerJoin(s.clientGroups, eq(s.clientGroups.id, s.clients.groupId))
      .where(where),
  ]);
  return { rows, total: counted?.total ?? 0 };
}

/**
 * Reads the balances of several accounts' store wallets (no lock).
 *
 * @param db the database or a transaction
 * @param accountIds the accounts
 * @returns balance (the account's side) by account id; an account without a store wallet has no entry
 */
export async function readCustomerBalances(
  db: DbExecutor,
  accountIds: readonly number[],
): Promise<Map<number, string>> {
  const unique = [...new Set(accountIds)];
  if (unique.length === 0) return new Map();
  const rows = await db
    .select({ ownerId: walletColumns.ownerId, balance: ledgerAccounts.balance })
    .from(ledgerAccounts)
    .where(
      and(
        eq(ledgerAccounts.kind, 'customer_wallet'),
        eq(ledgerAccounts.ownerType, 'account'),
        inArray(ledgerAccounts.ownerId, unique),
      ),
    );
  return new Map(rows.map((row) => [row.ownerId, row.balance]));
}

/** One line of a store wallet statement as stored. */
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
 * Lists the lines of a wallet's ledger account, newest first by default, within an optional posting-time window.
 *
 * Why: plan 21 § 5.6.1: the statement is ordered by the entry id (the posting order) and filtered on `ledger_entries.created_at`, so the
 * index `ledger_entries_account_idx (account_id, id)` serves it; the count is exact.
 *
 * @param db the database or a transaction
 * @param ledgerAccountId the id of the wallet's ledger account
 * @param options the direction, the page and the window (`from` and `to` inclusive)
 * @returns the page and the number of lines in the window
 */
export async function listWalletEntries(
  db: DbExecutor,
  ledgerAccountId: number,
  options: {
    readonly order: 'asc' | 'desc';
    readonly range: { readonly start: number; readonly limit: number };
    readonly from?: Date | undefined;
    readonly to?: Date | undefined;
  },
): Promise<{ rows: WalletEntryRow[]; total: number }> {
  const where = and(
    eq(ledgerEntries.accountId, ledgerAccountId),
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
