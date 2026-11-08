// CustomerSignInService: the use cases of POST /store/v1/auth/magic-link, /verify, /login and /logout (map domain I, stage 14).
// Sensitive steps read the customer from the database, not from the session's cached copy (decision 018).
import { Inject, Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import { CLOCK, type Clock } from '../../../common/clock';
import { AppError } from '../../../common/errors';
import { PasswordHasher, TokenService } from '../../../infra/crypto';
import { DbService } from '../../../infra/db';
import {
  type CustomerPrincipal,
  CustomerAuthTokens,
  type IssuedSession,
  type RequestMeta,
  SessionService,
  isUsableLink,
} from '../../identity';
import { Blocklist } from '../../risk';
import type { Customer } from '../db/schema';
import { canSignIn } from '../domain/customer-status';
import { normaliseEmail } from '../domain/customer-input';
import { findCredentials, replacePasswordHash, upsertCredentials } from '../infra/customer-credentials.repository';
import { CustomerSignInFailures } from '../infra/customer-sign-in-failures';
import {
  findCustomerByEmail,
  findCustomerById,
  insertCustomerIfAbsent,
  updateCustomerRow,
} from '../infra/customer.repository';
import { CustomerLinks } from './customer-links';
import { CustomerSignInLimiter } from './customer-sign-in-limiter';
import { type WireStoreMe, toStoreMe } from './customer-views';

/** The answer of `login`: the next step and the session to put in the cookies. */
export interface CustomerLoginResult {
  readonly next: 'password' | 'done';
  readonly session: IssuedSession;
}

/** The answer of `verifyLink`: the customer's account and the session to put in the cookies. */
export interface CustomerVerifyResult {
  readonly me: WireStoreMe;
  readonly session: IssuedSession;
}

const WRONG_CREDENTIALS = 'The email or password is not correct.';

/** The link purposes `POST /store/v1/auth/verify` accepts: the sign-in link and the email verification link. */
const SIGN_IN_PURPOSES: readonly string[] = ['magic_link', 'verify_email'];

/**
 * The storefront sign-in: the emailed link, the password, and sign-out.
 *
 * Why: decision 018 and the map. `login` runs in a fixed order: rate limit, then the email's lock (decided from the email alone,
 * so a known and an unknown email are locked alike), then credentials (one indistinguishable `401` for an unknown email, a
 * wrong password and an account with no password yet, with the same work done in each case, each one counted towards the lock),
 * then the status (`403 ACCOUNT_SUSPENDED`, scenario b2c-account step 8), then a session: `pending_password`
 * after a temporary password, `active` otherwise. The sign-in link answers `204` for every email and never says whether the
 * account exists; an email the store does not know becomes a customer (self-signup), because the storefront has no other
 * registration route.
 *
 * Side effects: reads and writes `customers`, `customer_credentials` and `sessions`; writes `auth_tokens` and `outbox_events`
 * (the link mail); counts rate-limit attempts and wrong passwords (cache Redis); a failed attempt is logged without the email. Customer sign-ins write no audit
 * rows (the audit log records staff writes).
 *
 * @see docs/contract/MISMATCHES.md (feature 14b specs)
 */
@Injectable()
export class CustomerSignInService implements OnModuleInit {
  private readonly logger = new Logger(CustomerSignInService.name);
  private dummyHash: Promise<string> | undefined;

  constructor(
    private readonly db: DbService,
    private readonly hasher: PasswordHasher,
    private readonly tokenService: TokenService,
    private readonly blocklist: Blocklist,
    private readonly authTokens: CustomerAuthTokens,
    private readonly sessions: SessionService,
    private readonly limiter: CustomerSignInLimiter,
    private readonly failures: CustomerSignInFailures,
    private readonly links: CustomerLinks,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  /** Makes the dummy hash at boot, so the first unknown-email login takes as long as every other one. */
  onModuleInit(): void {
    this.dummyHash ??= this.hasher.hash(this.tokenService.random(32));
  }

  /**
   * Emails a sign-in link; silent for every email that must not get one.
   *
   * @param email the normalised email
   * @param meta the caller's address
   * @throws {AppError} `RATE_LIMITED` (429); nothing else: a blocklisted, suspended, blocked or anonymized customer is silent
   */
  async requestMagicLink(email: string, meta: RequestMeta): Promise<void> {
    await this.limiter.enforceMagicLink(email, meta.ip);
    const now = this.clock.now();
    if (await this.blocklist.isEmailBlocked(this.db.db, email)) return;
    await this.db.runInTransaction(async (work) => {
      const customer =
        (await findCustomerByEmail(work.tx, email)) ??
        // Self-signup: a guest row without a name; the link proves the address, and verifying it makes the account.
        (await insertCustomerIfAbsent(work.tx, { email, createdAt: now, updatedAt: now })) ??
        (await findCustomerByEmail(work.tx, email));
      if (!customer || !canSignIn(customer.status)) return;
      await this.links.send(work, { kind: 'magic_link', customerId: customer.id, ip: meta.ip });
    });
  }

  /**
   * Exchanges a sign-in or verification link for a session.
   *
   * @param linkId the `auth_tokens` id the guard resolved from the token
   * @param meta the caller's address and user agent
   * @param staleToken the session cookie the request already carried, ended here so it cannot be fixated
   * @returns the customer's account and the session
   * @throws {AppError} `TOKEN_INVALID` (410: the link is used, expired, replaced or of another kind, or the customer is not active)
   */
  async verifyLink(linkId: number, meta: RequestMeta, staleToken?: string): Promise<CustomerVerifyResult> {
    const link = await this.authTokens.findById(linkId);
    const customer =
      link !== undefined && SIGN_IN_PURPOSES.includes(link.purpose) && isUsableLink(link, this.clock.nowMs())
        ? await findCustomerById(this.db.db, link.subjectId)
        : undefined;
    if (!link || !customer || !canSignIn(customer.status)) throw new AppError('TOKEN_INVALID');

    await this.endStaleSession(staleToken);
    const now = this.clock.now();
    return this.db.runInTransaction(async (work) => {
      // A parallel request used the link first.
      if (!(await this.authTokens.consume(work, link.id))) throw new AppError('TOKEN_INVALID');
      await this.authTokens.voidOpen(work, customer.id, ['magic_link', 'verify_email'], link.id);
      // The link proves the address: the account holder is verified, and a guest who signs in by link has an account now.
      const updated = await updateCustomerRow(work.tx, customer.id, {
        emailVerifiedAt: customer.emailVerifiedAt ?? now,
        hasAccount: true,
        lastLoginAt: now,
        updatedAt: now,
      });
      const credentials = await findCredentials(work.tx, customer.id);
      // Every account has a credentials row (an account chooses its password later through a reset link).
      if (!credentials) {
        await upsertCredentials(work.tx, customer.id, {
          passwordHash: null,
          mustChangePassword: false,
          passwordChangedAt: null,
          updatedBy: null,
          now,
        });
      }
      const session = await this.sessions.create(
        { subjectType: 'customer', subjectId: customer.id, stage: 'active', ip: meta.ip, userAgent: meta.userAgent },
        work,
      );
      return { me: toStoreMe(updated, credentials?.passwordHash != null), session };
    });
  }

  /**
   * Checks the email and password and opens a session.
   *
   * @param input the credentials as typed
   * @param meta the caller's address and user agent
   * @param staleToken the session cookie the request already carried, ended here so it cannot be fixated
   * @returns the next step (`password` after a temporary password, otherwise `done`) and the session
   * @throws {AppError} `RATE_LIMITED` (429: too many tries, or the email is locked after ten wrong passwords: the same for an
   *   email with an account and one without), `UNAUTHORIZED` (401: unknown email, wrong password or no password yet; each
   *   counts towards the lock), `ACCOUNT_SUSPENDED` (403: correct password, suspended or blocked customer)
   */
  async login(
    input: { readonly email: string; readonly password: string },
    meta: RequestMeta,
    staleToken?: string,
  ): Promise<CustomerLoginResult> {
    const email = normaliseEmail(input.email);
    await this.limiter.enforceLogin(email, meta.ip);
    // The lock is read before the account, from the email alone: it must answer the same for an email without an account.
    const lockedFor = await this.failures.lockedFor(email);
    if (lockedFor > 0) {
      this.logger.warn(`Sign-in refused: the email is locked after repeated failures (${meta.ip})`);
      throw new AppError('RATE_LIMITED', {
        detail: 'Too many failed attempts. Try again later.',
        retryAfterSeconds: lockedFor,
      });
    }
    const customer = await findCustomerByEmail(this.db.db, email);
    const credentials = customer?.hasAccount ? await findCredentials(this.db.db, customer.id) : undefined;

    const correct = await this.passwordMatches(credentials?.passwordHash ?? undefined, input.password);
    if (!customer || !credentials || !correct || customer.status === 'anonymized') {
      this.logger.warn(
        `Customer sign-in refused (${customer ? (credentials?.passwordHash ? 'wrong password' : 'no password yet') : 'unknown email'}) from ${meta.ip}`,
      );
      // Every 401 counts, whoever the email belongs to (or nobody): a lock only some emails reach would tell which have accounts.
      await this.failures.recordFailure(email);
      throw new AppError('UNAUTHORIZED', { detail: WRONG_CREDENTIALS });
    }
    if (!canSignIn(customer.status)) {
      this.logger.warn(
        `Customer ${customer.id} signed in with a correct password but is ${customer.status} (${meta.ip})`,
      );
      throw new AppError('ACCOUNT_SUSPENDED', { detail: 'This account is suspended. Contact support.' });
    }

    await this.limiter.resetLogin(email, meta.ip);
    await this.failures.clear(email);
    await this.upgradeHash(customer, credentials.passwordHash!, input.password);
    await this.endStaleSession(staleToken);
    const now = this.clock.now();
    const session = await this.db.runInTransaction(async (work) => {
      await updateCustomerRow(work.tx, customer.id, { lastLoginAt: now, updatedAt: now });
      return this.sessions.create(
        {
          subjectType: 'customer',
          subjectId: customer.id,
          stage: credentials.mustChangePassword ? 'pending_password' : 'active',
          ip: meta.ip,
          userAgent: meta.userAgent,
        },
        work,
      );
    });
    return { next: credentials.mustChangePassword ? 'password' : 'done', session };
  }

  /**
   * Ends the caller's session.
   *
   * Why: sign-out always works. If the customer was suspended meanwhile, every session of it ends, not only this one.
   *
   * @param principal the session's customer (pending password step or full)
   */
  async logout(principal: CustomerPrincipal): Promise<void> {
    const customer = await findCustomerById(this.db.db, principal.customerId);
    await this.db.runInTransaction(async (work) => {
      if (customer && !canSignIn(customer.status)) {
        await this.sessions.revokeAllOf('customer', customer.id, {}, work);
        return;
      }
      await this.sessions.revoke(principal.session.id, work);
    });
  }

  /**
   * Verifies a password in the same time whether or not the customer exists.
   *
   * Why: an unknown email and an account with no password yet must not answer faster than a wrong password (decision 007):
   * they verify against a dummy hash made at the configured cost.
   */
  private async passwordMatches(hash: string | undefined, password: string): Promise<boolean> {
    if (hash) return this.hasher.verify(hash, password);
    this.dummyHash ??= this.hasher.hash(this.tokenService.random(32));
    await this.hasher.verify(await this.dummyHash, password);
    return false;
  }

  /** Re-hashes a correct password made at a lower cost than the configured one (decision 007); never fails the sign-in. */
  private async upgradeHash(customer: Customer, hash: string, password: string): Promise<void> {
    if (!this.hasher.needsRehash(hash)) return;
    try {
      await replacePasswordHash(this.db.db, customer.id, await this.hasher.hash(password));
    } catch (error) {
      this.logger.warn(`Could not upgrade the password hash of customer ${customer.id}: ${String(error)}`);
    }
  }

  /** Ends the customer session a sign-in request already carried (a new sign-in never continues an old session). */
  private async endStaleSession(token: string | undefined): Promise<void> {
    if (token === undefined) return;
    const view = await this.sessions.lookup(token);
    if (view?.subjectType === 'customer') await this.sessions.revoke(view.id);
  }
}
