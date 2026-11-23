// MerchantRegistrationService: the use cases of POST /client/auth/register and POST /client/auth/verify-email (map domain A,
// stage 2; MISMATCHES B122, B123). A registration never tells whether the email was already known.
import { randomInt, randomUUID } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import { CLOCK, type Clock } from '../../../common/clock';
import { AppError } from '../../../common/errors';
import { PasswordHasher, TokenService } from '../../../infra/crypto';
import { DbService } from '../../../infra/db';
import { RateLimitService } from '../../../infra/rate-limit';
import { ClientGroupDirectory } from '../../catalog';
import { MerchantAccounts } from '../../money';
import { accountMailKey } from '../domain/account-mail';
import { checkPasswordPolicy } from '../domain/password-policy';
import { referralCodeFor, usernameFor } from '../domain/merchant-codes';
import { consumeAuthToken } from '../infra/auth-token.repository';
import {
  findClientByEmail,
  findClientById,
  findClientIdByReferralCode,
  insertClient,
  markClientEmailVerified,
  uniqueViolationOf,
} from '../infra/merchant-auth.repository';
import { findClientTokenByHash } from '../infra/merchant-token.repository';
import { MerchantMailOutbox } from './mail/merchant-mail-outbox';
import { CSRF_HEADER, CsrfService } from '../security/csrf';
import type { MerchantPrincipal } from '../security/principal';
import { SessionAuthenticator } from '../security/session-authenticator';
import { SessionService } from '../security/session.service';
import { MerchantAccountReader } from './merchant-account-reader';
import { MerchantAuthTokens } from './merchant-auth-tokens';
import { weakPassword } from './merchant-errors';
import { MerchantSignInLimiter } from './merchant-sign-in-limiter';
import type { RequestMeta } from './request-meta';

/** The body of `POST /client/auth/register`, after the contract trimmed and normalised it. */
export interface RegisterInput {
  readonly name: string;
  readonly email: string;
  readonly password: string;
  readonly company?: string | undefined;
  readonly phone?: string | undefined;
  /** ISO 3166 alpha-2, upper case. */
  readonly country: string;
  readonly referralCode?: string | undefined;
}

/** How often a generated username or referral code may clash before the request fails (clashes are rare). */
const MAX_NAME_ATTEMPTS = 5;

/**
 * Registers merchants and verifies their email.
 *
 * Why: B122 and decision 052. A visitor registers, the merchant exists as `pending` until staff approve it (B153), and the portal's
 * answer is `204` for a new and for a known email alike: the password is always hashed (same work), a known email runs the same
 * statements as a new one on a placeholder address and they are rolled back (it changes nothing and sends nothing), and the 429 counts
 * both. The merchant's ledger accounts are opened in the same transaction as the merchant (RESOLUTIONS identity-platform-1), so no
 * merchant exists without a wallet.
 *
 * A verification link proves the mailbox; the account is proven by the mailbox and the holder of the registration password together. So
 * `verifyEmail` keeps the password only when the request carries a full session of the same merchant; otherwise the address is
 * verified, the password chosen before ends with the two-step sign-in its holder enrolled, every session of the merchant ends and the
 * address gets the password-reset mail, so only the owner of the mailbox chooses the password (and with it the precedence over a shop
 * customer of the same email). The same holds for the link sent after staff changed a merchant's address.
 *
 * Side effects: `register` inserts `clients`, `ledger_accounts` (through `MerchantAccounts.open`), an `auth_tokens` row and the
 * outbox event `merchant.email_verification` (all rolled back for a known email); `verifyEmail` sets `clients.email_verified_at` and
 * uses the link up, and without the merchant's session also clears `clients.password_hash` and the two-factor columns, revokes the
 * merchant's sessions, inserts a `reset` link and writes the outbox event `merchant.password_reset` (ids only).
 *
 * @see docs/contract/MISMATCHES.md (B122, B123)
 */
@Injectable()
export class MerchantRegistrationService {
  constructor(
    private readonly db: DbService,
    private readonly hasher: PasswordHasher,
    private readonly tokens: TokenService,
    private readonly authTokens: MerchantAuthTokens,
    private readonly limiter: MerchantSignInLimiter,
    private readonly groups: ClientGroupDirectory,
    private readonly accounts: MerchantAccounts,
    private readonly mail: MerchantMailOutbox,
    private readonly reader: MerchantAccountReader,
    private readonly limits: RateLimitService,
    private readonly authenticator: SessionAuthenticator,
    private readonly csrf: CsrfService,
    private readonly sessions: SessionService,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  /**
   * Registers a merchant, or quietly does nothing when the email is already registered.
   *
   * @param input the form, trimmed; the email lower-cased and the country upper-cased by the contract
   * @param meta the caller's address and user agent
   * @throws {AppError} `RATE_LIMITED` (429), `WEAK_PASSWORD` (422 on `password`), `VALIDATION_FAILED` (422 on
   *   `referralCode`: no merchant has that code)
   */
  async register(input: RegisterInput, meta: RequestMeta): Promise<void> {
    await this.limiter.enforceRegister(meta.limitKey);
    const problem = checkPasswordPolicy(input.password, { email: input.email, name: input.name });
    if (problem) throw weakPassword(problem.message, 'password');

    let referredById: number | undefined;
    if (input.referralCode !== undefined) {
      referredById = await findClientIdByReferralCode(this.db.db, input.referralCode);
      if (referredById === undefined) {
        throw new AppError('VALIDATION_FAILED', {
          errors: [{ field: 'referralCode', code: 'unknown_code', message: 'This referral code does not exist.' }],
        });
      }
    }

    // Hash before looking the email up, so a known email costs the same time as a new one.
    const passwordHash = await this.hasher.hash(input.password);
    const known = (await findClientByEmail(this.db.db, input.email)) !== undefined;
    // A known email runs the same statements on a placeholder address and rolls them back, so the work does not tell who is registered.
    const attempted: RegisterInput = known ? { ...input, email: `discarded-${randomUUID()}@example.invalid` } : input;

    for (let attempt = 1; ; attempt++) {
      try {
        await this.create(attempted, passwordHash, referredById, meta, !known);
        return;
      } catch (error) {
        const constraint = uniqueViolationOf(error);
        // Another request registered this email first: it is registered now, which is the answer either way.
        if (constraint === 'clients_email_uq') return;
        const generatedNameClashed = constraint === 'clients_username_uq' || constraint === 'clients_referral_code_uq';
        if (!generatedNameClashed || attempt >= MAX_NAME_ATTEMPTS) throw error;
      }
    }
  }

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
   * @param principal the signed-in merchant (a pending merchant is fine)
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

  /** One attempt: the merchant, its accounts, the verification link and the mail event in one transaction (kept only when `keep`). */
  private async create(
    input: RegisterInput,
    passwordHash: string,
    referredById: number | undefined,
    meta: RequestMeta,
    keep: boolean,
  ): Promise<void> {
    await this.db.runOrDiscard(async (work) => {
      const group = await this.groups.findDefault(work.tx);
      if (!group) throw new AppError('INTERNAL_ERROR', { detail: 'No default merchant group is configured.' });
      const client = await insertClient(work.tx, {
        username: usernameFor(input.email, randomInt),
        email: input.email,
        passwordHash,
        passwordChangedAt: this.clock.now(),
        name: input.name,
        company: input.company ?? '',
        phone: input.phone ?? '',
        country: input.country,
        groupId: group.id,
        status: 'pending',
        kycStatus: 'none',
        referredById: referredById ?? null,
        referralCode: referralCodeFor(randomInt),
      });
      await this.accounts.open(work.tx, {
        clientId: client.id,
        currency: 'USD',
        creditLimit: '0.0000',
        overdraftAllowed: group.overdraftAllowed,
      });
      const issued = await this.authTokens.issue(work, { clientId: client.id, purpose: 'verify_email', ip: meta.ip });
      await this.mail.enqueue(work, {
        kind: 'email_verification',
        clientId: client.id,
        tokenId: issued.id,
      });
      return keep;
    });
  }
}
