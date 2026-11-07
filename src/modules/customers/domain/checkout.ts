// The pure rules of storefront checkout sessions and consents (feature 14a): how long a session lives, which consents it needs, how
// a session's status and consent state are worked out, and how the buyer's own data is masked. No database.
import type { CheckoutSessionStatus, ConsentPurpose } from '../db/schema';

/** How long an open checkout session holds its locked price, tax and exchange rate (minutes). */
export const CHECKOUT_SESSION_TTL_MINUTES = 30;

/** The encryption context of `checkout_sessions.imei_enc` (decision 019: `<table>.<column>`). */
export const CHECKOUT_IMEI_AAD = 'checkout_sessions.imei_enc';

/** The longest user agent kept on a session or a consent record. */
export const MAX_USER_AGENT_LENGTH = 500;

/**
 * The consents a checkout needs before it can be paid.
 *
 * Why: the map's consent route records "terms, the privacy policy and the waiver of the withdrawal right"; the waiver is a policy
 * switch (RULES settings 5: `withdrawalWaiver` on means checkout records it). The refund policy and marketing are recorded when
 * the buyer gives them but never block payment.
 *
 * @param withdrawalWaiver the policy switch
 * @returns the required purposes
 */
export function requiredConsents(withdrawalWaiver: boolean): readonly ConsentPurpose[] {
  return withdrawalWaiver ? ['terms', 'privacy', 'withdrawal_waiver'] : ['terms', 'privacy'];
}

/** The legal document type a consent purpose points at; the waiver and marketing have no document (RESOLUTIONS b2c-14). */
export const LEGAL_TYPE_OF_PURPOSE = {
  terms: 'terms',
  privacy: 'privacy',
  refund_policy: 'refund',
  withdrawal_waiver: null,
  marketing: null,
} as const satisfies Record<ConsentPurpose, 'terms' | 'privacy' | 'refund' | null>;

/**
 * The status a session has now.
 *
 * Why: RESOLUTIONS b2c-14: the stored status is `open`, `paid` or `expired`; an open session past `expires_at` is expired for every
 * reader at once, without a job having to flip the column first (the abandoned-checkouts report reads open sessions past their
 * expiry). Judged on the injected clock (decision 031).
 *
 * @param status the stored status
 * @param expiresAt when the session runs out
 * @param now the clock's time
 * @returns the status the buyer sees
 */
export function effectiveStatus(status: CheckoutSessionStatus, expiresAt: Date, now: Date): CheckoutSessionStatus {
  return status === 'open' && expiresAt.getTime() <= now.getTime() ? 'expired' : status;
}

/** One consent record as the state needs it. */
export interface ConsentFact {
  readonly purpose: ConsentPurpose;
  readonly granted: boolean;
  readonly createdAt: Date;
  readonly id: number;
}

/** Where a session's consent stands. */
export interface ConsentState {
  readonly required: readonly ConsentPurpose[];
  /** The purposes whose latest record is a grant, in the order of {@link CONSENT_ORDER}. */
  readonly granted: readonly ConsentPurpose[];
  /** True when every required purpose is granted. */
  readonly complete: boolean;
}

/** The order purposes are listed in. */
export const CONSENT_ORDER: readonly ConsentPurpose[] = [
  'terms',
  'privacy',
  'refund_policy',
  'withdrawal_waiver',
  'marketing',
];

/**
 * Works out where a session's consent stands.
 *
 * Why: consent records are append-only proof (a withdrawn consent is a new row), so the latest record per purpose decides.
 *
 * @param facts the session's consent records, any order
 * @param required the purposes the checkout needs
 * @returns the required list, what is granted now and whether the session is complete
 */
export function consentState(facts: readonly ConsentFact[], required: readonly ConsentPurpose[]): ConsentState {
  const latest = new Map<ConsentPurpose, ConsentFact>();
  for (const fact of facts) {
    const seen = latest.get(fact.purpose);
    if (
      seen === undefined ||
      fact.createdAt.getTime() > seen.createdAt.getTime() ||
      (fact.createdAt.getTime() === seen.createdAt.getTime() && fact.id > seen.id)
    ) {
      latest.set(fact.purpose, fact);
    }
  }
  const granted = CONSENT_ORDER.filter((purpose) => latest.get(purpose)?.granted === true);
  return { required, granted, complete: required.every((purpose) => granted.includes(purpose)) };
}

/**
 * The consent state as the wire carries it.
 *
 * @param state the state
 * @returns plain mutable arrays and the flag
 */
export function consentOf(state: ConsentState): {
  required: ConsentPurpose[];
  granted: ConsentPurpose[];
  complete: boolean;
} {
  return { required: [...state.required], granted: [...state.granted], complete: state.complete };
}

/**
 * Hides most of an email address: `ab•••@domain`.
 *
 * Why: the session link is a capability, but it can be forwarded or shown on a shared screen; the buyer knows their own address and
 * needs only enough to recognise it (the abandoned-checkouts rows use the same mask, ANSWERS customers).
 *
 * @param email the address
 * @returns the first two characters of the local part, three bullets and the domain
 */
export function maskEmail(email: string): string {
  const at = email.lastIndexOf('@');
  if (at <= 0) return '•••';
  return `${email.slice(0, Math.min(2, at))}•••${email.slice(at)}`;
}

/**
 * Hides an IMEI except its last four digits.
 *
 * @param imei the 15 digits
 * @returns eleven bullets and the last four digits
 */
export function maskImei(imei: string): string {
  return `${'•'.repeat(Math.max(0, imei.length - 4))}${imei.slice(-4)}`;
}
