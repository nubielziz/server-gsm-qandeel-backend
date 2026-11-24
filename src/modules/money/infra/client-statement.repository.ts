// Drizzle reads of the account statements (decision 064): the PDF of the live wallet (route GET /admin/reports/client-statement/:clientId,
// stage 11) with the wallet lines of a period (in ledger entry id order), the balance it opened with and the invoices issued in it, and the
// page of wallet lines of either kind that `GET /admin/clients/:id/statement` lists. Reads only, never cached (decision 022).
import { and, asc, desc, eq, gte, isNull, lt, lte, or, sql } from 'drizzle-orm';
import type { DbExecutor } from '../../../infra/db';
import { type Invoice, invoices, ledgerEntries, ledgerTransactions } from '../db/schema';
import { STATEMENT_LINE_COLUMNS, type StatementEntryRow } from './ledger-read.repository';

/**
 * Reads the wallet balance right before one line.
 *
 * Why: `balance_after` follows the entry id (the ledger writer numbers entries in the order it applies them), so the balance before a
 * line is the `balance_after` of the entry with the next lower id on the wallet, whatever clock time the postings carry. This is
 * the opening balance of a statement that starts with that line.
 *
 * @param db the database or a transaction
 * @param accountId the wallet's ledger account (`client_wallet` or `customer_wallet`)
 * @param entryId the entry the statement starts with
 * @returns the balance as wire money (the account's side), or zero when the wallet had no earlier line
 */
export async function walletBalanceBeforeEntry(db: DbExecutor, accountId: number, entryId: number): Promise<string> {
  const [row] = await db
    .select({ balanceAfter: ledgerEntries.balanceAfter })
    .from(ledgerEntries)
    .where(and(eq(ledgerEntries.accountId, accountId), lt(ledgerEntries.id, entryId)))
    .orderBy(desc(ledgerEntries.id))
    .limit(1);
  return row?.balanceAfter ?? '0.0000';
}

/**
 * Reads the wallet balance as it was before a moment.
 *
 * Why: the opening balance of a period that holds no line has no first line to look before, so it is the `balance_after` of the last
 * line (by entry id, the order the balance follows) made before the period starts.
 *
 * @param db the database or a transaction
 * @param accountId the wallet's ledger account (`client_wallet` or `customer_wallet`)
 * @param before the first instant of the period
 * @returns the balance as wire money, or zero when the wallet had no line yet
 */
export async function walletBalanceBeforeMoment(db: DbExecutor, accountId: number, before: Date): Promise<string> {
  const [row] = await db
    .select({ balanceAfter: ledgerEntries.balanceAfter })
    .from(ledgerEntries)
    .innerJoin(ledgerTransactions, eq(ledgerTransactions.id, ledgerEntries.transactionId))
    .where(and(eq(ledgerEntries.accountId, accountId), lt(ledgerTransactions.createdAt, before)))
    .orderBy(desc(ledgerEntries.id))
    .limit(1);
  return row?.balanceAfter ?? '0.0000';
}

/**
 * Lists the wallet lines of a period, in entry id order (oldest first).
 *
 * Why: the lines are shown in the order `balance_after` follows, so the last line's balance is the wallet's balance. With a `start`
 * the first `limit` lines of the period are read; without one (a statement of the whole history) the newest `limit` lines before
 * `end` are read, which is the part of a very long history the statement can hold.
 *
 * @param db the database or a transaction
 * @param accountId the wallet's ledger account (`client_wallet` or `customer_wallet`)
 * @param start the first instant of the period, or `undefined` for no lower bound
 * @param end the first instant after the period
 * @param limit the most lines to read (a caller with an explicit period asks for one more than it allows, to know there are too many)
 * @returns the lines, ascending by entry id
 */
export async function listWalletLinesBetween(
  db: DbExecutor,
  accountId: number,
  start: Date | undefined,
  end: Date,
  limit: number,
): Promise<StatementEntryRow[]> {
  const rows = await db
    .select(STATEMENT_LINE_COLUMNS)
    .from(ledgerEntries)
    .innerJoin(ledgerTransactions, eq(ledgerTransactions.id, ledgerEntries.transactionId))
    .where(
      and(
        eq(ledgerEntries.accountId, accountId),
        start === undefined ? undefined : gte(ledgerTransactions.createdAt, start),
        lt(ledgerTransactions.createdAt, end),
      ),
    )
    .orderBy(start === undefined ? desc(ledgerEntries.id) : asc(ledgerEntries.id))
    .limit(limit);
  return start === undefined ? rows.reverse() : rows;
}

/**
 * Lists the invoices an account was issued in a period, oldest first.
 *
 * Why: like the wallet lines, a statement of the whole history (no explicit `from`) may hold more invoices than the cap; then the
 * newest `limit` invoices are read (and put back oldest first), which is the part of a very long history the statement can hold. The
 * statement is of one wallet: the store balance's invoices are the top-ups that fill it (`wallet_kind` `customer_wallet`); every other
 * invoice of the account (a manual invoice, a merchant top-up, a statement) belongs to the merchant wallet.
 *
 * @param db the database or a transaction
 * @param accountId the account
 * @param wallet the wallet the statement is of
 * @param start the first instant of the period
 * @param end the first instant after the period
 * @param limit the most invoices to read (a caller with an explicit period asks for one more than it allows, to know there are too many)
 * @param newestFirst `true` to keep the newest `limit` invoices instead of the oldest ones (the result is still oldest first)
 * @returns the invoices of every kind and status, ascending by creation time and id
 */
export async function listInvoicesBetween(
  db: DbExecutor,
  accountId: number,
  wallet: 'merchant' | 'store',
  start: Date,
  end: Date,
  limit: number,
  newestFirst = false,
): Promise<Invoice[]> {
  const rows = await db
    .select()
    .from(invoices)
    .where(
      and(
        eq(invoices.accountId, accountId),
        wallet === 'store'
          ? eq(invoices.walletKind, 'customer_wallet')
          : or(isNull(invoices.walletKind), eq(invoices.walletKind, 'client_wallet')),
        gte(invoices.createdAt, start),
        lt(invoices.createdAt, end),
      ),
    )
    .orderBy(
      ...(newestFirst ? [desc(invoices.createdAt), desc(invoices.id)] : [asc(invoices.createdAt), asc(invoices.id)]),
    )
    .limit(limit);
  return newestFirst ? rows.reverse() : rows;
}

/** Reads the order column of a statement line: a number, or `null` when the journal is not about an order. */
const orderIdOf = (value: unknown): number | null => (value === null ? null : Number(value));

/** The order a journal is about: its reference when that is an order, else `null`. */
const ORDER_OF_LINE =
  sql`case when ${ledgerTransactions.refType} = 'order' then ${ledgerTransactions.refId} else null end`.mapWith(
    orderIdOf,
  );

/** One line of an account's wallet statement as the staff page shows it: the stored line and the order it is about, when it is one. */
export interface WalletStatementRow {
  readonly id: number;
  readonly transactionId: number;
  readonly kind: string;
  readonly memo: string;
  /** Signed, debit positive (a credit to the wallet is negative). */
  readonly amount: string;
  /** The wallet balance after the line, in the account's own sign. */
  readonly balanceAfter: string;
  /** The order the line is about, or `null`. */
  readonly orderId: number | null;
  readonly createdAt: Date;
}

/**
 * Lists the lines of one wallet account for the staff statement page, newest first by default, within an optional posting-time window.
 *
 * Why: one page for both wallet kinds. Lines are ordered by the entry id (the posting order, the order `balance_after` follows) and the
 * window filters `ledger_entries.created_at`, so the index `ledger_entries_account_idx (account_id, id)` serves it; the count is exact. The
 * order a line is about is its journal's reference when that is an order.
 *
 * @param db the database or a transaction
 * @param ledgerAccountId the wallet account (`client_wallet` or `customer_wallet`)
 * @param options the direction, the page and the window (`from` and `to` inclusive)
 * @returns the page and the number of lines in the window
 */
export async function listWalletStatement(
  db: DbExecutor,
  ledgerAccountId: number,
  options: {
    readonly order: 'asc' | 'desc';
    readonly range: { readonly start: number; readonly limit: number };
    readonly from?: Date | undefined;
    readonly to?: Date | undefined;
  },
): Promise<{ rows: WalletStatementRow[]; total: number }> {
  const where = and(
    eq(ledgerEntries.accountId, ledgerAccountId),
    options.from === undefined ? undefined : gte(ledgerEntries.createdAt, options.from),
    options.to === undefined ? undefined : lte(ledgerEntries.createdAt, options.to),
  );
  const direction = options.order === 'asc' ? asc : desc;
  // One after the other: `db` may be a transaction, whose connection runs one query at a time.
  const rows = await db
    .select({
      id: ledgerEntries.id,
      transactionId: ledgerEntries.transactionId,
      kind: ledgerTransactions.kind,
      memo: ledgerTransactions.memo,
      amount: ledgerEntries.amount,
      balanceAfter: ledgerEntries.balanceAfter,
      orderId: ORDER_OF_LINE,
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
