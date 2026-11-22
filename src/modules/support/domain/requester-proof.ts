// When a ticket's requester address counts as proven (decision 053): the one rule the public ticket form, the customer's list, the live
// streams and the resolve survey share.
import type { SupportTicket } from '../db/schema';

/**
 * The staff note written after the first message of a ticket opened on the contact form with a typed email address.
 *
 * Why: decision 053. Anyone can type an address; the thread tells staff that the address is not confirmed and what that hides.
 */
export const UNPROVEN_TICKET_NOTE =
  'Opened on the contact form by someone who typed this email address. The address is not confirmed yet: the ticket stays off the customer’s account until the link in the receipt email is opened.';

/**
 * The staff note written when the link of the receipt email is first used.
 *
 * Why: decision 053. The link goes only to the typed address, so using it confirms that its holder reads that mailbox.
 */
export const PROVEN_TICKET_NOTE =
  'The requester opened the link from the receipt email: the email address is confirmed.';

/**
 * Tells whether the requester's address of a ticket is proven.
 *
 * Why: decision 053. An unproven ticket stays off the customer's account list and live account stream and gets no satisfaction survey.
 *
 * @param ticket the ticket (only `requesterProvenAt` is read)
 * @returns true when the address was proven when the ticket was made or later
 */
export function isRequesterProven(ticket: Pick<SupportTicket, 'requesterProvenAt'>): boolean {
  return ticket.requesterProvenAt !== null;
}
