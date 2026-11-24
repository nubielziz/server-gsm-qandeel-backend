// AccountEmailVerificationService: the use cases of POST /client/auth/verify-email and POST /client/auth/verify-email/resend for every
// account (decision 064, map domain A, MISMATCHES B123). The link is sent when staff change an account's address or when the account asks
// for a new one.
import { Inject, Injectable } from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import { CLOCK, type Clock } from '../../../common/clock';
import { AppError } from '../../../common/errors';
import { DbService } from '../../../infra/db';
import { RateLimitService } from '../../../infra/rate-limit';
import { AccountDirectory } from '../accounts/account-directory';
import { canAct, sessionStateOf } from '../accounts/account-status';
import { accountMailKey } from '../domain/account-mail';
import { markClientEmailVerified } from '../infra/merchant-auth.repository';
import { AccountEmailVerification } from '../ports/account-auth';
import { AccountMailOutbox } from '../ports/account-mail-outbox';
import type { AccountPrincipal } from '../ports/account-principal';
import { AccountSessions } from '../ports/account-sessions';
import { CSRF_HEADER, CsrfService } from '../security/csrf';
import { SessionAuthenticator } from '../security/session-authenticator';
import { AccountAuthTokenService } from './account-auth-tokens';
import { isUsableLink } from './account-identity-registrar';
import { AccountSignInLimiter } from './account-sign-in-limiter';
import type { RequestMeta } from './request-meta';

/**
 * Verifies the email address of an account of any rank.
 *
 * Why: B123, decisions 052 and 064. Staff change an address, or the account asks for a new link; the link proves the mailbox, and the
 * account is proven by the mailbox and the holder of the password together. So `verify` keeps the password only when the account has none or
 * the request carries a full session of the same account; otherwise the address is verified, the password chosen before ends with the
 * two-step sign-in its holder enrolled, every session of the account ends and the address gets the password-reset mail, so only the
 * owner of the mailbox chooses the password (and with it the precedence over an account of the same email). The link never signs in. An
 * account that may not act (suspended, blocked, anonymized) gets the one `410 TOKEN_INVALID`.
 *
 * Side effects: `verify` sets `clients.email_verified_at` and uses the link up, and without the holder's session also clears
 * `clients.password_hash` and the two-factor columns, revokes the account's sessions (their cached views are dropped after the commit),
 * inserts a `reset` link and writes the outbox event of its mail (ids only); `resend` inserts an `auth_tokens` row, writes the outbox
 * event of the verification mail and counts one point of `account-mail`.
 *
 * @see docs/contract/MISMATCHES.md (B123)
 * @see POST /client/auth/verify-email
 * @see POST /client/auth/verify-email/resend
 */
@Injectable()
export class AccountEmailVerificationService implements AccountEmailVerification {
  constructor(
    private readonly db: DbService,
    private readonly directory: AccountDirectory,
    private readonly tokens: AccountAuthTokenService,
    private readonly mail: AccountMailOutbox,
    private readonly sessions: AccountSessions,
    private readonly authenticator: SessionAuthenticator,
    private readonly csrf: CsrfService,
    private readonly limiter: AccountSignInLimiter,
    private readonly limits: RateLimitService,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  /**
   * Marks the email of an account verified; without the holder's full session it also ends the password chosen before and the two-step
   * sign-in enrolled with it.
   *
   * Why: B123 and decision 052: the link proves the mailbox, a full session proves the holder of the password. Without that session (a
   * verification on another device, or the one after staff changed the address, which ended every session) the previous holder keeps
   * nothing: neither its password nor a second factor that would stand in front of the password the mailbox owner chooses. An account
   * without a password has nothing to protect: the link only stamps it.
   *
   * Side effects: uses the link and sets `clients.email_verified_at`. When the account has a password and the request carries no full
   * session of the link's account (none, a pending sign-in step, or another account's), the same transaction clears
   * `clients.password_hash`, turns two-factor sign-in off, revokes every session, issues a `reset` link (voiding older password links) and
   * writes the outbox event of its mail. Lock order: the account row, then the link rows (decision 064); a reset takes its link before the
   * row, so a reset of the same account at the same moment can deadlock: the database ends one (nothing kept).
   *
   * @param token the token of the emailed link
   * @param request the request (its session cookie and `X-CSRF-Token` header are read)
   * @param meta the caller's address and network
   * @throws {AppError} `RATE_LIMITED` (429), `TOKEN_INVALID` (410: unknown, used, expired or superseded, or the account is gone or may not
   *   act), `CSRF_FAILED` (403: a full session of the account without its CSRF token; the link is not used up)
   */
  async verify(token: string, request: FastifyRequest, meta: RequestMeta): Promise<void> {
    await this.limiter.enforceLink(meta.limitKey);
    const now = this.clock.now();
    const link = await this.tokens.findByHash(token);
    if (link?.purpose !== 'verify_email' || !isUsableLink(link, now.getTime())) throw new AppError('TOKEN_INVALID');
    // A suspended account's link is as dead as an unknown one (a suspension also voids the open links; this closes the race).
    const named = await this.directory.findById(this.db.db, link.subjectId);
    if (named === undefined || !named.hasAccount || !canAct(named.status)) throw new AppError('TOKEN_INVALID');

    await this.db.runInTransaction(async (work) => {
      const account = await this.directory.lockForUpdate(work.tx, named.id);
      if (account === undefined || !account.hasAccount || !canAct(account.status)) throw new AppError('TOKEN_INVALID');
      // A parallel request used the link first.
      if (!(await this.tokens.consume(work, link.id))) throw new AppError('TOKEN_INVALID');
      // The link proves the mailbox; a full session of the same account on this request proves the holder of its password. Read under the
      // row lock, so a password set a moment ago is seen; a refusal here (CSRF) rolls the use of the link back.
      const holder = !account.hasPassword || (await this.signedInAs(request, account.id));
      await markClientEmailVerified(work.tx, account.id, now, { voidPassword: !holder });
      if (holder) return;
      // Only the mailbox is proven: whoever chose the password before has no hold left (no password, no second factor), and the address
      // chooses a new one. Every session ends, so none of the old holder's stays.
      await this.sessions.revokeAll(work.tx, account.id);
      work.afterCommit(() => this.sessions.invalidate(account.id));
      const issued = await this.tokens.issue(work, { accountId: account.id, purpose: 'reset', ip: meta.ip });
      await this.mail.enqueue(work, { kind: 'password_reset', accountId: account.id, tokenId: issued.tokenId });
    });
  }

  /**
   * Sends the signed-in account a new verification link.
   *
   * Why: feature 20 (H-1): the portal said "contact support" when the first mail was lost; every account with an unverified address can ask
   * now. It is a session route, so it reveals nothing about other accounts; the newest link replaces the older one. The limiter key is
   * shared with the staff action.
   *
   * Side effects: inserts an `auth_tokens` row (a placeholder the mail job rotates), voids the older verification link, writes the outbox
   * event of the verification mail (ids only); counts one point of `account-mail`.
   *
   * @param principal the signed-in account
   * @param meta the caller's address, kept on the link row
   * @throws {AppError} `UNAUTHORIZED` (401: the account is gone), `ACCOUNT_SUSPENDED` (403), `CONFLICT` (409: already verified),
   *   `RATE_LIMITED` (429)
   */
  async resend(principal: AccountPrincipal, meta: RequestMeta): Promise<void> {
    const account = await this.directory.findById(this.db.db, principal.accountId);
    // The session guard has judged the account; the sensitive step reads it again (decision 018).
    const state = account === undefined ? 'gone' : sessionStateOf(account.status);
    if (account === undefined || state === 'gone') throw new AppError('UNAUTHORIZED');
    if (state === 'suspended') throw new AppError('ACCOUNT_SUSPENDED');
    if (account.emailVerifiedAt !== null) {
      throw new AppError('CONFLICT', { detail: 'This email address is already verified.' });
    }
    await this.limits.enforce('account-mail', accountMailKey('account', account.id, 'verification'));
    await this.db.runInTransaction(async (work) => {
      const issued = await this.tokens.issue(work, { accountId: account.id, purpose: 'verify_email', ip: meta.ip });
      await this.mail.enqueue(work, { kind: 'email_verification', accountId: account.id, tokenId: issued.tokenId });
    });
  }

  /**
   * Whether a request carries a full session of an account, with that session's CSRF token.
   *
   * @throws {AppError} `CSRF_FAILED` (403) when it carries such a session without the matching `X-CSRF-Token` header
   */
  private async signedInAs(request: FastifyRequest, accountId: number): Promise<boolean> {
    const auth = await this.authenticator.authenticateOptional('account', request, { stages: ['active'] });
    if (auth?.principal.kind !== 'account' || auth.principal.accountId !== accountId) return false;
    // A public route: the CSRF guard did not check this session's token (decision 018), so it is checked here, before any write is kept.
    this.csrf.assert(auth.view.tokenHash, request.headers[CSRF_HEADER]);
    return true;
  }
}
