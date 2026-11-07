// Drizzle queries on `api_keys` and the status of the merchant behind a key (identity module). Every function takes a
// DbExecutor, so a caller can run them inside its own transaction.
import { and, eq, isNull, lte, or } from 'drizzle-orm';
import type { DbExecutor } from '../../../../../infra/db';
import { apiKeys, clients } from '../../../db/schema';
import type { ApiKeyView } from './api-key.rules';

/**
 * Finds an API key and its merchant by the keyed hash of the key.
 *
 * Why: the guards look keys up by the hash of the presented key (unique index `api_keys_key_hash_uq`, decision 019).
 * Revoked and expired keys are returned too, so the guard can tell them from unknown ones; it judges them with the clock.
 *
 * @param db the database or a transaction
 * @param keyHash the keyed hash of the key
 * @returns the view, or `undefined` for an unknown key
 */
export async function findApiKeyByHash(db: DbExecutor, keyHash: string): Promise<ApiKeyView | undefined> {
  const [row] = await db
    .select({
      id: apiKeys.id,
      keyHash: apiKeys.keyHash,
      clientId: apiKeys.clientId,
      scopes: apiKeys.scopes,
      allowedIps: apiKeys.allowedIps,
      rateLimitPerMin: apiKeys.rateLimitPerMin,
      lastUsedAt: apiKeys.lastUsedAt,
      expiresAt: apiKeys.expiresAt,
      revokedAt: apiKeys.revokedAt,
      username: clients.username,
      name: clients.name,
      status: clients.status,
    })
    .from(apiKeys)
    .innerJoin(clients, eq(clients.id, apiKeys.clientId))
    .where(eq(apiKeys.keyHash, keyHash))
    .limit(1);
  if (!row) return undefined;
  return {
    id: row.id,
    keyHash: row.keyHash,
    clientId: row.clientId,
    scopes: row.scopes,
    allowedIps: row.allowedIps,
    rateLimitPerMin: row.rateLimitPerMin,
    lastUsedAtMs: row.lastUsedAt?.getTime() ?? null,
    expiresAtMs: row.expiresAt?.getTime() ?? null,
    revokedAtMs: row.revokedAt?.getTime() ?? null,
    client: { username: row.username, name: row.name, status: row.status },
  };
}

/**
 * Lists the key hashes of a merchant's keys that can still be used.
 *
 * Why: when a merchant is suspended or reactivated, the cached views of its keys (which hold the status) must be deleted.
 *
 * @param db the database or a transaction
 * @param clientId the merchant id
 * @returns the hashes of the keys that are not revoked
 */
export async function liveKeyHashesOf(db: DbExecutor, clientId: number): Promise<string[]> {
  const rows = await db
    .select({ keyHash: apiKeys.keyHash })
    .from(apiKeys)
    .where(and(eq(apiKeys.clientId, clientId), isNull(apiKeys.revokedAt)));
  return rows.map((row) => row.keyHash);
}

/**
 * Writes `last_used_at` and `last_used_ip`, but only if the stored time is at least `minGapMs` old.
 *
 * Why: the console shows when and from where a key was last used; the guard in the `WHERE` keeps the write to about once a
 * minute per key across API instances, so authenticating never turns every read into a write.
 *
 * @param db the database or a transaction
 * @param id the key id
 * @param now the time to write
 * @param ip the client address, printed
 * @param minGapMs the shortest time between two writes
 * @returns true when a row was updated
 */
export async function touchApiKey(
  db: DbExecutor,
  id: number,
  now: Date,
  ip: string,
  minGapMs: number,
): Promise<boolean> {
  const rows = await db
    .update(apiKeys)
    .set({ lastUsedAt: now, lastUsedIp: ip })
    .where(
      and(
        eq(apiKeys.id, id),
        or(isNull(apiKeys.lastUsedAt), lte(apiKeys.lastUsedAt, new Date(now.getTime() - minGapMs))),
      ),
    )
    .returning({ id: apiKeys.id });
  return rows.length > 0;
}
