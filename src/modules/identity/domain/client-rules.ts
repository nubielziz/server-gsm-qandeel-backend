// Pure rules of merchant management: the status machine, the Dhru username and referral code, and the suspension reason.
// No I/O, so the rules are unit-tested.
import type { ClientStatus } from '../db/schema';

/** The only allowed status changes (RULES merchants 1): approve, reactivate, suspend. */
const TRANSITIONS: Readonly<Record<ClientStatus, readonly ClientStatus[]>> = {
  pending: ['active'],
  suspended: ['active'],
  active: ['suspended'],
};

/**
 * Tells whether a merchant may move from one status to another.
 *
 * Why: `pending → active` (approve), `suspended → active` (reactivate), `active → suspended` (suspend); anything else is
 * `409 INVALID_TRANSITION` (identity.md, PATCH /admin/clients/:id).
 *
 * @param from the current status
 * @param to the wanted status
 * @returns true when the change is one of the three
 */
export function canMoveClient(from: ClientStatus, to: ClientStatus): boolean {
  return TRANSITIONS[from].includes(to);
}

/** The shortest and longest suspension reason (the console's dialog and the endpoint doc). */
export const SUSPEND_REASON_LENGTH = { min: 3, max: 140 } as const;

/**
 * Checks a suspension reason.
 *
 * @param reason the reason as sent (already trimmed)
 * @returns the sentence for the `reason` field, or `undefined` when it is acceptable
 */
export function suspendReasonProblem(reason: string | undefined): string | undefined {
  if (reason === undefined || reason.length < SUSPEND_REASON_LENGTH.min) {
    return `Say why, in at least ${SUSPEND_REASON_LENGTH.min} characters.`;
  }
  return reason.length > SUSPEND_REASON_LENGTH.max ? `Use at most ${SUSPEND_REASON_LENGTH.max} characters.` : undefined;
}

/**
 * Makes the first choice of a merchant's Dhru username from its name.
 *
 * Why: the username is what Dhru client software signs in with; it is lower case letters, digits and hyphens, and unique
 * case-insensitively. Collisions get a numeric suffix from {@link usernameCandidate}.
 *
 * @param name the merchant's name
 * @returns the slug, `merchant` when the name has no letters or digits
 */
export function usernameBase(name: string): string {
  const slug = name
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 30)
    .replace(/-+$/g, '');
  return slug === '' ? 'merchant' : slug;
}

/**
 * Names the nth candidate username: the base, then `base-2`, `base-3`, ...
 *
 * @param base the slug from {@link usernameBase}
 * @param attempt 1 for the base itself
 * @returns the candidate
 */
export function usernameCandidate(base: string, attempt: number): string {
  return attempt <= 1 ? base : `${base}-${attempt}`;
}

const REFERRAL_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

/**
 * Makes a referral code: `GSM` and six characters without look-alikes.
 *
 * @param pick returns a uniformly random whole number from 0 up to but not including `max`
 * @returns the code, for example `GSM7K3QXA`
 */
export function referralCode(pick: (max: number) => number): string {
  let code = 'GSM';
  for (let i = 0; i < 6; i++) code += REFERRAL_ALPHABET[pick(REFERRAL_ALPHABET.length)]!;
  return code;
}
