// The files participant of the guest-order claim (decision 064): the files a guest row owns move to the account that proved the mailbox.
import type { Transaction } from '../../../infra/db';
import { moveGuestFiles } from '../infra/file.repository';

/** The name the participant registers under (it keys the counts the claim records). */
export const GUEST_CLAIM_FILES_NAME = 'files';

/**
 * Moves the files of a guest row to the account that claims its records.
 *
 * Why: decision 064: the claim runs inside the email-link exchange, after the mailbox was proven, and moves every record of the guest
 * row to the retail account in one transaction. The platform owns the `files` table, so it owns this mover; the wiring registers it with the
 * identity registry (`GuestClaimParticipants.register('files', moveGuestClaimFiles)`). The platform imports no other module, so it
 * cannot register itself (decision 032).
 *
 * Side effects: locks the guest row's files `FOR UPDATE NOWAIT` and updates their owner (see {@link moveGuestFiles}).
 *
 * @param tx the claim's transaction, inside the savepoint the claim opened
 * @param ids the guest row and the account
 * @param ids.guestId the guest row that owns the files now
 * @param ids.accountId the account that takes them
 * @returns how many files moved
 * @throws the lock error (SQLSTATE 55P03) when another request holds one of the files: the claim answers `busy` and rolls back
 * @see POST /store/v1/auth/verify
 */
export async function moveGuestClaimFiles(
  tx: Transaction,
  ids: { readonly guestId: number; readonly accountId: number },
): Promise<number> {
  return moveGuestFiles(tx, ids.guestId, ids.accountId);
}
