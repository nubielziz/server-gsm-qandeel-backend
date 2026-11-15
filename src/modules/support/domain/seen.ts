// The seen marks of a ticket (feature 28, rule 3): one mark per side, moved forward only, over the messages the other side wrote. Pure.
import type { TicketAuthorType } from '../db/schema';

/** The two parties of a ticket: the requester (a customer or a merchant) and staff (one party: never who). */
export type TicketSide = 'requester' | 'staff';

/** What the seen rule needs to know about a message. */
export interface SeenCandidate {
  readonly ticketId: number;
  readonly authorType: TicketAuthorType;
  readonly isInternal: boolean;
}

/**
 * Whether a side may mark a message seen.
 *
 * Why: rule 3 and the plan's § 3.3: a mark covers the other side's messages that the marking side can see: the requester marks public
 * staff messages (never a note or a system message, which it must not learn about), staff mark the requester's messages. Anything else
 * is `422 unknown_message`, so a mark never reveals that a message exists.
 *
 * @param side who marks
 * @param ticketId the ticket of the route
 * @param message the message named by `upToMessageId`, or `undefined` when no message has that id
 * @returns true when the message may carry the mark
 */
export function canMarkSeen(side: TicketSide, ticketId: number, message: SeenCandidate | undefined): boolean {
  if (!message || message.ticketId !== ticketId) return false;
  if (side === 'requester') return message.authorType === 'staff' && !message.isInternal;
  return message.authorType === 'customer' || message.authorType === 'client';
}

/**
 * Whether a mark moves: marks only go forward.
 *
 * Why: rule 3: a late or repeated call (another tab, a replayed request) must not move a mark back; the route then answers 204 without a
 * doorbell. The database decides the same with one guarded `UPDATE` (`coalesce(seen, 0) < upTo`), so two tabs never race.
 *
 * @param current the stored mark, or `null`
 * @param upTo the newest message the caller has seen
 * @returns true when `upTo` is newer than the mark
 */
export function movesSeenMark(current: number | null, upTo: number): boolean {
  return upTo > (current ?? 0);
}

/**
 * Whether one side has a message it has not seen.
 *
 * Why: rule 3 and the plan's § 3.1: `hasUnread` is never stored: for staff it is the newest requester message after their mark, for the
 * requester the newest public staff message after theirs.
 *
 * @param last the newest message of the other side, or `null` when it wrote none
 * @param seen the side's mark, or `null`
 * @returns true when the other side wrote after the mark
 */
export function hasUnread(last: number | null, seen: number | null): boolean {
  return last !== null && last > (seen ?? 0);
}
