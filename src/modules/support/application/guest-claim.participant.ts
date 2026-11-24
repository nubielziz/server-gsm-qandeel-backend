// SupportGuestClaimParticipant: the tickets of a guest row, and the messages the guest row wrote on them, move to the account that proved the
// mailbox (decision 064), registered with identity's `GuestClaimParticipants` when the module starts.
import { Injectable, type OnModuleInit } from '@nestjs/common';
import type { Transaction } from '../../../infra/db';
import { type GuestClaimIds, GuestClaimParticipants } from '../../identity';
import {
  lockMessagesOfAuthorNoWait,
  lockTicketsOfRequesterNoWait,
  moveMessagesToAccount,
  moveTicketsToAccount,
} from '../infra/ticket.repository';

/** The name the participant registers under (it keys the counts the claim records). */
export const GUEST_CLAIM_SUPPORT = 'support';

/**
 * Moves the tickets and the requester's messages of a guest row to the account that claims them.
 *
 * Why: the claim runs inside the email-link exchange, after the mailbox was proven, and moves every record of the guest row to the retail
 * account in one transaction (decision 064). A ticket opened on the public form with that address, or from an order link of a guest
 * checkout, belongs to the guest row; once the address holder signs in, those tickets are theirs. Identity runs the claim but cannot know
 * this module's tables, so the module registers a mover. It never waits: the tickets are locked `FOR UPDATE NOWAIT` first (a staff
 * reply, a status change or the requester's own message holds the ticket, and the claim then answers `busy`), then the guest row's
 * messages of those tickets. Only pointers change: a ticket keeps its number, its link token (the ticket link keeps working), its
 * proof-of-address time and its `updated_at`; a message keeps its text, its files and its time. A ticket whose address was never proven
 * stays off the account's lists until its link is used, as for every account. The files of those messages move with the platform's
 * own participant.
 *
 * Side effects: row locks until the claim's transaction ends; updates `support_tickets.requester_id` and `ticket_messages.author_id`.
 *
 * @see POST /store/v1/auth/verify
 */
@Injectable()
export class SupportGuestClaimParticipant implements OnModuleInit {
  constructor(private readonly participants: GuestClaimParticipants) {}

  /** Registers the mover with the claim. */
  onModuleInit(): void {
    this.participants.register(GUEST_CLAIM_SUPPORT, (tx, ids) => this.move(tx, ids));
  }

  /**
   * Moves the records of the guest row.
   *
   * @param tx the claim's transaction, inside the savepoint the claim opened
   * @param ids the guest row and the account
   * @returns how many tickets and messages moved, together
   * @throws the lock error (SQLSTATE 55P03) when another request holds one of the tickets or messages: the claim catches it and answers `busy`
   */
  async move(tx: Transaction, ids: GuestClaimIds): Promise<number> {
    const ticketIds = await lockTicketsOfRequesterNoWait(tx, ids.guestId);
    if (ticketIds.length === 0) return 0;
    const messageIds = await lockMessagesOfAuthorNoWait(tx, ticketIds, ids.guestId);
    const tickets = await moveTicketsToAccount(tx, ticketIds, ids.guestId, ids.accountId);
    const messages = await moveMessagesToAccount(tx, messageIds, ids.guestId, ids.accountId);
    return tickets + messages;
  }
}
