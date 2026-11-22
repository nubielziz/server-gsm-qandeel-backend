// MerchantPasswordSignIn: the narrow piece of the merchant sign-in that the smart sign-in of feature 24A (POST /client/auth/sign-in,
// customers module) uses. The password hash never leaves identity: callers get closures that verify and open, never the hash.
import { Inject, Injectable, Logger } from '@nestjs/common';
import { CLOCK, type Clock } from '../../../common/clock';
import { PasswordHasher } from '../../../infra/crypto';
import { DbService } from '../../../infra/db';
import { merchantShadowsCustomer } from '../domain/merchant-sign-in-step';
import { temporaryPasswordExpired } from '../domain/temporary-password';
import { findClientByEmail } from '../infra/merchant-auth.repository';
import { upgradeClientPasswordHash } from './merchant-password-hash';
import { type MerchantLoginResult, MerchantSignInService } from './merchant-sign-in.service';
import { MerchantSignInLimiter } from './merchant-sign-in-limiter';
import type { RequestMeta } from './request-meta';

/**
 * A merchant found by email, as the smart sign-in sees it. The hash stays inside identity.
 *
 * Why: the smart sign-in must run exactly one argon2 verify per attempt, whichever table holds the email (feature 24A, D-3), so it
 * decides which verify to run; identity keeps the hash and the session rules.
 */
export interface MerchantCandidate {
  /** The merchant's id. */
  readonly clientId: number;
  /** False for a merchant that staff invited and that has not chosen a password yet: it cannot sign in with one. */
  readonly hasPassword: boolean;
  /**
   * True when the merchant's email is verified, so it takes precedence over a customer account with the same email (decision 052).
   * A merchant that registered but never proved its mailbox must not shadow the customer who owns that address.
   */
  readonly shadowsCustomer: boolean;
  /**
   * Runs one argon2 verify of a password against the stored hash, and refuses a temporary password older than 72 hours.
   *
   * @param password the password as typed
   * @returns true when it is the merchant's password and, if it is a temporary one, not older than 72 hours
   * @throws {Error} when the merchant has no password (`hasPassword` false): a caller's mistake, never an answer to a visitor
   */
  verify(password: string): Promise<boolean>;
  /**
   * Opens the session of the merchant after `verify` returned true: the suspension refusal, the stale merchant session ended, the session
   * of the next step (`MerchantSignInService.startSession`), then the hash upgraded to the configured cost with the proven password.
   *
   * @param meta the caller's address and user agent
   * @param staleToken the merchant session cookie the request carried, ended so it cannot be fixated
   * @returns the next step (`password`, `totp` or `done`) and the session
   * @throws {AppError} `ACCOUNT_SUSPENDED` (403)
   * @throws {Error} when no password was proven with `verify` first
   */
  open(meta: RequestMeta, staleToken?: string): Promise<MerchantLoginResult>;
}

/**
 * The merchant side of the smart sign-in: its rate-limit counter and a candidate per email.
 *
 * Why: feature 24A hosts `POST /client/auth/sign-in` in the customers module (customers may import identity, never the reverse,
 * decision 032). The route spends the same `sign-in` counter as `POST /client/auth/login` (D-2: one budget per email and network for
 * both routes) and reuses the merchant's step logic of feature 20 (`next: password | totp | done`) without duplicating it.
 *
 * Side effects: counter keys of `MerchantSignInLimiter` (`gsm:{env}:ratelimit:sign-in:{hash}`); `open` writes `sessions` and
 * `clients` (last sign-in, an upgraded hash) through `MerchantSignInService.startSession`.
 *
 * @see docs/briefs/24A-smart-sign-in.md § 2.2
 */
@Injectable()
export class MerchantPasswordSignIn {
  private readonly logger = new Logger(MerchantPasswordSignIn.name);

  constructor(
    private readonly db: DbService,
    private readonly hasher: PasswordHasher,
    private readonly limiter: MerchantSignInLimiter,
    private readonly signIn: MerchantSignInService,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  /**
   * Charges the login counter of `POST /client/auth/login` for an email from a network.
   *
   * @param email the email (normalised or as typed: the key trims and lower-cases it)
   * @param meta the caller (its network key: the IPv4 address or the IPv6 /64)
   * @throws {AppError} `RATE_LIMITED` (429, with `Retry-After`) from the sixth attempt in 15 minutes
   */
  async charge(email: string, meta: Pick<RequestMeta, 'limitKey'>): Promise<void> {
    await this.limiter.enforceLogin(email, meta);
  }

  /**
   * Clears that counter after a successful sign-in.
   *
   * @param email the email
   * @param meta the caller (its network key)
   */
  async reset(email: string, meta: Pick<RequestMeta, 'limitKey'>): Promise<void> {
    await this.limiter.resetLogin(email, meta);
  }

  /**
   * Finds the merchant of an email, whatever its status. No hashing happens here.
   *
   * @param email the email (compared case-insensitively)
   * @returns the candidate, or `undefined` when no merchant has this email
   */
  async find(email: string): Promise<MerchantCandidate | undefined> {
    const client = await findClientByEmail(this.db.db, email);
    if (!client) return undefined;
    const hash = client.passwordHash;
    // The password `verify` proved; `open` refuses to run without one, and upgrades the hash with this one only.
    let proven: string | undefined;
    return {
      clientId: client.id,
      hasPassword: hash !== null,
      shadowsCustomer: merchantShadowsCustomer(client),
      verify: async (password) => {
        if (hash === null) throw new Error(`Merchant ${client.id} has no password to verify`);
        // A temporary password runs out after 72 hours and is then refused like a wrong one (decision 052).
        const correct =
          (await this.hasher.verify(hash, password)) && !temporaryPasswordExpired(client, this.clock.nowMs());
        proven = correct ? password : undefined;
        return correct;
      },
      open: async (meta, staleToken) => {
        if (proven === undefined) throw new Error(`Merchant ${client.id}: open() needs a password proven by verify()`);
        const result = await this.signIn.startSession(client, meta, staleToken);
        await upgradeClientPasswordHash(this.db.db, this.hasher, this.logger, client, proven);
        return result;
      },
    };
  }
}
