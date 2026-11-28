// AccountLinkSignInService: the use cases of POST /store/v1/auth/magic-link, POST /store/v1/auth/sign-up, POST /store/v1/auth/verify and
// POST /store/v1/auth/sign-up/finish (decisions 064 and 079, map domain I): the emailed sign-in link of the retail rank, the sign-up with
// details that rides on it and its finish, and the guest-order claim that rides on its exchange. Sensitive steps read the account from the database under its row lock, not from the session's
// cached copy (decision 018).
import { Inject, Injectable } from '@nestjs/common';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { CLOCK, type Clock } from '../../../common/clock';
import { maskCustomerEmail } from '../../../common/customer-contact';
import { AppError } from '../../../common/errors';
import { setRequestActor } from '../../../common/request-context';
import { PasswordHasher, TokenService } from '../../../infra/crypto';
import { DbService, type Transaction, type TransactionContext, isUniqueViolation } from '../../../infra/db';
import { RateLimitService } from '../../../infra/rate-limit';
import { ShopCurrencyReads } from '../../money/ports/shop-currency-reads';
import { AccountDirectory, type AccountRecord } from '../accounts/account-directory';
import { canAct } from '../accounts/account-status';
import type { SessionStage } from '../db/schema';
import { checkPasswordPolicy } from '../domain/password-policy';
import { NO_ACCOUNT_ID } from '../domain/public-links';
import { signUpFinishSessionFresh, signUpFullName, signUpOutcome } from '../domain/sign-up';
import {
  type WaitingSignUp,
  discardWaitingSignUps,
  insertWaitingSignUp,
  takeWaitingSignUp,
} from '../infra/account-signup.repository';
import { updateClientRow } from '../infra/client-admin.repository';
import { clearCodeFailures } from '../infra/code-failures.repository';
import {
  findClientById,
  markClientEmailVerified,
  recordClientSignIn,
  saveClientPassword,
} from '../infra/merchant-auth.repository';
import {
  type AccountLinkBrowser,
  type AccountLinkExchange,
  type AccountLinkExchangeInput,
  AccountLinkSignIn,
  type AccountSignUpDetails,
  type AccountSignUpFinishInput,
  type AccountSignUpInput,
} from '../ports/account-auth';
import type { AccountTokenPurpose } from '../ports/account-auth-tokens';
import { AccountCreateGuards } from '../ports/account-create-guards';
import { AccountMailOutbox, type AccountMailKind } from '../ports/account-mail-outbox';
import { AccountSessions } from '../ports/account-sessions';
import { type AccountPrincipal, actorOf } from '../ports/account-principal';
import type { RankKind } from '../ports/rank-kind';
import { SessionCookies } from '../security/session-cookies';
import { SessionService, type SessionWork } from '../security/session.service';
import { livenessOf } from '../security/session.types';
import { ACCOUNT_TOKEN_TTL_MS, AccountAuthTokenService, type IssuedAccountToken } from './account-auth-tokens';
import { isUsableLink } from './account-identity-registrar';
import { AccountSignInLimiter } from './account-sign-in-limiter';
import { type GuestClaimResult, GuestClaimService } from './guest-claim.service';
import { MerchantLifecycleMails } from './mail/merchant-lifecycle-mails';
import { NoAccountNote } from './mail/no-account-note';
import { weakPassword } from './merchant-errors';
import { takeAddressMailPoint, takePublicMailPoint } from './public-mail-budget';
import { requestMetaOf, type RequestMeta } from './request-meta';
import { assertRetailCountry, retailCurrencyFor } from './retail-country';
import { SignInLock } from './sign-in-lock';

/** A value of the asking-browser cookie this service made: 32 random bytes in base64url. */
const BROWSER_KEY_SHAPE = /^[A-Za-z0-9_-]{43}$/;

const OTHER_ACCOUNT_SIGNED_IN =
  'This browser is signed in to another account. Sign out first, then open the link again.';

/**
 * The link purpose `POST /store/v1/auth/verify` accepts: the sign-in link only. A verification link never opens a session: it is answered
 * by `POST /client/auth/verify-email`, which applies decision 052's rule (without the holder's full session the password chosen before is
 * voided), so a link sent after a staff email change cannot sign in to an account whose password the earlier holder still knows.
 */
const SIGN_IN_PURPOSE = 'magic_link' satisfies AccountTokenPurpose;

/**
 * The open links a sign-in by link voids: the other sign-in links, and the verification link, whose work the exchange has just done (the
 * mailbox is proven).
 */
const VOIDED_BY_SIGN_IN: readonly AccountTokenPurpose[] = ['magic_link', 'verify_email'];

/** The unique index that keeps one login row per email: a guest row cannot become an account while another login row holds its email. */
const LOGIN_EMAIL_INDEX = 'clients_login_email_uq';

/** The links a password chosen through a mailed link uses up (as a reset does): an older invitation or reset must not undo it. */
const PASSWORD_LINKS: readonly AccountTokenPurpose[] = ['invite', 'reset'];

/**
 * Tells whether a sign-in link may open an account.
 *
 * Why: decision 064. Every link exchange answers `410 TOKEN_INVALID` unless the account may act, and the link is the retail
 * rank's: a rank raised to a merchant after the mail makes the link dead. The sign-in link may make an account out of a guest row: the
 * link of a sign-up (decision 079), or a link mailed to a guest row before that decision.
 *
 * @param account the account the link names
 * @returns true when the exchange may go on
 */
function mayOpen(account: AccountRecord): boolean {
  return canAct(account.status) && account.rankKind === 'retail';
}

/**
 * The refusal of a finish of a sign-up for an account that already has a password.
 *
 * Why: decision 079: the finish sets the first password only; a password is changed with the current one (`POST /store/v1/me/password`,
 * whose twin case "no password yet" answers `409 CONFLICT` too).
 *
 * @returns `CONFLICT` (409) with the sentence the shop shows
 */
function passwordAlreadySet(): AppError {
  return new AppError('CONFLICT', {
    detail: 'This account already has a password. Change it on your account page with the current one.',
  });
}

/**
 * The refusal of a finish of a sign-up on a session opened more than an hour ago.
 *
 * Why: the re-review of decision 079: any open session of an account without a password (an older account made by a link, a session left
 * on a shared computer) could otherwise choose the account's password. A session opened at most an hour ago (`signUpFinishSessionFresh`)
 * means the mailbox was proven minutes ago; an older one asks for a new sign-in link first. The code is the route's other refusal's.
 *
 * @returns `CONFLICT` (409) with the sentence the shop shows
 */
function finishSessionTooOld(): AppError {
  return new AppError('CONFLICT', {
    detail:
      'For your security, finish creating your account within an hour of opening the sign-in link. Ask for a new sign-in link, open it and try again.',
  });
}

/**
 * The details of a waiting form as the exchange's answer shows them: never the hash.
 *
 * @param waiting the waiting row of the link
 * @returns the names, the country and the phone as typed (cleaned)
 */
function detailsOf(waiting: AccountSignUpDetails): AccountSignUpDetails {
  return { firstName: waiting.firstName, lastName: waiting.lastName, country: waiting.country, phone: waiting.phone };
}

/**
 * The sign-in link of the retail rank: ask for it, sign up with it, exchange it for a session, and finish a sign-up later.
 *
 * Why: decisions 018, 052, 064 and 079. Asking for a link answers `204` for every email and never says whether the account exists; it
 * spends one point of the recipient's mail budget (five an hour), and a run that sends nothing is rolled back; it does not void the link
 * sent before (up to three work at once). A login row of the email is found first: a retail one that may act gets the sign-in link, a
 * merchant rank, a suspended, blocked or anonymized account, and a blocked email get nothing. Since decision 079 a link no longer makes an
 * account: an address with no login row is mailed a note with the shop's sign-up page instead, addressed to the typed email, so the request
 * writes no row of `clients` (the review: a guest row made only to address the note let anybody plant rows). The sign-up (`signUp`) is the
 * one way to make an account: it hashes the password (argon2id) before the address is looked up, in every branch; an address with a login
 * account gets its ordinary sign-in link in the mail "you already have an account, nothing was changed" and nothing of the form is stored;
 * any other address gets the sign-in link of its guest row in the mail "finish creating your account", and the form waits beside that link
 * (`account_signups`, one row per link: each link applies its own form). The link keeps the keyed hash of a cookie of the browser that asked
 * for it: there the exchange signs in at once; elsewhere it never replaces another account's live session (`409 CONFLICT`) and says whose
 * account it opened. The exchange proves the mailbox: it stamps the email, makes an account of a guest row, opens the session (a code step
 * first when two-step sign-in is on) and, when the visitor asked, claims the orders of the guest row of that email in a savepoint that never
 * waits. Every waiting form of the address is deleted in the exchange's transaction; the form of the exchanged link is applied (name,
 * country, phone and password) only to an account this exchange made and only in the browser that sent it (`signUpOutcome`): anywhere else
 * a stranger who signed up with someone else's address could sign in to the account the owner of the mailbox opens, or leave their own
 * details on it. Opened elsewhere, the account is made with nothing of the form and the answer shows the details (never the password) to
 * the person who proved the mailbox, who finishes with `finishSignUp` (the route `POST /store/v1/auth/sign-up/finish`, which also completes an older
 * account that has no details and no password). When the email gained another login row since the mail was sent, the guest row cannot
 * become an account: `410 TOKEN_INVALID`, nothing changed.
 *
 * Lock order (decision 064): the account row before the link rows. The exchange and the finish take the account row `FOR UPDATE`; a link
 * request and a sign-up only `FOR KEY SHARE`, which is enough: it holds off the writers that take `FOR UPDATE` (the exchange, the status and rank
 * writers) between the read that decides who gets a mail and the commit of the link and its outbox event, and it never makes two public
 * requests for one address wait for each other (the review's S2). Since every link keeps its own form, two sign-ups have nothing to
 * serialize.
 *
 * Side effects: `requestLink` writes `auth_tokens` and `outbox_events` (the link mail) for a login row, or the note's
 * `notifications` row and its `outbox_events` row; `signUp` may insert a guest row and writes `auth_tokens`, `outbox_events` and, for an address
 * without a login, `account_signups`; all of it is rolled back when no mail is sent; each counts a rate-limit attempt and a mail point
 * (cache Redis). `exchange` uses the link up, deletes every waiting form of the address, voids the account's other sign-in links, may
 * update `clients` (`has_account`, `email_verified_at`, `last_login_at`, and from a sign-up in its own browser `name`, `country`, `currency`,
 * `phone` and the password columns), ends the stale session of the browser, opens a `sessions` row with its cookies, and may move guest
 * records (see {@link GuestClaimService}). A password applied from a sign-up also voids the account's invitation and reset links, forgets
 * its wrong authenticator codes and, after the commit, ends the shop sign-in lock of the email, as a password from a mailed link does.
 * `finishSignUp` (only on a session opened at most an hour ago) updates `clients` (the details and the password columns), voids the
 * password links, ends the account's other sessions and queues the mail `customer.password_set` (`notifications` and
 * `outbox_events`). The mail points of an address without a login account (its notes and its sign-up links) are one budget, the address's. Account sign-ins write no audit rows (the audit log records writes of staff), except the claim; no plain password is stored,
 * logged or written to the outbox.
 *
 * @see POST /store/v1/auth/magic-link
 * @see POST /store/v1/auth/sign-up
 * @see POST /store/v1/auth/verify
 * @see POST /store/v1/auth/sign-up/finish
 */
@Injectable()
export class AccountLinkSignInService implements AccountLinkSignIn {
  constructor(
    private readonly db: DbService,
    private readonly tokenService: TokenService,
    private readonly directory: AccountDirectory,
    private readonly tokens: AccountAuthTokenService,
    private readonly mail: AccountMailOutbox,
    private readonly sessions: AccountSessions,
    private readonly sessionStore: SessionService,
    private readonly cookies: SessionCookies,
    private readonly guards: AccountCreateGuards,
    private readonly claims: GuestClaimService,
    private readonly limiter: AccountSignInLimiter,
    private readonly limits: RateLimitService,
    private readonly hasher: PasswordHasher,
    private readonly money: ShopCurrencyReads,
    private readonly lock: SignInLock,
    private readonly note: NoAccountNote,
    private readonly notices: MerchantLifecycleMails,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  /**
   * Emails a sign-in link to a login account, or the note with the sign-up page to an address without one; silent for every email that
   * must get neither.
   *
   * Why: the link stores the keyed hash of a cookie of the browser that asked, so the exchange can tell that browser from another one.
   * Every email gets the same cookie answer, so the cookie says nothing about the account. Decision 079: no link is issued for an address
   * without a login row (a link no longer makes an account); links issued before keep working until they expire. The note goes to the
   * typed address and the request makes no row: an address nobody used leaves nothing behind (the review of decision 079).
   *
   * @param email the normalised email
   * @param meta the caller's address and network
   * @param browserKey the asking-browser cookie the request already carried: kept when this service made it, so every link asked for
   *   in one browser matches that browser
   * @returns the asking-browser cookie to set and when it ends (when the link does)
   * @throws {AppError} `RATE_LIMITED` (429: too many requests for this email from this network); nothing else: a merchant rank, a
   *   blocklisted, suspended, blocked or anonymized account, or one whose mail budget (five an hour) is used up, is silent
   */
  async requestLink(email: string, meta: RequestMeta, browserKey?: string): Promise<AccountLinkBrowser> {
    await this.limiter.enforceMagicLink(email, meta);
    const now = this.clock.now();
    const key = this.browserKeyOf(browserKey);
    // The cookie lives as long as a link would (the same for every email), read from the link when one is issued.
    let linkEnds = new Date(now.getTime() + ACCOUNT_TOKEN_TTL_MS);
    await this.db.runOrDiscard(async (work) => {
      const login = await this.directory.findLoginByEmail(work.tx, email);
      if (login === undefined) {
        // Decision 079: an address without a login row gets no link (a link no longer makes an account) but the note with the sign-up
        // page, to the typed address, written in every run (a run that sends nothing is rolled back).
        const deliver = await this.mayMailNote(work.tx, email);
        await this.note.enqueue(work, email);
        return deliver;
      }
      const target = await this.keyShared(work, login);
      const deliver = await this.mayMail(work.tx, target, email);
      // The same statements for every login row: a run that sends no mail writes for an id no account has and is rolled back (decision 052).
      const subject = deliver ? target.id : NO_ACCOUNT_ID;
      linkEnds = (await this.issueSignInLink(work, subject, meta, key, 'magic_link')).expiresAt;
      return deliver;
    });
    return { browserKey: key, expiresAt: linkEnds };
  }

  /**
   * Signs up with the full details: an address with a login account gets its ordinary sign-in link in the mail "you already have an
   * account", any other address the sign-in link of its guest row in the mail "finish creating your account", with the form waiting beside it.
   *
   * Why: decision 079 (the owner's order: an account is made with an email, a password, both names, a country and a phone). The answer and
   * the work must not tell whether the address has an account, so the password is hashed (argon2id, tens of milliseconds) before the
   * address is looked up, in every branch, and every branch issues one link and queues one mail, or rolls back. A login account keeps
   * everything it has: nothing of the form is stored or applied. For any other address the form waits beside the new link; an older
   * sign-up's form stays beside its own link (the review's B2: each link applies its own form), and the exchange of any link of the address
   * deletes them all (see {@link exchange}). The password policy and the country rule are judged first, without the address.
   *
   * Side effects: see the class; the waiting row holds the argon2id hash, never the password.
   *
   * @param input the cleaned form
   * @param meta the caller's address and network
   * @param browserKey the asking-browser cookie the request already carried (kept when this service made it)
   * @returns the asking-browser cookie to set and when it ends (when the link does)
   * @throws {AppError} `WEAK_PASSWORD` (422 on `password`, the policy's sentence), `VALIDATION_FAILED` (422 on `country`, code
   *   `unsupported`: a country a retail account may not have), `RATE_LIMITED` (429: the budget of `POST /store/v1/auth/magic-link` for
   *   this email from this network, shared with it); nothing else: whoever holds the address, the answer is the same
   */
  async signUp(input: AccountSignUpInput, meta: RequestMeta, browserKey?: string): Promise<AccountLinkBrowser> {
    const problem = checkPasswordPolicy(input.password, {
      email: input.email,
      name: signUpFullName(input.firstName, input.lastName),
    });
    if (problem) throw weakPassword(problem.message, 'password');
    const now = this.clock.now();
    // The country rule of every retail account (the staff create and edit apply it too); it reads the tax windows, not the address.
    await assertRetailCountry(this.money, this.db.db, input.country, now);
    await this.limiter.enforceMagicLink(input.email, meta);
    // Hashed before the address is looked up, whoever holds it: the time of the answer says nothing about the account.
    const details: WaitingSignUp = {
      passwordHash: await this.hasher.hash(input.password),
      firstName: input.firstName,
      lastName: input.lastName,
      country: input.country,
      phone: input.phone,
    };
    const key = this.browserKeyOf(browserKey);
    let linkEnds = new Date(now.getTime() + ACCOUNT_TOKEN_TTL_MS);
    await this.db.runOrDiscard(async (work) => {
      const target = await this.keyShared(
        work,
        (await this.directory.findLoginByEmail(work.tx, input.email)) ??
          (await this.directory.findOrCreateGuest(work.tx, { email: input.email })).account,
      );
      const subject = (await this.mayMail(work.tx, target, input.email)) ? target.id : NO_ACCOUNT_ID;
      // The review's S3: the mail tells which of the two happened.
      const kind: AccountMailKind = target.hasAccount ? 'sign_up_existing' : 'sign_up_link';
      const issued = await this.issueSignInLink(work, subject, meta, key, kind);
      linkEnds = issued.expiresAt;
      // Only an address without a login row keeps the form, beside this link only: a login account gets its ordinary link and nothing of it.
      if (!target.hasAccount) await insertWaitingSignUp(work.tx, issued.tokenId, details, now);
      return subject !== NO_ACCOUNT_ID;
    });
    return { browserKey: key, expiresAt: linkEnds };
  }

  /**
   * Exchanges a sign-in link for a session.
   *
   * Why: a link opened in the browser that asked for it signs in at once. A link asked for elsewhere (or sent by staff, or after an
   * email change) must not replace the session of another account in this browser: that is refused, the session stays and the link
   * stays usable. In a browser without such a session it signs in, and the answer says the link was asked for elsewhere and whose
   * account it opened (masked), so the shop can show it. In one transaction: the account row is locked `FOR UPDATE` and read again (a
   * status or a rank that changed since the mail ends the exchange), the link is used up (a parallel request that uses it first
   * wins), the account's other sign-in links are voided, a guest row becomes an account, the mailbox is stamped proven, the session
   * opens (a `pending_totp` one when two-step sign-in is on) and, only for an account that already had its own login, the claim of the
   * guest row's records runs if the visitor asked for it. A refused or busy claim never fails the sign-in. Decision 079: the form of the
   * link is taken and every other waiting form of the address deleted (the links this exchange voids included), whatever happens; when
   * this exchange made the account and the browser sent the form, the form is applied (name, country with its currency, phone, and the
   * password: everything a password chosen through a mailed link sets, without ending the session this exchange opens) and the answer says
   * `passwordSet: true`; when it made the account elsewhere, nothing is applied and the answer says `passwordSet: false` with the details
   * as typed (`pendingDetails`); when the account already had its login, the link is a plain sign-in and the answer has neither key.
   *
   * Side effects: see the class.
   *
   * @param input the link the guard resolved, the asking-browser cookie and the claim choice
   * @param request the request (its session cookie is read and ended, its address is recorded)
   * @param reply the reply the new session's cookies go on
   * @returns the account, the next step, whether this browser asked for the link, the masked address, the claim result and, for a link of
   *   a sign-up that made the account, `passwordSet` (and the pending details when it is false)
   * @throws {AppError} `TOKEN_INVALID` (410: the link is used, expired, replaced or of another kind (a verification link included), the
   *   account may not act, is a merchant rank now, or its email gained a login row since the mail), `CONFLICT` (409: the link was not asked
   *   for in this browser and the browser holds a live session of another account)
   */
  async exchange(
    input: AccountLinkExchangeInput,
    request: FastifyRequest,
    reply: FastifyReply,
  ): Promise<AccountLinkExchange> {
    const now = this.clock.now();
    const link = await this.tokens.findById(input.linkId);
    const named =
      link !== undefined && link.purpose === SIGN_IN_PURPOSE && isUsableLink(link, now.getTime())
        ? await this.directory.findById(this.db.db, link.subjectId)
        : undefined;
    if (link === undefined || named === undefined || !mayOpen(named)) throw new AppError('TOKEN_INVALID');

    const requestedHere = this.tokens.askedFrom(link, input.browserKey);
    const staleToken = this.cookies.readToken(request, 'account');
    // Checked before anything is written: the refusal leaves the session and the link as they are.
    if (!requestedHere) await this.assertNoOtherAccountSession(staleToken, named.id);
    const meta = requestMetaOf(request);

    return this.db.runInTransaction(async (work) => {
      // The account as it is now, first (decision 064: the account row, then the link rows): the row lock is the exchange's own, which
      // the claim, the status writers and the finish of a sign-up take too.
      const account = await this.directory.lockForUpdate(work.tx, link.subjectId);
      if (account === undefined || !mayOpen(account)) throw new AppError('TOKEN_INVALID');
      // A parallel request used the link first.
      if (!(await this.tokens.consume(work, link.id))) throw new AppError('TOKEN_INVALID');
      await this.endStaleSession(staleToken, work);
      await this.tokens.voidOpenOf(work.tx, account.id, VOIDED_BY_SIGN_IN);

      // The link proves the address: the holder is verified, and a guest who signs in by link has an account now.
      const becameAccount = !account.hasAccount;
      if (becameAccount) await this.makeAccountOfGuest(work.tx, account.id);
      // Decision 079: the form of this link is taken (read and deleted), and every other waiting form of the address goes with it: the
      // forms of the links just voided and of any other link of this row (the review's B2 and S5). Nothing with a password hash outlives
      // the exchange.
      const waiting = await takeWaitingSignUp(work.tx, link.id);
      await discardWaitingSignUps(work.tx, account.id);
      // Only an account this exchange made takes the form, and only in the browser that sent it (`signUpOutcome`): anywhere else a
      // stranger who signed up with this address could sign in with a password of their own.
      const outcome = waiting === undefined ? undefined : signUpOutcome({ madeHere: becameAccount, requestedHere });
      if (waiting !== undefined && outcome === 'apply') {
        await this.applySignUpDetails(work.tx, account.id, waiting, true);
        await this.applySignUpPassword(work, account, waiting.passwordHash);
      }
      await markClientEmailVerified(work.tx, account.id, now);
      await recordClientSignIn(work.tx, account.id, now, meta.ip);

      const row = await findClientById(work.tx, account.id);
      const stage: SessionStage = row?.twofaEnabled === true ? 'pending_totp' : 'active';
      await this.sessions.start(work, reply, { accountId: account.id, stage, rankKind: account.rankKind });
      // From here the request acts as the account (the claim's audit row names it).
      setRequestActor(actorOf(account), meta.ip);

      // The claim is for an account that already had its own login: a converted guest row has no guest row left to claim.
      const claim: GuestClaimResult =
        input.claimGuestOrders && !becameAccount ? await this.claims.claim(work.tx, account) : { claimedOrders: 0 };
      return {
        accountId: account.id,
        next: stage === 'pending_totp' ? 'totp' : 'done',
        requestedHere,
        maskedEmail: maskCustomerEmail(account.email),
        claimedOrders: claim.claimedOrders,
        ...(claim.skipped === undefined ? {} : { claimSkipped: claim.skipped }),
        ...(outcome === 'apply' ? { passwordSet: true } : {}),
        ...(outcome === 'pending' && waiting !== undefined
          ? { passwordSet: false, pendingDetails: detailsOf(waiting) }
          : {}),
      } satisfies AccountLinkExchange;
    });
  }

  /**
   * Finishes the sign-up of a signed-in account that has no password yet: the name, the country (and the currency that follows), the
   * phone and the first password.
   *
   * Why: decision 079 (its fix round). A sign-up link opened in another browser (phone mail apps open links in their own) makes the account
   * with nothing of the form; the person who proved the mailbox confirms or corrects the details here and chooses the password. An older
   * account made by a link before decision 079, with no details and no password, completes itself the same way. The re-review: the session
   * must have been opened at most an hour ago ({@link signUpFinishSessionFresh}): an account without a password can only have been signed
   * in by a link, so a young session means the mailbox was proven minutes ago, while an older one (a session left on a shared computer)
   * must not choose the password; and the account's address is told that a password was set (`customer.password_set`). The rules are the
   * sign-up's (the route contract cleans the fields; the password policy with the email and the names, the country rule of a retail
   * account, here). The currency follows the country only when the country changes (as `PATCH /store/v1/me`): an account that confirms
   * its stored country keeps the currency it chose, and one with no country yet gets the currency of the new one. The password is one its
   * owner chose: like an own change it ends a forced change, voids the invitation and reset links and ends the account's other sessions,
   * while the session of this request stays. An account that already has a password is refused: this route never replaces one
   * (`POST /store/v1/me/password` changes it, with the current one).
   *
   * Side effects: reads the session's `created_at`; updates `clients` (`name`, `country`, `currency` when the country changed, `phone`,
   * the password columns) under the account's row lock; marks the open invitation and reset links used; revokes the account's other
   * sessions (their cached views are dropped after the commit); writes the `customer.password_set` notification ("a password was
   * set") and its `notification.send` outbox event in the same transaction; counts one attempt on the `sign-in` limiter (per account). No
   * audit row (an account's own write), no plain password stored or logged.
   *
   * @param principal the signed-in retail account and its session
   * @param input the details and the password, as the route contract cleaned them
   * @throws {AppError} `RATE_LIMITED` (429: five tries per account in 15 minutes), `CONFLICT` (409: the account already has a password,
   *   or the session was opened more than an hour ago: ask for a new sign-in link), `WEAK_PASSWORD` (422 on `password`),
   *   `VALIDATION_FAILED` (422 on `country`, code `unsupported`), `UNAUTHORIZED` (401: the account is gone or may not act)
   */
  async finishSignUp(principal: AccountPrincipal, input: AccountSignUpFinishInput): Promise<void> {
    await this.limiter.enforceSignUpFinish(principal.accountId);
    const current = await this.directory.findById(this.db.db, principal.accountId);
    if (current === undefined || !canAct(current.status)) throw new AppError('UNAUTHORIZED');
    if (current.hasPassword) throw passwordAlreadySet();
    const now = this.clock.now();
    // The creation time never changes, so one read before the work is enough; a session without a row counts as too old.
    const openedAt = await this.sessionStore.openedAt(principal.session.id);
    if (openedAt === undefined || !signUpFinishSessionFresh(openedAt.getTime(), now.getTime())) {
      throw finishSessionTooOld();
    }
    const problem = checkPasswordPolicy(input.password, {
      email: current.email,
      name: signUpFullName(input.firstName, input.lastName),
    });
    if (problem) throw weakPassword(problem.message, 'password');
    await assertRetailCountry(this.money, this.db.db, input.country, now);
    // Hashed before the transaction: argon2 takes tens of milliseconds and no row is locked meanwhile.
    const passwordHash = await this.hasher.hash(input.password);

    await this.db.runInTransaction(async (work) => {
      // Read again under the row lock the exchange and the status writers take: a password set meanwhile (a reset link opened in another
      // tab) wins, and this request changes nothing.
      const account = await this.directory.lockForUpdate(work.tx, principal.accountId);
      if (account === undefined || !canAct(account.status)) throw new AppError('UNAUTHORIZED');
      if (account.hasPassword) throw passwordAlreadySet();
      // As `PATCH /store/v1/me`: only a changed country derives the currency again (no stored country, an empty string, counts as one).
      await this.applySignUpDetails(work.tx, account.id, input, account.country !== input.country);
      // `expectedHash: null`: the write lands only on an account that still has no password.
      const saved = await saveClientPassword(work.tx, {
        id: account.id,
        passwordHash,
        now,
        verifyEmail: false,
        expectedHash: null,
      });
      if (!saved) throw passwordAlreadySet();
      // An old invitation or reset link must not be able to undo the password the owner chose.
      await this.tokens.voidOpenOf(work.tx, account.id, PASSWORD_LINKS);
      await this.sessionStore.revokeAllOf('account', account.id, { exceptSessionId: principal.session.id }, work);
      // The account's own address hears of it, in the same transaction: its own mail, not the staff notice (decision 047: a security
      // notice is always sent, from its shipped text when no template stands).
      await this.notices.passwordSet(work, { id: account.id, name: signUpFullName(input.firstName, input.lastName) });
    });
  }

  /** The asking-browser cookie to set: the one the request carried when this service made it, else a new one. */
  private browserKeyOf(browserKey: string | undefined): string {
    return browserKey !== undefined && BROWSER_KEY_SHAPE.test(browserKey) ? browserKey : this.tokenService.random(32);
  }

  /**
   * Takes the row lock a link request or a sign-up holds on the row it is about, and reads the row again under it.
   *
   * Why: the review of decision 079 (S2): a public request takes the weakest lock that is enough. `FOR KEY SHARE` makes the writers that
   * take `FOR UPDATE` (the exchange, the finish, the status and rank writers) wait until the link and its mail are committed, so the
   * row cannot change between the read that decided the mail and the commit; it never makes two link requests or sign-ups of one address
   * wait for each other (each link keeps its own form, so there is nothing to serialize). The mail outbox takes the same lock.
   */
  private async keyShared(work: Pick<TransactionContext, 'tx'>, found: AccountRecord): Promise<AccountRecord> {
    return (await this.directory.lockForKeyShare(work.tx, found.id)) ?? found;
  }

  /**
   * Tells whether the row may be mailed now: a retail rank that may act, an email no create check refuses, and a mail point left.
   *
   * Why: decision 052: the same budget call is made for every request, so the work does not tell who has an account. A login account
   * spends its own budget; a guest row (the sign-up of an address without a login) spends the address's, the budget of the note
   * (the re-review of decision 079: the notes and the sign-up links of one address share one five-an-hour budget, where counting the
   * links by the guest row's id doubled it).
   *
   * @param tx the request's transaction
   * @param target the row, read again under its lock
   * @param email the normalised address the visitor typed (the key of an address's budget)
   */
  private async mayMail(tx: Transaction, target: AccountRecord, email: string): Promise<boolean> {
    const eligible =
      target.rankKind === 'retail' &&
      canAct(target.status) &&
      (await this.passesCreateGuards(tx, target.email, target.rankKind));
    const budget = target.hasAccount
      ? await takePublicMailPoint(this.limits, 'account', eligible ? target.id : undefined, 'sign_in_link')
      : await takeAddressMailPoint(this.limits, email);
    return eligible && budget;
  }

  /**
   * Tells whether the note to an address without a login row may be mailed now: no blocked or suspended guest row holds the address, no
   * create check refuses it, and the address has a mail point left.
   *
   * Why: decision 079 (its review): the note goes to the typed address, so its budget is the address's own (five mails an hour, whoever
   * asks), shared with the sign-up links of the address (see {@link mayMail}); one budget call and one guest read are made for every such
   * request, found or not.
   */
  private async mayMailNote(tx: Transaction, email: string): Promise<boolean> {
    const guest = await this.directory.findGuestByEmail(tx, email);
    const eligible =
      (guest === undefined || (guest.rankKind === 'retail' && canAct(guest.status))) &&
      (await this.passesCreateGuards(tx, email, 'retail'));
    const budget = await takeAddressMailPoint(this.limits, email);
    return eligible && budget;
  }

  /**
   * Issues a sign-in link for the subject and queues its mail.
   *
   * @param work the caller's transaction
   * @param accountId the account or guest row, or the id of no account of a run that is rolled back
   * @param meta the caller's address
   * @param browserKey the asking-browser cookie whose keyed hash the link keeps
   * @param kind the mail that carries it: the plain sign-in link, or one of the two mails of a sign-up (decision 079)
   * @returns the issued link (its expiry is the asking-browser cookie's)
   */
  private async issueSignInLink(
    work: Pick<TransactionContext, 'tx'>,
    accountId: number,
    meta: RequestMeta,
    browserKey: string,
    kind: Extract<AccountMailKind, 'magic_link' | 'sign_up_link' | 'sign_up_existing'>,
  ): Promise<IssuedAccountToken> {
    const issued = await this.tokens.issue(work, {
      accountId,
      purpose: 'magic_link',
      ip: meta.ip,
      keepEarlier: true,
      browserKey,
    });
    // The issued token is a placeholder nobody receives: the mail job rotates it, so only the row's id goes on.
    await this.mail.enqueue(work, { kind, accountId, tokenId: issued.tokenId });
    return issued;
  }

  /**
   * Gives an account the details of its sign-up: the name (first, a space, last), the country, the phone and, when asked, the currency the
   * country derives (the rule of every retail account).
   *
   * @param tx the transaction that holds the account's row lock
   * @param accountId the account
   * @param details the names, the country and the phone, cleaned
   * @param deriveCurrency true when the currency follows the country: always for the account an exchange made, and for the finish only
   *   when the country changes (the re-review of decision 079: the finish keeps the currency an account chose, as `PATCH /store/v1/me`)
   */
  private async applySignUpDetails(
    tx: Transaction,
    accountId: number,
    details: AccountSignUpDetails,
    deriveCurrency: boolean,
  ): Promise<void> {
    const currency = deriveCurrency ? await retailCurrencyFor(this.money, tx, details.country) : null;
    await updateClientRow(tx, accountId, {
      name: signUpFullName(details.firstName, details.lastName),
      country: details.country,
      phone: details.phone,
      ...(currency === null ? {} : { currency }),
      updatedAt: this.clock.now(),
    });
  }

  /**
   * Sets the password of a sign-up on the account this exchange made, as a password chosen through a mailed link is set.
   *
   * Why: decision 079: the browser that sent the form opened the link, so the password is its owner's. Like `POST /client/auth/password/reset`
   * it writes `password_changed_at`, clears a forced change and the mark of a staff-set password, forgets the wrong authenticator codes,
   * voids the invitation and reset links and, after the commit, ends the shop sign-in lock of the email; it ends the account's other sessions
   * (a new account has none) before the session of this exchange is opened, so that one stays.
   *
   * @throws {AppError} `TOKEN_INVALID` (410) when the write finds an account that may not act (nothing is committed)
   */
  private async applySignUpPassword(work: SessionWork, account: AccountRecord, passwordHash: string): Promise<void> {
    const saved = await saveClientPassword(work.tx, {
      id: account.id,
      passwordHash,
      now: this.clock.now(),
      verifyEmail: false,
      clearTwoFactor: account.emailVerifiedAt === null,
      fromMailedLink: true,
    });
    if (!saved) throw new AppError('TOKEN_INVALID');
    await clearCodeFailures(work.tx, { type: 'account', id: account.id });
    await this.tokens.voidOpenOf(work.tx, account.id, PASSWORD_LINKS);
    await this.sessionStore.revokeAllOf('account', account.id, {}, work);
    work.afterCommit(() => this.lock.clear('shop', account.email));
  }

  /**
   * Runs the create checks (the blocklist) for an email that asks for a link or a note.
   *
   * Why: a blocklisted email gets nothing, whether or not it has an account; the modules that own such rules register them with the
   * create checks, and identity does not know them. A check that refuses throws an `AppError`, which here only means "silent".
   *
   * @returns true when no check refused
   */
  private async passesCreateGuards(tx: Transaction, email: string, rankKind: RankKind): Promise<boolean> {
    try {
      await this.guards.run(tx, { email, rankKind });
      return true;
    } catch (error) {
      if (error instanceof AppError) return false;
      throw error;
    }
  }

  /**
   * Turns a guest row into the account of the email.
   *
   * @throws {AppError} `TOKEN_INVALID` (410) when the email gained another login row since the mail was sent: nothing else is
   *   changed and no other link is voided
   */
  private async makeAccountOfGuest(tx: Transaction, accountId: number): Promise<void> {
    try {
      await updateClientRow(tx, accountId, { hasAccount: true, updatedAt: this.clock.now() });
    } catch (error) {
      if (isUniqueViolation(error, LOGIN_EMAIL_INDEX)) throw new AppError('TOKEN_INVALID');
      throw error;
    }
  }

  /**
   * Refuses a link asked for elsewhere while the browser holds a live session of another account.
   *
   * @param token the session cookie the request carried
   * @param accountId the account the link belongs to
   * @throws {AppError} `CONFLICT` (409) for a live session (any stage) of another account; an ended, unknown or missing session counts as none
   */
  private async assertNoOtherAccountSession(token: string | undefined, accountId: number): Promise<void> {
    if (token === undefined) return;
    const view = await this.sessionStore.lookup(token);
    if (
      view?.subjectType === 'account' &&
      view.subjectId !== accountId &&
      livenessOf(view, this.clock.nowMs()) === 'live'
    ) {
      throw new AppError('CONFLICT', { detail: OTHER_ACCOUNT_SIGNED_IN });
    }
  }

  /** Ends the account session the request already carried (a new sign-in never continues an old session), with the exchange. */
  private async endStaleSession(token: string | undefined, work: SessionWork): Promise<void> {
    if (token === undefined) return;
    const view = await this.sessionStore.lookup(token);
    if (view?.subjectType === 'account') await this.sessionStore.revoke(view.id, work);
  }
}
