// Route contracts of the shop's sign-in routes (map domain I, stage 14, routes /store/v1/auth/* and /store/v1/me/password; decisions 064
// and 079): sign-in link, sign-up with details and its finish, link exchange, password sign-in, password reset by email, choosing a password
// and sign-out.
// The password routes are aliases of the `/client/auth/*` ones (one use case each; the contract release retires them). The shop is another
// frontend, so these shapes are the specs of docs/contract/MISMATCHES.md (feature 14b) and ALIGNMENT § 7.
import { z } from 'zod';
import { defineRoute } from '../../../common/contract';
import {
  SIGN_UP_NAME_MAX_LENGTH,
  SIGN_UP_PHONE_DIGITS,
  type SignUpNamePart,
  cleanSignUpName,
  cleanSignUpPhone,
  signUpFullNameProblem,
  signUpNameProblem,
  signUpPhoneProblem,
} from '../../identity/ports/sign-up-fields';
import { CountryField, EmailField } from './shared';
import { StoreMeSchema, STORE_ME_EXAMPLE } from './store-account.contracts';

/**
 * What the shop does after the password: choose a new one (temporary password), type the authenticator code (an account with two-step
 * sign-in on), or the sign-in is complete.
 */
export const StoreNext = z.enum(['password', 'totp', 'done']);

const TokenField = z.string().min(1).max(512);

/**
 * The answer of `POST /store/v1/auth/verify`: the account the link opened (`AccountMe`), whether this browser asked for the link, whose
 * account it was, the next step and what the optional claim of guest orders did.
 */
export const StoreVerifySchema = StoreMeSchema.extend({
  requestedHere: z
    .boolean()
    .describe(
      'True when this browser asked for the link (it carries the cookie of `POST /store/v1/auth/magic-link`); false for a link asked ' +
        'for in another browser or sent by the shop: the shop then shows whose account was opened (`maskedEmail`).',
    ),
  maskedEmail: z.string().describe('The address of the account the link opened, masked (`da•••@example.com`).'),
  next: z
    .enum(['totp', 'done'])
    .describe(
      '`totp` when two-step sign-in still wants a code (a `pending_totp` session: finish with `POST /client/auth/2fa`), `done` otherwise.',
    ),
  claimedOrders: z
    .number()
    .int()
    .min(0)
    .describe(
      'How many guest orders (and their records) moved onto the account; 0 when the box was not ticked or nothing matched.',
    ),
  claimSkipped: z
    .literal('busy')
    .optional()
    .describe(
      '`busy` when the claim gave up because another request holds a row it needs: the sign-in still succeeded, ask for a new link later.',
    ),
  passwordSet: z
    .boolean()
    .optional()
    .describe(
      'Only for a link mailed by `POST /store/v1/auth/sign-up` that made the account (decision 079): true when the form was applied (the ' +
        'name, country, phone and password), which happens when the link is opened in the browser that sent the form; false when it was ' +
        'opened in another browser: the account exists and is signed in, but nothing of the form was applied (no name, country, phone or ' +
        'password), and `pendingDetails` shows what was typed so the person can confirm or correct it with ' +
        '`POST /store/v1/auth/sign-up/finish`. Absent for every other link, and for a sign-up link of an address that already had an ' +
        'account (then it was a plain sign-in and nothing was applied).',
    ),
  pendingDetails: z
    .object({
      firstName: z.string(),
      lastName: z.string(),
      country: z.string().describe('ISO 3166 alpha-2, upper case.'),
      phone: z.string().describe('The cleaned form: an optional leading `+` and 7 to 15 digits.'),
    })
    .optional()
    .describe(
      'Only with `passwordSet: false`: the details of the sign-up form as typed (never the password), shown only to the person who proved ' +
        'the mailbox. Nothing of them was applied; send them back, corrected if need be, with a password to ' +
        '`POST /store/v1/auth/sign-up/finish`.',
    ),
});

/** The longest text a name of the sign-up form may be before it is trimmed (the trimmed name has at most 60 characters). */
const RAW_NAME_MAX = 256;
/** The longest a typed phone number may be before its separators are removed. */
const RAW_PHONE_MAX = 64;

/**
 * A first or a last name of the sign-up form: trimmed, then 1 to 60 characters without a control character (identity's rule).
 *
 * @param part which name, for the sentence
 * @returns the field schema
 */
function signUpNameField(part: SignUpNamePart) {
  const label = part === 'first' ? 'first' : 'last';
  return z
    .string()
    .max(RAW_NAME_MAX, `Use at most ${SIGN_UP_NAME_MAX_LENGTH} characters.`)
    .transform(cleanSignUpName)
    .superRefine((name, ctx) => {
      const problem = signUpNameProblem(name, part);
      if (problem !== undefined) ctx.addIssue({ code: 'custom', message: problem });
    })
    .describe(
      `The ${label} name: trimmed, then 1 to ${SIGN_UP_NAME_MAX_LENGTH} characters, no line break or other control character; any script.`,
    );
}

/** The phone of the sign-up form: spaces, dashes, dots and brackets removed, then an optional leading `+` and 7 to 15 digits. */
const SignUpPhoneField = z
  .string()
  .max(RAW_PHONE_MAX, signUpPhoneProblem(''))
  .transform(cleanSignUpPhone)
  .superRefine((phone, ctx) => {
    const problem = signUpPhoneProblem(phone);
    if (problem !== undefined) ctx.addIssue({ code: 'custom', message: problem });
  })
  .describe(
    `The phone number with its country code. Spaces, dashes, dots and brackets are removed; what is left must be an optional leading \`+\` and ` +
      `${SIGN_UP_PHONE_DIGITS.min} to ${SIGN_UP_PHONE_DIGITS.max} digits, and is stored in that form (\`+962791234567\`).`,
  );

/** The password of a sign-up form, as typed; the policy is judged by the use case (it needs the email and the names). */
const SignUpPasswordField = z
  .string()
  .min(1)
  .max(1024)
  .describe('The password, as typed: at least 10 characters, not trivial, without the email or the names.');

/** The fields of a sign-up besides the email: the same rules for the sign-up and for its finish (decision 079). */
const SIGN_UP_DETAILS = {
  password: SignUpPasswordField,
  firstName: signUpNameField('first'),
  lastName: signUpNameField('last'),
  country: CountryField.describe(
    'ISO 3166 alpha-2 (any case): a country of the shop’s tax windows (`taxRates` of `GET /store/v1/config`), or any country when there is none.',
  ),
  phone: SignUpPhoneField,
};

/**
 * The rule of the two names together, for the body of a sign-up and of its finish: the account's name (first, a space, last) has at most
 * 120 characters, the limit of every account name; the sentence is on `lastName` (the review of decision 079, S4).
 *
 * @param value the parsed body (the names trimmed)
 * @param ctx the refinement context the issue goes to
 */
function fullNameRule(value: { readonly firstName: string; readonly lastName: string }, ctx: z.RefinementCtx): void {
  const problem = signUpFullNameProblem(value.firstName, value.lastName);
  if (problem !== undefined) ctx.addIssue({ code: 'custom', path: ['lastName'], message: problem });
}

/** `POST /store/v1/auth/magic-link`. */
export const requestMagicLink = defineRoute({
  key: 'POST /store/v1/auth/magic-link',
  summary: 'Email a sign-in link',
  description:
    'Answers `204` whatever the email is, so it cannot be used to find out who has an account. The link is for a retail account that ' +
    'may act: a merchant rank, a suspended, blocked or anonymized account, and a blocklisted email get nothing, with the same answer. ' +
    'Since decision 079 a link no longer makes an account: an address that has no account (unknown, or known only from a guest checkout) ' +
    'gets a short mail instead, which says that no account uses it yet and names the sign-up page of the shop (`/en/sign-up`, where ' +
    '`POST /store/v1/auth/sign-up` makes one); a link mailed before that release still works until it expires. ' +
    'The link is valid one hour and works once; up to three such links work at once (a fourth replaces the oldest), and at most ' +
    'five mails (links or notes) go out an hour per address; a request beyond that answers `204` and sends nothing. Counted per ' +
    'network and email, whether or not the email exists, in the budget `POST /store/v1/auth/sign-up` shares. Needs the anti-bot token ' +
    '(`X-Turnstile-Token`). Every answer sets an HttpOnly cookie that lives as long as a link and marks the browser that asked for it ' +
    '(`POST /store/v1/auth/verify` reads it).',
  tags: ['storefront-auth'],
  surface: 'store',
  access: 'public',
  turnstile: true,
  csrf: false,
  body: z.object({ email: EmailField }),
  success: { status: 204 },
  errors: ['VALIDATION_FAILED', 'IP_NOT_ALLOWED', 'RATE_LIMITED'],
  examples: { request: { email: 'daniel.whitmore@example.com' } },
});

/** `POST /store/v1/auth/sign-up`. */
export const signUpCustomer = defineRoute({
  key: 'POST /store/v1/auth/sign-up',
  summary: 'Sign up with the full details',
  description:
    'Makes a shop account (decision 079): every field is required. Answers `204` for every valid body whoever holds the email, so it ' +
    'cannot be used to find out who has an account (the password is hashed before the address is looked up, in every case). For an address ' +
    'that already has an account it mails, where `POST /store/v1/auth/magic-link` would mail its sign-in link, that link in a mail that ' +
    'says "You already have an account. Nothing was changed." (nothing for an account that gets no link), and keeps nothing of the form. ' +
    'For any other address it mails "Finish creating your account" with a sign-in link valid one hour ("no account is made until the link ' +
    'is opened"), and the form waits beside that link (the password only as an argon2id hash). Each link keeps its own form: a second ' +
    'sign-up mails a second link, and whichever link is opened first applies its own form and ends the others. Opening the link ' +
    '(`POST /store/v1/auth/verify`) in the browser that sent the form makes the account with the name (first name, a space, last name), ' +
    'the country (and the shop currency it derives), the phone and the password, and signs it in (`passwordSet: true`). Opened in any other ' +
    'browser it makes the account and signs it in with nothing of the form (`passwordSet: false`, and `pendingDetails` to confirm with ' +
    '`POST /store/v1/auth/sign-up/finish`), because anywhere else the form could be a stranger’s: someone who signed up with your address ' +
    'could otherwise sign in to your account with a password of their own. `422` names the field: `password` with `WEAK_PASSWORD` and the ' +
    'policy’s sentence (at least 10 characters, not trivial, without the email or the names), `country` with code `unsupported` for a ' +
    'country outside the shop’s tax windows (any listed country when there are none), `lastName` when both names together pass 119 ' +
    'characters, and `email`, `firstName`, `lastName` and `phone` for their shapes (names and phone refuse line breaks, tabs and ' +
    'invisible direction marks). The budget of `POST /store/v1/auth/magic-link` (per network and email, and five mails an hour per address) ' +
    'covers both routes. Needs the anti-bot token (`X-Turnstile-Token`). Every answer sets the HttpOnly cookie of the asking browser, as ' +
    '`POST /store/v1/auth/magic-link` does.',
  tags: ['storefront-auth'],
  surface: 'store',
  access: 'public',
  turnstile: true,
  csrf: false,
  body: z.object({ email: EmailField, ...SIGN_UP_DETAILS }).superRefine(fullNameRule),
  success: { status: 204 },
  errors: ['VALIDATION_FAILED', 'WEAK_PASSWORD', 'IP_NOT_ALLOWED', 'RATE_LIMITED'],
  examples: {
    request: {
      email: 'daniel.whitmore@example.com',
      password: 'a-long-password',
      firstName: 'Daniel',
      lastName: 'Whitmore',
      country: 'GB',
      phone: '+44 7700 900123',
    },
  },
});

/** `POST /store/v1/auth/sign-up/finish`. */
export const finishCustomerSignUp = defineRoute({
  key: 'POST /store/v1/auth/sign-up/finish',
  summary: 'Finish the sign-up of my account',
  description:
    'For a signed-in retail account that has no password yet (decision 079): a sign-up link opened in another browser than the one that ' +
    'sent the form (`passwordSet: false` with `pendingDetails`), or an older account made by a sign-in link without details. The body has ' +
    'exactly the rules of `POST /store/v1/auth/sign-up` without the email. It sets the name (first name, a space, last name), the country ' +
    '(and the shop currency it derives when the country differs from the stored one: an account that keeps its country keeps its ' +
    'currency), the phone and the password; the password ends a forced change and voids open invitation and reset links, every other ' +
    'session of the account ends while this one stays, and the address of the account gets the security notice that a password was set. ' +
    'Answers the account (`AccountMe`, as `GET /store/v1/me`). Only a session opened at most 60 minutes ago may finish: an older one is ' +
    '`409 CONFLICT` ("For your security, finish creating your account within an hour of opening the sign-in link. Ask for a new sign-in ' +
    'link, open it and try again."), and nothing is written. An account that already has a password is `409 CONFLICT` too (change it ' +
    'with `POST /store/v1/me/password`). `422` names the field as the sign-up does (`WEAK_PASSWORD` on `password`, code `unsupported` ' +
    'on `country`). Five tries per account in 15 minutes.',
  tags: ['storefront-auth'],
  surface: 'store',
  access: 'customer-session',
  sessionStages: ['active'],
  body: z.object(SIGN_UP_DETAILS).superRefine(fullNameRule),
  success: { status: 200, schema: StoreMeSchema },
  errors: [
    'VALIDATION_FAILED',
    'WEAK_PASSWORD',
    'CONFLICT',
    'UNAUTHORIZED',
    'ACCOUNT_SUSPENDED',
    'CSRF_FAILED',
    'IP_NOT_ALLOWED',
    'RATE_LIMITED',
  ],
  examples: {
    request: {
      password: 'a-long-password',
      firstName: 'Daniel',
      lastName: 'Whitmore',
      country: 'GB',
      phone: '+44 7700 900123',
    },
    response: {
      ...STORE_ME_EXAMPLE,
      name: 'Daniel Whitmore',
      country: 'GB',
      phone: '+447700900123',
      hasPassword: true,
    },
  },
});

/** `POST /store/v1/auth/verify`. */
export const verifyMagicLink = defineRoute({
  key: 'POST /store/v1/auth/verify',
  summary: 'Exchange a sign-in link for a session',
  description:
    'Spends the link (single use), marks the email verified on first use, turns a guest of that email into an account holder and opens a ' +
    'session: the cookies and the `X-CSRF-Token` header come with the answer, which is the account (`AccountMe`) plus ' +
    '`requestedHere`, `maskedEmail`, `next`, `claimedOrders`, `claimSkipped` and, for a link of a sign-up, `passwordSet` and ' +
    '`pendingDetails`. A link mailed by `POST /store/v1/auth/sign-up` (decision 079) that makes the account applies its form (name, ' +
    'country, phone and password) only when it is opened in the browser that sent the form (`passwordSet: true`); opened elsewhere it ' +
    'applies nothing and answers `passwordSet: false` with the details as typed (`pendingDetails`, never the password) for ' +
    '`POST /store/v1/auth/sign-up/finish`. Every waiting form of the address is deleted whatever happens, and an address that already had ' +
    'an account keeps what it has (a plain sign-in: neither key). `next` is `totp` when the account has two-step sign-in on ' +
    '(the session is then a `pending_totp` one, finished by `POST /client/auth/2fa`) and `done` otherwise. `claimGuestOrders: true` asks ' +
    'to move the orders and records of the guest row of the same email onto the account (the mailbox is proven by this link, only the ' +
    'retail rank is offered it): `claimedOrders` says how many moved, and `claimSkipped: busy` says the claim gave up because another ' +
    'request holds one of the rows (the sign-in itself still succeeded; ask for a new link later). In the browser that asked for the link ' +
    '(the cookie of `POST /store/v1/auth/magic-link`) it signs in as before (`requestedHere` true). Anywhere else, while the browser holds ' +
    'a live session of another account, it is `409 CONFLICT` (sign out first): that session stays and the link is not spent; in a browser ' +
    'without such a session it signs in with `requestedHere` false, and the shop shows whose account was opened. A link that ' +
    'is unknown, used, expired or replaced, or belongs to an account that may not act, or whose email gained a login account since the ' +
    'mail was sent, is `410 TOKEN_INVALID`; so is a link of a merchant rank, and so is a verification link: that one is answered by ' +
    '`POST /client/auth/verify-email`, which never opens a session (decision 052). Accepted only with an `Origin` header ' +
    'that is one of the shop’s origins, like the public `/client` sign-in routes (`403 CSRF_FAILED` otherwise).',
  tags: ['storefront-auth'],
  surface: 'store',
  access: 'link-token',
  csrf: false,
  originCheck: true,
  body: z.object({
    token: TokenField,
    claimGuestOrders: z
      .boolean()
      .optional()
      .describe(
        'Move the orders of the guest row of this email onto the account (offered after the mailbox was proven); default false.',
      ),
  }),
  success: { status: 200, schema: StoreVerifySchema },
  errors: ['VALIDATION_FAILED', 'TOKEN_INVALID', 'CONFLICT', 'IP_NOT_ALLOWED', 'RATE_LIMITED', 'CSRF_FAILED'],
  examples: {
    request: { token: 'k3Jx9Qd7mT2vN8bR5yHc1WzA4uLsE6oPgF0iVtXnDqM', claimGuestOrders: true },
    response: {
      ...STORE_ME_EXAMPLE,
      requestedHere: true,
      maskedEmail: 'da•••@example.com',
      next: 'done',
      claimedOrders: 2,
    },
  },
});

/** `POST /store/v1/auth/login`. */
export const loginCustomer = defineRoute({
  key: 'POST /store/v1/auth/login',
  summary: 'Sign in with email and password',
  description:
    'An alias of `POST /client/auth/sign-in` that answers only `next`: the same use case, the same budget and the same lock. Opens a session: ' +
    'a full one, a `pending_password` one when the account must change a temporary password first (`next` `password`: continue with ' +
    '`POST /client/auth/password/change`), or a `pending_totp` one when two-step sign-in is on (`next` `totp`: continue with ' +
    '`POST /client/auth/2fa`). One `401` answers an unknown email, a wrong ' +
    'password and an account with no password yet. A correct password on a suspended or blocked account is `403 ' +
    'ACCOUNT_SUSPENDED`. Five attempts per email and network in 15 minutes, and ten failed attempts (a success in between does not cancel them) lock the email ' +
    '(known or not, so the answer never shows who has an account) for 15 minutes for every network its account has not signed in ' +
    'from: both answer `429 RATE_LIMITED` with `Retry-After`. While the lock runs, the attempts a network the account has signed in from is ' +
    'still allowed share one budget per network: five in 15 minutes, then `429 RATE_LIMITED` like any other attempt. A temporary password works for 72 hours after it was set; after that ' +
    'it is refused like a wrong password. ' +
    'Needs the anti-bot token (`X-Turnstile-Token`). Accepted only with an `Origin` header that is one of the shop’s origins, like the ' +
    'public `/client` sign-in routes (`403 CSRF_FAILED` otherwise). Retired in the contract release.',
  tags: ['storefront-auth'],
  surface: 'store',
  access: 'public',
  turnstile: true,
  csrf: false,
  originCheck: true,
  body: z.object({ email: z.string().trim().min(1).max(254), password: z.string().min(1).max(1024) }),
  success: { status: 200, schema: z.object({ next: StoreNext }) },
  errors: ['VALIDATION_FAILED', 'UNAUTHORIZED', 'ACCOUNT_SUSPENDED', 'IP_NOT_ALLOWED', 'RATE_LIMITED', 'CSRF_FAILED'],
  examples: {
    request: { email: 'daniel.whitmore@example.com', password: 'a-long-password' },
    response: { next: 'done' },
  },
});

/** `POST /store/v1/auth/password/forgot`. */
export const forgotCustomerPassword = defineRoute({
  key: 'POST /store/v1/auth/password/forgot',
  summary: 'Send a password reset link',
  description:
    'An alias of `POST /client/auth/password/forgot`: the same use case. Answers `204` whether or not the email belongs to an account, so no ' +
    'registered email is revealed. An account that is active ' +
    'gets a link valid one hour that works once; up to three such links work at once (a fourth replaces the oldest), and at most ' +
    'five are mailed an hour per account; a request beyond that answers `204` and sends nothing. Needs the anti-bot token ' +
    '(`X-Turnstile-Token`, always). Retired in the contract release.',
  tags: ['storefront-auth'],
  surface: 'store',
  access: 'public',
  turnstile: true,
  csrf: false,
  body: z.object({ email: EmailField }),
  success: { status: 204 },
  errors: ['VALIDATION_FAILED', 'IP_NOT_ALLOWED', 'RATE_LIMITED'],
  examples: { request: { email: 'daniel.whitmore@example.com' } },
});

/** `POST /store/v1/auth/password/set`. */
export const setCustomerPasswordByLink = defineRoute({
  key: 'POST /store/v1/auth/password/set',
  summary: 'Choose a password with an invitation or reset link',
  description:
    'An alias of `POST /client/auth/password/reset`: the same use case, which takes the link itself (the guard only checks that the link is usable). ' +
    'Accepts the invitation of an account that staff created and a reset link. It sets the password, uses the link up, ends ' +
    'every session of the account and signs nobody in; an invitation also marks the email verified. A weak password does not ' +
    'use the link up (`422 WEAK_PASSWORD` on `password`); an unknown, used, expired or replaced link, or an account that may not act, ' +
    'is `410 TOKEN_INVALID`. Retired in the contract release.',
  tags: ['storefront-auth'],
  surface: 'store',
  access: 'link-token',
  csrf: false,
  body: z.object({ token: TokenField, password: z.string().min(1).max(1024) }),
  success: { status: 204 },
  errors: ['VALIDATION_FAILED', 'WEAK_PASSWORD', 'TOKEN_INVALID', 'IP_NOT_ALLOWED', 'RATE_LIMITED'],
  examples: { request: { token: 'k3Jx9Qd7mT2vN8bR5yHc1WzA4uLsE6oPgF0iVtXnDqM', password: 'a-long-new-password' } },
});

/** `POST /store/v1/me/password`. */
export const changeMyPassword = defineRoute({
  key: 'POST /store/v1/me/password',
  summary: 'Change my password',
  description:
    "The retail account's own password change (the use case of `POST /client/security/password`). Needs the current password (a wrong one is " +
    '`422` on `currentPassword`, never `401`). Ends the other devices and keeps this session. An account that has no password yet is ' +
    '`409 CONFLICT` (it gets its first password from a mailed link). Until the contract release a `pending_password` session (after a ' +
    'temporary password) is accepted too and becomes a full one with new cookies, as the shop of the time before accounts became one asks; ' +
    'the new shop continues with `POST /client/auth/password/change`. `422 ' +
    'WEAK_PASSWORD` on `newPassword` for a weak password or the one in use. Five tries per account in 15 minutes.',
  tags: ['storefront-auth'],
  surface: 'store',
  access: 'customer-session',
  sessionStages: ['pending_password', 'active'],
  body: z.object({ currentPassword: z.string().min(1).max(1024), newPassword: z.string().min(1).max(1024) }),
  success: { status: 204 },
  errors: [
    'VALIDATION_FAILED',
    'WEAK_PASSWORD',
    'CONFLICT',
    'UNAUTHORIZED',
    'ACCOUNT_SUSPENDED',
    'CSRF_FAILED',
    'IP_NOT_ALLOWED',
    'RATE_LIMITED',
  ],
  examples: { request: { currentPassword: 'Hk7mQ2wPzR9tNx', newPassword: 'a-long-new-password' } },
});

/** `POST /store/v1/auth/logout`. */
export const logoutCustomer = defineRoute({
  key: 'POST /store/v1/auth/logout',
  summary: 'Sign out and end the session',
  description:
    'An alias of `POST /client/auth/logout`: ends the session whatever step it is at, for an account of any rank, and clears the session ' +
    'cookie and both CSRF cookies. Retired in the contract release.',
  tags: ['storefront-auth'],
  surface: 'store',
  access: 'customer-session',
  rank: 'any',
  sessionStages: ['pending_password', 'pending_totp', 'active'],
  success: { status: 204 },
  errors: ['UNAUTHORIZED', 'ACCOUNT_SUSPENDED', 'CSRF_FAILED', 'IP_NOT_ALLOWED'],
});
