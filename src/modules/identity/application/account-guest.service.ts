// AccountGuestService: "Make an account" (POST /admin/clients/:id/account): staff give a guest row a login (decision 064).
import { randomInt } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import { CLOCK, type Clock } from '../../../common/clock';
import { AppError } from '../../../common/errors';
import { PasswordHasher } from '../../../infra/crypto';
import { DbService, isUniqueViolation } from '../../../infra/db';
import { RankGroupReads } from '../../catalog/ports/rank-group-reads';
import { AuditService } from '../../platform';
import { AccountDirectory } from '../accounts/account-directory';
import { type PasswordMode, passwordModePermission } from '../domain/account-rules';
import { temporaryPasswordFor } from '../domain/temporary-password';
import { lockClient, updateClientRow } from '../infra/client-admin.repository';
import { AccountAuthTokens } from '../ports/account-auth-tokens';
import { AccountMailOutbox } from '../ports/account-mail-outbox';
import { rankKindOf } from '../ports/rank-kind';
import { type StaffPrincipal, requirePermission } from '../security/principal';
import { AccountCreateChecks, emailConflictError } from './account-create-guards';
import { MerchantLifecycleMails } from './mail/merchant-lifecycle-mails';
import { SignInLock } from './sign-in-lock';

/** What "Make an account" answers: the temporary password (shown once) in that mode, or the kind of link that was mailed. */
export interface MadeAccountResult {
  readonly temporaryPassword?: string;
  readonly link?: 'invite';
}

function notFound(): AppError {
  return new AppError('NOT_FOUND', { detail: 'No account has this id.' });
}

/**
 * Gives a guest row a login.
 *
 * Why: a person who bought without signing up leaves a guest row (`has_account` false); staff can give that row a login without losing the
 * person's orders, which stay on the row (decision 064, scenario b2c-account step 6). The row keeps the retail rank (no Owner check: a guest always holds
 * it), becomes a row with a login in place, and gets either an emailed invitation or a temporary password the server makes and returns once
 * (`clients:security` as well, decision 047). No other row with a login may hold the email (`409 EMAIL_TAKEN`, code `login_exists`; the unique
 * index of the login rows is the last word when two writes meet). The guest row's own open email links are voided in the same transaction: it
 * has a login now, so the next link is a sign-in link of the account. Failed passwords tried for this email while it was a guest must not
 * lock the new account, so the sign-in lock is cleared after the commit.
 *
 * Side effects: writes `clients`, `auth_tokens`, `outbox_events`, `notifications` and `audit_logs`.
 *
 * @see docs/contract/endpoints/identity.md (POST /admin/clients/:id/account)
 */
@Injectable()
export class AccountGuestService {
  constructor(
    private readonly db: DbService,
    private readonly directory: AccountDirectory,
    private readonly checks: AccountCreateChecks,
    private readonly tokens: AccountAuthTokens,
    private readonly mail: AccountMailOutbox,
    private readonly lifecycleMails: MerchantLifecycleMails,
    private readonly ranks: RankGroupReads,
    private readonly hasher: PasswordHasher,
    private readonly audit: AuditService,
    private readonly signInLock: SignInLock,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  /**
   * Makes an account of a guest.
   *
   * @param staff the signed-in staff member
   * @param id the guest row's id
   * @param mode how the account gets a password
   * @returns the temporary password in that mode, else `{ link: 'invite' }`
   * @throws {AppError} `FORBIDDEN` (403: a temporary password needs `clients:security`), `NOT_FOUND` (404), `ANONYMIZED` (409), `ACCOUNT_EXISTS`
   *   (409: the row already has a login), `EMAIL_TAKEN` (409, code `login_exists`), `VALIDATION_FAILED` (422 on `email`: a blocklisted
   *   email, the same refusal as a create)
   */
  async makeAccount(staff: StaffPrincipal, id: number, mode: PasswordMode): Promise<MadeAccountResult> {
    // Decision 047: a temporary password is a working credential; checked before any read, so a refused call reads nothing.
    const needed = passwordModePermission(mode);
    if (needed !== null) requirePermission(staff, needed);
    const guest = await this.directory.findById(this.db.db, id);
    if (!guest) throw notFound();
    if (guest.status === 'anonymized') throw new AppError('ANONYMIZED');
    if (guest.hasAccount) throw new AppError('ACCOUNT_EXISTS');
    // Argon2 takes tens of milliseconds: hash before the transaction.
    const temporary =
      mode === 'temporary_password'
        ? temporaryPasswordFor((max) => randomInt(max), { email: guest.email, name: guest.name })
        : undefined;
    const passwordHash = temporary === undefined ? undefined : await this.hasher.hash(temporary);
    const now = this.clock.now();

    await this.db.runInTransaction(async (work) => {
      const row = await lockClient(work.tx, id);
      if (!row) throw notFound();
      if (row.status === 'anonymized') throw new AppError('ANONYMIZED');
      if (row.hasAccount) throw new AppError('ACCOUNT_EXISTS');
      await this.checks.assertMayMakeAccount(work.tx, row.email);
      try {
        await updateClientRow(work.tx, id, {
          hasAccount: true,
          ...(passwordHash === undefined
            ? {}
            : {
                passwordHash,
                // Marks a password staff set; a password chosen from a mailed link clears it (nothing reads it since decision 067).
                mustChangePassword: true,
                passwordChangedAt: now,
                passwordSetByStaff: true,
              }),
        });
      } catch (error) {
        // Another row with a login took the email between the check and the write: the unique index decides.
        if (isUniqueViolation(error, 'clients_login_email_uq')) throw emailConflictError('login_exists', row.email);
        throw error;
      }
      // The row has a login now: the sign-in links mailed to it as a guest must not work as links of the account.
      await this.tokens.voidOpenOf(work.tx, id);
      if (passwordHash === undefined) {
        const invite = await this.tokens.issue(work, {
          accountId: id,
          purpose: 'invite',
          createdBy: staff.staffId,
          ip: staff.ip,
        });
        await this.mail.enqueue(work, { kind: 'invited', accountId: id, tokenId: invite.tokenId });
      } else {
        // The notice of the row's rank (a guest holds the retail rank): the retail text, never the merchant one.
        const rankKind = rankKindOf((await this.ranks.kindOf(work.tx, row.groupId)) ?? '');
        await this.lifecycleMails.securityNotice(work, { id: row.id, name: row.name, rankKind }, 'temporary_password');
      }
      await this.audit.record(work.tx, {
        action: 'made an account for',
        entityType: 'account',
        entityId: id,
        entityLabel: row.name,
        before: { account: 'guest' },
        // Not `password`: the audit log redacts every key that ends in it, and this is only the way the password was set.
        after: {
          account: 'login',
          credential: passwordHash === undefined ? 'invitation emailed' : 'temporary password set',
        },
      });
      work.afterCommit(() => this.signInLock.clear('shop', row.email));
    });
    return temporary === undefined ? { link: 'invite' } : { temporaryPassword: temporary };
  }
}
