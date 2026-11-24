// MerchantPasswordService: the use cases of POST /client/auth/password/forgot, /password/reset and POST /client/security/password
// (map domain A, stage 2; MISMATCHES B127, B128, B131). A password change always ends the merchant's other sessions.
import { Inject, Injectable } from '@nestjs/common';
import { CLOCK, type Clock } from '../../../common/clock';
import { AppError } from '../../../common/errors';
import { PasswordHasher, TokenService } from '../../../infra/crypto';
import { DbService } from '../../../infra/db';
import { RateLimitService } from '../../../infra/rate-limit';
import type { Client } from '../db/schema';
import { NO_ACCOUNT_ID } from '../domain/public-links';
import { checkPasswordPolicy } from '../domain/password-policy';
import { consumeAuthToken } from '../infra/auth-token.repository';
import { clearCodeFailures } from '../infra/code-failures.repository';
import { nextMerchantStep, merchantStageOfStep } from '../domain/merchant-sign-in-step';
import {
  findClientByEmail,
  findClientById,
  recordClientSignIn,
  saveClientPassword,
  saveForcedClientPassword,
} from '../infra/merchant-auth.repository';
import {
  CLIENT_TOKEN_PURPOSES,
  PASSWORD_LINK_PURPOSES,
  findClientTokenByHash,
  voidOpenClientTokens,
} from '../infra/merchant-token.repository';
import type { MerchantPrincipal } from '../security/principal';
import { SessionService } from '../security/session.service';
import type { IssuedSession } from '../security/session.types';
import { MerchantMailOutbox } from './mail/merchant-mail-outbox';
import { MerchantAccountReader } from './merchant-account-reader';
import { MerchantAuthTokens } from './merchant-auth-tokens';
import { weakPassword } from './merchant-errors';
import { MerchantSignInLimiter } from './merchant-sign-in-limiter';
import { takePublicMailPoint } from './public-mail-budget';
import type { RequestMeta } from './request-meta';
import { SignInLock } from './sign-in-lock';

/**
 * Sends reset links, sets a password from a link, and changes the password of a signed-in merchant.
 *
 * Why: B127, B128 and B131 (with the invite link of identity-platform-2) and decision 052. "Forgot password" answers `204` for any
 * email, so it cannot be used to find out who is registered, and it runs the same statements for every email (the ones that get
 * no mail are rolled back); it spends one point of the merchant's mail budget (five an hour), and a request beyond it answers `204`
 * and sends nothing. A link works once, for an hour; links a visitor asked for do not void each other (up to three work at once, the
 * oldest goes first); choosing a password ends the merchant's sessions (reset, invite) or the others (change). A password from a link
 * ends the email's shop sign-in lock and the count of wrong authenticator codes (a closed code step opens, `CodeStepLock`) and, when
 * the email was never verified, turns two-factor sign-in off (the link proves the mailbox); an own or forced change leaves both running, because a password chosen without the emailed link proves no mailbox and the customer of the same
 * email may be someone else. Only a password from a link ends the hold that a password set by staff puts on API keys
 * (`password_set_by_staff`, `MachineCredentialHold`), and not the hold of an email address staff set. A wrong current password is `422` on its field, never `401`, which would sign the caller out.
 *
 * Side effects: updates `clients`; inserts `auth_tokens` rows and the outbox event `merchant.password_reset` (rolled back for an email
 * that gets no mail); marks links used; revokes sessions (their cached views are dropped after the commit); counts one point of
 * `account-mail`; deletes the sign-in lock key of the email after the commit of a password from a link.
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
    private readonly lock: SignInLock,
    private readonly limits: RateLimitService,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  /**
   * Sends a reset link when the email belongs to a merchant that is not suspended.
   *
   * @param email the email as typed (lower-cased by the contract)
   * @param meta the caller's address and network
   * @throws {AppError} `RATE_LIMITED` (429: too many requests for this email from this network); nothing else: an unknown or
   *   suspended email, or a merchant whose mail budget (five an hour) is used up, is silent
   */
  async forgot(email: string, meta: RequestMeta): Promise<void> {
    await this.limiter.enforceForgot(email, meta);
    const client = await findClientByEmail(this.db.db, email);
    // A pending merchant without a password yet is allowed: this is how an expired invitation is renewed (identity-platform-2).
    const eligible = client !== undefined && client.status !== 'suspended';
    const budget = await takePublicMailPoint(
      this.limits,
      'client',
      eligible ? client.id : undefined,
      'forgot_password',
    );
    const deliver = eligible && budget;
    const subject = deliver ? client.id : NO_ACCOUNT_ID;
    // The same statements for every email: a run that gets no mail writes for an id no account has and is rolled back (decision 052).
    await this.db.runOrDiscard(async (work) => {
      const issued = await this.authTokens.issue(work, {
        clientId: subject,
        purpose: 'reset',
        ip: meta.ip,
        keepEarlier: true,
      });
      await this.mail.enqueue(work, { kind: 'password_reset', clientId: subject, tokenId: issued.id });
      return deliver;
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
      // The link proves the mailbox: a merchant whose email was never verified loses the two-factor sign-in it enrolled before (decision 052).
      const saved = await saveClientPassword(work.tx, {
        id: client.id,
        passwordHash,
        now,
        verifyEmail: link.purpose === 'invite',
        clearTwoFactor: client.emailVerifiedAt === null,
        // The link reached the account's mailbox: a hold from a password staff set ends (decision 046). The hold of an email address
        // staff set stays: the link went to that address.
        fromMailedLink: true,
      });
      // The merchant was suspended since it was read: the change must not land.
      if (!saved) throw new AppError('TOKEN_INVALID');
      // The link proves the mailbox: the wrong codes before the new password no longer count.
      await clearCodeFailures(work.tx, { type: 'client', id: client.id });
      // An invitation proves the email address, so a pending verification link is moot too; a plain reset does not, so
      // it keeps that link (a new one can be asked for through the resend route).
      const spent = link.purpose === 'invite' ? CLIENT_TOKEN_PURPOSES : PASSWORD_LINK_PURPOSES;
      await voidOpenClientTokens(work.tx, client.id, spent, now, link.id);
      await this.sessions.revokeAllOf('client', client.id, {}, work);
      // The owner of the mailbox chose a password: the failed tries before it no longer count (decision 052).
      work.afterCommit(() => this.lock.clear('shop', client.email));
    });
  }

  /**
   * Changes the password of the signed-in merchant.
   *
   * @param principal the signed-in merchant
   * @param input the current and the new password
   * @throws {AppError} `RATE_LIMITED` (429), `VALIDATION_FAILED` (422 on `currentPassword`), `WEAK_PASSWORD` (422 on
   *   `newPassword`), `UNAUTHORIZED` (401: the merchant is gone or suspended, or its password changed or was ended since the current
   *   one was checked; nothing is written), `ACCOUNT_SUSPENDED` (403)
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
    // The current password proves the hash it was checked against, not the one the row holds at the write.
    const expectedHash = client.passwordHash;
    const passwordHash = await this.acceptableHash(input.newPassword, client);

    const now = this.clock.now();
    await this.db.runInTransaction(async (work) => {
      if (
        !(await saveClientPassword(work.tx, { id: client.id, passwordHash, now, verifyEmail: false, expectedHash }))
      ) {
        throw new AppError('UNAUTHORIZED', { detail: 'The account changed while this request ran. Sign in again.' });
      }
      // An old reset link must not be able to undo the change.
      await voidOpenClientTokens(work.tx, client.id, PASSWORD_LINK_PURPOSES, now);
      await this.sessions.revokeAllOf('client', client.id, { exceptSessionId: principal.session.id }, work);
      // The shop lock of the email stays: a password chosen without the emailed link proves no mailbox, so the email's customer may be someone else (decision 052).
    });
  }

  /**
   * Replaces a temporary password during the sign-in, and continues the same sign-in.
   *
   * Why: feature 20: staff set a temporary password (`must_change_password`), so the merchant's login opened a `pending_password` session.
   * The password the merchant types here is the one they keep; the temporary one was proven when the session was opened. The pending
   * session is rotated (new token, the old one dies in the same transaction: no fixation) to `pending_totp` when 2FA is on, or to a full
   * session; every other session of the merchant ends and open password links are voided.
   *
   * Side effects: updates `clients` (password, `must_change_password`, and the last sign-in when the session becomes full); marks links used;
   * revokes sessions; rotates the session; counts attempts on the `sign-in` limiter's per-account password counter.
   *
   * @param principal the merchant of the `pending_password` session
   * @param password the new password
   * @param meta the caller's address and user agent
   * @returns the next step (`totp` or `done`) and the new session for the cookies
   * @throws {AppError} `RATE_LIMITED` (429), `UNAUTHORIZED` (401: the session is not a pending password step, the account no longer
   *   needs the change, or a parallel request or a suspension won), `ACCOUNT_SUSPENDED` (403), `WEAK_PASSWORD` (422 on `password`:
   *   the policy, or the password in use)
   */
  async changeForced(
    principal: MerchantPrincipal,
    password: string,
    meta: RequestMeta,
  ): Promise<{ readonly next: 'totp' | 'done'; readonly session: IssuedSession }> {
    await this.limiter.enforcePasswordChange(principal.clientId);
    const client = await this.reader.current(principal.clientId);
    if (principal.stage !== 'pending_password' || !client.mustChangePassword) throw new AppError('UNAUTHORIZED');
    const passwordHash = await this.acceptableHash(password, client, 'password');

    const now = this.clock.now();
    const result = await this.db.runInTransaction(async (work) => {
      const saved = await saveForcedClientPassword(work.tx, { id: client.id, passwordHash, now });
      // A parallel request replaced the password first, or a suspension landed since the read.
      if (!saved) throw new AppError('UNAUTHORIZED');
      await voidOpenClientTokens(work.tx, client.id, PASSWORD_LINK_PURPOSES, now);
      await this.sessions.revokeAllOf('client', client.id, { exceptSessionId: principal.session.id }, work);
      // The shop lock stays, as after an own change; the staff action that set the temporary password ended it (decision 052).
      const next = nextMerchantStep({ mustChangePassword: false, twofaEnabled: saved.twofaEnabled });
      // `done` or `totp` here: `password` cannot come back after the flag was cleared.
      const stepAfter = next === 'password' ? 'done' : next;
      // Rotating ends the pending session: if it was ended meanwhile this throws `UNAUTHORIZED` and the change rolls back.
      const session = await this.sessions.rotate(
        principal.session,
        { stage: merchantStageOfStep(stepAfter), ip: meta.ip, userAgent: meta.userAgent },
        work,
      );
      if (stepAfter === 'done') await recordClientSignIn(work.tx, client.id, now, meta.ip);
      return { next: stepAfter, session };
    });
    await this.limiter.resetPasswordChange(client.id);
    return result;
  }

  /** Applies the policy, refuses the current password, and hashes (before any transaction: argon2 takes tens of milliseconds). */
  private async acceptableHash(
    password: string,
    client: Client,
    field: 'newPassword' | 'password' = 'newPassword',
  ): Promise<string> {
    const problem = checkPasswordPolicy(password, { email: client.email, name: client.name });
    if (problem) throw weakPassword(problem.message, field);
    if (client.passwordHash && (await this.hasher.verify(client.passwordHash, password))) {
      throw weakPassword('Choose a password you are not using now.', field);
    }
    return this.hasher.hash(password);
  }
}
