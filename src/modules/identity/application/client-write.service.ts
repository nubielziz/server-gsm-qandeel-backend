// ClientWriteService: the staff writes of one account: create (any rank), edit the details, and suspend or reactivate (decision 064). The
// reads (list, detail, counts) are `ClientAdminService`'s; "Make an account" is `AccountGuestService`'s; the rank change is the money module's
// (`POST /admin/clients/:id/rank`).
import { randomInt } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import { CLOCK, type Clock } from '../../../common/clock';
import { AppError } from '../../../common/errors';
import { Money } from '../../../common/money';
import { PasswordHasher } from '../../../infra/crypto';
import { type DbExecutor, DbService, type TransactionContext, isUniqueViolation } from '../../../infra/db';
import { ClientGroupDirectory, RankGroupReads } from '../../catalog';
import {
  ADJUST_APPROVAL_LIMIT_KEY,
  MerchantAccounts,
  approvalLimitOf,
  creditLimitNeedsOwner,
  creditLimitOwnerDetail,
} from '../../money';
import { AuditService, SettingsReader } from '../../platform';
import { AccountDirectory } from '../accounts/account-directory';
import { rankKindOf } from '../ports/rank-kind';
import type { Client, ClientStatus } from '../db/schema';
import {
  type AccountFieldProblem,
  type PasswordMode,
  assertMayGiveRank,
  emailChangePermission,
  passwordModePermission,
  retailCreateProblem,
  securityToolError,
  securityToolRefusal,
  statusWriteProblem,
} from '../domain/account-rules';
import { type ClientChangeInput, type FieldProblem, kindOfClientChange } from '../domain/client-details';
import {
  NEVER_APPROVED_OWNER_DETAIL,
  canMoveClient,
  reactivationNeedsOwner,
  statusChangePermission,
  suspendReasonProblem,
  usernameBase,
  usernameCandidate,
} from '../domain/client-rules';
import { temporaryPasswordFor } from '../domain/temporary-password';
import { lockClient, insertClientRow, updateClientRow, usernameTaken } from '../infra/client-admin.repository';
import { AccountAuthTokens } from '../ports/account-auth-tokens';
import { AccountMailOutbox } from '../ports/account-mail-outbox';
import { AccountAccessEffects } from '../ports/account-access-effects';
import { isOwner, requireOwner, requirePermission } from '../security/principal';
import type { StaffPrincipal } from '../security/principal';
import { AccountCreateChecks, emailConflictError } from './account-create-guards';
import { ClientDetailsEditor } from './client-details-editor';
import { MerchantLifecycleMails } from './mail/merchant-lifecycle-mails';
import { SignInLock } from './sign-in-lock';

/** The input of `POST /admin/clients` as the wire carries it (cleaned by the contract). */
export interface CreateAccountInput {
  readonly name: string;
  readonly email: string;
  readonly country: string;
  readonly phone?: string | undefined;
  readonly company?: string | undefined;
  /** The rank; left out, the account is made with the retail rank (never the default merchant rank). */
  readonly groupId?: number | undefined;
  readonly creditLimit?: string | undefined;
  /** How the account gets its password; left out, an emailed link. */
  readonly password?: { readonly mode: PasswordMode } | undefined;
}

/** What `create` answers: the new account's id, and the temporary password (shown once) in that mode. */
export interface CreatedAccount {
  readonly id: number;
  readonly temporaryPassword?: string;
}

/** The input of `PATCH /admin/clients/:id`: a status change or details (one kind per call). */
export type UpdateAccountInput = ClientChangeInput;

/** A `422 VALIDATION_FAILED` on one field. */
function invalid(problem: FieldProblem | AccountFieldProblem): AppError {
  return new AppError('VALIDATION_FAILED', {
    detail: problem.message,
    errors: [{ field: problem.field, code: problem.code ?? 'invalid', message: problem.message }],
  });
}

function notFound(): AppError {
  return new AppError('NOT_FOUND', { detail: 'No account has this id.' });
}

/** Thrown inside a transaction when the generated username lost a race: the caller retries once more. */
class GeneratedValueTaken extends Error {}

const MAX_CREATE_ATTEMPTS = 4;

/**
 * Creates, edits and suspends accounts for staff.
 *
 * Why: scenario "accounts" of the console (RULES merchants and customers, decision 064). One create serves every rank: an omitted rank is the
 * retail rank, a merchant rank is the Owner's (checked before anything is written), the email follows the two-partition rule (a login
 * row of the email stops the create; a guest row stops a retail create and is left alone by a merchant create, which voids its open email
 * links), and the checks other modules registered (the blocklist) run before the first write. The account is made `active` at once
 * (decision 062); a merchant rank also opens its wallet and hold in the same transaction (so no merchant exists without a wallet); a retail
 * account opens none (its wallet is opened when it is first needed). The password is an emailed link (an invitation) or a temporary one the
 * server makes and returns once; user rule 2: a credit limit above zero needs a rank with `overdraft_allowed`, and a retail rank allows none.
 * The status machine is `active → suspended → active`; `blocked` and `anonymized` have their own routes. Ranks are never written here (`422
 * use_rank_route`): the rank change is the Owner's and moves the balance.
 *
 * Side effects: writes `clients`, the ledger accounts (through the money module), `auth_tokens`, `outbox_events`, `sessions` and `audit_logs`;
 * a suspension ends the account's sessions and voids its links through `AccountAccessEffects`, and every status change drops the cached session
 * and API key views after the commit. A status change of a merchant rank writes the suspension or reactivation mail (`notifications`); a retail
 * rank gets none, as before the one account type. A create clears the failed-sign-in lock of the email after the commit.
 *
 * Second permissions (decisions 046, 047, 049, checked here, not by the route's guard): a merchant rank needs the Owner; a temporary password
 * needs `clients:security`; a credit limit above zero needs `wallet:credit_limit`, and above the approval limit of adjustments (or past the
 * caller's 24-hour sum) an Owner; suspending and reactivating need `clients:security`, and reactivating a merchant-rank account that was never
 * approved (suspended by the retirement of the approval step) needs the Owner; changing the email of an account with a login needs
 * `clients:security` too.
 *
 * @see docs/contract/endpoints/identity.md (the `/admin/clients` sections)
 */
@Injectable()
export class ClientWriteService {
  constructor(
    private readonly db: DbService,
    private readonly groups: ClientGroupDirectory,
    private readonly ranks: RankGroupReads,
    private readonly directory: AccountDirectory,
    private readonly accounts: MerchantAccounts,
    private readonly checks: AccountCreateChecks,
    private readonly tokens: AccountAuthTokens,
    private readonly mail: AccountMailOutbox,
    private readonly effects: AccountAccessEffects,
    private readonly details: ClientDetailsEditor,
    private readonly lifecycleMails: MerchantLifecycleMails,
    private readonly hasher: PasswordHasher,
    private readonly audit: AuditService,
    private readonly settings: SettingsReader,
    private readonly signInLock: SignInLock,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  /**
   * Creates an account with a login.
   *
   * @param caller the signed-in staff member
   * @param input the cleaned body
   * @returns the new account's id and, for the temporary mode, the password (shown once; the controller answers `Cache-Control: no-store`)
   * @throws {AppError} `FORBIDDEN` (403: a merchant rank needs the Owner, checked first; a temporary password needs `clients:security`; a
   *   credit limit needs `wallet:credit_limit` and, above the approval limit, an Owner), `VALIDATION_FAILED` (422 on `groupId` for an unknown
   *   rank, on `company` or `creditLimit` for a retail rank, on `creditLimit` for a rank without credit, on `country` for a country the shop
   *   does not sell to, on `email` for a blocklisted address), `EMAIL_TAKEN` (409: `errors[0].code` `taken` for an email another login row holds,
   *   `guest` for a retail create over a guest's email)
   */
  async create(caller: StaffPrincipal, input: CreateAccountInput): Promise<CreatedAccount> {
    const email = input.email.trim().toLowerCase();
    const mode: PasswordMode = input.password?.mode ?? 'reset_link';
    // Read the rank without a lock first: the refusals below need its kind. It is read again under a share lock in the transaction.
    const peek = await this.rankOf(this.db.db, input.groupId, false);
    const rankKind = rankKindOf(peek.kind);
    // Nothing is read for writing before this: decision 064 (a merchant rank is the Owner's), decision 047 (a temporary password).
    assertMayGiveRank(caller, rankKind);
    const modePermission = passwordModePermission(mode);
    if (modePermission !== null) requirePermission(caller, modePermission);
    const currency = rankKind === 'retail' ? await this.retailCurrency(input.country) : null;
    if (rankKind === 'retail') {
      const problem = retailCreateProblem({ company: input.company, creditLimit: input.creditLimit });
      if (problem) throw invalid(problem);
    }
    // Decision 046: credit at creation is a credit-limit decision, as on the credit-limit route. Decision 049: above the approval limit of
    // adjustments it is an Owner's decision. Both before anything is written.
    let ceiling: Money | undefined;
    if (rankKind === 'merchant' && input.creditLimit !== undefined && Money.of(input.creditLimit).isPositive()) {
      requirePermission(caller, 'wallet:credit_limit');
      ceiling = approvalLimitOf(await this.settings.get(ADJUST_APPROVAL_LIMIT_KEY));
      if (creditLimitNeedsOwner(Money.of(input.creditLimit), Money.zero(), ceiling)) {
        requireOwner(caller, creditLimitOwnerDetail(ceiling));
      }
    }
    const name = input.name.replace(/\s+/g, ' ').trim();
    // Argon2 takes tens of milliseconds: hash before the transaction, not while rows are locked.
    const temporary =
      mode === 'temporary_password' ? temporaryPasswordFor((max) => randomInt(max), { email, name }) : undefined;
    const passwordHash = temporary === undefined ? undefined : await this.hasher.hash(temporary);

    for (let attempt = 1; ; attempt++) {
      try {
        const id = await this.createOnce(
          caller,
          { ...input, email, name },
          { rankId: peek.id, currency, ceiling, passwordHash },
        );
        return temporary === undefined ? { id } : { id, temporaryPassword: temporary };
      } catch (error) {
        // Two merchants made at the same moment may draw the same username: draw again.
        if (!(error instanceof GeneratedValueTaken) || attempt >= MAX_CREATE_ATTEMPTS) throw error;
      }
    }
  }

  /**
   * Suspends or reactivates an account, or edits its details.
   *
   * @param caller the signed-in staff member
   * @param id the account id
   * @param input a status change (with a reason when suspending), or details (several keys at once); one kind per call
   * @throws {AppError} `NOT_FOUND` (404), `ANONYMIZED` (409, any write on an anonymized account), `INVALID_TRANSITION` (409), `NO_ACCOUNT` (409,
   *   a status change of a guest), `EMAIL_TAKEN` (409), `RATE_LIMITED` (429, an email change), `VALIDATION_FAILED` (422 on `reason`, on `status`
   *   for `blocked`, `anonymized` and `pending`, on `groupId` with code `use_rank_route`, on a detail key, on `country` of a retail account for a
   *   country the shop does not sell to, on `email` for a blocklisted address, or on the first key of a second kind), `FORBIDDEN` (403: a move into
   *   or out of `suspended` needs `clients:security`, decision 046; an email change of an account with a login needs `clients:security`, decision 047;
   *   reactivating a merchant-rank account that was never approved needs the Owner, checked first)
   */
  async update(caller: StaffPrincipal, id: number, input: UpdateAccountInput): Promise<void> {
    const kind = kindOfClientChange(input);
    if ('problem' in kind) throw invalid(kind.problem);
    if (kind.kind === 'status') {
      const problem = statusWriteProblem(input.status!);
      if (problem) throw invalid(problem);
    }
    if (kind.kind === 'details' && input.email !== undefined) {
      // After the cheap refusals (404, 409), before the transaction: a refused call spends no point of the limiter.
      const existing = await this.directory.findById(this.db.db, id);
      if (!existing) throw notFound();
      if (existing.status === 'anonymized') throw new AppError('ANONYMIZED');
      if (input.email.toLowerCase() !== existing.email.toLowerCase()) {
        // Decision 047: checked before the limiter, so a refused call spends no point; `ClientDetailsEditor.apply` checks again on the locked row.
        const needed = emailChangePermission(existing.hasAccount);
        if (needed !== null) requirePermission(caller, needed);
        if (existing.hasAccount) await this.details.enforceEmailChangeLimit(id);
      }
    }
    await this.db.runInTransaction(async (work) => {
      const account = await lockClient(work.tx, id);
      if (!account) throw notFound();
      if (account.status === 'anonymized') throw new AppError('ANONYMIZED');
      if (kind.kind === 'status') await this.changeStatus(work, caller, account, input.status!, input.reason);
      else await this.details.apply(work, caller, account, input);
    });
  }

  private async createOnce(
    caller: StaffPrincipal,
    input: CreateAccountInput & { readonly email: string; readonly name: string },
    facts: {
      readonly rankId: number;
      readonly currency: string | null;
      readonly ceiling: Money | undefined;
      readonly passwordHash: string | undefined;
    },
  ): Promise<number> {
    const { email, name } = input;
    return this.db.runInTransaction(async (work) => {
      // Decision 049: a credit limit given here counts in the caller's 24-hour sum, judged under their lock, which comes before any row lock.
      if (facts.ceiling) await this.accounts.lockStaffCredit(work.tx, caller.staffId);
      const group = await this.rankOf(work.tx, facts.rankId, true);
      const rankKind = rankKindOf(group.kind);
      // The email rule of both partitions and the registered checks (the blocklist), before the first write.
      const admitted = await this.checks.admitCreate(work.tx, { email, rankKind });

      const now = this.clock.now();
      const username = rankKind === 'merchant' ? await this.freeUsername(work.tx, name) : null;
      let account: Client;
      try {
        account = await insertClientRow(work.tx, {
          username,
          email,
          name,
          phone: input.phone ?? '',
          company: rankKind === 'merchant' ? (input.company ?? '') : '',
          country: input.country,
          groupId: group.id,
          status: 'active',
          hasAccount: true,
          currency: facts.currency,
          createdBy: caller.staffId,
          // The console shows it: written from the clock, not the column default (decision 031).
          createdAt: now,
          ...(facts.passwordHash === undefined
            ? {}
            : {
                passwordHash: facts.passwordHash,
                // Until the person chooses a password from a mailed link, the account's sessions hand out no API key (decision 046).
                mustChangePassword: true,
                passwordChangedAt: now,
                passwordSetByStaff: true,
              }),
        });
      } catch (error) {
        // Two creates of one email at once: the unique index decides.
        if (isUniqueViolation(error, 'clients_login_email_uq')) throw emailConflictError('taken', email);
        if (isUniqueViolation(error, 'clients_username_uq')) throw new GeneratedValueTaken();
        throw error;
      }
      if (rankKind === 'merchant') {
        // User rule 2 is checked here: a credit limit above zero on a rank without credit is `422` on `creditLimit`.
        await this.accounts.open(work.tx, {
          clientId: account.id,
          currency: 'USD',
          creditLimit: input.creditLimit ?? '0.0000',
          overdraftAllowed: group.overdraftAllowed,
          grant:
            facts.ceiling === undefined
              ? undefined
              : { staffId: caller.staffId, owner: isOwner(caller), approvalLimit: facts.ceiling, at: now },
        });
      }
      if (facts.passwordHash === undefined) {
        // The invitation mail is a real mail job: the outbox row carries ids only; the worker rotates the token and mails the link.
        const invite = await this.tokens.issue(work, {
          accountId: account.id,
          purpose: 'invite',
          createdBy: caller.staffId,
          ip: caller.ip,
        });
        await this.mail.enqueue(work, { kind: 'invited', accountId: account.id, tokenId: invite.tokenId });
      }
      // A merchant create over a guest row of the email: a mail sent to the guest row earlier must not make a second login row.
      if (admitted.guestIdToVoid !== undefined) await this.checks.voidGuestLinks(work.tx, admitted.guestIdToVoid);
      await this.audit.record(work.tx, {
        action: 'created account',
        entityType: 'account',
        entityId: account.id,
        entityLabel: account.name,
        after: {
          name: account.name,
          email: account.email,
          country: account.country,
          rank: { id: group.id, name: group.name, kind: rankKind },
          status: 'active',
          ...(rankKind === 'merchant' ? { creditLimit: input.creditLimit ?? '0.0000' } : {}),
          // Not `password`: the audit log redacts every key that ends in it, and this is only the way the password was set.
          credential: facts.passwordHash === undefined ? 'invitation emailed' : 'temporary password set',
        },
      });
      // Failed passwords tried for this email before the account existed must not lock the new account.
      work.afterCommit(() => this.signInLock.clear('shop', email));
      return account.id;
    });
  }

  private async changeStatus(
    work: TransactionContext,
    caller: StaffPrincipal,
    account: Client,
    to: ClientStatus,
    reasonInput: string | undefined,
  ): Promise<void> {
    // A guest has no login to suspend: the same refusal as the security tools (the anonymized case was refused before the lock was used).
    const refusal = securityToolRefusal(account, 'revoke_sessions');
    if (refusal !== undefined) throw securityToolError(refusal);
    if (!canMoveClient(account.status, to)) {
      throw new AppError('INVALID_TRANSITION', {
        detail: `A ${account.status} account cannot become ${to}.`,
        errors: [
          { field: 'status', code: 'INVALID_TRANSITION', message: `Cannot go from ${account.status} to ${to}.` },
        ],
      });
    }
    // Read under the row lock: the rank kind decides the Owner's check below and the mail.
    const rankKind = rankKindOf((await this.ranks.kindOf(work.tx, account.groupId)) ?? '');
    // First: a merchant-rank account that was never approved becomes active only by the Owner's hand (decisions 062, 064), whatever else
    // the caller holds (the bulk Reactivate of the console sends this same request once per account).
    if (reactivationNeedsOwner({ ...account, rankKind }, to)) requireOwner(caller, NEVER_APPROVED_OWNER_DETAIL);
    // Decision 046: who may use the account (suspend, reactivate) is an account-security decision.
    const needed = statusChangePermission(account.status, to);
    if (needed !== null) requirePermission(caller, needed);
    const suspending = to === 'suspended';
    const reason = reasonInput ?? '';
    if (suspending) {
      const problem = suspendReasonProblem(reason);
      if (problem) throw invalid({ field: 'reason', code: 'invalid', message: problem });
    }
    await updateClientRow(work.tx, account.id, {
      status: to,
      suspendedAt: suspending ? this.clock.now() : null,
      suspendedReason: suspending ? reason : null,
      suspendedBy: suspending ? caller.staffId : null,
    });
    // A suspension ends the sessions and cancels every open link (a link sent before it must not work after a reactivation); every change
    // drops the cached views that carry the status.
    const ended = await this.effects.statusChanged(work, { accountId: account.id, to });
    // The mail rides on the same guarded change: transactional, so a suspended account gets the suspension notice too. The suspension
    // and reactivation mails are merchant mails: a retail rank has no text of them, so a retail account's status changes without a mail.
    if (rankKind === 'merchant') {
      if (suspending) await this.lifecycleMails.suspended(work, account);
      else await this.lifecycleMails.reactivated(work, account);
    }
    await this.audit.record(work.tx, {
      action: suspending ? 'suspended account of' : 'reactivated account of',
      entityType: 'account',
      entityId: account.id,
      entityLabel: account.name,
      before: { status: account.status },
      after: suspending ? { status: to, reason, sessionsEnded: ended.sessionsEnded } : { status: to },
    });
  }

  /** Reads the rank of a create: the given one, or the retail rank. A missing rank is `422` on `groupId`. */
  private async rankOf(db: DbExecutor, groupId: number | undefined, lock: boolean) {
    const id = groupId ?? (await this.ranks.retailGroupId(db));
    const group = await this.groups.find(db, id, lock ? { lock: 'share' } : {});
    if (!group) throw invalid({ field: 'groupId', code: 'invalid', message: 'This rank does not exist.' });
    return group;
  }

  /** The currency of a new retail account, and the refusal of a country the shop does not sell to. */
  private async retailCurrency(country: string): Promise<string | null> {
    await this.details.assertCountryAccepted(this.db.db, country);
    return this.details.currencyFor(this.db.db, country);
  }

  /** The first free Dhru username for a name: the slug, then `slug-2`, `slug-3`, ... */
  private async freeUsername(tx: TransactionContext['tx'], name: string): Promise<string> {
    const base = usernameBase(name);
    for (let attempt = 1; attempt <= 50; attempt++) {
      const candidate = usernameCandidate(base, attempt);
      if (!(await usernameTaken(tx, candidate))) return candidate;
    }
    // Fifty accounts with the same name: a random tail keeps the invitation working.
    return `${base}-${randomInt(100_000, 1_000_000)}`;
  }
}
