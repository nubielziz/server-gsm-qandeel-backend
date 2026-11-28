// The seams to the sign-in use cases of accounts (decision 064): the controllers of the two URL families (`/client/auth/*` and
// `/store/v1/*`) call these classes, never the services behind them, so both families run one use case per step. Declared here; the
// identity module implements them.
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { RankKind } from './rank-kind';
import type { RequestMeta } from '../application/request-meta';
import type { AccountPrincipal } from './account-principal';

/** The next step of a sign-in: the password is still to be set (`password`), a code is still to be typed (`totp`), or the session is full (`done`). */
export type AccountSignInStep = 'password' | 'totp' | 'done';

/** The rank of the account that signed in, as the answers show it. */
export interface AccountRankSummary {
  readonly id: number;
  readonly name: string;
  /** The rank kind: the shop picks its area (merchant or retail) by it. */
  readonly kind: RankKind;
}

/** The credentials of a password sign-in. */
export interface AccountSignInInput {
  readonly email: string;
  readonly password: string;
}

/** The answer of a sign-in: the next step and the rank. The session cookies are already on the reply. */
export interface AccountSignInAnswer {
  readonly next: AccountSignInStep;
  readonly rank: AccountRankSummary;
}

/** The answer of the forced password change. */
export interface AccountForcedChangeAnswer {
  readonly next: 'totp' | 'done';
}

/**
 * The sign-in steps of every account: password, the code step, the forced password change, sign-out and the password links.
 *
 * Why: one use case serves the three sign-in routes, one argon2 verify, one budget and one lock for all of them (decision 064). The
 * email is looked up through the account directory's login lookup only, so a guest row that shares an email never meets a sign-in.
 *
 * Side effects (of the implementation): reads and writes `clients` and `sessions`, counts rate-limit attempts, writes `auth_tokens` and
 * `outbox_events` (the reset link mail), sets and clears the session cookies on the reply.
 *
 * @see POST /client/auth/sign-in, POST /client/auth/2fa, POST /client/auth/logout, POST /client/auth/password/change,
 *   POST /client/auth/password/forgot, POST /client/auth/password/reset
 */
export abstract class AccountSignIn {
  /**
   * Checks the email and password and opens a session.
   *
   * @param input the credentials as typed
   * @param request the request: its address and agent are read, and a stale session cookie on it is ended
   * @param reply the reply the session cookies go on
   * @returns the next step and the rank
   * @throws {AppError} `RATE_LIMITED` (429), `UNAUTHORIZED` (401: one answer for every refusal of the credentials), `ACCOUNT_SUSPENDED` (403)
   */
  abstract signIn(
    input: AccountSignInInput,
    request: FastifyRequest,
    reply: FastifyReply,
  ): Promise<AccountSignInAnswer>;

  /**
   * Checks the authenticator code and opens the full session.
   *
   * @param principal the account of the pending code step
   * @param code the six digits
   * @param request the request (its address and agent)
   * @param reply the reply the full session's cookies go on
   * @throws {AppError} `RATE_LIMITED` (429), `ACCOUNT_SUSPENDED` (403), `UNAUTHORIZED` (401), `VALIDATION_FAILED` (422 on `code`)
   */
  abstract finishCodeStep(
    principal: AccountPrincipal,
    code: string,
    request: FastifyRequest,
    reply: FastifyReply,
  ): Promise<void>;

  /**
   * Ends the caller's session and clears its cookies.
   *
   * Why: sign-out always works, at any stage and for any rank; a suspended account loses every session.
   *
   * @param principal the account of the session
   * @param reply the reply the cleared cookies go on
   */
  abstract signOut(principal: AccountPrincipal, reply: FastifyReply): Promise<void>;

  /**
   * Replaces a temporary password during the sign-in and continues it.
   *
   * @param principal the account of the `pending_password` session
   * @param password the new password
   * @param request the request (its address and agent)
   * @param reply the reply the rotated session's cookies go on
   * @returns the next step (`totp` or `done`)
   * @throws {AppError} `RATE_LIMITED` (429), `UNAUTHORIZED` (401), `ACCOUNT_SUSPENDED` (403), `WEAK_PASSWORD` (422 on `password`)
   */
  abstract changeForcedPassword(
    principal: AccountPrincipal,
    password: string,
    request: FastifyRequest,
    reply: FastifyReply,
  ): Promise<AccountForcedChangeAnswer>;

  /**
   * Sends a password link to an account that may use one.
   *
   * Why: the answer and the work are the same for every email (a guest, a suspended or an unknown address stays silent), so the route
   * reveals nothing.
   *
   * @param email the email as typed
   * @param meta the caller's address and network
   * @throws {AppError} `RATE_LIMITED` (429)
   */
  abstract forgotPassword(email: string, meta: RequestMeta): Promise<void>;

  /**
   * Sets a new password from an invitation or a reset link. It never signs in.
   *
   * @param input the token of the link and the new password
   * @param meta the caller's address and network
   * @throws {AppError} `RATE_LIMITED` (429), `TOKEN_INVALID` (410: unknown, used, expired, or the account may not act), `WEAK_PASSWORD` (422 on `password`)
   */
  abstract resetPassword(
    input: { readonly token: string; readonly password: string },
    meta: RequestMeta,
  ): Promise<void>;
}

/** The answer of `AccountTwoFactorSetup.setup`: the key to type, the `otpauth://` link and the QR code. */
export interface AccountTwoFactorSetupAnswer {
  readonly secret: string;
  readonly otpauthUrl: string;
  readonly qrSvg: string;
}

/**
 * Sets up, enables and disables the authenticator of an account.
 *
 * Why: two-step sign-in is for every account with a password, of any rank (decision 064); the merchant routes and the new store routes
 * run the same use case. An account without a password is refused with 409 `CONFLICT`.
 *
 * Side effects (of the implementation): locks the account row and updates `clients` (`totp_secret_enc`, `twofa_enabled`, `totp_last_step`),
 * ends the account's other sessions.
 *
 * @see POST /client/security/2fa/setup, POST /client/security/2fa/enable, POST /client/security/2fa/disable,
 *   POST /store/v1/me/2fa/setup, POST /store/v1/me/2fa/enable, POST /store/v1/me/2fa/disable
 */
export abstract class AccountTwoFactorSetup {
  /**
   * Stores a pending secret and describes it.
   *
   * @param principal the signed-in account
   * @returns the secret, the link and the QR code
   * @throws {AppError} `CONFLICT` (409: no password yet, or the email is not confirmed), `ACCOUNT_SUSPENDED` (403), `UNAUTHORIZED` (401)
   */
  abstract setup(principal: AccountPrincipal): Promise<AccountTwoFactorSetupAnswer>;

  /**
   * Confirms the pending secret with a current code and turns two-step sign-in on.
   *
   * @param principal the signed-in account
   * @param code the six digits
   * @throws {AppError} `VALIDATION_FAILED` (422 on `code`), `CONFLICT` (409), `RATE_LIMITED` (429)
   */
  abstract enable(principal: AccountPrincipal, code: string): Promise<void>;

  /**
   * Turns two-step sign-in off with a current code.
   *
   * @param principal the signed-in account
   * @param code the six digits
   * @throws {AppError} `VALIDATION_FAILED` (422 on `code`), `RATE_LIMITED` (429)
   */
  abstract disable(principal: AccountPrincipal, code: string): Promise<void>;
}

/**
 * The account's own password change.
 *
 * Why: the same use case for `POST /client/security/password` and `POST /store/v1/me/password`; it needs the current password and ends
 * the account's other sessions.
 *
 * Side effects (of the implementation): updates `clients.password_hash`, voids the open password links, revokes the other sessions.
 *
 * @see POST /client/security/password, POST /store/v1/me/password
 */
export abstract class AccountOwnPassword {
  /**
   * Changes the password of the signed-in account.
   *
   * @param principal the signed-in account
   * @param input the current and the new password
   * @throws {AppError} `RATE_LIMITED` (429), `VALIDATION_FAILED` (422 on `currentPassword`), `WEAK_PASSWORD` (422 on `newPassword`),
   *   `CONFLICT` (409: the account has no password yet), `UNAUTHORIZED` (401), `ACCOUNT_SUSPENDED` (403)
   */
  abstract change(
    principal: AccountPrincipal,
    input: { readonly currentPassword: string; readonly newPassword: string },
  ): Promise<void>;
}

/** What `AccountLinkSignIn.requestLink` gives the controller: the asking-browser cookie to set and when it ends (with the link). */
export interface AccountLinkBrowser {
  readonly browserKey: string;
  readonly expiresAt: Date;
}

/** What `AccountLinkSignIn.exchange` takes. */
export interface AccountLinkExchangeInput {
  /** The `auth_tokens` id the link guard resolved from the token. */
  readonly linkId: number;
  /** The asking-browser cookie the request carried, if any. */
  readonly browserKey?: string;
  /** The visitor asked to move the orders of the guest row of this email onto the account (offered after the mailbox was proven). */
  readonly claimGuestOrders: boolean;
}

/** The answer of `AccountLinkSignIn.exchange`; the session cookies are already on the reply. */
export interface AccountLinkExchange {
  /** The account the link opened (the controller reads its own view of it). */
  readonly accountId: number;
  /** `totp` when two-step sign-in still wants a code, `done` when the session is full. */
  readonly next: 'totp' | 'done';
  /** Whether this browser asked for the link. */
  readonly requestedHere: boolean;
  /** The account's email with its middle hidden. */
  readonly maskedEmail: string;
  /** How many orders (and their records) moved from the guest row of the email to the account. */
  readonly claimedOrders: number;
  /** `busy` when the claim gave up because another request holds a row it needs; the sign-in itself still succeeded. */
  readonly claimSkipped?: 'busy';
  /**
   * Only for a link that carried the details of a sign-up and made the account (decision 079): true when the form was applied (the
   * browser that sent it opened the link), false when it was opened elsewhere and nothing was applied (then `pendingDetails` is set).
   * Absent for every other link, and for a sign-up link of an address that already had an account (a plain sign-in).
   */
  readonly passwordSet?: boolean;
  /**
   * Only with `passwordSet: false`: the details of the form as typed (never the password), for the person who proved the mailbox to confirm
   * or correct with `finishSignUp`. Nothing of them was applied.
   */
  readonly pendingDetails?: AccountSignUpDetails;
}

/** The details of a sign-up form besides the email and the password (decision 079). */
export interface AccountSignUpDetails {
  /** Trimmed, 1 to 60 characters, no control character or invisible direction mark. */
  readonly firstName: string;
  /** Trimmed, 1 to 60 characters, no control character or invisible direction mark; with the first name at most 119. */
  readonly lastName: string;
  /** ISO 3166 alpha-2, upper case (the use case checks that a retail account may have it). */
  readonly country: string;
  /** The cleaned form: an optional leading `+` and 7 to 15 digits. */
  readonly phone: string;
}

/** What `AccountLinkSignIn.finishSignUp` takes: the details and the password, with the rules of the sign-up. */
export interface AccountSignUpFinishInput extends AccountSignUpDetails {
  /** The password as typed (1 to 1024 characters); never stored, logged or sent anywhere: only its argon2id hash is written. */
  readonly password: string;
}

/** What `AccountLinkSignIn.signUp` takes: the form of the shop's sign-up, as the route contract cleaned it. */
export interface AccountSignUpInput extends AccountSignUpDetails {
  /** The normalised email. */
  readonly email: string;
  /** The password as typed (1 to 1024 characters); never stored, logged or sent anywhere: only its argon2id hash waits. */
  readonly password: string;
}

/**
 * The sign-in link of the retail rank, and the shop's sign-up that rides on it.
 *
 * Why: a retail account signs in with a link mailed to the address, which proves the mailbox (decision 064). Since decision 079 an account
 * is made only by a sign-up: the form waits beside the link, and the exchange of that link makes the account; the form is applied only in the
 * browser that sent it, and elsewhere the account is made with nothing of it and finished later by its owner (`finishSignUp`). A sign-in
 * link asked for an address without an account mails a note instead. The claim of guest orders rides on the exchange and never waits for a
 * lock.
 *
 * Side effects (of the implementation): `requestLink` and `signUp` write `auth_tokens`, `outbox_events` and (sign-up) `account_signups`, or
 * (the note) `notifications`, all rolled back when no mail is sent, and may create a guest row; `exchange` consumes the link, deletes its
 * waiting details, may turn a guest row into an account and give it the details, opens the session and may move guest records;
 * `finishSignUp` writes the details and the first password on `clients`, voids the password links and ends the account's other sessions.
 *
 * @see POST /store/v1/auth/magic-link, POST /store/v1/auth/sign-up, POST /store/v1/auth/verify, POST /store/v1/auth/sign-up/finish
 */
export abstract class AccountLinkSignIn {
  /**
   * Asks for a sign-in link; the answer and the work are the same for every email.
   *
   * @param email the normalised email
   * @param meta the caller's address and network
   * @param browserKey the asking-browser cookie the request already carried
   * @returns the asking-browser cookie to set and when it ends
   * @throws {AppError} `RATE_LIMITED` (429); nothing else: a merchant rank, a blocked or non-active account is silent
   */
  abstract requestLink(email: string, meta: RequestMeta, browserKey?: string): Promise<AccountLinkBrowser>;

  /**
   * Signs up with the full details; the answer and the work are the same whoever holds the email.
   *
   * @param input the cleaned form
   * @param meta the caller's address and network
   * @param browserKey the asking-browser cookie the request already carried
   * @returns the asking-browser cookie to set and when it ends
   * @throws {AppError} `WEAK_PASSWORD` (422 on `password`), `VALIDATION_FAILED` (422 on `country`, code `unsupported`), `RATE_LIMITED`
   *   (429); nothing else: an address with a login account gets what `requestLink` gives it
   */
  abstract signUp(input: AccountSignUpInput, meta: RequestMeta, browserKey?: string): Promise<AccountLinkBrowser>;

  /**
   * Exchanges a link for a session.
   *
   * @param input the link, the asking browser and the claim choice
   * @param request the request: a stale session cookie on it is ended
   * @param reply the reply the session cookies go on
   * @returns the account, the next step and the claim result
   * @throws {AppError} `TOKEN_INVALID` (410: used, expired, replaced, of another kind, the account may not act, or its email gained a login row since the mail),
   *   `CONFLICT` (409: the browser holds a live session of another account), `CSRF_FAILED` (403)
   */
  abstract exchange(
    input: AccountLinkExchangeInput,
    request: FastifyRequest,
    reply: FastifyReply,
  ): Promise<AccountLinkExchange>;

  /**
   * Finishes the sign-up of a signed-in account that has no password yet: its name, country, phone and first password.
   *
   * @param principal the signed-in retail account (its session stays; the account's other sessions end)
   * @param input the details and the password, cleaned by the route contract
   * @throws {AppError} `CONFLICT` (409: the account already has a password), `WEAK_PASSWORD` (422 on `password`), `VALIDATION_FAILED` (422 on
   *   `country`, code `unsupported`), `RATE_LIMITED` (429), `UNAUTHORIZED` (401: the account is gone or may not act)
   */
  abstract finishSignUp(principal: AccountPrincipal, input: AccountSignUpFinishInput): Promise<void>;
}

/**
 * The email verification of every account.
 *
 * Why: one flow for every rank (decision 064): a link proves the mailbox; it never signs in, and an account that may not act gets one
 * `TOKEN_INVALID`.
 *
 * Side effects (of the implementation): `verify` consumes the link and sets `clients.email_verified_at`; without a full session of the same
 * account it also clears the password, turns two-step off, revokes the sessions and queues a reset link; `resend` writes `auth_tokens` and `outbox_events`.
 *
 * @see POST /client/auth/verify-email, POST /client/auth/verify-email/resend
 */
export abstract class AccountEmailVerification {
  /**
   * Verifies the email with the mailed token.
   *
   * @param token the token of the link
   * @param request the request (its session cookie and CSRF header are read)
   * @param meta the caller's address
   * @throws {AppError} `RATE_LIMITED` (429), `TOKEN_INVALID` (410), `CSRF_FAILED` (403: a full session of the account without its CSRF token)
   */
  abstract verify(token: string, request: FastifyRequest, meta: RequestMeta): Promise<void>;

  /**
   * Sends the signed-in account a new verification mail.
   *
   * @param principal the signed-in account
   * @param meta the caller's address
   * @throws {AppError} `CONFLICT` (409: already verified), `RATE_LIMITED` (429), `UNAUTHORIZED` (401), `ACCOUNT_SUSPENDED` (403)
   */
  abstract resend(principal: AccountPrincipal, meta: RequestMeta): Promise<void>;
}
