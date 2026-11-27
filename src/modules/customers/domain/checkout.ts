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
 * reader at once, without a job having to flip the column first. Judged on the injected clock (decision 031).
 *
 * @param status the stored status
 * @param expiresAt when the session runs out
 * @param now the clock's time
 * @returns the status the buyer sees
 */
export function effectiveStatus(status: CheckoutSessionStatus, expiresAt: Date, now: Date): CheckoutSessionStatus {
  return status === 'open' && expiresAt.getTime() <= now.getTime() ? 'expired' : status;
}

/**
 * Tells whether a checkout session is still in flight: open and not run out.
 *
 * Why: the guest claim must not move the records of a guest row that is paying right now (decision 064): an open session is a buyer
 * who may be on a payment page. A paid or expired session is history and moves with the rest. Judged like {@link effectiveStatus}, on the
 * injected clock.
 *
 * @param session the stored status and expiry
 * @param now the clock's time
 * @returns true when the session reads `open`
 */
export function isLiveCheckout(session: { status: CheckoutSessionStatus; expiresAt: Date }, now: Date): boolean {
  return effectiveStatus(session.status, session.expiresAt, now) === 'open';
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
 * Tells whether an address is on one of the shop's own origins.
 *
 * Why: decision 048: the gateway sends the buyer to the return address of a storefront payment, so it must be the shop's (scheme, host
 * and port of the storefront's or the portal's base URL, or of a configured shop origin), never another site, and never with a user name
 * or password.
 *
 * @param url the address to check
 * @param baseUrls the shop's base URLs and origins (one that does not parse is skipped)
 * @returns true when the address parses, has no user name or password, and its origin is the origin of one of `baseUrls`
 */
export function isShopAddress(url: string, baseUrls: readonly string[]): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (parsed.username !== '' || parsed.password !== '') return false;
  return baseUrls.some((base) => {
    try {
      return new URL(base).origin === parsed.origin;
    } catch {
      return false;
    }
  });
}

/**
 * Hides most of an email address: `ab•••@domain`.
 *
 * Why: the session link is a capability, but it can be forwarded or shown on a shared screen; the buyer knows their own address and
 * needs only enough to recognise it.
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
 * Hides the main input of a checkout (usually an IMEI) except its last four characters; a list shows only its first item so.
 *
 * Why: the session link can be forwarded or shown on a shared screen; the buyer recognises the phone by the end of its IMEI. Decision 076:
 * a main input of type `imei_bulk` is stored one IMEI per line (up to 30), so its line is the mask of its FIRST IMEI followed by
 * ` +N more` for the other items, short enough for a phone, instead of hundreds of bullets; a one-item list reads like one IMEI.
 *
 * @param imei the main input as stored (an IMEI as 15 digits, a list with line breaks)
 * @returns bullets and the last four characters of the first item (eleven and four for an IMEI), then ` +N more` when there are N other
 *   items
 */
export function maskImei(imei: string): string {
  const [first = '', ...others] = imei.split(/\r?\n/).filter((item) => item.trim() !== '');
  const masked = `${'•'.repeat(Math.max(0, first.length - 4))}${first.slice(-4)}`;
  return others.length === 0 ? masked : `${masked} +${others.length} more`;
}
