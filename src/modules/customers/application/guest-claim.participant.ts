// CustomersGuestClaimParticipant: the checkout sessions and the consents of a guest row move to the account that proved the mailbox
// (decision 064), registered with identity's `GuestClaimParticipants` when the module starts.
import { Inject, Injectable, type OnModuleInit } from '@nestjs/common';
import { CLOCK, type Clock } from '../../../common/clock';
import type { Transaction } from '../../../infra/db';
import { GuestClaimBusy, GuestClaimParticipants, type GuestClaimIds } from '../../identity';
import { isLiveCheckout } from '../domain/checkout';
import { lockSessionsOfAccountNoWait, moveSessionsToAccount } from '../infra/checkout.repository';
import { moveGuestConsents } from '../infra/consent.repository';

/** The name the participant registers under (it keys the counts the claim records). */
export const GUEST_CLAIM_CUSTOMERS = 'customers';

/**
 * Moves the checkout sessions and consent records of a guest row to the account that claims them.
 *
 * Why: the claim runs inside the email-link exchange, after the mailbox was proven, and moves every record of the guest row to the retail
 * account in one transaction (decision 064). Identity runs it but cannot know this module's tables, so the module registers a mover. It
 * never waits: the sessions are locked `FOR UPDATE NOWAIT` first (a capture or a consent post that holds one makes the claim answer
 * `busy`), then a session that is still open refuses the claim (`GuestClaimBusy`: the guest may be on a payment page), then the consents
 * are locked and re-pointed. Only pointers change: a session keeps its email, price, amounts and token; a consent record keeps every proof
 * column byte for byte (purpose, answer, document, address, user agent, time). The paid and expired sessions of the guest row now belong to
 * the account, so its order links and receipts keep working and its history shows them.
 *
 * Side effects: row locks until the claim's transaction ends; updates `checkout_sessions.account_id` and `consent_records.subject_id`.
 *
 * @see POST /store/v1/auth/verify
 */
@Injectable()
export class CustomersGuestClaimParticipant implements OnModuleInit {
  constructor(
    private readonly participants: GuestClaimParticipants,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  /** Registers the mover with the claim. */
  onModuleInit(): void {
    this.participants.register(GUEST_CLAIM_CUSTOMERS, (tx, ids) => this.move(tx, ids));
  }

  /**
   * Moves the records of the guest row.
   *
   * @param tx the claim's transaction, inside the savepoint the claim opened
   * @param ids the guest row and the account
   * @returns how many checkout sessions and consent records moved, together
   * @throws {GuestClaimBusy} when the guest row has a checkout session that is open and not run out
   * @throws the lock error (SQLSTATE 55P03) when another request holds one of the rows: the claim catches it and answers `busy`
   */
  async move(tx: Transaction, ids: GuestClaimIds): Promise<number> {
    const sessions = await lockSessionsOfAccountNoWait(tx, ids.guestId);
    const now = this.clock.now();
    if (sessions.some((session) => isLiveCheckout(session, now))) throw new GuestClaimBusy('an open checkout session');
    const movedSessions = sessions.length === 0 ? 0 : await moveSessionsToAccount(tx, ids.guestId, ids.accountId, now);
    const movedConsents = await moveGuestConsents(tx, ids.guestId, ids.accountId);
    return movedSessions + movedConsents;
  }
}
