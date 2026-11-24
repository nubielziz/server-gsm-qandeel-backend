// The money participant of the guest-order claim (decision 064): the payments, the receipt invoices, the refunds and the disputes of a guest
// row move to the account that proved the mailbox. A plain function and a name, like the files participant of the platform: the wiring
// registers them with the identity registry (`GuestClaimParticipants.register(GUEST_CLAIM_MONEY_NAME, moveGuestClaimMoney)`), because the
// money module cannot register itself before the registry exists (decision 032).
import type { Transaction } from '../../../infra/db';
import { GuestClaimBusy } from '../../identity';
import { hasLedgerAccount, lockGuestPayments, moveGuestPaymentRecords } from '../infra/order-payment.repository';
import { moveGuestRefunds } from '../infra/refund.repository';

/** The name the participant registers under (it keys the counts the claim records on its audit row). */
export const GUEST_CLAIM_MONEY_NAME = 'money';

/**
 * Moves the money records of a guest row to the account that claims its orders.
 *
 * Why: decision 064: the claim runs inside the email-link exchange, after the mailbox was proven, and re-points every record
 * of the guest row to the retail account in one transaction. The payments of a guest checkout, the receipt invoices issued for them, their
 * refunds and the disputes of their payments all name the buyer by `account_id`, so they move together; the ledger is not touched (a
 * payment, a refund or a dispute posts to system accounts, and a guest row has no wallet). The claim gives up, and the sign-in still
 * succeeds, in two cases: a payment of the guest row is still pending (a hosted page open, a confirmation held for staff), and the guest row
 * has a ledger account (money that sits on the row would have to move with it). Every row is taken `FOR UPDATE NOWAIT`, so a record another
 * request holds (a dispute webhook, a refund approval, a crediting) never makes the claim wait: the lock error (SQLSTATE 55P03) rolls the claim
 * back to its savepoint. Lock order: the account row (the claim's), the guest row, then payments, invoices, disputes and refunds, all
 * without waiting; the paths that hold these rows first take the account row after them, so nothing can wait in a cycle.
 *
 * Side effects: updates `account_id` of the guest row's payments, invoices, disputes and refunds (`updated_at` stays: an owner change is not a
 * change of state).
 *
 * @param tx the claim's transaction, inside the savepoint the claim opened
 * @param ids the guest row and the account
 * @param ids.guestId the guest row that holds the records now
 * @param ids.accountId the account that takes them
 * @returns how many records moved (payments, invoices, disputes and refunds together)
 * @throws {GuestClaimBusy} when a payment of the guest row is pending or the guest row has a ledger account
 * @throws the lock error (SQLSTATE 55P03) when another request holds one of the rows: the claim answers `busy` and rolls back
 * @see POST /store/v1/auth/verify
 */
export async function moveGuestClaimMoney(
  tx: Transaction,
  ids: { readonly guestId: number; readonly accountId: number },
): Promise<number> {
  if (await hasLedgerAccount(tx, ids.guestId)) throw new GuestClaimBusy('the guest row has a ledger account');
  const payments = await lockGuestPayments(tx, ids.guestId);
  if (payments.pending) throw new GuestClaimBusy('a payment of the guest row is still pending');
  const moved = await moveGuestPaymentRecords(tx, ids.guestId, ids.accountId);
  const refunds = await moveGuestRefunds(tx, ids.guestId, ids.accountId);
  return moved.payments + moved.invoices + moved.disputes + refunds;
}
