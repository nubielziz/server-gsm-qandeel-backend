// CustomerSignInService: the use cases of POST /store/v1/auth/magic-link, /verify, /login and /logout (map domain I, stage 14).
// Sensitive steps read the customer from the database, not from the session's cached copy (decision 018).
import { Inject, Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import { CLOCK, type Clock } from '../../../common/clock';
import { maskCustomerEmail } from '../../../common/customer-contact';
import { AppError } from '../../../common/errors';
import { PasswordHasher, TokenService } from '../../../infra/crypto';
import { DbService } from '../../../infra/db';
import { RateLimitService } from '../../../infra/rate-limit';
import {
  CUSTOMER_TOKEN_TTL_MS,
  type CustomerPrincipal,
  CustomerAuthTokens,
  type IssuedSession,
  NO_ACCOUNT_ID,
  type RequestMeta,
  SessionService,
  SignInLock,
  isUsableLink,
  livenessOf,
  takePublicMailPoint,
  temporaryPasswordExpired,
} from '../../identity';
import { Blocklist } from '../../risk';
import type { Customer, CustomerCredential } from '../db/schema';
import { canSignIn } from '../domain/customer-status';
import { normaliseEmail } from '../domain/customer-input';
import { findCredentials, replacePasswordHash, upsertCredentials } from '../infra/customer-credentials.repository';
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

/** What `requestMagicLink` gives the controller: the asking-browser cookie to set and when it ends (with the link). */
export interface MagicLinkBrowser {
  readonly browserKey: string;
  readonly expiresAt: Date;
}

/**
 * The answer of `verifyLink`: the customer's account, whether this browser asked for the link, the account's masked address, and the
 * session to put in the cookies.
 */
export interface CustomerVerifyResult {
  readonly me: WireStoreMe & { readonly requestedHere: boolean; readonly maskedEmail: string };
  readonly session: IssuedSession;
}

/** A value of the asking-browser cookie this service made: 32 random bytes in base64url. */
const BROWSER_KEY_SHAPE = /^[A-Za-z0-9_-]{43}$/;

const OTHER_ACCOUNT_SIGNED_IN =
  'This browser is signed in to another account. Sign out first, then open the link again.';

const WRONG_CREDENTIALS = 'The email or password is not correct.';

/** The link purposes `POST /store/v1/auth/verify` accepts: the sign-in link and the email verification link. */
const SIGN_IN_PURPOSES: readonly string[] = ['magic_link', 'verify_email'];

/**
 * The storefront sign-in: the emailed link, the password, and sign-out.
 *
 * Why: decisions 018 and 052 and the map. `login` runs in a fixed order: rate limit per email and network, then the email's lock
 * (decided from the email alone, so a known and an unknown email are locked alike; a network the account signed in from keeps a budget of its
 * own: five attempts in 15 minutes per email and network), then credentials (one indistinguishable `401` for an unknown email, a wrong password, a temporary password older than 72
 * hours and an account with no password yet, with the same work done in each case, each one counted towards the lock), then the
 * status (`403 ACCOUNT_SUSPENDED`, scenario b2c-account step 8), then a session: `pending_password` after a temporary password,
 * `active` otherwise. The sign-in link answers `204` for every email and never says whether the account exists; it spends one point of
 * the recipient's mail budget (five an hour), runs the same statements for every email (a run that sends nothing is rolled back) and
 * does not void the link sent before (up to three work at once). An email the store does not know becomes a customer (self-signup),
 * because the storefront has no other registration route. The link keeps the keyed hash of a cookie of the browser that asked for it: there
 * the exchange signs in as before; elsewhere it never replaces another customer's live session (`409 CONFLICT`) and says whose account
 * it opened.
 *
 * Side effects: reads and writes `customers`, `customer_credentials` and `sessions`; writes `auth_tokens` and `outbox_events`
 * (the link mail; rolled back when no mail is sent); counts rate-limit attempts, mail points and failed passwords (cache Redis); a failed
 * attempt is logged without the email. Customer sign-ins write no audit rows (the audit log records staff writes).
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
    private readonly lock: SignInLock,
    private readonly limits: RateLimitService,
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
   * Why: the link stores the keyed hash of a cookie of the browser that asked, so `verifyLink` can tell that browser from another
   * one. Every email gets the same cookie answer, so the cookie says nothing about the account.
   *
   * @param email the normalised email
   * @param meta the caller's address and network
   * @param browserKey the asking-browser cookie the request already carried: kept when this service made it, so every link asked for
   *   in one browser matches that browser
   * @returns the asking-browser cookie to set and when it ends (when the link does)
   * @throws {AppError} `RATE_LIMITED` (429: too many requests for this email from this network); nothing else: a blocklisted,
   *   suspended, blocked or anonymized customer, or one whose mail budget (five an hour) is used up, is silent
   */
  async requestMagicLink(email: string, meta: RequestMeta, browserKey?: string): Promise<MagicLinkBrowser> {
    await this.limiter.enforceMagicLink(email, meta);
    const now = this.clock.now();
    const key =
      browserKey !== undefined && BROWSER_KEY_SHAPE.test(browserKey) ? browserKey : this.tokenService.random(32);
    const blocked = await this.blocklist.isEmailBlocked(this.db.db, email);
    // The same statements for every email: a run that sends no mail writes for an id no account has and is rolled back (decision 052).
    await this.db.runOrDiscard(async (work) => {
      const customer =
        (await findCustomerByEmail(work.tx, email)) ??
        // Self-signup: a guest row without a name; the link proves the address, and verifying it makes the account.
        (await insertCustomerIfAbsent(work.tx, { email, createdAt: now, updatedAt: now })) ??
        (await findCustomerByEmail(work.tx, email));
      const eligible = !blocked && customer !== undefined && canSignIn(customer.status);
      const budget = await takePublicMailPoint(
        this.limits,
        'customer',
        eligible ? customer.id : undefined,
        'sign_in_link',
      );
      const deliver = eligible && budget;
      await this.links.send(work, {
        kind: 'magic_link',
        customerId: deliver ? customer.id : NO_ACCOUNT_ID,
        ip: meta.ip,
        keepEarlier: true,
        browserKey: key,
      });
      return deliver;
    });
    return { browserKey: key, expiresAt: new Date(now.getTime() + CUSTOMER_TOKEN_TTL_MS) };
  }

  /**
   * Exchanges a sign-in or verification link for a session.
   *
   * Why: a link opened in the browser that asked for it signs in at once. A link asked for elsewhere (or sent by staff, or after an
   * email change) must not replace the session of another customer in this browser: that is refused, the session stays and the link
   * stays usable. In a browser without such a session it signs in, and the answer says the link was asked for elsewhere and whose
   * account it opened (masked), so the shop can show it.
   *
   * @param linkId the `auth_tokens` id the guard resolved from the token
   * @param meta the caller's address and user agent
   * @param staleToken the session cookie the request already carried, ended here so it cannot be fixated
   * @param browserKey the asking-browser cookie the request carried, if any
   * @returns the customer's account with `requestedHere` and `maskedEmail`, and the session
   * @throws {AppError} `TOKEN_INVALID` (410: the link is used, expired, replaced or of another kind, or the customer is not active),
   *   `CONFLICT` (409: the link was not asked for in this browser and the browser holds a live session of another customer)
   */
  async verifyLink(
    linkId: number,
    meta: RequestMeta,
    staleToken?: string,
    browserKey?: string,
  ): Promise<CustomerVerifyResult> {
    const link = await this.authTokens.findById(linkId);
    const customer =
      link !== undefined && SIGN_IN_PURPOSES.includes(link.purpose) && isUsableLink(link, this.clock.nowMs())
        ? await findCustomerById(this.db.db, link.subjectId)
        : undefined;
    if (!link || !customer || !canSignIn(customer.status)) throw new AppError('TOKEN_INVALID');

    const requestedHere = this.authTokens.askedFrom(link, browserKey);
    // Checked before anything is written: the refusal leaves the session and the link as they are.
    if (!requestedHere) await this.assertNoOtherCustomerSession(staleToken, customer.id);
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
      return {
        me: {
          ...toStoreMe(updated, credentials?.passwordHash != null),
          requestedHere,
          maskedEmail: maskCustomerEmail(updated.email),
        },
        session,
      };
    });
  }

  /**
   * Checks the email and password and opens a session.
   *
   * @param input the credentials as typed
   * @param meta the caller's address and user agent
   * @param staleToken the session cookie the request already carried, ended here so it cannot be fixated
   * @returns the next step (`password` after a temporary password, otherwise `done`) and the session
   * @throws {AppError} `RATE_LIMITED` (429: too many tries from this network, or the email is locked after ten failed attempts and
   *   the account has not signed in from this network: the same for an email with an account and one without), `UNAUTHORIZED`
   *   (401: unknown email, wrong password, expired temporary password or no password yet; each stays counted towards the lock),
   *   `ACCOUNT_SUSPENDED` (403: correct password, suspended or blocked customer)
   */
  async login(
    input: { readonly email: string; readonly password: string },
    meta: RequestMeta,
    staleToken?: string,
  ): Promise<CustomerLoginResult> {
    const email = normaliseEmail(input.email);
    await this.limiter.enforceLogin(email, meta);
    const customer = await findCustomerByEmail(this.db.db, email);
    const credentials = customer?.hasAccount ? await findCredentials(this.db.db, customer.id) : undefined;
    // The lock is decided from the email alone (with the network exception of the account, if there is one): it must answer the same
    // for an email without an account.
    const account =
      customer?.hasAccount && customer.status !== 'anonymized'
        ? ({ subjectType: 'customer', subjectId: customer.id } as const)
        : undefined;
    await this.lock.assertMayTry('shop', email, account, meta);

    const verified = await this.passwordMatches(credentials?.passwordHash ?? undefined, input.password);
    // A temporary password runs out after 72 hours and is then refused like a wrong one (decision 052).
    const expired = credentials !== undefined && verified && temporaryPasswordExpired(credentials, this.clock.nowMs());
    if (!customer || !credentials || !verified || expired || customer.status === 'anonymized') {
      this.logger.warn(
        `Customer sign-in refused (${
          customer
            ? expired
              ? 'temporary password expired'
              : credentials?.passwordHash
                ? 'wrong password'
                : 'no password yet'
            : 'unknown email'
        }) from ${meta.ip}`,
      );
      // The attempt stays counted, whoever the email belongs to (or nobody): a lock only some emails reach would tell which have accounts.
      throw new AppError('UNAUTHORIZED', { detail: WRONG_CREDENTIALS });
    }
    // A correct password is no guess: only its own count goes back (a 403 below included); the failures of other attempts stay.
    await this.lock.giveBack('shop', email);
    this.assertCanSignIn(customer, meta);

    await this.limiter.resetLogin(email, meta);
    return this.startSession(customer, credentials, input.password, meta, staleToken);
  }

  /**
   * Opens the session of a customer whose password is already proven.
   *
   * Why: every password-verified customer sign-in ends here, `login` and the smart sign-in of feature 24A (which verifies the password
   * itself, once, and calls this): the status refusal, the hash upgrade, ending the stale customer session, `last_login_at`, and the
   * session (`pending_password` after a temporary password, `active` otherwise). Rate-limit counters and the lock are the caller's.
   *
   * Side effects: may update `customer_credentials.password_hash`; ends the session of `staleToken`; writes `customers.last_login_at`;
   * inserts a `sessions` row.
   *
   * @param customer the customer whose password was just proven
   * @param credentials its credentials row (the hash the password matched, the temporary-password flag)
   * @param password the proven password (for the hash upgrade)
   * @param meta the caller's address and user agent
   * @param staleToken the customer session cookie the request carried, ended so it cannot be fixated
   * @returns the next step (`password` or `done`) and the session
   * @throws {AppError} `ACCOUNT_SUSPENDED` (403: suspended or blocked customer)
   */
  async startSession(
    customer: Customer,
    credentials: Pick<CustomerCredential, 'passwordHash' | 'mustChangePassword'>,
    password: string,
    meta: RequestMeta,
    staleToken?: string,
  ): Promise<CustomerLoginResult> {
    this.assertCanSignIn(customer, meta);
    if (credentials.passwordHash) await this.upgradeHash(customer, credentials.passwordHash, password);
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

  /** Refuses a suspended or blocked customer whose password was correct (`403 ACCOUNT_SUSPENDED`, only after a correct password). */
  private assertCanSignIn(customer: Customer, meta: RequestMeta): void {
    if (canSignIn(customer.status)) return;
    this.logger.warn(
      `Customer ${customer.id} signed in with a correct password but is ${customer.status} (${meta.ip})`,
    );
    throw new AppError('ACCOUNT_SUSPENDED', { detail: 'This account is suspended. Contact support.' });
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

  /**
   * Refuses a link asked for elsewhere while the browser holds a live session of another customer.
   *
   * @param token the customer session cookie the request carried
   * @param customerId the customer the link belongs to
   * @throws {AppError} `CONFLICT` (409) for a live customer session (any stage) of another customer; an ended, unknown or missing
   *   session counts as none
   */
  private async assertNoOtherCustomerSession(token: string | undefined, customerId: number): Promise<void> {
    if (token === undefined) return;
    const view = await this.sessions.lookup(token);
    if (
      view?.subjectType === 'customer' &&
      view.subjectId !== customerId &&
      livenessOf(view, this.clock.nowMs()) === 'live'
    ) {
      throw new AppError('CONFLICT', { detail: OTHER_ACCOUNT_SIGNED_IN });
    }
  }

  /** Ends the customer session a sign-in request already carried (a new sign-in never continues an old session). */
  private async endStaleSession(token: string | undefined): Promise<void> {
    if (token === undefined) return;
    const view = await this.sessions.lookup(token);
    if (view?.subjectType === 'customer') await this.sessions.revoke(view.id);
  }
}
