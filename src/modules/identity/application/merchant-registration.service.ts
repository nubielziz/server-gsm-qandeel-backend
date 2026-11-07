// MerchantRegistrationService: the use cases of POST /client/auth/register and POST /client/auth/verify-email (map domain A,
// stage 2; MISMATCHES B122, B123). A registration never tells whether the email was already known.
import { randomInt } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import { CLOCK, type Clock } from '../../../common/clock';
import { AppError } from '../../../common/errors';
import { PasswordHasher, TokenService } from '../../../infra/crypto';
import { DbService } from '../../../infra/db';
import { ClientGroupDirectory } from '../../catalog';
import { MerchantAccounts } from '../../money';
import { checkPasswordPolicy } from '../domain/password-policy';
import { referralCodeFor, usernameFor } from '../domain/merchant-codes';
import { consumeAuthToken } from '../infra/auth-token.repository';
import {
  findClientByEmail,
  findClientIdByReferralCode,
  insertClient,
  markClientEmailVerified,
  uniqueViolationOf,
} from '../infra/merchant-auth.repository';
import { findClientTokenByHash } from '../infra/merchant-token.repository';
import { MerchantMailOutbox } from './mail/merchant-mail-outbox';
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
 * Why: B122. A visitor registers, the merchant exists as `pending` until staff approve it (B153), and the portal's answer is
 * `204` for a new and for a known email alike: the password is always hashed (same work), the known email changes nothing and
 * sends nothing, and the 429 counts both. The merchant's ledger accounts are opened in the same transaction as the merchant
 * (RESOLUTIONS identity-platform-1), so no merchant exists without a wallet.
 *
 * Side effects: `register` inserts `clients`, `ledger_accounts` (through `MerchantAccounts.open`), an `auth_tokens` row and the
 * outbox event `merchant.email_verification`; `verifyEmail` sets `clients.email_verified_at` and uses the link up.
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
    if (await findClientByEmail(this.db.db, input.email)) return;

    for (let attempt = 1; ; attempt++) {
      try {
        await this.create(input, passwordHash, referredById, meta);
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
   * Marks the email of a merchant verified.
   *
   * @param token the token of the emailed link
   * @param meta the caller's address
   * @throws {AppError} `RATE_LIMITED` (429), `TOKEN_INVALID` (410: unknown, used, expired or superseded)
   */
  async verifyEmail(token: string, meta: RequestMeta): Promise<void> {
    await this.limiter.enforceLink(meta.limitKey);
    const now = this.clock.now();
    const link = await findClientTokenByHash(this.db.db, this.tokens.hash(token));
    if (link?.purpose !== 'verify_email' || link.usedAt !== null || link.expiresAt.getTime() <= now.getTime()) {
      throw new AppError('TOKEN_INVALID');
    }
    await this.db.runInTransaction(async (work) => {
      // A parallel request used the link first.
      if (!(await consumeAuthToken(work.tx, link.id, now))) throw new AppError('TOKEN_INVALID');
      await markClientEmailVerified(work.tx, link.subjectId, now);
    });
  }

  /** One attempt: the merchant, its accounts, the verification link and the mail event in one transaction. */
  private async create(
    input: RegisterInput,
    passwordHash: string,
    referredById: number | undefined,
    meta: RequestMeta,
  ): Promise<void> {
    await this.db.runInTransaction(async (work) => {
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
        token: issued.token,
      });
    });
  }
}
