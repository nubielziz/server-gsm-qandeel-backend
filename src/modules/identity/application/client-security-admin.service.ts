// ClientSecurityAdminService: the staff security tools on an account (feature 20, routes of /admin/clients/:id, decision 064): a password or
// invitation link, a temporary password, a 2FA reset, "sign out everywhere" and a new verification email. One service for every rank.
import { randomInt } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import { CLOCK, type Clock } from '../../../common/clock';
import { AppError } from '../../../common/errors';
import { PasswordHasher } from '../../../infra/crypto';
import { DbService, type TransactionContext } from '../../../infra/db';
import { RateLimitService } from '../../../infra/rate-limit';
import { RankGroupReads } from '../../catalog/ports/rank-group-reads';
import { AuditService } from '../../platform';
import { AccountDirectory } from '../accounts/account-directory';
import type { Client } from '../db/schema';
import { accountMailKey } from '../domain/account-mail';
import { type SecurityTool, securityToolError, securityToolRefusal } from '../domain/account-rules';
import { temporaryPasswordFor } from '../domain/temporary-password';
import { lockClient, updateClientRow } from '../infra/client-admin.repository';
import { clearCodeFailures } from '../infra/code-failures.repository';
import { AccountAuthTokens } from '../ports/account-auth-tokens';
import { AccountMailOutbox } from '../ports/account-mail-outbox';
import { AccountSessions } from '../ports/account-sessions';
import { rankKindOf } from '../ports/rank-kind';
import type { StaffPrincipal } from '../security/principal';
import { MerchantLifecycleMails } from './mail/merchant-lifecycle-mails';
import { SignInLock } from './sign-in-lock';

/** What `POST /admin/clients/:id/password` answers: which link was mailed, or the temporary password (shown once). */
export interface SetClientPasswordResult {
  readonly temporaryPassword?: string;
  readonly link?: 'invite' | 'reset';
}

function notFound(): AppError {
  return new AppError('NOT_FOUND', { detail: 'No account has this id.' });
}

/**
 * The security tools staff use on an account of any rank.
 *
 * Why: LEAD-DECISIONS section 6 and plan sections 4.2 and 5.1 (decision 064 makes the tools work on every account): a person who lost the invitation or
 * the password, lost the phone with the authenticator, or must be signed out, is helped from the console (permission `clients:security`),
 * whatever the rank. Every action needs an account with a login (a guest is `409 NO_ACCOUNT`, "Make an account first."), refuses an anonymized
 * account (`409 ANONYMIZED`), locks the `clients` row first (lock order), writes one audit row under the account, and never returns or stores a
 * link: the request makes a placeholder token whose clear value is dropped, the outbox carries ids, and the mail job rotates the token and
 * sends the real link (feature 12a). A password link and a verification link need an account that may act (`409 NOT_ACTIVE` for a suspended
 * or blocked one); a 2FA reset and "sign out everywhere" stay possible, because they only take access away.
 *
 * A temporary password ends every session of the account (the old password may be known to someone else), works for 72 hours and lifts the
 * failed-sign-in lock of the account's email (decision 052); it and a 2FA reset open a
 * code step closed after repeated wrong authenticator codes (`CodeStepLock`). It also sets the mark `password_set_by_staff`, which a password
 * chosen from a link mailed to the account's address clears. Nothing reads the mark since decision 067 (merchants no longer create API keys);
 * it stays, and is still written, until the accounts model's migration drops it.
 *
 * Side effects: writes `clients`, `auth_tokens`, `sessions`, `outbox_events`, `notifications` and `audit_logs`; ending sessions drops their cached
 * views after the commit; a temporary password deletes the sign-in lock key of the email after the commit; the link and verification mails
 * count against the `account-mail` limiter (five an hour per account and kind).
 *
 * @see docs/briefs/20-merchant-management.md
 */
@Injectable()
export class ClientSecurityAdminService {
  constructor(
    private readonly db: DbService,
    private readonly directory: AccountDirectory,
    private readonly hasher: PasswordHasher,
    private readonly tokens: AccountAuthTokens,
    private readonly mail: AccountMailOutbox,
    private readonly lifecycleMails: MerchantLifecycleMails,
    private readonly ranks: RankGroupReads,
    private readonly sessions: AccountSessions,
    private readonly audit: AuditService,
    private readonly limits: RateLimitService,
    private readonly lock: SignInLock,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  /**
   * Mails a set-password link (the invitation while the account has no password), or sets a temporary password.
   *
   * @param caller the signed-in staff member
   * @param id the account id
   * @param input the mode and, for the link mode, whether to end the account's sessions (a temporary password always ends them)
   * @returns `{ link }` for the link mode, `{ temporaryPassword }` (once) for the temporary mode
   * @throws {AppError} `NOT_FOUND` (404), `NO_ACCOUNT` (409: a guest), `ANONYMIZED` (409), `NOT_ACTIVE` (409: suspended or blocked), `RATE_LIMITED`
   *   (429, link mode)
   */
  async setPassword(
    caller: StaffPrincipal,
    id: number,
    input: { mode: 'reset_link' | 'temporary_password'; revokeSessions: boolean },
  ): Promise<SetClientPasswordResult> {
    const existing = await this.assertAllowed(id, 'password');
    if (input.mode === 'reset_link') {
      await this.limits.enforce('account-mail', accountMailKey('account', id, 'password_link'));
    }
    // Argon2 takes tens of milliseconds: hash before the transaction, not while the account row is locked.
    const temporary =
      input.mode === 'temporary_password'
        ? temporaryPasswordFor((max) => randomInt(max), { email: existing.email, name: existing.name })
        : undefined;
    const passwordHash = temporary === undefined ? undefined : await this.hasher.hash(temporary);

    const link = await this.db.runInTransaction(async (work) => {
      const account = await this.lockAllowed(work.tx, id, 'password');
      const now = this.clock.now();
      let purpose: 'invite' | 'reset' | undefined;
      if (passwordHash === undefined) {
        purpose = account.passwordHash === null ? 'invite' : 'reset';
        // `issue` voids the older invitation and reset links; the clear token it returns is dropped on purpose: the mail job makes the real one.
        const issued = await this.tokens.issue(work, {
          accountId: id,
          purpose,
          createdBy: caller.staffId,
          ip: caller.ip,
        });
        await this.mail.enqueue(work, {
          kind: purpose === 'invite' ? 'invited' : 'password_reset',
          accountId: id,
          tokenId: issued.tokenId,
        });
      } else {
        // The mark of a password staff set: a password chosen from a mailed link clears it (nothing reads it since decision 067).
        await updateClientRow(work.tx, id, {
          passwordHash,
          mustChangePassword: true,
          passwordChangedAt: now,
          passwordSetByStaff: true,
        });
        await clearCodeFailures(work.tx, { type: 'account', id });
        // An older link must not undo the temporary password.
        await this.tokens.voidOpenOf(work.tx, id, ['invite', 'reset']);
        await this.lifecycleMails.securityNotice(
          work,
          await this.noticeRecipient(work.tx, account),
          'temporary_password',
        );
        // A new password lifts the failed-sign-in lock of the account's email (decision 052).
        work.afterCommit(() => this.lock.clear('shop', account.email));
      }
      // A temporary password replaces a password that may be known to someone else (a taken-over account): every session ends, whatever the
      // caller ticked. A link leaves the current password working until it is used, so there the caller decides.
      const endsSessions = passwordHash !== undefined || input.revokeSessions;
      const sessionsEnded = endsSessions ? await this.endSessions(work, id) : 0;
      await this.audit.record(work.tx, {
        action:
          purpose === undefined
            ? 'set a temporary password for'
            : purpose === 'invite'
              ? 'resent the invitation of'
              : 'sent a password reset link to',
        entityType: 'account',
        entityId: id,
        entityLabel: account.name,
        // `credential`, not `password`: the audit redaction hides keys that end in password, secret or token.
        after: {
          credential:
            purpose === undefined
              ? 'temporary password set'
              : purpose === 'invite'
                ? 'invitation emailed'
                : 'reset link emailed',
          revokeSessions: endsSessions,
          sessionsEnded,
        },
      });
      return purpose;
    });
    return temporary === undefined ? { link: link! } : { temporaryPassword: temporary };
  }

  /**
   * Turns off an account's two-factor sign-in and ends its sessions; it also forgets the count of wrong authenticator codes, which opens a
   * code step closed after repeated wrong codes (`CodeStepLock`).
   *
   * @param id the account id
   * @throws {AppError} `NOT_FOUND` (404), `NO_ACCOUNT` (409: a guest), `ANONYMIZED` (409), `TWOFA_NOT_ENABLED` (409)
   */
  async resetTwoFactor(id: number): Promise<void> {
    await this.db.runInTransaction(async (work) => {
      const account = await this.lockAllowed(work.tx, id, 'reset_2fa');
      if (!account.twofaEnabled) throw new AppError('TWOFA_NOT_ENABLED');
      // The same three columns the account's own "turn off" clears.
      await updateClientRow(work.tx, id, { twofaEnabled: false, totpSecretEnc: null, totpLastStep: null });
      // The wrong codes were guessed for the authenticator that is gone: a closed code step opens (CodeStepLock).
      await clearCodeFailures(work.tx, { type: 'account', id });
      const sessionsEnded = await this.endSessions(work, id);
      await this.lifecycleMails.securityNotice(work, await this.noticeRecipient(work.tx, account), 'twofa_reset');
      await this.audit.record(work.tx, {
        action: 'reset 2FA of',
        entityType: 'account',
        entityId: id,
        entityLabel: account.name,
        before: { twofaEnabled: true },
        after: { twofaEnabled: false, sessionsEnded },
      });
    });
  }

  /**
   * Ends every session of an account, a sign-in step in progress included.
   *
   * @param id the account id
   * @throws {AppError} `NOT_FOUND` (404), `NO_ACCOUNT` (409: a guest), `ANONYMIZED` (409)
   */
  async revokeSessions(id: number): Promise<void> {
    await this.db.runInTransaction(async (work) => {
      const account = await this.lockAllowed(work.tx, id, 'revoke_sessions');
      const ended = await this.endSessions(work, id);
      await this.audit.record(work.tx, {
        action: 'signed out all devices of',
        entityType: 'account',
        entityId: id,
        entityLabel: account.name,
        before: { sessions: ended },
        after: { sessions: 0 },
      });
    });
  }

  /**
   * Mails the account a new verification link.
   *
   * @param caller the signed-in staff member
   * @param id the account id
   * @throws {AppError} `NOT_FOUND` (404), `NO_ACCOUNT` (409: a guest), `ANONYMIZED` (409), `CONFLICT` (409: already verified), `NOT_ACTIVE` (409:
   *   suspended or blocked), `RATE_LIMITED` (429)
   */
  async resendVerification(caller: StaffPrincipal, id: number): Promise<void> {
    const existing = await this.assertAllowed(id, 'verification');
    this.assertNotVerified(existing.emailVerifiedAt);
    await this.limits.enforce('account-mail', accountMailKey('account', id, 'verification'));
    await this.db.runInTransaction(async (work: TransactionContext) => {
      const account = await this.lockAllowed(work.tx, id, 'verification');
      this.assertNotVerified(account.emailVerifiedAt);
      const issued = await this.tokens.issue(work, {
        accountId: id,
        purpose: 'verify_email',
        createdBy: caller.staffId,
        ip: caller.ip,
      });
      await this.mail.enqueue(work, { kind: 'email_verification', accountId: id, tokenId: issued.tokenId });
      await this.audit.record(work.tx, {
        action: 'sent a verification email to',
        entityType: 'account',
        entityId: id,
        entityLabel: account.name,
        after: { email: account.email },
      });
    });
  }

  /** Ends every session of the account in the caller's transaction; returns how many there were. */
  private endSessions(work: Pick<TransactionContext, 'tx'>, id: number): Promise<number> {
    return this.sessions.revokeAll(work.tx, id);
  }

  /**
   * The account as the security notice needs it: its rank kind picks the family of the mail (the merchant text or the retail one), so a
   * retail account never gets the merchant notice (which has no text for its audience).
   */
  private async noticeRecipient(tx: TransactionContext['tx'], account: Client) {
    const rankKind = rankKindOf((await this.ranks.kindOf(tx, account.groupId)) ?? '');
    return { id: account.id, name: account.name, rankKind };
  }

  /** Reads the account outside the transaction and refuses a missing one or one the tool cannot run on, before any hashing or limiter point. */
  private async assertAllowed(id: number, tool: SecurityTool) {
    const existing = await this.directory.findById(this.db.db, id);
    if (!existing) throw notFound();
    const refusal = securityToolRefusal(existing, tool);
    if (refusal !== undefined) throw securityToolError(refusal);
    return existing;
  }

  /** Locks the account row and judges it again: another request may have changed it since the first read. */
  private async lockAllowed(tx: TransactionContext['tx'], id: number, tool: SecurityTool): Promise<Client> {
    const account = await lockClient(tx, id);
    if (!account) throw notFound();
    const refusal = securityToolRefusal(account, tool);
    if (refusal !== undefined) throw securityToolError(refusal);
    return account;
  }

  private assertNotVerified(verifiedAt: Date | null): void {
    if (verifiedAt !== null) throw new AppError('CONFLICT', { detail: 'This email address is already verified.' });
  }
}
