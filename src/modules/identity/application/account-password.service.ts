// AccountPasswordService: the use cases of POST /client/auth/password/forgot, /password/reset, /password/change and POST /client/security/password
// (and their store aliases), for an account of any rank (map domain A, stage 2; MISMATCHES B127, B128, B131; decision 064). A password change
// always ends the account's other sessions.
import { Inject, Injectable } from '@nestjs/common';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { CLOCK, type Clock } from '../../../common/clock';
import { AppError } from '../../../common/errors';
import { PasswordHasher } from '../../../infra/crypto';
import { DbService } from '../../../infra/db';
import { RateLimitService } from '../../../infra/rate-limit';
import { RankGroupReads } from '../../catalog/ports/rank-group-reads';
import { AccountDirectory } from '../accounts/account-directory';
import { canAct } from '../accounts/account-status';
import type { Client } from '../db/schema';
import { accountStageOfStep, nextAccountStep } from '../domain/account-sign-in-step';
import { checkPasswordPolicy } from '../domain/password-policy';
import { NO_ACCOUNT_ID } from '../domain/public-links';
import { clearCodeFailures } from '../infra/code-failures.repository';
import { recordClientSignIn, saveClientPassword, saveForcedClientPassword } from '../infra/merchant-auth.repository';
import { AccountAuthTokens, type AccountTokenPurpose } from '../ports/account-auth-tokens';
import { AccountMailOutbox } from '../ports/account-mail-outbox';
import type { AccountForcedChangeAnswer, AccountOwnPassword } from '../ports/account-auth';
import type { AccountPrincipal } from '../ports/account-principal';
import { AccountSessions } from '../ports/account-sessions';
import { SessionService } from '../security/session.service';
import { AccountSignInLimiter } from './account-sign-in-limiter';
import { MerchantAccountReader } from './merchant-account-reader';
import { weakPassword } from './merchant-errors';
import { takePublicMailPoint } from './public-mail-budget';
import { type RequestMeta, requestMetaOf } from './request-meta';
import { SignInLock } from './sign-in-lock';

/** A rank id no rank has: the read of an email that finds no account (the rank ids are small whole numbers from 1). */
const NO_RANK_ID = 0;
/** The links that set a password: an invitation and a reset (a visitor may hold up to three of them at once). */
const PASSWORD_LINKS = ['invite', 'reset'] as const satisfies readonly AccountTokenPurpose[];
/** What an invitation uses up besides itself: the other password links and the verification link, because it proves the mailbox. */
const INVITATION_SPENT = ['invite', 'reset', 'verify_email'] as const satisfies readonly AccountTokenPurpose[];

/**
 * Sends reset links, sets a password from a link, replaces a temporary password, and changes the password of a signed-in account.
 *
 * Why: B127, B128 and B131 (with the invite link of identity-platform-2), decisions 052 and 064. "Forgot password" answers `204` for any
 * email, so it cannot be used to find out who is registered, and it runs the same statements for every email (the ones that get no
 * mail are rolled back); it finds the account through `AccountDirectory.findLoginByEmail` only, so a guest row that shares the email is
 * never what it meets, and it spends one point of the account's mail budget (five an hour); a request beyond it answers `204` and sends
 * nothing. A link works once, for an hour, and only while the account may act (`canAct`); links a visitor asked for do not void each
 * other (up to three work at once, the oldest goes first); choosing a password ends the account's sessions (reset, invite) or the others
 * (change). A password from a link ends the email's shop sign-in lock and the count of wrong authenticator codes (a closed code step
 * opens, `CodeStepLock`) and, when the email was never verified, turns two-step sign-in off (the link proves the mailbox); an own or
 * forced change leaves both running, because a password chosen without the emailed link proves no mailbox. Only a password from a link
 * clears the mark `password_set_by_staff` (a staff temporary password; nothing reads it since decision 067), and it leaves `email_set_by_staff`
 * as it is. A wrong current password is `422` on its field, never `401`, which would sign the caller out; an account
 * without a password is told to choose one first with `409`.
 *
 * Side effects: updates `clients`; inserts `auth_tokens` rows and the outbox event of the reset mail (rolled back for an email that
 * gets no mail); marks links used; revokes sessions (their cached views are dropped after the commit); counts one point of
 * `account-mail`; deletes the sign-in lock key of the email after the commit of a password from a link; opens the new session of a
 * forced change and sets its cookies on the reply.
 *
 * @see docs/contract/MISMATCHES.md (B127, B128, B131)
 */
@Injectable()
export class AccountPasswordService implements AccountOwnPassword {
  constructor(
    private readonly db: DbService,
    private readonly hasher: PasswordHasher,
    private readonly directory: AccountDirectory,
    private readonly ranks: RankGroupReads,
    private readonly authTokens: AccountAuthTokens,
    private readonly mail: AccountMailOutbox,
    private readonly accountSessions: AccountSessions,
    private readonly sessions: SessionService,
    private readonly limiter: AccountSignInLimiter,
    private readonly reader: MerchantAccountReader,
    private readonly lock: SignInLock,
    private readonly limits: RateLimitService,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  /**
   * Sends a reset link when the email belongs to an account with a login that may act.
   *
   * @param email the email as typed
   * @param meta the caller's address and network
   * @throws {AppError} `RATE_LIMITED` (429: too many requests for this email from this network); nothing else: an unknown email, a
   *   guest row, a suspended, blocked or erased account, or an account whose mail budget (five an hour) is used up, is silent
   */
  async forgot(email: string, meta: RequestMeta): Promise<void> {
    await this.limiter.enforceForgot(email, meta);
    const found = await this.directory.findLoginByEmail(this.db.db, email);
    // The directory reads the rank of a row it finds; an email it does not find reads the same table once too, so the statements sent
    // do not tell the two apart (decision 052, rule seven).
    if (found === undefined) await this.ranks.kindOf(this.db.db, NO_RANK_ID);
    // An account without a password yet is allowed: this is how an expired invitation is renewed (identity-platform-2).
    const target = found !== undefined && found.hasAccount && canAct(found.status) ? found : undefined;
    const budget = await takePublicMailPoint(this.limits, 'account', target?.id, 'forgot_password');
    const subject = target !== undefined && budget ? target.id : NO_ACCOUNT_ID;
    // The same statements for every email: a run that gets no mail writes for an id no account has and is rolled back (decision 052).
    await this.db.runOrDiscard(async (work) => {
      const issued = await this.authTokens.issue(work, {
        accountId: subject,
        purpose: 'reset',
        ip: meta.ip,
        keepEarlier: true,
      });
      await this.mail.enqueue(work, { kind: 'password_reset', accountId: subject, tokenId: issued.tokenId });
      return subject !== NO_ACCOUNT_ID;
    });
  }

  /**
   * Sets the password from a reset or invite link. It never signs anybody in.
   *
   * Why: the link is looked at twice. The first look (a short transaction of its own) only says whose link it is, so the password
   * policy can use the account's email and name and the argon2 hash is made while no row is locked; the second look, inside the
   * transaction that writes, locks the link again and requires the same one, so two requests with one link use it once.
   *
   * @param input the link token and the new password
   * @param meta the caller's address
   * @throws {AppError} `RATE_LIMITED` (429), `TOKEN_INVALID` (410: unknown, used, expired, superseded, or the account may not act),
   *   `WEAK_PASSWORD` (422 on `password`; the link is not used up)
   */
  async reset(input: { readonly token: string; readonly password: string }, meta: RequestMeta): Promise<void> {
    await this.limiter.enforceLink(meta.limitKey);
    const seen = await this.db.runInTransaction((work) => this.authTokens.take(work.tx, input.token, PASSWORD_LINKS));
    const account = seen === undefined ? undefined : await this.directory.findById(this.db.db, seen.accountId);
    // The link of an account that may not act is as dead as an unknown one (decision 064).
    if (seen === undefined || account === undefined || !account.hasAccount || !canAct(account.status)) {
      throw new AppError('TOKEN_INVALID');
    }
    const problem = checkPasswordPolicy(input.password, { email: account.email, name: account.name });
    if (problem) throw weakPassword(problem.message, 'password');
    const passwordHash = await this.hasher.hash(input.password);

    const now = this.clock.now();
    await this.db.runInTransaction(async (work) => {
      // Locked again: a parallel request that used the link first (or voided it) leaves nothing to take.
      const link = await this.authTokens.take(work.tx, input.token, PASSWORD_LINKS);
      if (link?.tokenId !== seen.tokenId) throw new AppError('TOKEN_INVALID');
      // An invite link proves the email address (identity-platform-2); a reset link does not. A link on an account whose email was never
      // verified turns two-step sign-in off: it proves the mailbox, so what an unverified registrant enrolled before it must not outlive
      // it (decision 052).
      const saved = await saveClientPassword(work.tx, {
        id: account.id,
        passwordHash,
        now,
        verifyEmail: link.purpose === 'invite',
        clearTwoFactor: account.emailVerifiedAt === null,
        // The link reached the account's mailbox: a hold from a password staff set ends (decision 046). The hold of an email address
        // staff set stays: the link went to that address.
        fromMailedLink: true,
      });
      // The account was suspended or blocked since it was read: the change must not land.
      if (!saved) throw new AppError('TOKEN_INVALID');
      // The link proves the mailbox: the wrong codes before the new password no longer count.
      await clearCodeFailures(work.tx, { type: 'account', id: account.id });
      // The link taken here is voided with the rest of its family. An invitation proves the email address, so a pending verification
      // link is moot too; a plain reset does not, so it keeps that link (a new one can be asked for through the resend route).
      await this.authTokens.voidOpenOf(
        work.tx,
        account.id,
        link.purpose === 'invite' ? INVITATION_SPENT : PASSWORD_LINKS,
      );
      await this.sessions.revokeAllOf('account', account.id, {}, work);
      // The owner of the mailbox chose a password: the failed tries before it no longer count (decision 052).
      work.afterCommit(() => this.lock.clear('shop', account.email));
    });
  }

  /**
   * Changes the password of the signed-in account.
   *
   * @param principal the signed-in account
   * @param input the current and the new password
   * @throws {AppError} `RATE_LIMITED` (429), `CONFLICT` (409: the account has no password yet), `VALIDATION_FAILED` (422 on
   *   `currentPassword`), `WEAK_PASSWORD` (422 on `newPassword`), `UNAUTHORIZED` (401: the account is gone, or its password changed or was
   *   ended since the current one was checked; nothing is written), `ACCOUNT_SUSPENDED` (403)
   */
  async change(
    principal: AccountPrincipal,
    input: { readonly currentPassword: string; readonly newPassword: string },
  ): Promise<void> {
    await this.limiter.enforcePasswordChange(principal.accountId);
    const client = await this.reader.current(principal.accountId);
    if (!client.passwordHash) throw new AppError('CONFLICT', { detail: 'Choose a password first.' });
    if (!(await this.hasher.verify(client.passwordHash, input.currentPassword))) {
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
      await this.authTokens.voidOpenOf(work.tx, client.id, PASSWORD_LINKS);
      await this.sessions.revokeAllOf('account', client.id, { exceptSessionId: principal.session.id }, work);
      // The shop lock of the email stays: a password chosen without the emailed link proves no mailbox (decision 052).
    });
  }

  /**
   * Replaces a temporary password during the sign-in, and continues the same sign-in.
   *
   * Why: feature 20: staff set a temporary password (`must_change_password`), so the sign-in opened a `pending_password` session. The
   * password the account types here is the one it keeps; the temporary one was proven when the session was opened. The pending session
   * is replaced (the old one dies in the same transaction: no fixation) by one at `pending_totp` when two-step sign-in is on, or by a
   * full one; every other session of the account ends and open password links are voided.
   *
   * Side effects: updates `clients` (password, `must_change_password`, and the last sign-in when the session becomes full); voids
   * links; revokes sessions; opens a session and sets its cookies on the reply; counts attempts on the `sign-in` limiter's per-account
   * password counter.
   *
   * @param principal the account of the `pending_password` session
   * @param password the new password
   * @param request the request (its address and user agent)
   * @param reply the reply the new session's cookies go on
   * @returns the next step (`totp` or `done`)
   * @throws {AppError} `RATE_LIMITED` (429), `UNAUTHORIZED` (401: the session is not a pending password step, the account no longer
   *   needs the change, or a parallel request or a suspension won), `ACCOUNT_SUSPENDED` (403), `WEAK_PASSWORD` (422 on `password`: the
   *   policy, or the password in use)
   */
  async changeForced(
    principal: AccountPrincipal,
    password: string,
    request: FastifyRequest,
    reply: FastifyReply,
  ): Promise<AccountForcedChangeAnswer> {
    const meta = requestMetaOf(request);
    await this.limiter.enforcePasswordChange(principal.accountId);
    const client = await this.reader.current(principal.accountId);
    if (principal.stage !== 'pending_password' || !client.mustChangePassword) throw new AppError('UNAUTHORIZED');
    const passwordHash = await this.acceptableHash(password, client, 'password');

    const now = this.clock.now();
    const answer = await this.db.runInTransaction(async (work) => {
      const saved = await saveForcedClientPassword(work.tx, { id: client.id, passwordHash, now });
      // A parallel request replaced the password first, or a suspension or a block landed since the read.
      if (!saved) throw new AppError('UNAUTHORIZED');
      await this.authTokens.voidOpenOf(work.tx, client.id, PASSWORD_LINKS);
      await this.sessions.revokeAllOf('account', client.id, { exceptSessionId: principal.session.id }, work);
      // The shop lock stays, as after an own change; the staff action that set the temporary password ended it (decision 052).
      const next = nextAccountStep({ mustChangePassword: false, twofaEnabled: saved.twofaEnabled });
      // `done` or `totp` here: `password` cannot come back after the flag was cleared.
      const stepAfter = next === 'password' ? 'done' : next;
      // Replacing the pending session: if it was ended meanwhile this throws `UNAUTHORIZED` and the change rolls back.
      if (!(await this.sessions.revoke(principal.session.id, work))) throw new AppError('UNAUTHORIZED');
      // The rank kind is read under the account row, which the write above holds, so it names the CSRF cookie of the rank in force.
      const record = await this.directory.findById(work.tx, client.id);
      if (!record) throw new AppError('UNAUTHORIZED');
      await this.accountSessions.start(work, reply, {
        accountId: client.id,
        stage: accountStageOfStep(stepAfter),
        rankKind: record.rankKind,
      });
      if (stepAfter === 'done') await recordClientSignIn(work.tx, client.id, now, meta.ip);
      return { next: stepAfter } satisfies AccountForcedChangeAnswer;
    });
    await this.limiter.resetPasswordChange(client.id);
    return answer;
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
