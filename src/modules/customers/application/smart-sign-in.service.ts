// SmartSignInService: the use case of POST /client/auth/sign-in (feature 24A, ROADMAP 1.3): one email + password form that signs in a
// merchant or a customer, without telling which emails exist. Enumeration and lock-out rules: docs/briefs/24A-smart-sign-in.md § 2.3.
import { Inject, Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import { CLOCK, type Clock } from '../../../common/clock';
import { AppError } from '../../../common/errors';
import { PasswordHasher, TokenService } from '../../../infra/crypto';
import { DbService } from '../../../infra/db';
import {
  type IssuedSession,
  MerchantPasswordSignIn,
  type MerchantSignInStep,
  type RequestMeta,
  SignInLock,
  temporaryPasswordExpired,
} from '../../identity';
import { normaliseEmail } from '../domain/customer-input';
import { findCredentials } from '../infra/customer-credentials.repository';
import { findCustomerByEmail } from '../infra/customer.repository';
import { CustomerSignInLimiter } from './customer-sign-in-limiter';
import { CustomerSignInService } from './customer-sign-in.service';

/** Which account a smart sign-in opened: it says which surface's cookies and CSRF token came back. */
export type SignInKind = 'merchant' | 'customer';

/** The answer of `signIn`: the account kind, its next step and the session to put in that kind's cookies. */
export interface SmartSignInResult {
  readonly kind: SignInKind;
  /** `password` (a temporary password to replace), `totp` (merchants only) or `done`. */
  readonly next: MerchantSignInStep;
  readonly session: IssuedSession;
}

/** The session cookies the request already carried, one per kind (each is ended only by a sign-in of its own kind). */
export interface StaleSessions {
  readonly client?: string;
  readonly customer?: string;
}

const WRONG_CREDENTIALS = 'The email or password is not correct.';

/**
 * Signs a merchant or a customer in from one form.
 *
 * Why: feature 24A (D-1 to D-3) and decision 052. The site has one sign-in form; the answer must never show which table holds an email.
 * So every attempt, whatever the email is, in this order: charges **both** login counters (the merchant one of `POST /client/auth/login`
 * and the customer one of `POST /store/v1/auth/login`, so the three routes share one budget per email and network), looks the email up in
 * both tables, applies the email's lock (shared by the three routes: the attempt is counted before the verify and refused while the email
 * is locked; a network the account being signed into has signed in from keeps a budget of its own: five attempts in 15 minutes per email and network), and runs **exactly one** argon2 verify: against the merchant's hash when a merchant with a password exists and its email is
 * verified or no customer account with a password has the email (a merchant that never proved its mailbox does not shadow the customer who
 * owns it), else against the customer's hash when an account with a password exists and is not anonymized, else against a dummy hash made
 * at boot. A temporary password older than 72 hours is refused like a wrong one. Every `401` (unknown email, wrong password, expired
 * temporary password, no password yet, anonymized) is one answer and stays counted towards the lock; a correct password takes back only
 * its own count (before `403 ACCOUNT_SUSPENDED`, which comes only after a correct password, like the old routes).
 * A success opens the session of that kind through its own module's `startSession` (feature 20's merchant steps; the customer's
 * temporary password), ends only the stale session of the same kind (a session of the other kind stays), then clears both login
 * counters (a running lock stays). No transaction spans the two modules: each `startSession` owns its writes.
 *
 * Side effects: rate-limit counters and the shop sign-in lock (cache Redis; one `sessions` read while the email is locked); `sessions`, `clients` or `customers` and their
 * credentials (through each side's `startSession`); a failed attempt is logged without the email. No audit row, no outbox, no job.
 *
 * @see docs/briefs/24A-smart-sign-in.md
 */
@Injectable()
export class SmartSignInService implements OnModuleInit {
  private readonly logger = new Logger(SmartSignInService.name);
  private dummyHash: Promise<string> | undefined;

  constructor(
    private readonly db: DbService,
    private readonly hasher: PasswordHasher,
    private readonly tokens: TokenService,
    private readonly merchants: MerchantPasswordSignIn,
    private readonly limiter: CustomerSignInLimiter,
    private readonly lock: SignInLock,
    private readonly customers: CustomerSignInService,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  /** Makes the dummy hash at boot, so the first attempt for an unknown email takes as long as every other one. */
  onModuleInit(): void {
    this.dummyHash ??= this.hasher.hash(this.tokens.random(32));
  }

  /**
   * Checks the email and password against both account kinds and opens the session of the one that matched.
   *
   * @param input the credentials as typed
   * @param meta the caller's address and user agent
   * @param stale the session cookies the request carried (the one of the kind that signs in is ended)
   * @returns the kind, the next step and the session
   * @throws {AppError} `RATE_LIMITED` (429: either counter is spent, or the email is locked after ten failures and the account being
   *   signed into has not signed in from this network; the same for every email), `UNAUTHORIZED` (401: unknown email, wrong password,
   *   expired temporary password, no password yet, anonymized customer; the attempt stays counted towards the lock), `ACCOUNT_SUSPENDED` (403: correct
   *   password, suspended merchant or suspended or blocked customer)
   */
  async signIn(
    input: { readonly email: string; readonly password: string },
    meta: RequestMeta,
    stale: StaleSessions,
  ): Promise<SmartSignInResult> {
    const email = normaliseEmail(input.email);
    await this.chargeBoth(email, meta);

    // Both lookups always run, whatever the first one finds.
    const [merchant, customerFound] = await Promise.all([
      this.merchants.find(email),
      findCustomerByEmail(this.db.db, email).then(async (customer) => ({
        customer,
        credentials: customer?.hasAccount ? await findCredentials(this.db.db, customer.id) : undefined,
      })),
    ]);
    const { customer, credentials } = customerFound;

    // Exactly one argon2 verify per attempt (D-3). The merchant's hash comes first when the merchant has a password and its email is
    // verified (or no customer account with a password has the email); a merchant without a password, or one that never proved its
    // mailbox next to a customer who has a password, does not shadow the customer (decision 052).
    const customerHash = customer && customer.status !== 'anonymized' ? credentials?.passwordHash : undefined;
    const customerReady = customer !== undefined && credentials !== undefined && customerHash != null;
    const merchantFirst = merchant?.hasPassword === true && (merchant.shadowsCustomer || !customerReady);
    // The lock is decided from the email alone, with the network exception of the account being signed into (if any).
    const account =
      merchantFirst && merchant
        ? ({ subjectType: 'client', subjectId: merchant.clientId } as const)
        : customerReady
          ? ({ subjectType: 'customer', subjectId: customer.id } as const)
          : undefined;
    await this.lock.assertMayTry('shop', email, account, meta);

    if (merchantFirst && merchant) {
      if (await merchant.verify(input.password)) {
        // A correct password is no guess: only its own count goes back (a 403 of `open` included); other attempts' failures stay.
        await this.lock.giveBack('shop', email);
        const { next, session } = await merchant.open(meta, stale.client);
        await this.clearCounters(email, meta);
        return { kind: 'merchant', next, session };
      }
      return this.refuse(meta, 'wrong password (merchant)');
    }
    if (customerReady) {
      const correct =
        (await this.hasher.verify(customerHash, input.password)) &&
        !temporaryPasswordExpired(credentials, this.clock.nowMs());
      if (correct) {
        await this.lock.giveBack('shop', email);
        const { next, session } = await this.customers.startSession(
          customer,
          credentials,
          input.password,
          meta,
          stale.customer,
        );
        await this.clearCounters(email, meta);
        return { kind: 'customer', next, session };
      }
      return this.refuse(meta, 'wrong password (customer)');
    }
    this.dummyHash ??= this.hasher.hash(this.tokens.random(32));
    await this.hasher.verify(await this.dummyHash, input.password);
    return this.refuse(meta, merchant || customer ? 'no password yet' : 'unknown email');
  }

  /**
   * Charges the merchant then the customer login counter; both are always charged, even when the first refuses.
   *
   * Why: a counter charged only for some emails would let the `429` tell which table holds an email (D-2).
   */
  private async chargeBoth(email: string, meta: RequestMeta): Promise<void> {
    let refusal: Error | undefined;
    // Sequential on purpose (the merchant counter first), and never short-circuited: the second is charged even after a refusal.
    for (const charge of [() => this.merchants.charge(email, meta), () => this.limiter.enforceLogin(email, meta)]) {
      try {
        await charge();
      } catch (error) {
        refusal ??= error instanceof Error ? error : new Error(String(error));
      }
    }
    if (refusal) throw refusal;
  }

  /** After a success: both login counters start again (the email's lock count was given back after the password; a running lock stays). */
  private async clearCounters(email: string, meta: RequestMeta): Promise<void> {
    await this.merchants.reset(email, meta);
    await this.limiter.resetLogin(email, meta);
  }

  /**
   * Answers the one `401` every failed attempt gets; the attempt stays counted towards the email's lock, whoever the email belongs to (or
   * nobody): a lock only some emails reach would tell which have accounts.
   */
  private refuse(meta: RequestMeta, reason: string): never {
    this.logger.warn(`Smart sign-in refused (${reason}) from ${meta.ip}`);
    throw new AppError('UNAUTHORIZED', { detail: WRONG_CREDENTIALS });
  }
}
