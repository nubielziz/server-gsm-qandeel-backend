// MerchantPasswordService: the use cases of POST /client/auth/password/forgot, /password/reset and POST /client/security/password
// (map domain A, stage 2; MISMATCHES B127, B128, B131). A password change always ends the merchant's other sessions.
import { Inject, Injectable } from '@nestjs/common';
import { CLOCK, type Clock } from '../../../common/clock';
import { AppError } from '../../../common/errors';
import { PasswordHasher, TokenService } from '../../../infra/crypto';
import { DbService } from '../../../infra/db';
import type { Client } from '../db/schema';
import { checkPasswordPolicy } from '../domain/password-policy';
import { consumeAuthToken } from '../infra/auth-token.repository';
import { findClientByEmail, findClientById, saveClientPassword } from '../infra/merchant-auth.repository';
import {
  CLIENT_TOKEN_PURPOSES,
  PASSWORD_LINK_PURPOSES,
  findClientTokenByHash,
  voidOpenClientTokens,
} from '../infra/merchant-token.repository';
import type { MerchantPrincipal } from '../security/principal';
import { SessionService } from '../security/session.service';
import { MerchantMailOutbox } from './mail/merchant-mail-outbox';
import { MerchantAccountReader } from './merchant-account-reader';
import { MerchantAuthTokens } from './merchant-auth-tokens';
import { weakPassword } from './merchant-errors';
import { MerchantSignInLimiter } from './merchant-sign-in-limiter';
import type { RequestMeta } from './request-meta';

/**
 * Sends reset links, sets a password from a link, and changes the password of a signed-in merchant.
 *
 * Why: B127, B128 and B131 (with the invite link of identity-platform-2). "Forgot password" answers `204` for any email, so it
 * cannot be used to find out who is registered; a link works once, for an hour, and the newest wins; choosing a password ends
 * the merchant's sessions (reset, invite) or the others (change), and a wrong current password is `422` on its field, never
 * `401`, which would sign the caller out.
 *
 * Side effects: updates `clients`; inserts `auth_tokens` rows and the outbox event `merchant.password_reset`; marks links used;
 * revokes sessions (their cached views are dropped after the commit).
 *
 * @see docs/contract/MISMATCHES.md (B127, B128, B131)
 */
@Injectable()
export class MerchantPasswordService {
  constructor(
    private readonly db: DbService,
    private readonly hasher: PasswordHasher,
    private readonly tokens: TokenService,
    private readonly authTokens: MerchantAuthTokens,
    private readonly sessions: SessionService,
    private readonly limiter: MerchantSignInLimiter,
    private readonly reader: MerchantAccountReader,
    private readonly mail: MerchantMailOutbox,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  /**
   * Sends a reset link when the email belongs to a merchant that is not suspended.
   *
   * @param email the email as typed (lower-cased by the contract)
   * @param meta the caller's address
   * @throws {AppError} `RATE_LIMITED` (429); nothing else: an unknown or suspended email is silent
   */
  async forgot(email: string, meta: RequestMeta): Promise<void> {
    await this.limiter.enforceForgot(email, meta.ip);
    const client = await findClientByEmail(this.db.db, email);
    // A pending merchant without a password yet is allowed: this is how an expired invitation is renewed (identity-platform-2).
    if (!client || client.status === 'suspended') return;
    await this.db.runInTransaction(async (work) => {
      const issued = await this.authTokens.issue(work, { clientId: client.id, purpose: 'reset', ip: meta.ip });
      await this.mail.enqueue(work, {
        kind: 'password_reset',
        clientId: client.id,
        tokenId: issued.id,
        token: issued.token,
      });
    });
  }

  /**
   * Sets the password from a reset or invite link. It never signs anybody in.
   *
   * @param input the link token and the new password
   * @param meta the caller's address
   * @throws {AppError} `RATE_LIMITED` (429), `TOKEN_INVALID` (410: unknown, used, expired, superseded, or the merchant is
   *   suspended), `WEAK_PASSWORD` (422 on `password`; the link is not used up)
   */
  async reset(input: { readonly token: string; readonly password: string }, meta: RequestMeta): Promise<void> {
    await this.limiter.enforceLink(meta.limitKey);
    const now = this.clock.now();
    const link = await findClientTokenByHash(this.db.db, this.tokens.hash(input.token));
    const usable =
      link !== undefined &&
      link.usedAt === null &&
      link.expiresAt.getTime() > now.getTime() &&
      (PASSWORD_LINK_PURPOSES as readonly string[]).includes(link.purpose);
    const client = usable ? await findClientById(this.db.db, link.subjectId) : undefined;
    // A suspended merchant's link is as dead as an unknown one.
    if (!usable || !client || client.status === 'suspended') throw new AppError('TOKEN_INVALID');

    const problem = checkPasswordPolicy(input.password, { email: client.email, name: client.name });
    if (problem) throw weakPassword(problem.message, 'password');
    const passwordHash = await this.hasher.hash(input.password);
    await this.db.runInTransaction(async (work) => {
      // A parallel request used the link first.
      if (!(await consumeAuthToken(work.tx, link.id, now))) throw new AppError('TOKEN_INVALID');
      // An invite link proves the email address (identity-platform-2); a reset link does not.
      const saved = await saveClientPassword(work.tx, {
        id: client.id,
        passwordHash,
        now,
        verifyEmail: link.purpose === 'invite',
      });
      // The merchant was suspended since it was read: the change must not land.
      if (!saved) throw new AppError('TOKEN_INVALID');
      // An invitation proves the email address, so a pending verification link is moot too; a plain reset does not, and
      // there is no way to ask for a new verification mail, so it keeps that link.
      const spent = link.purpose === 'invite' ? CLIENT_TOKEN_PURPOSES : PASSWORD_LINK_PURPOSES;
      await voidOpenClientTokens(work.tx, client.id, spent, now, link.id);
      await this.sessions.revokeAllOf('client', client.id, {}, work);
    });
  }

  /**
   * Changes the password of the signed-in merchant.
   *
   * @param principal the signed-in merchant
   * @param input the current and the new password
   * @throws {AppError} `RATE_LIMITED` (429), `VALIDATION_FAILED` (422 on `currentPassword`), `WEAK_PASSWORD` (422 on
   *   `newPassword`), `UNAUTHORIZED` (401), `ACCOUNT_SUSPENDED` (403)
   */
  async change(
    principal: MerchantPrincipal,
    input: { readonly currentPassword: string; readonly newPassword: string },
  ): Promise<void> {
    await this.limiter.enforcePasswordChange(principal.clientId);
    const client = await this.reader.current(principal.clientId);
    if (!client.passwordHash || !(await this.hasher.verify(client.passwordHash, input.currentPassword))) {
      const message = 'The current password is not correct.';
      throw new AppError('VALIDATION_FAILED', {
        detail: message,
        errors: [{ field: 'currentPassword', code: 'INVALID_PASSWORD', message }],
      });
    }
    await this.limiter.resetPasswordChange(client.id);
    const passwordHash = await this.acceptableHash(input.newPassword, client);

    const now = this.clock.now();
    await this.db.runInTransaction(async (work) => {
      if (!(await saveClientPassword(work.tx, { id: client.id, passwordHash, now, verifyEmail: false }))) {
        throw new AppError('UNAUTHORIZED');
      }
      // An old reset link must not be able to undo the change.
      await voidOpenClientTokens(work.tx, client.id, PASSWORD_LINK_PURPOSES, now);
      await this.sessions.revokeAllOf('client', client.id, { exceptSessionId: principal.session.id }, work);
    });
  }

  /** Applies the policy, refuses the current password, and hashes (before any transaction: argon2 takes tens of milliseconds). */
  private async acceptableHash(password: string, client: Client): Promise<string> {
    const problem = checkPasswordPolicy(password, { email: client.email, name: client.name });
    if (problem) throw weakPassword(problem.message, 'newPassword');
    if (client.passwordHash && (await this.hasher.verify(client.passwordHash, password))) {
      throw weakPassword('Choose a password you are not using now.', 'newPassword');
    }
    return this.hasher.hash(password);
  }
}
