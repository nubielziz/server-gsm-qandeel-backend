// How long a support ticket's link opens it (decision 054): pure rules, no database and no clock of their own.

/**
 * How many days after its resolution a ticket's link stops opening it.
 *
 * Why: decision 054: a ticket's link stops working this long after the ticket was resolved; 180 is the default of
 * `support.attachmentRetentionDays`, so with the default settings the link and the files of a resolved ticket end together. Reopening the
 * ticket clears `resolved_at`, so the link works again. A fixed constant, not the setting: `0` there keeps the files for ever, which must
 * not mean that a link never ends.
 */
export const TICKET_LINK_DAYS_AFTER_RESOLUTION = 180;

const DAY_MS = 86_400_000;

/**
 * Tells whether a ticket's link still opens it.
 *
 * Why: decision 054 (see {@link TICKET_LINK_DAYS_AFTER_RESOLUTION}); an expired link answers the same `404` as an unknown one.
 *
 * @param resolvedAt when the ticket was resolved, or `null` while it is open
 * @param nowMs the injected clock's time in milliseconds
 * @returns true while the ticket is open, or until 180 days after its resolution
 */
export function ticketLinkOpen(resolvedAt: Date | null, nowMs: number): boolean {
  return resolvedAt === null || nowMs < resolvedAt.getTime() + TICKET_LINK_DAYS_AFTER_RESOLUTION * DAY_MS;
}
