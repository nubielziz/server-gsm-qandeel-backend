// ClientDetailsEditor: the "details" kind of PATCH /admin/clients/:id (feature 20, decision 064): staff edit the profile and the email of an
// account of any rank, and of a guest row.
import { Inject, Injectable } from '@nestjs/common';
import { CLOCK, type Clock } from '../../../common/clock';
import { AppError } from '../../../common/errors';
import { type DbExecutor, type TransactionContext, isUniqueViolation } from '../../../infra/db';
import { RateLimitService } from '../../../infra/rate-limit';
import { RankGroupReads } from '../../catalog/ports/rank-group-reads';
import { ShopCurrencyReads } from '../../money/ports/shop-currency-reads';
import { AuditService } from '../../platform';
import { canAct } from '../accounts/account-status';
import { rankKindOf } from '../ports/rank-kind';
import type { Client } from '../db/schema';
import { accountMailKey } from '../domain/account-mail';
import { emailChangePermission } from '../domain/account-rules';
import { type ClientChangeInput, detailChanges, emailMarkAfterEdit } from '../domain/client-details';
import { updateClientRow } from '../infra/client-admin.repository';
import { AccountAuthTokens } from '../ports/account-auth-tokens';
import { AccountMailOutbox } from '../ports/account-mail-outbox';
import { AccountSessions } from '../ports/account-sessions';
import { ApiKeyDirectory } from '../security/machine/api-keys/api-key.directory';
import { type StaffPrincipal, isOwner, requirePermission } from '../security/principal';
import { type Admitted, AccountCreateChecks, emailConflictError } from './account-create-guards';
import { MerchantLifecycleMails } from './mail/merchant-lifecycle-mails';
import { assertRetailCountry, retailCurrencyFor } from './retail-country';

/**
 * Applies a staff edit of an account's details.
 *
 * Why: LEAD-DECISIONS section 6 (account management): staff change name, company, phone, country, address, tax id, internal notes and the
 * email (plan sections 4.1 and 5.1.2). A retail account's country must be one the shop sells to (a current tax rate) and a changed country
 * derives its currency again (ANSWERS customers Q8). An email change follows the rule of the two partitions (decision 064): a login row may take the
 * email of a guest row (that guest row's open links are voided) and not the email of another login row; a guest row may not take another
 * guest row's email; the checks other modules registered (the blocklist) judge the new address. Of an account with a login, an email change
 * voids every open link (a verification link carries no email snapshot, so an old one would prove the new address), clears the
 * verification, sends a new verification (or the invitation while there is no password) to the new address, ends every session and sends a
 * security notice to the address before the change (decision 047, `clients:security`); a guest row keeps nothing to end or send, and its
 * old links die with the old address; a name change keeps the sessions. `email_set_by_staff` (decision 046, `emailMarkAfterEdit`) says that the
 * address was last set by a staff member who is not an Owner and that no Owner has confirmed it since; nothing reads it since decision 067
 * (merchants no longer create API keys), and it is still written. An Owner's edit that carries the stored address clears a set mark and
 * does nothing else to the email.
 *
 * Side effects: writes `clients` (`email_set_by_staff` and the derived `currency` included), `auth_tokens`, `outbox_events` (the verification
 * or invitation mail, ids only), `sessions`, a `notifications` row with its outbox event (the security notice, to the previous address) and
 * `audit_logs`; drops the cached session and API key views of the account after the commit when the name or email changed; an email change of
 * an account with a login counts one point of the `account-mail` limiter.
 */
@Injectable()
export class ClientDetailsEditor {
  constructor(
    private readonly tokens: AccountAuthTokens,
    private readonly mail: AccountMailOutbox,
    private readonly sessions: AccountSessions,
    private readonly apiKeys: ApiKeyDirectory,
    private readonly audit: AuditService,
    private readonly lifecycleMails: MerchantLifecycleMails,
    private readonly limits: RateLimitService,
    private readonly checks: AccountCreateChecks,
    private readonly ranks: RankGroupReads,
    private readonly money: ShopCurrencyReads,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  /**
   * Spends one `account-mail` point for an email change. Called before the transaction, after the cheap refusals, so a refused call spends none.
   *
   * @param accountId the account id
   * @throws {AppError} `RATE_LIMITED` (429)
   */
  async enforceEmailChangeLimit(accountId: number): Promise<void> {
    await this.limits.enforce('account-mail', accountMailKey('account', accountId, 'email_change'));
  }

  /**
   * Refuses a country the shop does not sell to.
   *
   * Why: ANSWERS customers Q8: a retail account can only be given a country with a current tax rate (the list the store config serves).
   *
   * @param db the database or a transaction
   * @param country the upper-case ISO 3166 alpha-2 code
   * @throws {AppError} `VALIDATION_FAILED` (422 on `country`, code `unsupported`: "Choose a country.")
   */
  async assertCountryAccepted(db: DbExecutor, country: string): Promise<void> {
    await assertRetailCountry(this.money, db, country, this.clock.now());
  }

  /**
   * Derives the currency code a retail account of a country pays in.
   *
   * @param db the database or a transaction
   * @param country the upper-case ISO 3166 alpha-2 code
   * @returns the country's shop currency when the shop offers it, else USD; `null` only when USD itself is missing (the column is a foreign key)
   */
  async currencyFor(db: DbExecutor, country: string): Promise<string | null> {
    return retailCurrencyFor(this.money, db, country);
  }

  /**
   * Applies the edit inside the caller's transaction (the account row is already locked).
   *
   * @param work the caller's transaction
   * @param caller the signed-in staff member
   * @param client the locked account row
   * @param input the body of the edit
   * @throws {AppError} `VALIDATION_FAILED` (422 on `name`, on `country` of a retail account, on `email` for a blocklisted address), `EMAIL_TAKEN` (409),
   *   `FORBIDDEN` (403: an email change of an account with a login needs `clients:security`)
   */
  async apply(
    work: TransactionContext,
    caller: StaffPrincipal,
    client: Client,
    input: ClientChangeInput,
  ): Promise<void> {
    const changes = detailChanges(client, input);
    if ('problem' in changes) {
      throw new AppError('VALIDATION_FAILED', {
        errors: [{ field: changes.problem.field, code: 'invalid', message: changes.problem.message }],
      });
    }
    // Decision 047: judged on the locked row, so an edit that turned "same email" into "new email" since the pre-check is still refused.
    const emailPermission = emailChangePermission(client.hasAccount);
    if (changes.emailChanged && emailPermission !== null) requirePermission(caller, emailPermission);
    const rankKind = rankKindOf((await this.ranks.kindOf(work.tx, client.groupId)) ?? '');
    // A retail account's country must be one the shop sells to, and a changed country derives the currency again. Only a country change is
    // checked: a form that sends the stored country again must not fail when its tax rate has ended since.
    let currency: string | null | undefined;
    if (changes.columns.country !== undefined && rankKind === 'retail') {
      await this.assertCountryAccepted(work.tx, changes.columns.country);
      currency = await this.currencyFor(work.tx, changes.columns.country);
    }
    // The email rule of both partitions and the registered checks judge the new address before anything is written.
    let admitted: Admitted = { guestIdToVoid: undefined };
    if (changes.emailChanged) {
      admitted = await this.checks.admitEmailChange(work.tx, {
        accountId: client.id,
        hasAccount: client.hasAccount,
        email: changes.columns.email!,
        rankKind,
      });
    }
    // Decision 046: the mark of an address that a staff member who is not an Owner set, judged on the locked row.
    const mark = emailMarkAfterEdit({
      marked: client.emailSetByStaff,
      emailSent: input.email !== undefined,
      emailChanged: changes.emailChanged,
      byOwner: isOwner(caller),
    });
    // An Owner confirmed the stored address: only the mark changes, and the audit row says so.
    const confirmed = !changes.emailChanged && mark === false;
    const before: Record<string, unknown> = { ...changes.before, ...(confirmed ? { emailSetByStaff: true } : {}) };
    const after: Record<string, unknown> = { ...changes.after, ...(confirmed ? { emailSetByStaff: false } : {}) };
    if (currency !== undefined) {
      before.currency = client.currency;
      after.currency = currency;
    }
    const columns = {
      ...changes.columns,
      ...(changes.emailChanged ? { emailVerifiedAt: null } : {}),
      ...(currency === undefined ? {} : { currency }),
      ...(mark === undefined ? {} : { emailSetByStaff: mark }),
    };
    if (Object.keys(columns).length > 0) {
      try {
        await updateClientRow(work.tx, client.id, columns);
      } catch (error) {
        // The two unique indexes (login rows, guest rows) are the last word when two edits of one address meet.
        if (isUniqueViolation(error, 'clients_login_email_uq') || isUniqueViolation(error, 'clients_guest_email_uq')) {
          throw emailConflictError('taken', changes.columns.email ?? client.email);
        }
        throw error;
      }
    }
    if (changes.emailChanged) {
      after.emailVerified = false;
      // Every link sent to the old address dies with it, a guest row's too: using one would mark the new address as proven.
      await this.tokens.voidOpenOf(work.tx, client.id);
      // A login row that took the email of a guest row: the mail sent to that guest row earlier must not make a second login row.
      if (admitted.guestIdToVoid !== undefined) await this.checks.voidGuestLinks(work.tx, admitted.guestIdToVoid);
      if (client.hasAccount) {
        await this.sendNewAddressMail(work, caller, client);
        // Decision 047: the address carries the account's sign-in and password links; nobody stays signed in across its change.
        after.sessionsEnded = await this.sessions.revokeAll(work.tx, client.id);
        // `client.email` is the locked row's address before the update: the previous address is told, whoever owns the new one.
        await this.lifecycleMails.securityNotice(
          work,
          { id: client.id, name: changes.columns.name ?? client.name, rankKind },
          'email_changed',
          { to: client.email },
        );
      }
    } else if (changes.nameChanged) {
      // The cached session views hold the name: drop them after the commit.
      work.afterCommit(() => this.sessions.invalidate(client.id));
    }
    // The API key view holds the name and the status: drop it after the commit.
    if (changes.emailChanged || changes.nameChanged) await this.apiKeys.invalidateClient(client.id, work);
    await this.audit.record(work.tx, {
      action: 'edited details of',
      entityType: 'account',
      entityId: client.id,
      entityLabel: changes.columns.name ?? client.name,
      before,
      after,
    });
  }

  /** Mails the new address a verification (or the invitation while there is no password). The older links were voided by the caller. */
  private async sendNewAddressMail(work: TransactionContext, caller: StaffPrincipal, client: Client): Promise<void> {
    // An account that may not act gets nothing: every link of its is dead anyway, and a reactivation does not send one.
    if (!canAct(client.status)) return;
    const invited = client.passwordHash === null;
    const issued = await this.tokens.issue(work, {
      accountId: client.id,
      purpose: invited ? 'invite' : 'verify_email',
      createdBy: caller.staffId,
      ip: caller.ip,
    });
    await this.mail.enqueue(work, {
      kind: invited ? 'invited' : 'email_verification',
      accountId: client.id,
      tokenId: issued.tokenId,
    });
  }
}
