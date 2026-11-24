// The seam from the rank and status changes to the API keys (decision 064): leaving the merchant kind ends every key of the account.
import type { Transaction } from '../../../infra/db';

/**
 * Revokes the API keys of an account.
 *
 * Why: API keys (the Dhru interface included) work only for an account of a merchant rank. A rank change that leaves the merchant kind
 * and an erasure revoke every live key in their own transaction, and a later change back never restores one.
 *
 * The implementation runs while the caller already holds the account row, so it updates the live key rows directly and never takes the
 * advisory lock `api-keys:<accountId>` that the two key creations take before the row (the one named exception to the lock order).
 *
 * Side effects (of the implementation): updates `api_keys.revoked_at`; the caller invalidates the cached key views after the commit.
 */
export abstract class ApiKeyRevocation {
  /**
   * Revokes every live key of an account.
   *
   * @param tx the caller's transaction (it holds the account row)
   * @param accountId the account
   * @returns how many keys were revoked
   */
  abstract revokeLiveKeysOf(tx: Transaction, accountId: number): Promise<number>;
}
