// ClientAdminService: the use cases of the merchant management routes (map domain A, stage 2): list, show, invite a merchant,
// approve, suspend, reactivate and move to another group. Groups, wallets and order figures come from their own modules.
import { randomInt } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import { CLOCK, type Clock } from '../../../common/clock';
import type { ParsedListQuery } from '../../../common/contract';
import { AppError } from '../../../common/errors';
import { Money } from '../../../common/money';
import { DbService, type TransactionContext, isUniqueViolation } from '../../../infra/db';
import { ClientGroupDirectory, RETAIL_GROUP_KIND } from '../../catalog';
import {
  ADJUST_APPROVAL_LIMIT_KEY,
  MerchantAccounts,
  MerchantWallets,
  approvalLimitOf,
  creditLimitNeedsOwner,
  creditLimitOwnerDetail,
} from '../../money';
import { AuditService, SettingsReader } from '../../platform';
import type { Client, ClientStatus } from '../db/schema';
import { type ClientChangeInput, kindOfClientChange } from '../domain/client-details';
import {
  MERCHANT_EMAIL_CHANGE_PERMISSION,
  canMoveClient,
  referralCode,
  statusChangePermission,
  suspendReasonProblem,
  usernameBase,
  usernameCandidate,
} from '../domain/client-rules';
import { findClientById } from '../infra/merchant-auth.repository';
import { CLIENT_TOKEN_PURPOSES, voidOpenClientTokens } from '../infra/merchant-token.repository';
import {
  insertClientRow,
  listClientRows,
  lockClient,
  updateClientRow,
  usernameTaken,
} from '../infra/client-admin.repository';
import { requireOwner, requirePermission } from '../security/principal';
import type { StaffPrincipal } from '../security/principal';
import { ApiKeyDirectory } from '../security/machine/api-keys/api-key.directory';
import { SessionService } from '../security/session.service';
import { ClientDetailsEditor } from './client-details-editor';
import { type ClientView, ClientViews } from './client-views';
import { MerchantLifecycleMails } from './mail/merchant-lifecycle-mails';
import { MERCHANT_MAIL_EVENTS, MerchantMailOutbox } from './mail/merchant-mail-outbox';
import { MerchantInvites } from './merchant-invites';

/** The outbox event written when a merchant is invited; ids only, never the token (RESOLUTIONS identity-platform-2). */
export const MERCHANT_INVITED_EVENT = MERCHANT_MAIL_EVENTS.invited;

/** The input of `POST /admin/clients`. */
export interface CreateClientInput {
  readonly name: string;
  readonly email: string;
  readonly country: string;
  readonly groupId?: number | undefined;
  readonly creditLimit?: string | undefined;
}

/** The input of `PATCH /admin/clients/:id`: a status change, a group move or details (one kind per call). */
export type UpdateClientInput = ClientChangeInput;

function invalid(field: string, message: string): AppError {
  return new AppError('VALIDATION_FAILED', { errors: [{ field, code: 'invalid', message }] });
}

/** Thrown inside a transaction when a generated value (username, referral code) lost a race: the caller retries once more. */
class GeneratedValueTaken extends Error {}

const MAX_CREATE_ATTEMPTS = 4;

/**
 * Manages merchants.
 *
 * Why: scenario "merchants" of the console (RULES merchants) and RESOLUTIONS identity-platform-1 to -3. A merchant is created
 * `pending` by staff with an invitation, its ledger accounts are opened in the same transaction (so no merchant exists without a
 * wallet), the status machine is `pending → active → suspended → active`, and a group move prices new orders only. User rule 2:
 * a credit limit above zero needs a group with `overdraft_allowed`, at creation (`MerchantAccounts.open`) and on a group move
 * while the wallet's limit is above zero. User rule 1 (promotion by spend) belongs to feature 4a.
 *
 * Side effects: writes `clients`, `ledger_accounts` (through the money module), `auth_tokens`, `outbox_events` and `audit_logs`; a
 * status change clears the cached API key views (`ApiKeyDirectory.invalidateClient`) and session views after the commit and a
 * suspension ends the merchant's sessions.
 *
 * Second permissions (decision 046, checked here, not by the route's guard): a credit limit above zero at invitation needs
 * `wallet:credit_limit`; a group other than the default one at invitation, and a group move, need `groups:update`; suspending,
 * declining and reactivating need `clients:security`; changing the email address needs `clients:security` too (decision 047). A credit
 * limit above the approval limit of adjustments at invitation needs an Owner (decision 049).
 *
 * @see docs/contract/endpoints/identity.md (the `/admin/clients` sections)
 */
@Injectable()
export class ClientAdminService {
  constructor(
    private readonly db: DbService,
    private readonly groups: ClientGroupDirectory,
    private readonly accounts: MerchantAccounts,
    private readonly wallets: MerchantWallets,
    private readonly invites: MerchantInvites,
    private readonly sessions: SessionService,
    private readonly apiKeys: ApiKeyDirectory,
    private readonly audit: AuditService,
    private readonly settings: SettingsReader,
    private readonly mail: MerchantMailOutbox,
    private readonly views: ClientViews,
    private readonly lifecycleMails: MerchantLifecycleMails,
    private readonly details: ClientDetailsEditor,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  /**
   * Lists merchants.
   *
   * @param caller the signed-in staff member (wallet and stats are sent only with `wallet:read`)
   * @param query the parsed list request
   * @returns the page and the exact total
   */
  async list(
    caller: StaffPrincipal,
    query: ParsedListQuery<'name' | 'status' | 'createdAt' | 'id'>,
  ): Promise<{ rows: ClientView[]; total: number }> {
    const { rows, total } = await listClientRows(this.db.db, query, this.clock.now());
    return { rows: await this.views.many(this.db.db, caller, rows), total };
  }

  /**
   * Shows one merchant.
   *
   * @param caller the signed-in staff member
   * @param id the merchant id
   * @returns the merchant
   * @throws {AppError} `NOT_FOUND` (404)
   */
  show(caller: StaffPrincipal, id: number): Promise<ClientView> {
    return this.views.one(this.db.db, caller, id);
  }

  /**
   * Invites a new merchant.
   *
   * @param caller the signed-in staff member
   * @param input name, email, country, group and credit limit
   * @returns the new merchant (status `pending`)
   * @throws {AppError} `VALIDATION_FAILED` (422 on `groupId` for an unknown group, the retail group or no default group, on
   *   `creditLimit` for a negative limit or a group without credit), `EMAIL_TAKEN` (409), `FORBIDDEN` (403: a `creditLimit` above
   *   zero needs `wallet:credit_limit`; a `groupId` other than the default group needs `groups:update`, checked after the group is
   *   found and before any write, decision 046; a `creditLimit` above the approval limit of adjustments needs an Owner, before any
   *   write, decision 049)
   */
  async create(caller: StaffPrincipal, input: CreateClientInput): Promise<ClientView> {
    // Decision 046: credit at invitation is a credit-limit decision, as on the credit-limit route. Decision 049: above the approval limit
    // of adjustments it is an Owner's decision. Both before anything is written.
    if (input.creditLimit !== undefined && Money.of(input.creditLimit).isPositive()) {
      requirePermission(caller, 'wallet:credit_limit');
      const ceiling = approvalLimitOf(await this.settings.get(ADJUST_APPROVAL_LIMIT_KEY));
      if (creditLimitNeedsOwner(Money.of(input.creditLimit), Money.zero(), ceiling)) {
        requireOwner(caller, creditLimitOwnerDetail(ceiling));
      }
    }
    for (let attempt = 1; ; attempt++) {
      try {
        return await this.createOnce(caller, input);
      } catch (error) {
        // Two merchants invited at the same moment may draw the same username or code: draw again.
        if (!(error instanceof GeneratedValueTaken) || attempt >= MAX_CREATE_ATTEMPTS) throw error;
      }
    }
  }

  /**
   * Approves, suspends or reactivates a merchant, moves it to another group, or edits its details.
   *
   * @param caller the signed-in staff member
   * @param id the merchant id
   * @param input a status change (with a reason when suspending), a group move, or details (several keys at once); one kind per call
   * @returns the updated merchant
   * @throws {AppError} `NOT_FOUND` (404), `INVALID_TRANSITION` (409), `EMAIL_TAKEN` (409), `RATE_LIMITED` (429, an email change),
   *   `VALIDATION_FAILED` (422 on `reason`, `status`, `groupId`, a detail key, or the first key of a second kind in the same call),
   *   `FORBIDDEN` (403: a group move needs `groups:update`; a move into or out of `suspended` needs `clients:security`, decision 046;
   *   an email change needs `clients:security`, decision 047)
   */
  async update(caller: StaffPrincipal, id: number, input: UpdateClientInput): Promise<ClientView> {
    const kind = kindOfClientChange(input);
    if ('problem' in kind) throw invalid(kind.problem.field, kind.problem.message);
    // Decision 046: a group decides the merchant's prices and credit.
    if (kind.kind === 'group') requirePermission(caller, 'groups:update');
    if (kind.kind === 'details' && input.email !== undefined) {
      // After the cheap refusals (404), before the transaction: a refused call spends no point of the limiter.
      const existing = await findClientById(this.db.db, id);
      if (!existing) throw new AppError('NOT_FOUND', { detail: 'No merchant has this id.' });
      if (input.email.toLowerCase() !== existing.email.toLowerCase()) {
        // Decision 047: checked before the limiter, so a refused call spends no point; `ClientDetailsEditor.apply` checks again on the locked row.
        requirePermission(caller, MERCHANT_EMAIL_CHANGE_PERMISSION);
        await this.details.enforceEmailChangeLimit(id);
      }
    }
    return this.db.runInTransaction(async (work) => {
      const client = await lockClient(work.tx, id);
      if (!client) throw new AppError('NOT_FOUND', { detail: 'No merchant has this id.' });
      if (kind.kind === 'group') await this.moveToGroup(work, client, input.groupId!);
      else if (kind.kind === 'status') await this.changeStatus(work, caller, client, input.status!, input.reason);
      else await this.details.apply(work, caller, client, input);
      return this.views.one(work.tx, caller, id);
    });
  }

  private async createOnce(caller: StaffPrincipal, input: CreateClientInput): Promise<ClientView> {
    const name = input.name.replace(/\s+/g, ' ').trim();
    return this.db.runInTransaction(async (work) => {
      const group =
        input.groupId === undefined
          ? await this.groups.findDefault(work.tx)
          : await this.groups.find(work.tx, input.groupId, { lock: 'share' });
      if (!group) {
        throw invalid(
          'groupId',
          input.groupId === undefined ? 'No default group is set.' : 'This group does not exist.',
        );
      }
      if (group.kind === RETAIL_GROUP_KIND) throw invalid('groupId', 'A merchant cannot join the storefront group.');
      // Decision 046: a group decides the merchant's prices and credit, so a group other than the default one is a groups decision,
      // as on the move route. No group, or the default group, needs only the route's permission. Nothing is written before this.
      if (input.groupId !== undefined && (await this.groups.findDefault(work.tx))?.id !== group.id) {
        requirePermission(caller, 'groups:update');
      }

      const username = await this.freeUsername(work.tx, name);
      let client: Client;
      try {
        client = await insertClientRow(work.tx, {
          username,
          email: input.email,
          name,
          country: input.country,
          groupId: group.id,
          status: 'pending',
          kycStatus: 'none',
          referralCode: referralCode((max) => randomInt(max)),
          // The console shows it: written from the clock, not the column default (decision 031).
          createdAt: this.clock.now(),
        });
      } catch (error) {
        if (isUniqueViolation(error, 'clients_email_uq')) {
          throw new AppError('EMAIL_TAKEN', { detail: `A merchant with ${input.email} already exists.` });
        }
        if (isUniqueViolation(error, 'clients_username_uq') || isUniqueViolation(error, 'clients_referral_code_uq')) {
          throw new GeneratedValueTaken();
        }
        throw error;
      }
      // Rule 2 is checked here: a credit limit above zero on a group without credit is `422` on `creditLimit`.
      await this.accounts.open(work.tx, {
        clientId: client.id,
        currency: 'USD',
        creditLimit: input.creditLimit ?? '0.0000',
        overdraftAllowed: group.overdraftAllowed,
      });
      const invite = await this.invites.issue(work, { clientId: client.id, createdBy: caller.staffId, ip: caller.ip });
      // The invitation mail is a real mail job: MerchantMailOutbox owns the route and the payload (ids only); the worker mails the link.
      await this.mail.enqueue(work, { kind: 'invited', clientId: client.id, tokenId: invite.id });
      await this.audit.record(work.tx, {
        action: 'invited merchant',
        entityType: 'merchant',
        entityId: client.id,
        entityLabel: client.name,
        after: {
          name: client.name,
          email: client.email,
          country: client.country,
          groupId: group.id,
          status: 'pending',
          creditLimit: input.creditLimit ?? '0.0000',
        },
      });
      return this.views.one(work.tx, caller, client.id);
    });
  }

  private async changeStatus(
    work: TransactionContext,
    caller: StaffPrincipal,
    client: Client,
    to: ClientStatus,
    reasonInput: string | undefined,
  ): Promise<void> {
    if (!canMoveClient(client.status, to)) {
      throw new AppError('INVALID_TRANSITION', {
        detail: `A ${client.status} merchant cannot become ${to}.`,
        errors: [{ field: 'status', code: 'INVALID_TRANSITION', message: `Cannot go from ${client.status} to ${to}.` }],
      });
    }
    // Decision 046: who may use the account (suspend, decline, reactivate) is an account-security decision.
    const needed = statusChangePermission(client.status, to);
    if (needed !== null) requirePermission(caller, needed);
    const suspending = to === 'suspended';
    const reason = reasonInput ?? '';
    if (suspending) {
      const problem = suspendReasonProblem(reason);
      if (problem) throw invalid('reason', problem);
    }
    await updateClientRow(work.tx, client.id, {
      status: to,
      suspendedAt: suspending ? this.clock.now() : null,
      suspendedReason: suspending ? reason : null,
      suspendedBy: suspending ? caller.staffId : null,
    });
    // A suspension ends the merchant's sessions and cancels every open link (a link sent before it must not work after a reactivation);
    // every change clears the cached views that carry the status.
    if (suspending) {
      await this.sessions.revokeAllOf('client', client.id, {}, work);
      await voidOpenClientTokens(work.tx, client.id, CLIENT_TOKEN_PURPOSES, this.clock.now());
    } else await this.sessions.invalidateSubject('client', client.id, work);
    await this.apiKeys.invalidateClient(client.id, work);
    // The mail rides on the same guarded change: transactional, so a suspended merchant gets the suspension notice too.
    if (suspending) await this.lifecycleMails.suspended(work, client);
    else if (client.status === 'pending') await this.lifecycleMails.approved(work, client);
    else await this.lifecycleMails.reactivated(work, client);
    await this.audit.record(work.tx, {
      action: suspending
        ? 'suspended merchant'
        : client.status === 'pending'
          ? 'approved merchant'
          : 'reactivated merchant',
      entityType: 'merchant',
      entityId: client.id,
      entityLabel: client.name,
      before: { status: client.status },
      after: suspending ? { status: to, reason } : { status: to },
    });
  }

  private async moveToGroup(work: TransactionContext, client: Client, groupId: number): Promise<void> {
    // The shared lock keeps the group from changing its credit rule or being deleted until this move commits.
    const group = await this.groups.find(work.tx, groupId, { lock: 'share' });
    if (!group) throw invalid('groupId', 'This group does not exist.');
    if (group.kind === RETAIL_GROUP_KIND) throw invalid('groupId', 'A merchant cannot join the storefront group.');
    if (group.id === client.groupId) throw invalid('groupId', 'The merchant is already in this group.');
    // User rule 2: a group without credit cannot hold a merchant whose credit limit is above zero.
    if (!group.overdraftAllowed && (await this.wallets.creditLimitOf(work.tx, client.id)).isPositive()) {
      throw invalid('groupId', "This group does not allow credit. Lower the merchant's credit limit to zero first.");
    }
    await updateClientRow(work.tx, client.id, { groupId: group.id });
    const before = await this.groups.find(work.tx, client.groupId);
    await this.audit.record(work.tx, {
      action: 'changed group of',
      entityType: 'merchant',
      entityId: client.id,
      entityLabel: client.name,
      before: { groupId: client.groupId, group: before?.name ?? null },
      after: { groupId: group.id, group: group.name },
    });
  }

  /** The first free Dhru username for a name: the slug, then `slug-2`, `slug-3`, ... */
  private async freeUsername(tx: TransactionContext['tx'], name: string): Promise<string> {
    const base = usernameBase(name);
    for (let attempt = 1; attempt <= 50; attempt++) {
      const candidate = usernameCandidate(base, attempt);
      if (!(await usernameTaken(tx, candidate))) return candidate;
    }
    // Fifty merchants with the same name: a random tail keeps the signup working.
    return `${base}-${randomInt(100_000, 1_000_000)}`;
  }
}
