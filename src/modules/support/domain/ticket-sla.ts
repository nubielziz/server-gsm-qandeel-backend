// The reply targets of a ticket (support module, RULES support 2, MISMATCHES B62): the default priority of a category, the target of a
// priority and when the next reply is due. Pure: callers pass the time, nothing here reads the clock (decision 031).
import type { TicketCategory, TicketPriority, TicketStatus } from '../db/schema';

const HOUR_MS = 3_600_000;

/**
 * How long a customer may wait for a reply, by priority: 2 hours for high, 8 for normal, 24 for low.
 *
 * Why: the demo's `PRIO_TARGET` (RULES support 2); the dashboard's late-ticket rule and the inbox's `late` flag both use these.
 */
export const PRIORITY_TARGET_MS: Readonly<Record<TicketPriority, number>> = {
  high: 2 * HOUR_MS,
  normal: 8 * HOUR_MS,
  low: 24 * HOUR_MS,
};

/**
 * The priority a new ticket starts with, from its category.
 *
 * Why: B62 (accepted): the category sets the default priority. The demo makes a phone that is still locked after an unlock `high` and
 * the rest `normal`; a refund request is `high` too (money is waiting), and a question before buying, a how-to or anything else is `low`.
 * Staff change it afterwards.
 *
 * @param category the ticket's category
 * @returns the starting priority
 */
export function defaultPriority(category: TicketCategory): TicketPriority {
  switch (category) {
    case 'failed_unlock':
    case 'refund':
      return 'high';
    case 'presale':
    case 'howto':
    case 'other':
      return 'low';
    case 'delay':
    case 'billing':
    case 'wrong_imei':
      return 'normal';
  }
}

/** The last message a person could see on a ticket: who wrote it and when. */
export interface LastPublicMessage {
  /** True for the requester's side (a customer or a merchant), false for staff. */
  readonly fromRequester: boolean;
  readonly at: Date;
}

/**
 * Works out when the next reply is due.
 *
 * Why: RULES support 2: a reply is awaited when the ticket is `new` or `open` and the last public message came from the requester's
 * side; it is due that message's time plus the priority's target. After a public staff reply, while the ticket waits on the customer
 * and once it is resolved nobody is waiting, so the answer is `null`. The same rule runs when a ticket is created, when the customer
 * writes, when the priority changes and when a ticket is reopened, so `sla_due_at` never drifts from the thread.
 *
 * @param status the stored status the ticket has (after the change being made)
 * @param priority the priority the ticket has (after the change being made)
 * @param last the last non-internal message, or `undefined` for a ticket without one
 * @returns the due time, or `null` when nobody waits for a reply
 */
export function slaDueAt(
  status: TicketStatus,
  priority: TicketPriority,
  last: LastPublicMessage | undefined,
): Date | null {
  if (status !== 'new' && status !== 'open') return null;
  if (last === undefined || !last.fromRequester) return null;
  return new Date(last.at.getTime() + PRIORITY_TARGET_MS[priority]);
}

/**
 * Tells whether a ticket is late.
 *
 * Why: the inbox flag and the dashboard's attention rule: a reply is awaited and its due time has passed. The list's `late` filter and
 * sort say the same in SQL (`ticket.repository.ts`).
 *
 * @param dueAt the ticket's `sla_due_at`
 * @param status the stored status
 * @param now the time to judge at (the injected clock's)
 * @returns true when a reply is overdue
 */
export function isLate(dueAt: Date | null, status: TicketStatus, now: Date): boolean {
  return dueAt !== null && status !== 'resolved' && dueAt.getTime() < now.getTime();
}
