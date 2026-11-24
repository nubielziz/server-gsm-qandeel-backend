// MerchantEmailVerificationService: the use cases of POST /client/auth/verify-email and POST /client/auth/verify-email/resend (map domain
// A, stage 2; MISMATCHES B123). The link is sent when staff change a merchant's address or when the merchant asks for a new one.
import { Inject, Injectable } from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import { CLOCK, type Clock } from '../../../common/clock';
import { AppError } from '../../../common/errors';
import { TokenService } from '../../../infra/crypto';
import { DbService } from '../../../infra/db';
import { RateLimitService } from '../../../infra/rate-limit';
import { accountMailKey } from '../domain/account-mail';
import { consumeAuthToken } from '../infra/auth-token.repository';
import { findClientById, markClientEmailVerified } from '../infra/merchant-auth.repository';
import { findClientTokenByHash } from '../infra/merchant-token.repository';
import { MerchantMailOutbox } from './mail/merchant-mail-outbox';
import { CSRF_HEADER, CsrfService } from '../security/csrf';
import type { MerchantPrincipal } from '../security/principal';
import { SessionAuthenticator } from '../security/session-authenticator';
import { SessionService } from '../security/session.service';
import { MerchantAccountReader } from './merchant-account-reader';
import { MerchantAuthTokens } from './merchant-auth-tokens';
import { MerchantSignInLimiter } from './merchant-sign-in-limiter';
import type { RequestMeta } from './request-meta';

/**
 * Verifies the email address of a merchant.
 *
 * Why: B123 and decision 052. Staff change a merchant's address, or the merchant asks for a new link; the link proves the mailbox, and the
 * account is proven by the mailbox and the holder of the password together. So `verifyEmail` keeps the password only when the request
 * carries a full session of the same merchant; otherwise the address is verified, the password chosen before ends with the two-step
 * sign-in its holder enrolled, every session of the merchant ends and the address gets the password-reset mail, so only the owner of
 * the mailbox chooses the password (and with it the precedence over a shop customer of the same email).
 *
 * Side effects: `verifyEmail` sets `clients.email_verified_at` and uses the link up, and without the merchant's session also clears
 * `clients.password_hash` and the two-factor columns, revokes the merchant's sessions, inserts a `reset` link and writes the outbox
 * event `merchant.password_reset` (ids only); `resendVerification` inserts an `auth_tokens` row and writes the outbox event
 * `merchant.email_verification`.
 *
 * @see docs/contract/MISMATCHES.md (B123)
 */
@Injectable()
export class MerchantEmailVerificationService {
  constructor(
    private readonly db: DbService,
    private readonly tokens: TokenService,
    private readonly authTokens: MerchantAuthTokens,
    private readonly limiter: MerchantSignInLimiter,
    private readonly mail: MerchantMailOutbox,
    private readonly reader: MerchantAccountReader,
    private readonly limits: RateLimitService,
    private readonly authenticator: SessionAuthenticator,
    private readonly csrf: CsrfService,
    private readonly sessions: SessionService,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  /**
   * Marks the email of a merchant verified; without a full session of that merchant it also ends the password chosen before and the
   * two-step sign-in enrolled with it.
   *
   * Why: B123 and decision 052: the link proves the mailbox, a full session proves the holder of the password. Without that session
   * (a verification on another device, or the one after staff changed the address, which ended every session) the previous holder keeps
   * nothing: neither its password nor a second factor that would stand in front of the password the mailbox owner chooses.
   *
   * Side effects: uses the link and sets `clients.email_verified_at`. When the request carries no full session of the link's merchant
   * (none, a pending sign-in step, or another merchant's), the same transaction clears `clients.password_hash`, turns two-factor
   * sign-in off (`twofa_enabled`, `totp_secret_enc`, `totp_last_step`), revokes every session of the merchant (their cached views
   * are dropped after the commit), issues a `reset` link (voiding older password links) and writes the outbox event
   * `merchant.password_reset`.
   *
   * @param token the token of the emailed link
   * @param request the request (its merchant session cookie and `X-CSRF-Token` header are read)
   * @param meta the caller's address
   * @throws {AppError} `RATE_LIMITED` (429), `TOKEN_INVALID` (410: unknown, used, expired or superseded, or the merchant is gone or
   *   suspended), `CSRF_FAILED` (403: a full session of the merchant without its CSRF token; the link is not used up)
   */
  async verifyEmail(token: string, request: FastifyRequest, meta: RequestMeta): Promise<void> {
    await this.limiter.enforceLink(meta.limitKey);
    const now = this.clock.now();
    const link = await findClientTokenByHash(this.db.db, this.tokens.hash(token));
    if (link?.purpose !== 'verify_email' || link.usedAt !== null || link.expiresAt.getTime() <= now.getTime()) {
      throw new AppError('TOKEN_INVALID');
    }
    // A suspended merchant's link is as dead as an unknown one (a suspension also voids the open links; this closes the race).
    const client = await findClientById(this.db.db, link.subjectId);
    if (!client || client.status === 'suspended') throw new AppError('TOKEN_INVALID');
    // The link proves the mailbox; a full session of the same merchant on this request proves the holder of its password.
    const holder = await this.signedInAs(request, client.id);
    await this.db.runInTransaction(async (work) => {
      // A parallel request used the link first.
      if (!(await consumeAuthToken(work.tx, link.id, now))) throw new AppError('TOKEN_INVALID');
      await markClientEmailVerified(work.tx, link.subjectId, now, { voidPassword: !holder });
      if (holder) return;
      // Only the mailbox is proven: whoever chose the password before has no hold left (no password, no second factor), and the address
      // chooses a new one. The write above takes the merchant row lock that a password change, a sign-in and a 2FA enrolment take before
      // they write, so either they find no password or what they wrote ends with it and their session ends below. Lock order here: this
      // link, the merchant row, then its password links (issue); a reset takes its link before the row, so a reset of the same merchant
      // at the same moment can deadlock: the database ends one (409, nothing kept).
      await this.sessions.revokeAllOf('client', client.id, {}, work);
      const issued = await this.authTokens.issue(work, { clientId: client.id, purpose: 'reset', ip: meta.ip });
      await this.mail.enqueue(work, { kind: 'password_reset', clientId: client.id, tokenId: issued.id });
    });
  }

  /**
   * Whether a request carries a full session of a merchant, with that session's CSRF token.
   *
   * @throws {AppError} `CSRF_FAILED` (403) when it carries such a session without the matching `X-CSRF-Token` header
   */
  private async signedInAs(request: FastifyRequest, clientId: number): Promise<boolean> {
    const auth = await this.authenticator.authenticateOptional('client', request, { stages: ['active'] });
    if (auth?.principal.kind !== 'merchant' || auth.principal.clientId !== clientId) return false;
    // A public route: the CSRF guard did not check this session's token (decision 018), so it is checked here, before any write.
    this.csrf.assert(auth.view.tokenHash, request.headers[CSRF_HEADER]);
    return true;
  }

  /**
   * Sends the signed-in merchant a new verification link.
   *
   * Why: feature 20 (H-1): the portal said "contact support" when the first mail was lost. It is a session route, so it reveals nothing about
   * other accounts; the newest link replaces the older one. The limiter key is shared with the staff action.
   *
   * Side effects: inserts an `auth_tokens` row (a placeholder the mail job rotates), voids the older verification link, writes the outbox
   * event `merchant.email_verification` (ids only); counts one point of `account-mail`.
   *
   * @param principal the signed-in merchant
   * @param meta the caller's address, kept on the link row
   * @throws {AppError} `UNAUTHORIZED` (401), `ACCOUNT_SUSPENDED` (403), `CONFLICT` (409: already verified), `RATE_LIMITED` (429)
   */
  async resendVerification(principal: MerchantPrincipal, meta: RequestMeta): Promise<void> {
    const client = await this.reader.current(principal.clientId);
    if (client.emailVerifiedAt !== null) {
      throw new AppError('CONFLICT', { detail: 'This email address is already verified.' });
    }
    await this.limits.enforce('account-mail', accountMailKey('client', client.id, 'verification'));
    await this.db.runInTransaction(async (work) => {
      const issued = await this.authTokens.issue(work, { clientId: client.id, purpose: 'verify_email', ip: meta.ip });
      await this.mail.enqueue(work, { kind: 'email_verification', clientId: client.id, tokenId: issued.id });
    });
  }
}
