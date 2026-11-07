// Drizzle read queries of the ledger: the journal list with its lines, one journal, a merchant's wallet statement, the trial
// balance and the reconcile comparison. Reads only; the writer is application/post-transaction.ts. Never cached (decision 022).
import {
  type SQL,
  and,
  asc,
  desc,
  eq,
  exists,
  gt,
  gte,
  ilike,
  inArray,
  lt,
  lte,
  ne,
  notInArray,
  or,
  sql,
} from 'drizzle-orm';
import type { AnyPgColumn } from 'drizzle-orm/pg-core';
import type { FilterValue, ParsedFilter, ParsedListQuery } from '../../../common/contract';
import type { DbExecutor } from '../../../infra/db';
import {
  type LedgerAccountKind,
  type LedgerActorType,
  type LedgerOwnerType,
  type LedgerRefType,
  ledgerAccounts,
  ledgerEntries,
  ledgerTransactions,
} from '../db/schema';
import { CREDIT_NORMAL_KINDS } from '../domain/accounts';
import { type WireRefType, storedRefTypesOf } from '../domain/ref-types';
import { type OwnerMatches } from './foreign-directory.repository';

/** The sort fields of the journal list. */
export type LedgerSortField = 'createdAt' | 'id' | 'kind';

/** What the journal list filters on, already parsed: the search is split into what SQL needs. */
export interface LedgerListSearch {
  /** A numeric `q`: matches `id` or `ref_id`. */
  readonly id?: number;
  /** A text `q`, escaped for `LIKE`, with the owners whose names match it. */
  readonly text?: { readonly pattern: string; readonly owners: OwnerMatches };
}

/** A journal header with its lines, as stored (money in each account's normal sign). */
export interface JournalRow {
  readonly id: number;
  readonly kind: string;
  readonly refType: LedgerRefType;
  readonly refId: number;
  readonly memo: string;
  readonly createdAt: Date;
  readonly createdByType: LedgerActorType;
  readonly createdById: number | null;
  readonly entries: readonly JournalEntryRow[];
}

/** One line of a journal with its account. */
export interface JournalEntryRow {
  readonly id: number;
  /** Signed, debit positive. */
  readonly amount: string;
  /** The account balance after the line, in the account's normal sign. */
  readonly balanceAfter: string;
  readonly account: {
    readonly id: number;
    readonly kind: LedgerAccountKind;
    readonly ownerType: LedgerOwnerType | null;
    readonly ownerId: number | null;
  };
}

const SORT_COLUMNS: Readonly<Record<LedgerSortField, AnyPgColumn>> = {
  createdAt: ledgerTransactions.createdAt,
  id: ledgerTransactions.id,
  kind: ledgerTransactions.kind,
};

/** Applies one parsed filter operator to a column. */
function compare(column: AnyPgColumn, op: ParsedFilter['op'], values: readonly FilterValue[]): SQL | undefined {
  const [first] = values;
  switch (op) {
    case 'eq':
      return values.length > 1 ? inArray(column, [...values]) : eq(column, first!);
    case 'ne':
      return values.length > 1 ? notInArray(column, [...values]) : ne(column, first!);
    case 'gte':
      return gte(column, first!);
    case 'lte':
      return lte(column, first!);
    case 'gt':
      return gt(column, first!);
    case 'lt':
      return lt(column, first!);
    case 'like':
      return undefined;
  }
}

/** True when a transaction has a line on an account that satisfies `condition`. */
function hasLine(condition: SQL | undefined): SQL {
  return exists(
    sql`(select 1 from ${ledgerEntries} inner join ${ledgerAccounts} on ${ledgerAccounts.id} = ${ledgerEntries.accountId}
      where ${ledgerEntries.transactionId} = ${ledgerTransactions.id} and ${condition ?? sql`true`})`,
  );
}

function filterCondition(filter: ParsedFilter): SQL | undefined {
  switch (filter.field) {
    case 'refType': {
      // Resolution money-1: the wire word `system` stands for stored `system` and `client`.
      const stored = [...new Set(filter.values.flatMap((value) => storedRefTypesOf(value as WireRefType)))];
      return filter.op === 'ne'
        ? notInArray(ledgerTransactions.refType, stored)
        : inArray(ledgerTransactions.refType, stored);
    }
    case 'refId':
      return compare(ledgerTransactions.refId, filter.op, filter.values);
    case 'kind':
      return compare(ledgerTransactions.kind, filter.op, filter.values);
    case 'accountKind':
      return hasLine(compare(ledgerAccounts.kind, filter.op, filter.values));
    default:
      throw new Error(`The ledger list has no filter "${filter.field}".`);
  }
}

function searchCondition(search: LedgerListSearch | undefined): SQL | undefined {
  if (!search) return undefined;
  if (search.id !== undefined) {
    return or(eq(ledgerTransactions.id, search.id), eq(ledgerTransactions.refId, search.id));
  }
  const { pattern, owners } = search.text!;
  const ownerMatches = (type: LedgerOwnerType, ids: readonly number[]) =>
    ids.length > 0 ? and(eq(ledgerAccounts.ownerType, type), inArray(ledgerAccounts.ownerId, [...ids])) : undefined;
  const onOwners = or(
    ownerMatches('client', owners.client),
    ownerMatches('supplier', owners.supplier),
    ownerMatches('customer', owners.customer),
  );
  return or(
    ilike(ledgerTransactions.memo, pattern),
    ilike(ledgerTransactions.kind, pattern),
    onOwners ? hasLine(onOwners) : undefined,
  );
}

function whereOf(query: ParsedListQuery<LedgerSortField>, search: LedgerListSearch | undefined): SQL | undefined {
  return and(...query.filters.map(filterCondition), searchCondition(search));
}

/**
 * Lists journals with their lines.
 *
 * Why: `GET /admin/ledger/transactions`: filters, sort and range are SQL; the count is exact; the lines of the page are
 * loaded with one query (no N+1).
 *
 * @param db the database or a transaction
 * @param query the parsed list request
 * @param search the search, split into an id or a text with the owners whose names match
 * @returns the page of journals and the number of journals matching the filters
 */
export async function listJournals(
  db: DbExecutor,
  query: ParsedListQuery<LedgerSortField>,
  search: LedgerListSearch | undefined,
): Promise<{ rows: JournalRow[]; total: number }> {
  const where = whereOf(query, search);
  const lastOrder = query.sort[query.sort.length - 1]?.order ?? 'desc';
  const order = [
    ...query.sort.map((sort) => (sort.order === 'asc' ? asc : desc)(SORT_COLUMNS[sort.field])),
    // The primary key breaks ties so a page never repeats or skips a row.
    (lastOrder === 'asc' ? asc : desc)(ledgerTransactions.id),
  ];
  const [headers, [counted]] = await Promise.all([
    db
      .select({
        id: ledgerTransactions.id,
        kind: ledgerTransactions.kind,
        refType: ledgerTransactions.refType,
        refId: ledgerTransactions.refId,
        memo: ledgerTransactions.memo,
        createdAt: ledgerTransactions.createdAt,
        createdByType: ledgerTransactions.createdByType,
        createdById: ledgerTransactions.createdById,
      })
      .from(ledgerTransactions)
      .where(where)
      .orderBy(...order)
      .limit(query.range.limit)
      .offset(query.range.start),
    db
      .select({ total: sql<number>`count(*)::int` })
      .from(ledgerTransactions)
      .where(where),
  ]);
  return { rows: await withEntries(db, headers), total: counted?.total ?? 0 };
}

/**
 * Reads one journal with its lines.
 *
 * @param db the database or a transaction
 * @param id the `ledger_transactions.id`
 * @returns the journal, or `undefined` when there is none
 */
export async function findJournal(db: DbExecutor, id: number): Promise<JournalRow | undefined> {
  const headers = await db
    .select({
      id: ledgerTransactions.id,
      kind: ledgerTransactions.kind,
      refType: ledgerTransactions.refType,
      refId: ledgerTransactions.refId,
      memo: ledgerTransactions.memo,
      createdAt: ledgerTransactions.createdAt,
      createdByType: ledgerTransactions.createdByType,
      createdById: ledgerTransactions.createdById,
    })
    .from(ledgerTransactions)
    .where(eq(ledgerTransactions.id, id))
    .limit(1);
  return (await withEntries(db, headers))[0];
}

type Header = Omit<JournalRow, 'entries'>;

async function withEntries(db: DbExecutor, headers: readonly Header[]): Promise<JournalRow[]> {
  if (headers.length === 0) return [];
  const lines = await db
    .select({
      transactionId: ledgerEntries.transactionId,
      id: ledgerEntries.id,
      amount: ledgerEntries.amount,
      balanceAfter: ledgerEntries.balanceAfter,
      accountId: ledgerAccounts.id,
      kind: ledgerAccounts.kind,
      ownerType: ledgerAccounts.ownerType,
      ownerId: ledgerAccounts.ownerId,
    })
    .from(ledgerEntries)
    .innerJoin(ledgerAccounts, eq(ledgerAccounts.id, ledgerEntries.accountId))
    .where(
      inArray(
        ledgerEntries.transactionId,
        headers.map((header) => header.id),
      ),
    )
    .orderBy(asc(ledgerEntries.id));
  const byTransaction = new Map<number, JournalEntryRow[]>();
  for (const line of lines) {
    const entry: JournalEntryRow = {
      id: line.id,
      amount: line.amount,
      balanceAfter: line.balanceAfter,
      account: { id: line.accountId, kind: line.kind, ownerType: line.ownerType, ownerId: line.ownerId },
    };
    const list = byTransaction.get(line.transactionId);
    if (list) list.push(entry);
    else byTransaction.set(line.transactionId, [entry]);
  }
  return headers.map((header) => ({ ...header, entries: byTransaction.get(header.id) ?? [] }));
}

/** One line of a merchant's statement as stored. */
export interface StatementEntryRow {
  readonly id: number;
  readonly transactionId: number;
  readonly kind: string;
  readonly memo: string;
  /** Signed, debit positive (the wallet is credit-normal, so a deposit is negative here). */
  readonly amount: string;
  /** The wallet balance after the line, merchant side (positive is the merchant's money). */
  readonly balanceAfter: string;
  readonly createdAt: Date;
}

/**
 * Lists the lines of one account, newest first by default.
 *
 * Why: the merchant statement is the entries on the merchant's `client_wallet`; `order_settle` lines move `client_hold`
 * and never appear (money.md).
 *
 * @param db the database or a transaction
 * @param accountId the wallet account
 * @param order the direction of `createdAt` (the entry id breaks ties the same way)
 * @param range `start` and `limit` of the page
 * @returns the page and the number of lines on the account
 */
export async function listAccountEntries(
  db: DbExecutor,
  accountId: number,
  order: 'asc' | 'desc',
  range: { readonly start: number; readonly limit: number },
): Promise<{ rows: StatementEntryRow[]; total: number }> {
  const direction = order === 'asc' ? asc : desc;
  const [rows, [counted]] = await Promise.all([
    db
      .select({
        id: ledgerEntries.id,
        transactionId: ledgerEntries.transactionId,
        kind: ledgerTransactions.kind,
        memo: ledgerTransactions.memo,
        amount: ledgerEntries.amount,
        balanceAfter: ledgerEntries.balanceAfter,
        createdAt: ledgerTransactions.createdAt,
      })
      .from(ledgerEntries)
      .innerJoin(ledgerTransactions, eq(ledgerTransactions.id, ledgerEntries.transactionId))
      .where(eq(ledgerEntries.accountId, accountId))
      .orderBy(direction(ledgerTransactions.createdAt), direction(ledgerEntries.id))
      .limit(range.limit)
      .offset(range.start),
    db
      .select({ total: sql<number>`count(*)::int` })
      .from(ledgerEntries)
      .where(eq(ledgerEntries.accountId, accountId)),
  ]);
  return { rows, total: counted?.total ?? 0 };
}

/** One row of the trial balance as stored. */
export interface TrialBalanceRow {
  readonly kind: LedgerAccountKind;
  /** The sum of the kind's balances, debit positive. */
  readonly balance: string;
  readonly accounts: number;
}

const creditKindList = sql.join(
  CREDIT_NORMAL_KINDS.map((kind) => sql`${kind}`),
  sql`, `,
);

/** SQL: an account balance in the debit-positive sign. */
const debitPositiveBalance = sql`case when ${ledgerAccounts.kind} in (${creditKindList}) then -${ledgerAccounts.balance} else ${ledgerAccounts.balance} end`;

/**
 * Sums the accounts of a currency per kind.
 *
 * Why: `GET /admin/ledger/accounts` is the trial balance: one row per kind, debit positive (a wallet reads negative).
 *
 * @param db the database or a transaction
 * @param currency the ledger currency
 * @returns one row per kind that has accounts
 */
export async function trialBalanceRows(db: DbExecutor, currency: string): Promise<TrialBalanceRow[]> {
  return db
    .select({
      kind: ledgerAccounts.kind,
      balance: sql<string>`coalesce(sum(${debitPositiveBalance}), 0)::numeric(18,4)::text`,
      accounts: sql<number>`count(*)::int`,
    })
    .from(ledgerAccounts)
    .where(eq(ledgerAccounts.currency, currency))
    .groupBy(ledgerAccounts.kind);
}

/** An account whose stored balance differs from its entries. */
export interface BalanceDifferenceRow {
  readonly accountId: number;
  readonly kind: LedgerAccountKind;
  readonly ownerType: LedgerOwnerType | null;
  readonly ownerId: number | null;
  /** The stored balance, normal sign. */
  readonly stored: string;
  /** The balance the entries add up to, normal sign. */
  readonly expected: string;
}

/**
 * Compares every account's stored balance with the sum of its entries.
 *
 * Why: scenario system-integrity and `POST /admin/ledger/reconcile`: "sum of entries per account = balance". One statement,
 * so the balances and the sums come from one snapshot even while postings go on.
 *
 * @param db the database or a transaction (use a repeatable-read one when the counts must agree with it)
 * @returns the accounts that differ, ascending by id
 */
export async function findBalanceDifferences(db: DbExecutor): Promise<BalanceDifferenceRow[]> {
  const entriesSum = sql`coalesce(sum(${ledgerEntries.amount}), 0)`;
  const expected = sql`case when ${ledgerAccounts.kind} in (${creditKindList}) then -${entriesSum} else ${entriesSum} end`;
  const rows = await db
    .select({
      accountId: ledgerAccounts.id,
      kind: ledgerAccounts.kind,
      ownerType: ledgerAccounts.ownerType,
      ownerId: ledgerAccounts.ownerId,
      stored: ledgerAccounts.balance,
      expected: sql<string>`(${expected})::numeric(18,4)::text`,
    })
    .from(ledgerAccounts)
    .leftJoin(ledgerEntries, eq(ledgerEntries.accountId, ledgerAccounts.id))
    .groupBy(ledgerAccounts.id)
    .having(sql`${ledgerAccounts.balance} <> ${expected}`)
    .orderBy(asc(ledgerAccounts.id));
  return rows;
}

/**
 * Counts accounts and entries.
 *
 * @param db the database or a transaction
 * @returns how many accounts and entries the ledger holds
 */
export async function countLedger(db: DbExecutor): Promise<{ accounts: number; entries: number }> {
  const [accounts] = await db.select({ total: sql<number>`count(*)::int` }).from(ledgerAccounts);
  const [entries] = await db.select({ total: sql<number>`count(*)::int` }).from(ledgerEntries);
  return { accounts: accounts?.total ?? 0, entries: entries?.total ?? 0 };
}

/** The wallet and hold of a merchant as stored. */
export interface WalletAccounts {
  readonly walletId: number | undefined;
  readonly walletBalance: string;
  readonly creditLimit: string;
  readonly holdBalance: string;
}

/**
 * Reads a merchant's wallet and hold figures.
 *
 * Why: the wallet view is `{ balance, reserved, creditLimit, available }` from `client_wallet` and `client_hold`
 * (decision 024). A merchant with no accounts reads as zeros. Pass `lock` to take the rows `FOR UPDATE` (credit-limit change).
 *
 * @param db the database or a transaction
 * @param clientId the merchant
 * @param currency the wallet currency
 * @param lock lock the rows for the rest of the transaction
 * @returns the figures in the accounts' normal sign (merchant side)
 */
export async function readWalletAccounts(
  db: DbExecutor,
  clientId: number,
  currency: string,
  lock = false,
): Promise<WalletAccounts> {
  const query = db
    .select({
      id: ledgerAccounts.id,
      kind: ledgerAccounts.kind,
      balance: ledgerAccounts.balance,
      overdraftLimit: ledgerAccounts.overdraftLimit,
    })
    .from(ledgerAccounts)
    .where(
      and(
        eq(ledgerAccounts.ownerType, 'client'),
        eq(ledgerAccounts.ownerId, clientId),
        eq(ledgerAccounts.currency, currency),
        inArray(ledgerAccounts.kind, ['client_wallet', 'client_hold']),
      ),
    )
    .orderBy(asc(ledgerAccounts.id));
  const rows = await (lock ? query.for('update') : query);
  const wallet = rows.find((row) => row.kind === 'client_wallet');
  const hold = rows.find((row) => row.kind === 'client_hold');
  return {
    walletId: wallet?.id,
    walletBalance: wallet?.balance ?? '0.0000',
    creditLimit: wallet?.overdraftLimit ?? '0.0000',
    holdBalance: hold?.balance ?? '0.0000',
  };
}

/**
 * Sets the credit limit of a locked wallet account.
 *
 * Side effects: updates `ledger_accounts.overdraft_limit` and `version`.
 *
 * @param db the transaction that holds the lock
 * @param walletId the `client_wallet` account
 * @param creditLimit the new limit (wire `Money`)
 * @param now the change time, from the injected clock
 */
export async function writeCreditLimit(
  db: DbExecutor,
  walletId: number,
  creditLimit: string,
  now: Date,
): Promise<void> {
  await db
    .update(ledgerAccounts)
    .set({ overdraftLimit: creditLimit, version: sql`${ledgerAccounts.version} + 1`, updatedAt: now })
    .where(eq(ledgerAccounts.id, walletId));
}
