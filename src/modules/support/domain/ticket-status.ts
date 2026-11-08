// Ticket status words (support module, RESOLUTIONS b2c-2, MISMATCHES B112): the one codec between the stored word and the console's, and
// the moves a staff member may make. Pure; the repository and the use cases call it, nothing else translates a status.
import type { TicketStatus } from '../db/schema';

/**
 * The words the console and the storefront know for a ticket's status.
 *
 * Why: the console's badge crashes on any other word (TicketStatusBadge.tsx), so `pending_customer` goes out as `pending` and `closed`
 * is not part of the vocabulary at all (B112, RESOLUTIONS b2c-2).
 */
export const WIRE_TICKET_STATUSES = ['new', 'open', 'pending', 'resolved'] as const;

/** One value of {@link WIRE_TICKET_STATUSES}. */
export type WireTicketStatus = (typeof WIRE_TICKET_STATUSES)[number];

/**
 * Turns a stored status into the word on the wire.
 *
 * @param stored a stored status
 * @returns `pending` for `pending_customer`, the same word for the others
 */
export function toWireStatus(stored: TicketStatus): WireTicketStatus {
  return stored === 'pending_customer' ? 'pending' : stored;
}

/**
 * Turns a wire word into the stored status.
 *
 * @param wire a status word from the console (a PATCH body or a list filter)
 * @returns `pending_customer` for `pending`, the same word for the others
 */
export function fromWireStatus(wire: WireTicketStatus): TicketStatus {
  return wire === 'pending' ? 'pending_customer' : wire;
}

/** The result of asking whether a staff member may move a ticket from one status to another. */
export type StatusMove = { readonly ok: true } | { readonly ok: false; readonly message: string };

/**
 * Judges a status change a staff member asks for with `PATCH /admin/support-tickets/:id`.
 *
 * Why: RULES support 1: `new` exists only at creation, a ticket waits on the customer (`pending`) after a staff reply or when staff say
 * so, `open` is the ticket being worked on (the map's step 4, and the move out of `pending` when staff pick it up again), `resolved` is
 * final until it is reopened, and a reopen goes to `open`. A move to the status the ticket already has is not a change (the caller
 * skips it before asking).
 *
 * @param from the stored status now
 * @param to the stored status asked for
 * @returns `ok`, or the message to show under the status control
 */
export function judgeStatusMove(from: TicketStatus, to: TicketStatus): StatusMove {
  if (from === to) return { ok: true };
  if (to === 'new') return { ok: false, message: 'A ticket cannot go back to new.' };
  if (from === 'resolved' && to !== 'open') return { ok: false, message: 'A resolved ticket can only be reopened.' };
  return { ok: true };
}
