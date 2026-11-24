// The seam from the erasure of an account to its money (decision 064): the wallets must be empty before the account is anonymized.
import type { Transaction } from '../../../infra/db';

/**
 * Closes the money side of an account that is being erased.
 *
 * Why: an account's data may be erased only when no money is left to owe or to take: every wallet of the account (both kinds) and its
 * holds must be at zero and no rank-change blocker may exist. The anonymize use case calls this last, in its own transaction.
 *
 * Side effects (of the implementation): reads the account's ledger accounts; may mark them closed.
 *
 * @see POST /admin/clients/:id/anonymize, POST /store/v1/me/data-delete
 */
export abstract class WalletErasure {
  /**
   * Checks that the account's wallets and holds are empty and closes them.
   *
   * @param tx the caller's transaction
   * @param accountId the account
   * @throws {AppError} `CONFLICT` (409) naming what is left (a balance, a hold, a frozen wallet or an open top-up) when any is not zero
   */
  abstract closeForErasure(tx: Transaction, accountId: number): Promise<void>;
}
