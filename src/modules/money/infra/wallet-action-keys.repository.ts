// Reads and writes of `wallet_action_keys` (money module, decision 064): the key of a staff freeze, unfreeze or credit-limit change,
// kept with the request it was first sent with and the answer it got, so a retry replays that answer and changes nothing twice.
import { and, eq } from 'drizzle-orm';
import type { DbExecutor } from '../../../infra/db';
import { type NewWalletActionKey, type WalletActionKey, walletActionKeys } from '../db/schema';

/**
 * Finds the key an account already used for a staff wallet action.
 *
 * Why: a request with a key stored for the account answers the stored answer when the action and the request hash agree and is refused
 * otherwise; the use case reads the key in the transaction of the change, under the account row lock, before it applies anything.
 *
 * @param db the use case's transaction
 * @param accountId the account the action is about
 * @param idempotencyKey the `Idempotency-Key` header as sent
 * @returns the stored row, or `undefined` for a key the account has not used
 */
export async function findWalletActionKey(
  db: DbExecutor,
  accountId: number,
  idempotencyKey: string,
): Promise<WalletActionKey | undefined> {
  const [row] = await db
    .select()
    .from(walletActionKeys)
    .where(and(eq(walletActionKeys.accountId, accountId), eq(walletActionKeys.idempotencyKey, idempotencyKey)))
    .limit(1);
  return row;
}

/**
 * Stores the key of an action that was applied, with its answer.
 *
 * Why: written in the transaction of the change, so the change and its key exist together or not at all. Two requests that carry the
 * same new key at once both pass the lookup; the unique index `wallet_action_keys_key_uq (account_id, idempotency_key)` lets the first commit
 * and refuses the second, which the use case retries once (it then finds the key and replays).
 *
 * Side effects: inserts one append-only `wallet_action_keys` row.
 *
 * @param tx the transaction of the change
 * @param row the account, the action, the key, the keyed hash of the request, the answer and the staff member
 * @throws {Error} the database's unique violation of `wallet_action_keys_key_uq` when the key was stored in the meantime
 */
export async function insertWalletActionKey(tx: DbExecutor, row: NewWalletActionKey): Promise<void> {
  await tx.insert(walletActionKeys).values(row);
}
