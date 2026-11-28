// The one-time links of accounts: the limits on the ones a visitor can ask for (the sign-in link, forgot password; decision 052) and the
// addresses the mails point at (decision 064). Pure constants and functions.
import type { AccountMailKind } from '../ports/account-mail-outbox';

/** The most live links of one family an account may hold when the visitor asked for them: the oldest goes first. */
export const MAX_LIVE_PUBLIC_LINKS = 3;

/**
 * An id no account has: the budget key of an email without an account, and the subject of a run that is rolled back.
 *
 * Why: decision 052. A request for an email that gets no mail runs the same statements as one that does, on this subject, and keeps
 * nothing. It is positive, so the outbox accepts it as an aggregate id, and it fits every bigint column the run writes.
 */
export const NO_ACCOUNT_ID = Number.MAX_SAFE_INTEGER;

/**
 * Where each mail's link points in the shop (`<storeBaseUrl><path>?token=<token>`).
 *
 * Why: decision 064: one shop serves every account, so every link of every rank points at the shop; the old merchant pages
 * (`/merchant/set-password`, `/merchant/verify-email`) redirect to these with the query kept.
 */
export const ACCOUNT_LINK_PATHS: Readonly<Record<AccountMailKind, string>> = {
  email_verification: '/verify-email',
  password_reset: '/set-password',
  invited: '/set-password',
  magic_link: '/sign-in',
  // The two mails of a sign-up carry sign-in links (decision 079): the shop's link page exchanges them like any other.
  sign_up_link: '/sign-in',
  sign_up_existing: '/sign-in',
};

/**
 * Builds the link of an account mail.
 *
 * @param storeBaseUrl the shop's base URL, without a trailing slash
 * @param kind which mail
 * @param token the clear token
 * @returns `<storeBaseUrl>/sign-in?token=<token>` (or `/set-password`, `/verify-email`)
 */
export function accountMailLink(storeBaseUrl: string, kind: AccountMailKind, token: string): string {
  return `${storeBaseUrl}${ACCOUNT_LINK_PATHS[kind]}?token=${encodeURIComponent(token)}`;
}

/** The path of the shop's sign-up page (decision 079), which the note to an address without an account names. */
export const SIGN_UP_PATH = '/en/sign-up';

/**
 * Builds the address of the shop's sign-up page.
 *
 * Why: decision 079: a sign-in link no longer makes an account; an address without one is mailed the page where an account is made.
 *
 * @param storeBaseUrl the shop's base URL, without a trailing slash
 * @returns `<storeBaseUrl>/en/sign-up`
 */
export function signUpPageUrl(storeBaseUrl: string): string {
  return `${storeBaseUrl}${SIGN_UP_PATH}`;
}

/** The path of the signed-in area of the shop, where a notification sends an account (the old `/merchant` area redirects here). */
export const ACCOUNT_AREA_PATH = '/account';

/**
 * Builds the address of a page of the signed-in area, for the links inside a notification.
 *
 * Why: decision 064 and the shop's route table: the merchant pages live under `/account`, whatever the rank; a notification that names
 * the area uses this path and never the retired `/merchant` one.
 *
 * @param storeBaseUrl the shop's base URL, without a trailing slash
 * @param page the page below the area, with a leading slash (for example `/wallet`), or none for the area's home
 * @returns `<storeBaseUrl>/account` followed by the page
 */
export function accountAreaUrl(storeBaseUrl: string, page = ''): string {
  return `${storeBaseUrl}${ACCOUNT_AREA_PATH}${page}`;
}
