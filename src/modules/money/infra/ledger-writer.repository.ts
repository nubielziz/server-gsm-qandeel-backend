// Drizzle inserts on ledger_transactions and ledger_entries for the ledger writer. Both tables are append-only (trigger).
import { eq } from 'drizzle-orm';
import type { DbExecutor } from '../../../infra/db';
import {
  type LedgerActorType,
  type LedgerRefType,
  type NewLedgerEntry,
  ledgerEntries,
  ledgerTransactions,
} from '../db/schema';

/** The header of a ledger transaction as the writer reads it back. */
export interface LedgerHeader {
  readonly id: number;
  readonly kind: string;
  readonly refType: LedgerRefType;
  readonly refId: number;
  readonly memo: string;
  readonly idempotencyKey: string;
  readonly createdByType: LedgerActorType;
  readonly createdById: number | null;
  readonly createdAt: Date;
}

const headerColumns = {
  id: ledgerTransactions.id,
  kind: ledgerTransactions.kind,
  refType: ledgerTransactions.refType,
  refId: ledgerTransactions.refId,
  memo: ledgerTransactions.memo,
  idempotencyKey: ledgerTransactions.idempotencyKey,
  createdByType: ledgerTransactions.createdByType,
  createdById: ledgerTransactions.createdById,
  createdAt: ledgerTransactions.createdAt,
};

/**
 * Inserts the header of a transaction unless its idempotency key was used before.
 *
 * Why: decision 024 step 2: the unique `idempotency_key` makes a replay post nothing. `ON CONFLICT DO NOTHING` waits for a
 * concurrent first insert of the same key to commit or roll back, so exactly one caller posts.
 *
 * Side effects: inserts a `ledger_transactions` row.
 *
 * @param tx the transaction
 * @param header the new header
 * @returns the new id, or `undefined` when the key already exists
 */
export async function insertHeader(tx: DbExecutor, header: Omit<LedgerHeader, 'id'>): Promise<number | undefined> {
  const [row] = await tx
    .insert(ledgerTransactions)
    .values(header)
    .onConflictDoNothing({ target: ledgerTransactions.idempotencyKey })
    .returning({ id: ledgerTransactions.id });
  return row?.id;
}

/**
 * Reads the transaction an idempotency key stands for.
 *
 * @param db the database or a transaction
 * @param idempotencyKey the key
 * @returns the header, or `undefined`
 */
export async function findHeaderByKey(db: DbExecutor, idempotencyKey: string): Promise<LedgerHeader | undefined> {
  const [row] = await db
    .select(headerColumns)
    .from(ledgerTransactions)
    .where(eq(ledgerTransactions.idempotencyKey, idempotencyKey))
    .limit(1);
  return row;
}

/**
 * Inserts the entries of a transaction.
 *
 * Side effects: inserts `ledger_entries` rows; the deferred zero-sum trigger checks them at commit.
 *
 * @param tx the transaction
 * @param entries the entries, in line order
 * @returns the new entry ids, in the same order
 */
export async function insertEntries(tx: DbExecutor, entries: readonly NewLedgerEntry[]): Promise<number[]> {
  const rows = await tx
    .insert(ledgerEntries)
    .values([...entries])
    .returning({ id: ledgerEntries.id });
  return rows.map((row) => row.id).sort((a, b) => a - b);
}
