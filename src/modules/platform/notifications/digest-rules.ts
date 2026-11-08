// Pure rules of the daily price change digest (platform module, feature 12a, user rule 9): which day's digest an event joins, when it
// is sent, and how its items become the text a merchant reads.

/** The hour (UTC) a digest is sent: the day's digest covers the price changes since the same hour the day before. */
export const DIGEST_HOUR_UTC = 6;
/** Most items one digest lists; further changes only raise the count. */
export const MAX_DIGEST_ITEMS = 100;
/** The shortest wait before a digest send job runs: it covers the commit of the transaction that adds the job (see {@link digestSendDelay}). */
export const MIN_DIGEST_DELAY_MS = 10_000;
const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;

/** One digest period: a day that starts at 06:00 UTC. */
export interface DigestCycle {
  /** The UTC calendar day the period starts on, `YYYY-MM-DD`; part of the row's dedupe key. */
  readonly day: string;
  readonly startsAt: Date;
  /** When the digest of this period is sent: the start of the next one. */
  readonly sendAt: Date;
}

/**
 * Finds the digest period a moment belongs to.
 *
 * Why: "at most one digest per day": every price change that arrives between two 06:00 UTC marks joins one row, sent at the later
 * mark. A change arriving at 05:59 waits one minute, one at 06:01 waits a day: the wait is at most 24 hours.
 *
 * @param now the moment the event is processed (the injected clock)
 * @returns the period that moment is in
 */
export function digestCycleOf(now: Date): DigestCycle {
  const shifted = new Date(now.getTime() - DIGEST_HOUR_UTC * HOUR_MS);
  const day = shifted.toISOString().slice(0, 10);
  const startsAt = new Date(Date.parse(`${day}T00:00:00.000Z`) + DIGEST_HOUR_UTC * HOUR_MS);
  return { day, startsAt, sendAt: new Date(startsAt.getTime() + DAY_MS) };
}

/**
 * Works out how long the send job of a digest row waits.
 *
 * Why: the job is added to the queue before the transaction that makes the row commits. A change at 05:59:59.99x would give a delay of a
 * few milliseconds, so the job could run before its row is visible, find nothing and end, and the digest would be lost. The floor of
 * {@link MIN_DIGEST_DELAY_MS} leaves the commit time to finish; the schedule is otherwise the 06:00 UTC mark.
 *
 * @param cycle the period the row belongs to
 * @param now the moment the row is made (the injected clock)
 * @returns the delay in milliseconds, never less than {@link MIN_DIGEST_DELAY_MS}
 */
export function digestSendDelay(cycle: DigestCycle, now: Date): number {
  return Math.max(MIN_DIGEST_DELAY_MS, cycle.sendAt.getTime() - now.getTime());
}

/**
 * Builds the dedupe key of one merchant's digest on one channel in one period.
 *
 * @param event the event key (`service.price_changed`)
 * @param channel `email` or `telegram`
 * @param clientId the merchant
 * @param cycle the period
 * @returns the key stored on the notification row
 */
export function digestKey(event: string, channel: string, clientId: number, cycle: DigestCycle): string {
  return `digest:${event}:${channel}:${clientId}:${cycle.day}`;
}

/** One price change inside a digest. */
export interface DigestItem {
  /** The outbox event it came from; two deliveries of one event add it once. */
  readonly eventId: number;
  readonly serviceId: number;
  readonly serviceName: string;
  readonly previousPrice: string | null;
  readonly price: string;
  readonly currency: string;
}

/**
 * Adds an item to a digest unless the same event is already in it.
 *
 * Why: the planning job can run twice for one event (a retry after a crash); the digest must list a change once.
 *
 * @param items the items so far
 * @param item the new one
 * @returns the new list, or the same list when the event is already there or the digest is full
 */
export function addDigestItem(items: readonly DigestItem[], item: DigestItem): readonly DigestItem[] {
  if (items.some((existing) => existing.eventId === item.eventId)) return items;
  return items.length >= MAX_DIGEST_ITEMS ? items : [...items, item];
}

/**
 * Shows a money string the way a person reads it: at least two decimals, no useless zeros after that.
 *
 * @param value a decimal string such as `12.5000`
 * @returns for example `12.50`; the text itself when it is not a decimal
 */
export function shortMoney(value: string): string {
  if (!/^-?\d+(\.\d+)?$/.test(value)) return value;
  const [whole = '', fraction = ''] = value.split('.');
  const trimmed = fraction.replace(/0+$/, '').padEnd(2, '0');
  return `${whole}.${trimmed}`;
}

/**
 * Writes the digest's list of changes, one line per service.
 *
 * Why: the `changes` placeholder of the `service.price_changed` templates; the line names the service and both prices.
 *
 * @param items the digest items
 * @returns lines like `- Vodafone UK iPhone Unlock: 12.00 to 12.50 USD`, joined with line breaks
 */
export function describeChanges(items: readonly DigestItem[]): string {
  return items
    .map((item) =>
      item.previousPrice === null
        ? `- ${item.serviceName}: now ${shortMoney(item.price)} ${item.currency}`
        : `- ${item.serviceName}: ${shortMoney(item.previousPrice)} to ${shortMoney(item.price)} ${item.currency}`,
    )
    .join('\n');
}
