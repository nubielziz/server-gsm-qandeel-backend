// The requester's lock on a resolved ticket (owner decision 2026-11-15, B220): once staff resolve a ticket, its requester can no longer
// write on it. One refusal shared by the message path and the upload path, so both answer the same words.
import { AppError } from '../../../common/errors';

/** The `detail` of the refusal: tells the requester what to do instead. */
export const REQUESTER_LOCKED_DETAIL = 'This ticket is closed. Open a new ticket if you still need help.';

/**
 * Whether a ticket is closed for its requester.
 *
 * Why: B220 (owner decision 2026-11-15, replacing ANSWERS support Q8): a resolved ticket takes no message, no upload and no typing
 * doorbell from the customer or the merchant; staff reopen it (`PATCH` resolved to open) to continue. Read marks and the rating are not
 * writes on the conversation and stay allowed.
 *
 * @param ticket the ticket row, or anything with its status
 * @returns true when the status is `resolved`
 */
export function isLockedForRequester(ticket: { readonly status: string }): boolean {
  return ticket.status === 'resolved';
}

/**
 * Builds the `409 TICKET_RESOLVED` a requester gets on a resolved ticket.
 *
 * Why: B220; the console's staff reply refusal uses the same code with a different detail (`Reopen the ticket before you reply.`).
 *
 * @returns the error to throw, before anything is written, published or mailed
 * @see POST /store/v1/tickets/:token/messages, POST /client/tickets/:id/messages, POST /store/v1/tickets/:token/files
 */
export function requesterLockedError(): AppError {
  return new AppError('TICKET_RESOLVED', { detail: REQUESTER_LOCKED_DETAIL });
}
