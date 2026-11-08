// The pure rules of abandoned-checkout recovery (feature 19, RULES checkouts 2 to 4, ANSWERS checkouts 2 to 5): when a checkout may be
// emailed, why one is skipped, and the words of the recovery mail. No database, no clock: callers pass the clock's time.
import type { CheckoutSessionStatus } from '../db/schema';

/** The settings key of the delay before the one recovery email (RULES settings 3: minutes, 5 to 1440). */
export const ABANDONED_MINUTES_KEY = 'abandonedMinutes';

/** What the delay is when staff never set it (the demo's default). */
export const DEFAULT_ABANDONED_MINUTES = 60;

/** The accepted range of the delay, in minutes. */
export const ABANDONED_MINUTES_BOUNDS = { min: 5, max: 1440 } as const;

/**
 * How long after the checkout a recovery email may still go out, and how far back the abandoned list looks (days).
 *
 * Why: ANSWERS checkouts 3 and 8: recovery stops 30 days after the checkout; the list shows the last 30 days (the demo's strip).
 */
export const RECOVERY_WINDOW_DAYS = 30;

/** The most checkout ids one `POST /admin/checkouts/recover` call takes (ANSWERS checkouts 4). */
export const RECOVERY_MAX_IDS = 100;

/** The most checkouts one run of the automatic reminder job emails. */
export const REMINDER_BATCH_SIZE = 200;

/**
 * Why a checkout was left out of a recovery send.
 *
 * Why: the console's four codes (`not_found`, `already_emailed`, `already_paid`, `no_marketing_consent`, M133), the two ANSWERS
 * checkouts 4 adds (`too_recent`, `expired`), `recipient_suspended` for a customer who is suspended or blocked (marketing mail goes to
 * active customers only) and two for a mail that has no template to send (`no_template`, `template_off`): any other code is printed
 * with spaces instead of underscores, so the console needs no change.
 */
export const SKIP_REASONS = [
  'not_found',
  'already_emailed',
  'already_paid',
  'no_marketing_consent',
  'recipient_suspended',
  'too_recent',
  'expired',
  'no_template',
  'template_off',
] as const;

/** One value of {@link SKIP_REASONS}. */
export type SkipReason = (typeof SKIP_REASONS)[number];

/** The parts of a checkout session the recovery rule reads. */
export interface RecoverySession {
  readonly createdAt: Date;
  readonly recoveryEmailedAt: Date | null;
  readonly orderId: number | null;
  readonly status: CheckoutSessionStatus;
  /** True when the session's customer exists and is `active` (a suspended or blocked customer gets no marketing mail). */
  readonly customerActive: boolean;
}

const MINUTE_MS = 60_000;
const DAY_MS = 86_400_000;

/**
 * The two moments that bound a recoverable checkout.
 *
 * Why: the list's `canRecover` filter, the job's selection and the per-id verdict must use the same two times, so they come from
 * one function: a checkout is due once it is at least `delayMinutes` old (`createdAt <= dueBefore`) and stays recoverable for 30
 * days (`createdAt >= notBefore`).
 *
 * @param now the injected clock's time (decision 031)
 * @param delayMinutes the `abandonedMinutes` setting
 * @returns the latest creation time that is due, and the earliest that is still recoverable
 */
export function recoveryBounds(now: Date, delayMinutes: number): { dueBefore: Date; notBefore: Date } {
  return {
    dueBefore: new Date(now.getTime() - delayMinutes * MINUTE_MS),
    notBefore: new Date(now.getTime() - RECOVERY_WINDOW_DAYS * DAY_MS),
  };
}

/**
 * Tells whether a session counts as paid.
 *
 * Why: a paid session has an order (`order_id`); the stored status says the same, and either one means nothing is left to recover.
 *
 * @param session the session's parts
 * @returns true when it is paid
 */
export function isPaid(session: Pick<RecoverySession, 'orderId' | 'status'>): boolean {
  return session.orderId !== null || session.status === 'paid';
}

/**
 * Decides whether a checkout may get its recovery email now, and if not, why.
 *
 * Why: RULES checkouts 4 and ANSWERS checkouts 4: the server decides per id, in this order: the checkout exists, no recovery email
 * went out before, it is not paid, the customer agreed to marketing email, the customer is active, it is at least `abandonedMinutes`
 * old and not older than 30 days. The first failing check is the reason. The same rule decides the manual send and the automatic
 * reminder; `canRecover` of the list is this function returning `null`, and the SQL twin of the list filter (`canRecoverSql`) is
 * kept equal to it by a test.
 *
 * @param session the checkout, or `undefined` when there is none
 * @param consent whether the customer's marketing consent holds (`marketingConsent` of the list row)
 * @param now the injected clock's time
 * @param delayMinutes the `abandonedMinutes` setting
 * @returns the reason to skip it, or `null` when it may be emailed
 */
export function recoveryVerdict(
  session: RecoverySession | undefined,
  consent: boolean,
  now: Date,
  delayMinutes: number,
): SkipReason | null {
  if (session === undefined) return 'not_found';
  if (session.recoveryEmailedAt !== null) return 'already_emailed';
  if (isPaid(session)) return 'already_paid';
  if (!consent) return 'no_marketing_consent';
  if (!session.customerActive) return 'recipient_suspended';
  const { dueBefore, notBefore } = recoveryBounds(now, delayMinutes);
  if (session.createdAt.getTime() > dueBefore.getTime()) return 'too_recent';
  if (session.createdAt.getTime() < notBefore.getTime()) return 'expired';
  return null;
}

/**
 * The address the recovery mail links to.
 *
 * Why: the endpoint doc's "one-click link back to the saved basket": the storefront reads the session by its token
 * (`GET /store/v1/checkout-sessions/:token`) and starts a fresh checkout at today's price (ANSWERS checkouts 3). The token is the
 * checkout's capability (decision 010), so the link goes into the mail as a secret and is never stored on the notification row.
 *
 * @param storeBaseUrl the storefront's base URL, without a trailing slash
 * @param token the checkout session's token
 * @returns `<storeBaseUrl>/checkout/resume?token=<token>`
 */
export function recoveryLink(storeBaseUrl: string, token: string): string {
  return `${storeBaseUrl}/checkout/resume?token=${encodeURIComponent(token)}`;
}

/** What the TAC catalogue knows about a device, as the mail needs it. */
export interface DeviceFacts {
  readonly brand: string;
  readonly model: string;
  readonly marketingName: string;
}

/** The words used for a device the catalogue does not know. */
export const UNKNOWN_DEVICE = 'your phone';

/**
 * The device name for the mail's `{{device}}`.
 *
 * Why: the default text reads "you started an unlock for {{device}}": the marketing name when the catalogue has one (`iPhone 13`),
 * else brand and model, else a plain "your phone" (an order with no IMEI, or a TAC the catalogue lacks).
 *
 * @param device the catalogue entry of the IMEI's TAC, if any
 * @returns the name to print
 */
export function deviceName(device: DeviceFacts | undefined): string {
  if (device === undefined) return UNKNOWN_DEVICE;
  const marketing = device.marketingName.trim();
  if (marketing !== '') return marketing;
  const named = `${device.brand} ${device.model}`.trim();
  return named === '' ? UNKNOWN_DEVICE : named;
}

/**
 * The name the mail greets.
 *
 * Why: a guest customer has no name (`customers.name` is empty), and "Hi ," reads badly.
 *
 * @param name the customer's name, possibly empty
 * @returns the name, or `there`
 */
export function greetingName(name: string): string {
  const trimmed = name.trim();
  return trimmed === '' ? 'there' : trimmed;
}
