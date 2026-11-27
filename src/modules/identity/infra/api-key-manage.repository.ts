// Drizzle queries of the API key routes on `api_keys` (identity module): a merchant's own (read-only) list, the admin's list, the one
// row a change locks, and the writes. The guards' lookup by key hash is `security/machine/api-keys/api-key.repository.ts`.
import { and, desc, eq, gt, isNull, like, or, sql } from 'drizzle-orm';
import { type DbExecutor, type ListColumns, listOrderBy } from '../../../infra/db';
import { type ApiKey, type NewApiKey, apiKeys, clients } from '../db/schema';

/** The columns a merchant's key list may be sorted by (wire names). */
export type ApiKeySortField = 'createdAt' | 'id';

const COLUMNS: ListColumns = { createdAt: apiKeys.createdAt, id: apiKeys.id };

/**
 * Lists a merchant's keys for `GET /client/api-keys`: live keys first, then revoked ones, then the client's sort (newest first
 * by default).
 *
 * @param db the database or a transaction
 * @param clientId the merchant
 * @param page the range and the sort keys
 * @returns the page and the exact number of keys of the merchant (revoked and expired included)
 */
export async function listKeysOfClient(
  db: DbExecutor,
  clientId: number,
  page: {
    readonly offset: number;
    readonly limit: number;
    readonly sort: readonly { readonly field: ApiKeySortField; readonly order: 'asc' | 'desc' }[];
  },
): Promise<{ rows: ApiKey[]; total: number }> {
  const where = eq(apiKeys.clientId, clientId);
  const [rows, [count]] = await Promise.all([
    db
      .select()
      .from(apiKeys)
      .where(where)
      // `revoked_at is not null` is false for a live key, and false sorts first.
      .orderBy(sql`(${apiKeys.revokedAt} is not null)`, ...listOrderBy(page.sort, COLUMNS, apiKeys.id))
      .limit(page.limit)
      .offset(page.offset),
    db
      .select({ total: sql<number>`count(*)::int` })
      .from(apiKeys)
      .where(where),
  ]);
  return { rows, total: count?.total ?? 0 };
}

/**
 * Lists every key of a merchant for `GET /admin/clients/:id/api-keys`, newest first (no paging).
 *
 * @param db the database or a transaction
 * @param clientId the merchant
 * @returns all keys, revoked and expired included
 */
export function listAllKeysOfClient(db: DbExecutor, clientId: number): Promise<ApiKey[]> {
  return db.select().from(apiKeys).where(eq(apiKeys.clientId, clientId)).orderBy(desc(apiKeys.id));
}

/**
 * Counts the keys of a merchant that can still be used: not revoked and not expired.
 *
 * @param db the transaction that holds the merchant's key lock
 * @param clientId the merchant
 * @param now the injected clock's time (decision 031)
 * @returns the number of live keys
 */
export async function countLiveKeys(db: DbExecutor, clientId: number, now: Date): Promise<number> {
  const [row] = await db
    .select({ total: sql<number>`count(*)::int` })
    .from(apiKeys)
    .where(
      and(
        eq(apiKeys.clientId, clientId),
        isNull(apiKeys.revokedAt),
        or(isNull(apiKeys.expiresAt), gt(apiKeys.expiresAt, now)),
      ),
    );
  return row?.total ?? 0;
}

/**
 * Serialises the creation of keys of one merchant.
 *
 * Why: "at most 10 live keys" is a count followed by an insert; two requests at once would both see 9. A transaction-level
 * advisory lock on the merchant lets the second wait for the first's commit, with no row to lock for the case of zero keys.
 *
 * Side effects: takes `pg_advisory_xact_lock` (released at commit or rollback).
 *
 * @param db the transaction
 * @param clientId the merchant
 */
export async function lockKeysOfClient(db: DbExecutor, clientId: number): Promise<void> {
  await db.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`api-keys:${clientId}`}, 0))`);
}

/**
 * Reads a key and holds its row until the transaction ends.
 *
 * @param db the transaction
 * @param id the key id
 * @returns the key, or `undefined` when there is none
 */
export async function lockKey(db: DbExecutor, id: number): Promise<ApiKey | undefined> {
  const [row] = await db.select().from(apiKeys).where(eq(apiKeys.id, id)).limit(1).for('update');
  return row;
}

/**
 * Reads the account a key belongs to without locking it.
 *
 * Why: a change of a key's expiry takes the account's advisory lock before the key row (decision 078), so it needs the account first.
 * `api_keys.client_id` never changes, so an unlocked read cannot go stale.
 *
 * @param db the transaction
 * @param id the key id
 * @returns the account id, or `undefined` when there is no such key
 */
export async function clientIdOfKey(db: DbExecutor, id: number): Promise<number | undefined> {
  const [row] = await db.select({ clientId: apiKeys.clientId }).from(apiKeys).where(eq(apiKeys.id, id)).limit(1);
  return row?.clientId;
}

/**
 * Reads the names of an account's keys that start like a default name, revoked and expired keys included.
 *
 * Why: decision 078: a key made without a name is called `API key <n>`, so the creation needs the numbers already taken. The caller holds
 * the advisory lock `api-keys:<accountId>`, so two creations at once read different sets.
 *
 * @param db the transaction that holds the account's key lock
 * @param clientId the account id
 * @param prefix the start of a default name (`API key `)
 * @returns the names (the caller keeps only the exact `<prefix><n>` form)
 */
export async function keyNamesStartingWith(db: DbExecutor, clientId: number, prefix: string): Promise<string[]> {
  const escaped = prefix.replace(/[\\%_]/g, (character) => `\\${character}`);
  const rows = await db
    .select({ name: apiKeys.name })
    .from(apiKeys)
    .where(and(eq(apiKeys.clientId, clientId), like(apiKeys.name, `${escaped}%`)));
  return rows.map((row) => row.name);
}

/**
 * Inserts a key.
 *
 * Side effects: inserts an `api_keys` row (the unique index on `key_hash` refuses a repeated hash).
 *
 * @param db the transaction
 * @param values the new key (hash, prefix, scopes, allowed addresses, limit)
 * @returns the stored row
 */
export async function insertKey(db: DbExecutor, values: NewApiKey): Promise<ApiKey> {
  const [row] = await db.insert(apiKeys).values(values).returning();
  return row!;
}

/**
 * Changes the name, the allowed addresses, the per-minute limit or the expiry of a key.
 *
 * @param db the transaction that holds the key
 * @param id the key id
 * @param changes the columns to change
 * @returns the key after the change
 */
export async function updateKey(
  db: DbExecutor,
  id: number,
  changes: {
    readonly name?: string;
    readonly allowedIps?: readonly string[];
    readonly rateLimitPerMin?: number;
    /** A new time, or `null` to remove the expiry; left out, the expiry stays. */
    readonly expiresAt?: Date | null;
  },
): Promise<ApiKey> {
  const [row] = await db
    .update(apiKeys)
    .set({
      ...(changes.name === undefined ? {} : { name: changes.name }),
      ...(changes.allowedIps === undefined ? {} : { allowedIps: [...changes.allowedIps] }),
      ...(changes.rateLimitPerMin === undefined ? {} : { rateLimitPerMin: changes.rateLimitPerMin }),
      ...(changes.expiresAt === undefined ? {} : { expiresAt: changes.expiresAt }),
      updatedAt: sql`now()`,
    })
    .where(eq(apiKeys.id, id))
    .returning();
  return row!;
}

/**
 * Revokes a key.
 *
 * @param db the transaction that holds the key
 * @param id the key id
 * @param now the time to write (the injected clock's)
 * @returns true when the key was live and is now revoked
 */
export async function revokeKeyRow(db: DbExecutor, id: number, now: Date): Promise<boolean> {
  const rows = await db
    .update(apiKeys)
    .set({ revokedAt: now, updatedAt: sql`now()` })
    .where(and(eq(apiKeys.id, id), isNull(apiKeys.revokedAt)))
    .returning({ id: apiKeys.id });
  return rows.length > 0;
}

/**
 * Revokes every key of an account that is not revoked yet.
 *
 * Why: an account that leaves the merchant kind (a rank change) or is erased keeps no key, and a later change back never restores one
 * (decision 064). The caller holds the account row; this function never takes the advisory lock `api-keys:<accountId>` (a key
 * creation takes it before the row, so taking it after would invite a cycle).
 *
 * Side effects: sets `api_keys.revoked_at` and `updated_at`; a key that was revoked earlier keeps its own time.
 *
 * @param db the caller's transaction
 * @param clientId the account id (`api_keys.client_id` already names the account)
 * @param now the time to write (the injected clock's)
 * @returns how many keys were revoked
 */
export async function revokeLiveKeysOfClient(db: DbExecutor, clientId: number, now: Date): Promise<number> {
  const rows = await db
    .update(apiKeys)
    .set({ revokedAt: now, updatedAt: sql`now()` })
    .where(and(eq(apiKeys.clientId, clientId), isNull(apiKeys.revokedAt)))
    .returning({ id: apiKeys.id });
  return rows.length;
}

/**
 * Reads an account's name and whether it exists.
 *
 * @param db the database or a transaction
 * @param clientId the account id (a merchant or any other rank: staff read the keys an account had)
 * @returns the name, or `undefined` when there is no such account
 */
export async function accountNameOf(db: DbExecutor, clientId: number): Promise<string | undefined> {
  const [row] = await db.select({ name: clients.name }).from(clients).where(eq(clients.id, clientId)).limit(1);
  return row?.name;
}
