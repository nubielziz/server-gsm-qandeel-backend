// Drizzle reads of the client statement PDF (route GET /admin/reports/client-statement/:clientId, stage 11): the wallet lines of a
// period (in ledger entry id order) with the balance it opened with, and the merchant's invoices issued in it. Reads only, never cached (decision 022).
import { and, asc, desc, eq, gte, lt } from 'drizzle-orm';
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
 * @param accountId the merchant's `client_wallet` account
 * @param entryId the entry the statement starts with
 * @returns the balance as wire money (merchant side), or zero when the wallet had no earlier line
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
 * @param accountId the merchant's `client_wallet` account
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
 * @param accountId the merchant's `client_wallet` account
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
 * Lists the invoices a merchant was issued in a period, oldest first.
 *
 * Why: like the wallet lines, a statement of the whole history (no explicit `from`) may hold more invoices than the cap; then the
 * newest `limit` invoices are read (and put back oldest first), which is the part of a very long history the statement can hold.
 *
 * @param db the database or a transaction
 * @param clientId the merchant
 * @param start the first instant of the period
 * @param end the first instant after the period
 * @param limit the most invoices to read (a caller with an explicit period asks for one more than it allows, to know there are too many)
 * @param newestFirst `true` to keep the newest `limit` invoices instead of the oldest ones (the result is still oldest first)
 * @returns the invoices of every kind and status, ascending by creation time and id
 */
export async function listInvoicesBetween(
  db: DbExecutor,
  clientId: number,
  start: Date,
  end: Date,
  limit: number,
  newestFirst = false,
): Promise<Invoice[]> {
  const rows = await db
    .select()
    .from(invoices)
    .where(and(eq(invoices.clientId, clientId), gte(invoices.createdAt, start), lt(invoices.createdAt, end)))
    .orderBy(
      ...(newestFirst ? [desc(invoices.createdAt), desc(invoices.id)] : [asc(invoices.createdAt), asc(invoices.id)]),
    )
    .limit(limit);
  return newestFirst ? rows.reverse() : rows;
}
