// ClientSecurityAdminService: the staff security tools on a merchant (feature 20, routes R1-R4 of /admin/clients/:id): a password or invitation
// link, a temporary password, a 2FA reset, "sign out everywhere" and a new verification email.
import { randomInt } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import { CLOCK, type Clock } from '../../../common/clock';
import { AppError } from '../../../common/errors';
import { PasswordHasher } from '../../../infra/crypto';
import { DbService, type TransactionContext } from '../../../infra/db';
import { RateLimitService } from '../../../infra/rate-limit';
import { AuditService } from '../../platform';
import type { Client } from '../db/schema';
import { accountMailKey } from '../domain/account-mail';
import { temporaryPasswordFor } from '../domain/temporary-password';
import { lockClient, updateClientRow } from '../infra/client-admin.repository';
import { clearCodeFailures } from '../infra/code-failures.repository';
import { findClientById } from '../infra/merchant-auth.repository';
import { PASSWORD_LINK_PURPOSES, voidOpenClientTokens } from '../infra/merchant-token.repository';
import type { StaffPrincipal } from '../security/principal';
import { SessionService } from '../security/session.service';
import { MerchantLifecycleMails } from './mail/merchant-lifecycle-mails';
import { MerchantMailOutbox } from './mail/merchant-mail-outbox';
import { MerchantAuthTokens } from './merchant-auth-tokens';
import { SignInLock } from './sign-in-lock';

/** What `POST /admin/clients/:id/password` answers: which link was mailed, or the temporary password (shown once). */
export interface SetClientPasswordResult {
  readonly temporaryPassword?: string;
  readonly link?: 'invite' | 'reset';
}

function notFound(): AppError {
  return new AppError('NOT_FOUND', { detail: 'No merchant has this id.' });
}

function suspended(): AppError {
  return new AppError('NOT_ACTIVE', { detail: 'This merchant is suspended. Reactivate the account first.' });
}

/**
 * The security tools staff use on a merchant.
 *
 * Why: LEAD-DECISIONS section 6 and plan sections 4.2 and 5.1: a merchant who lost the invitation or the password, lost the phone with the
 * authenticator, or must be signed out, is helped from the console (permission `clients:security`). Every action locks the `clients` row first
 * (lock order), writes one audit row under the merchant, and never returns or stores a link: the request makes a placeholder token whose clear
 * value is dropped, the outbox carries ids, and the mail job rotates the token and sends the real link (feature 12a).
 *
 * A temporary password works for 72 hours and lifts the failed-sign-in lock of the merchant's email (decision 052); it and a 2FA reset open a
 * code step closed after repeated wrong authenticator codes (`CodeStepLock`).
 *
 * Side effects: writes `clients`, `auth_tokens`, `sessions`, `outbox_events`, `notifications` and `audit_logs`; ending sessions drops their cached
 * views after the commit; a temporary password deletes the sign-in lock key of the email after the commit; the link and verification mails
 * count against the `account-mail` limiter (five an hour per merchant and kind).
 *
 * @see docs/briefs/20-merchant-management.md
 */
@Injectable()
export class ClientSecurityAdminService {
  constructor(
    private readonly db: DbService,
    private readonly hasher: PasswordHasher,
    private readonly tokens: MerchantAuthTokens,
    private readonly mail: MerchantMailOutbox,
    private readonly lifecycleMails: MerchantLifecycleMails,
    private readonly sessions: SessionService,
    private readonly audit: AuditService,
    private readonly limits: RateLimitService,
    private readonly lock: SignInLock,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  /**
   * Mails a set-password link (the invitation while the merchant has no password), or sets a temporary password.
   *
   * @param caller the signed-in staff member
   * @param id the merchant id
   * @param input the mode and whether to end the merchant's sessions
   * @returns `{ link }` for the link mode, `{ temporaryPassword }` (once) for the temporary mode
   * @throws {AppError} `NOT_FOUND` (404), `NOT_ACTIVE` (409: suspended), `RATE_LIMITED` (429, link mode)
   */
  async setPassword(
    caller: StaffPrincipal,
    id: number,
    input: { mode: 'reset_link' | 'temporary_password'; revokeSessions: boolean },
  ): Promise<SetClientPasswordResult> {
    const existing = await findClientById(this.db.db, id);
    if (!existing) throw notFound();
    if (existing.status === 'suspended') throw suspended();
    if (input.mode === 'reset_link') {
      await this.limits.enforce('account-mail', accountMailKey('client', id, 'password_link'));
    }
    // Argon2 takes tens of milliseconds: hash before the transaction, not while the merchant row is locked.
    const temporary =
      input.mode === 'temporary_password'
        ? temporaryPasswordFor((max) => randomInt(max), { email: existing.email, name: existing.name })
        : undefined;
    const passwordHash = temporary === undefined ? undefined : await this.hasher.hash(temporary);

    const link = await this.db.runInTransaction(async (work) => {
      const client = await lockClient(work.tx, id);
      if (!client) throw notFound();
      if (client.status === 'suspended') throw suspended();
      const now = this.clock.now();
      let purpose: 'invite' | 'reset' | undefined;
      if (passwordHash === undefined) {
        purpose = client.passwordHash === null ? 'invite' : 'reset';
        // `issue` voids the older invitation and reset links; the clear token it returns is dropped on purpose: the mail job makes the real one.
        const issued = await this.tokens.issue(work, {
          clientId: id,
          purpose,
          createdBy: caller.staffId,
          ip: caller.ip,
        });
        await this.mail.enqueue(work, {
          kind: purpose === 'invite' ? 'invited' : 'password_reset',
          clientId: id,
          tokenId: issued.id,
        });
      } else {
        await updateClientRow(work.tx, id, { passwordHash, mustChangePassword: true, passwordChangedAt: now });
        await clearCodeFailures(work.tx, { type: 'client', id });
        // An older link must not undo the temporary password.
        await voidOpenClientTokens(work.tx, id, PASSWORD_LINK_PURPOSES, now);
        await this.lifecycleMails.securityNotice(work, client, 'temporary_password');
        // A new password lifts the failed-sign-in lock of the merchant's email (decision 052).
        work.afterCommit(() => this.lock.clear('shop', client.email));
      }
      const sessionsEnded = input.revokeSessions ? await this.sessions.revokeAllOf('client', id, {}, work) : 0;
      await this.audit.record(work.tx, {
        action:
          purpose === undefined
            ? 'set a temporary password for'
            : purpose === 'invite'
              ? 'resent the invitation of'
              : 'sent a password reset link to',
        entityType: 'merchant',
        entityId: id,
        entityLabel: client.name,
        // `credential`, not `password`: the audit redaction hides keys that end in password, secret or token.
        after: {
          credential:
            purpose === undefined
              ? 'temporary password set'
              : purpose === 'invite'
                ? 'invitation emailed'
                : 'reset link emailed',
          revokeSessions: input.revokeSessions,
          sessionsEnded,
        },
      });
      return purpose;
    });
    return temporary === undefined ? { link: link! } : { temporaryPassword: temporary };
  }

  /**
   * Turns off a merchant's two-factor sign-in and ends their sessions; it also forgets the count of wrong authenticator codes, which
   * opens a code step closed after repeated wrong codes (`CodeStepLock`).
   *
   * @param id the merchant id
   * @throws {AppError} `NOT_FOUND` (404), `TWOFA_NOT_ENABLED` (409)
   */
  async resetTwoFactor(id: number): Promise<void> {
    await this.db.runInTransaction(async (work) => {
      const client = await lockClient(work.tx, id);
      if (!client) throw notFound();
      if (!client.twofaEnabled) throw new AppError('TWOFA_NOT_ENABLED');
      // The same three columns the merchant's own "turn off" clears (disableClientTwoFactor).
      await updateClientRow(work.tx, id, { twofaEnabled: false, totpSecretEnc: null, totpLastStep: null });
      // The wrong codes were guessed for the authenticator that is gone: a closed code step opens (CodeStepLock).
      await clearCodeFailures(work.tx, { type: 'client', id });
      const sessionsEnded = await this.sessions.revokeAllOf('client', id, {}, work);
      await this.lifecycleMails.securityNotice(work, client, 'twofa_reset');
      await this.audit.record(work.tx, {
        action: 'reset 2FA of',
        entityType: 'merchant',
        entityId: id,
        entityLabel: client.name,
        before: { twofaEnabled: true },
        after: { twofaEnabled: false, sessionsEnded },
      });
    });
  }

  /**
   * Ends every session of a merchant, a sign-in step in progress included.
   *
   * @param id the merchant id
   * @throws {AppError} `NOT_FOUND` (404)
   */
  async revokeSessions(id: number): Promise<void> {
    await this.db.runInTransaction(async (work) => {
      const client = await lockClient(work.tx, id);
      if (!client) throw notFound();
      const ended = await this.sessions.revokeAllOf('client', id, {}, work);
      await this.audit.record(work.tx, {
        action: 'signed out all devices of',
        entityType: 'merchant',
        entityId: id,
        entityLabel: client.name,
        before: { sessions: ended },
        after: { sessions: 0 },
      });
    });
  }

  /**
   * Mails the merchant a new verification link.
   *
   * @param caller the signed-in staff member
   * @param id the merchant id
   * @throws {AppError} `NOT_FOUND` (404), `CONFLICT` (409: already verified), `NOT_ACTIVE` (409: suspended), `RATE_LIMITED` (429)
   */
  async resendVerification(caller: StaffPrincipal, id: number): Promise<void> {
    const existing = await findClientById(this.db.db, id);
    if (!existing) throw notFound();
    this.assertCanVerify(existing);
    await this.limits.enforce('account-mail', accountMailKey('client', id, 'verification'));
    await this.db.runInTransaction(async (work: TransactionContext) => {
      const client = await lockClient(work.tx, id);
      if (!client) throw notFound();
      this.assertCanVerify(client);
      const issued = await this.tokens.issue(work, {
        clientId: id,
        purpose: 'verify_email',
        createdBy: caller.staffId,
        ip: caller.ip,
      });
      await this.mail.enqueue(work, { kind: 'email_verification', clientId: id, tokenId: issued.id });
      await this.audit.record(work.tx, {
        action: 'sent a verification email to',
        entityType: 'merchant',
        entityId: id,
        entityLabel: client.name,
        after: { email: client.email },
      });
    });
  }

  private assertCanVerify(client: Client): void {
    if (client.emailVerifiedAt !== null) {
      throw new AppError('CONFLICT', { detail: 'This email address is already verified.' });
    }
    if (client.status === 'suspended') throw suspended();
  }
}
