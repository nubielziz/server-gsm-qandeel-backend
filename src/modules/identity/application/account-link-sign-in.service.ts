// AccountLinkSignInService: the use cases of POST /store/v1/auth/magic-link and POST /store/v1/auth/verify (decision 064, map domain I):
// the emailed sign-in link of the retail rank, self sign-up by it, and the guest-order claim that rides on its exchange.
// Sensitive steps read the account from the database under its row lock, not from the session's cached copy (decision 018).
import { Inject, Injectable } from '@nestjs/common';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { CLOCK, type Clock } from '../../../common/clock';
import { maskCustomerEmail } from '../../../common/customer-contact';
import { AppError } from '../../../common/errors';
import { setRequestActor } from '../../../common/request-context';
import { TokenService } from '../../../infra/crypto';
import { DbService, type Transaction, isUniqueViolation } from '../../../infra/db';
import { RateLimitService } from '../../../infra/rate-limit';
import { AccountDirectory, type AccountRecord } from '../accounts/account-directory';
import { canAct } from '../accounts/account-status';
import type { SessionStage } from '../db/schema';
import { NO_ACCOUNT_ID } from '../domain/public-links';
import { updateClientRow } from '../infra/client-admin.repository';
import { findClientById, markClientEmailVerified, recordClientSignIn } from '../infra/merchant-auth.repository';
import {
  type AccountLinkBrowser,
  type AccountLinkExchange,
  type AccountLinkExchangeInput,
  AccountLinkSignIn,
} from '../ports/account-auth';
import type { AccountTokenPurpose } from '../ports/account-auth-tokens';
import { AccountCreateGuards } from '../ports/account-create-guards';
import { AccountMailOutbox } from '../ports/account-mail-outbox';
import { AccountSessions } from '../ports/account-sessions';
import { actorOf } from '../ports/account-principal';
import { SessionCookies } from '../security/session-cookies';
import { SessionService, type SessionWork } from '../security/session.service';
import { livenessOf } from '../security/session.types';
import { AccountAuthTokenService } from './account-auth-tokens';
import { isUsableLink } from './account-identity-registrar';
import { AccountSignInLimiter } from './account-sign-in-limiter';
import { type GuestClaimResult, GuestClaimService } from './guest-claim.service';
import { takePublicMailPoint } from './public-mail-budget';
import { requestMetaOf, type RequestMeta } from './request-meta';

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

/**
 * Tells whether a sign-in link may open an account.
 *
 * Why: decision 064. Every link exchange answers `410 TOKEN_INVALID` unless the account may act, and the link is the retail
 * rank's: a rank raised to a merchant after the mail makes the link dead. The sign-in link may make an account out of a guest row
 * (self sign-up).
 *
 * @param account the account the link names
 * @returns true when the exchange may go on
 */
function mayOpen(account: AccountRecord): boolean {
  return canAct(account.status) && account.rankKind === 'retail';
}

/**
 * The sign-in link of the retail rank: ask for it, and exchange it for a session.
 *
 * Why: decisions 018, 052 and 064. The link answers `204` for every email and never says whether the account exists; it spends one point
 * of the recipient's mail budget (five an hour), runs the same statements for every email (a run that sends nothing is rolled back) and
 * does not void the link sent before (up to three work at once). An email the shop does not know becomes a guest row (self sign-up),
 * because the shop has no other registration route; a login row of the email is found first, and a merchant rank, a suspended, blocked
 * or anonymized account, and a blocked email get nothing. The link keeps the keyed hash of a cookie of the browser that asked for it:
 * there the exchange signs in at once; elsewhere it never replaces another account's live session (`409 CONFLICT`) and says whose account it
 * opened. The exchange proves the mailbox: it stamps the email, makes an account of a guest row, opens the session (a code step first when
 * two-step sign-in is on) and, when the visitor asked, claims the orders of the guest row of that email in a savepoint that never waits.
 * When the email gained another login row since the mail was sent, the guest row cannot become an account: `410 TOKEN_INVALID`, nothing
 * changed.
 *
 * Side effects: `requestLink` may insert a guest row and writes `auth_tokens` and `outbox_events` (the link mail), all rolled back when no
 * mail is sent; it counts a rate-limit attempt and a mail point (cache Redis). `exchange` uses the link up, voids the account's other
 * sign-in links, may update `clients` (`has_account`, `email_verified_at`, `last_login_at`), ends the stale session of the browser, opens a
 * `sessions` row with its cookies, and may move guest records (see {@link GuestClaimService}). Account sign-ins write no audit rows (the audit log
 * records writes of staff), except the claim.
 *
 * @see POST /store/v1/auth/magic-link
 * @see POST /store/v1/auth/verify
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
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  /**
   * Emails a sign-in link; silent for every email that must not get one.
   *
   * Why: the link stores the keyed hash of a cookie of the browser that asked, so the exchange can tell that browser from another one.
   * Every email gets the same cookie answer, so the cookie says nothing about the account.
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
    const key =
      browserKey !== undefined && BROWSER_KEY_SHAPE.test(browserKey) ? browserKey : this.tokenService.random(32);
    // The same statements for every email: a run that sends no mail writes for an id no account has and is rolled back (decision 052).
    // The cookie lives as long as the link, so it is read from the link that was issued (the same for every email).
    let linkEnds = new Date(now.getTime());
    await this.db.runOrDiscard(async (work) => {
      // The login row of the email first (any rank): a guest row never hides it, and a login row is never turned into a guest.
      const found =
        (await this.directory.findLoginByEmail(work.tx, email)) ??
        // Self sign-up: a guest row without a name; the link proves the address, and exchanging it makes the account.
        (await this.directory.findOrCreateGuest(work.tx, { email })).account;
      // Lock order (decision 064): the account row before the link rows, as the exchange and the status writers take them. KEY SHARE
      // waits only for those, never for another request of this kind.
      const target = (await this.directory.lockForKeyShare(work.tx, found.id)) ?? found;
      const eligible =
        target.rankKind === 'retail' && canAct(target.status) && (await this.passesCreateGuards(work.tx, target));
      const budget = await takePublicMailPoint(
        this.limits,
        'account',
        eligible ? target.id : undefined,
        'sign_in_link',
      );
      const deliver = eligible && budget;
      const accountId = deliver ? target.id : NO_ACCOUNT_ID;
      const issued = await this.tokens.issue(work, {
        accountId,
        purpose: 'magic_link',
        ip: meta.ip,
        keepEarlier: true,
        browserKey: key,
      });
      linkEnds = issued.expiresAt;
      // The issued token is a placeholder nobody receives: the mail job rotates it, so only the row's id goes on.
      await this.mail.enqueue(work, { kind: 'magic_link', accountId, tokenId: issued.tokenId });
      return deliver;
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
   * guest row's records runs if the visitor asked for it. A refused or busy claim never fails the sign-in.
   *
   * Side effects: see the class.
   *
   * @param input the link the guard resolved, the asking-browser cookie and the claim choice
   * @param request the request (its session cookie is read and ended, its address is recorded)
   * @param reply the reply the new session's cookies go on
   * @returns the account, the next step, whether this browser asked for the link, the masked address and the claim result
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
      // the claim, the status writers and a new link request take too.
      const account = await this.directory.lockForUpdate(work.tx, link.subjectId);
      if (account === undefined || !mayOpen(account)) throw new AppError('TOKEN_INVALID');
      // A parallel request used the link first.
      if (!(await this.tokens.consume(work, link.id))) throw new AppError('TOKEN_INVALID');
      await this.endStaleSession(staleToken, work);
      await this.tokens.voidOpenOf(work.tx, account.id, VOIDED_BY_SIGN_IN);

      // The link proves the address: the holder is verified, and a guest who signs in by link has an account now.
      const becameAccount = !account.hasAccount;
      if (becameAccount) await this.makeAccountOfGuest(work.tx, account.id);
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
      } satisfies AccountLinkExchange;
    });
  }

  /**
   * Runs the create checks (the blocklist) for an email that asks for a link.
   *
   * Why: a blocklisted email gets nothing, whether or not it has an account; the modules that own such rules register them with the
   * create checks, and identity does not know them. A check that refuses throws an `AppError`, which here only means "silent".
   *
   * @returns true when no check refused
   */
  private async passesCreateGuards(tx: Transaction, account: AccountRecord): Promise<boolean> {
    try {
      await this.guards.run(tx, { email: account.email, rankKind: account.rankKind });
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
