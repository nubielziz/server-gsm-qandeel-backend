// ClientAdminService: the use cases of the merchant management routes (map domain A, stage 2): list, show, invite a merchant,
// approve, suspend, reactivate and move to another group. Groups, wallets and order figures come from their own modules.
import { randomInt } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import { CLOCK, type Clock } from '../../../common/clock';
import type { ParsedListQuery } from '../../../common/contract';
import { AppError } from '../../../common/errors';
import { DbService, type TransactionContext, isUniqueViolation } from '../../../infra/db';
import { ClientGroupDirectory, type ClientGroupRef, RETAIL_GROUP_KIND } from '../../catalog';
import { MerchantAccounts, MerchantWallets } from '../../money';
import { AuditService } from '../../platform';
import type { Client, ClientStatus } from '../db/schema';
import {
  canMoveClient,
  referralCode,
  suspendReasonProblem,
  usernameBase,
  usernameCandidate,
} from '../domain/client-rules';
import {
  type ClientRow,
  findClientRow,
  insertClientRow,
  listClientRows,
  lockClient,
  updateClientRow,
  usernameTaken,
} from '../infra/client-admin.repository';
import { grants } from '../security/permission-grammar';
import type { StaffPrincipal } from '../security/principal';
import { ApiKeyDirectory } from '../security/machine/api-keys/api-key.directory';
import { SessionService } from '../security/session.service';
import { type ClientStats, ClientStatsDirectory } from './client-stats';
import { MERCHANT_MAIL_EVENTS, MerchantMailOutbox } from './mail/merchant-mail-outbox';
import { MerchantInvites } from './merchant-invites';

/** The outbox event written when a merchant is invited; ids only, never the token (RESOLUTIONS identity-platform-2). */
export const MERCHANT_INVITED_EVENT = MERCHANT_MAIL_EVENTS.invited;

/** A merchant as the console reads it. `wallet` and `stats` only for staff who hold `wallet:read`. */
export interface ClientView {
  readonly id: number;
  readonly createdAt: string;
  readonly name: string;
  readonly email: string;
  readonly country: string;
  readonly username: string;
  readonly company: string;
  readonly phone: string;
  readonly groupId: number;
  readonly referralCode: string;
  readonly emailVerifiedAt: string | null;
  readonly status: ClientStatus;
  readonly kycStatus: Client['kycStatus'];
  readonly group: { id: number; name: string; discountPercent: string } | null;
  readonly referredBy: { id: number; name: string } | null;
  readonly wallet?: { balance: string; reserved: string; creditLimit: string; available: string };
  readonly stats?: ClientStats;
}

/** The input of `POST /admin/clients`. */
export interface CreateClientInput {
  readonly name: string;
  readonly email: string;
  readonly country: string;
  readonly groupId?: number | undefined;
  readonly creditLimit?: string | undefined;
}

/** The input of `PATCH /admin/clients/:id`. */
export interface UpdateClientInput {
  readonly status?: ClientStatus | undefined;
  readonly reason?: string | undefined;
  readonly groupId?: number | undefined;
}

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
 * @see docs/contract/endpoints/identity.md (the `/admin/clients` sections)
 */
@Injectable()
export class ClientAdminService {
  constructor(
    private readonly db: DbService,
    private readonly groups: ClientGroupDirectory,
    private readonly accounts: MerchantAccounts,
    private readonly wallets: MerchantWallets,
    private readonly stats: ClientStatsDirectory,
    private readonly invites: MerchantInvites,
    private readonly sessions: SessionService,
    private readonly apiKeys: ApiKeyDirectory,
    private readonly audit: AuditService,
    private readonly mail: MerchantMailOutbox,
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
    const { rows, total } = await listClientRows(this.db.db, query);
    return { rows: await this.viewsOf(this.db.db, caller, rows), total };
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
    return this.viewOf(this.db.db, caller, id);
  }

  /**
   * Invites a new merchant.
   *
   * @param caller the signed-in staff member
   * @param input name, email, country, group and credit limit
   * @returns the new merchant (status `pending`)
   * @throws {AppError} `VALIDATION_FAILED` (422 on `groupId` for an unknown group, the retail group or no default group, on
   *   `creditLimit` for a negative limit or a group without credit), `EMAIL_TAKEN` (409)
   */
  async create(caller: StaffPrincipal, input: CreateClientInput): Promise<ClientView> {
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
   * Approves, suspends or reactivates a merchant, or moves it to another group.
   *
   * @param caller the signed-in staff member
   * @param id the merchant id
   * @param input a status change (with a reason when suspending) or a group move
   * @returns the updated merchant
   * @throws {AppError} `NOT_FOUND` (404), `INVALID_TRANSITION` (409), `VALIDATION_FAILED` (422 on `reason`, `status` or
   *   `groupId`)
   */
  async update(caller: StaffPrincipal, id: number, input: UpdateClientInput): Promise<ClientView> {
    if (input.status !== undefined && input.groupId !== undefined) {
      throw invalid('status', 'Send one change at a time: a status or a group.');
    }
    return this.db.runInTransaction(async (work) => {
      const client = await lockClient(work.tx, id);
      if (!client) throw new AppError('NOT_FOUND', { detail: 'No merchant has this id.' });
      if (input.groupId !== undefined) await this.moveToGroup(work, client, input.groupId);
      else await this.changeStatus(work, caller, client, input.status!, input.reason);
      return this.viewOf(work.tx, caller, id);
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
      // One owner for the merchant mail events (route, payload with ids only, the dev-only link log): MerchantMailOutbox.
      await this.mail.enqueue(work, { kind: 'invited', clientId: client.id, tokenId: invite.id, token: invite.token });
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
      return this.viewOf(work.tx, caller, client.id);
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
    // A suspension ends the merchant's sessions; every change clears the cached views that carry the status.
    if (suspending) await this.sessions.revokeAllOf('client', client.id, {}, work);
    else await this.sessions.invalidateSubject('client', client.id, work);
    await this.apiKeys.invalidateClient(client.id, work);
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

  private async viewOf(
    db: Parameters<typeof findClientRow>[0],
    caller: StaffPrincipal,
    id: number,
  ): Promise<ClientView> {
    const row = await findClientRow(db, id);
    if (!row) throw new AppError('NOT_FOUND', { detail: 'No merchant has this id.' });
    return (await this.viewsOf(db, caller, [row]))[0]!;
  }

  private async viewsOf(
    db: Parameters<typeof findClientRow>[0],
    caller: StaffPrincipal,
    rows: ClientRow[],
  ): Promise<ClientView[]> {
    const ids = rows.map((row) => row.client.id);
    const finance = grants(caller.permissions, 'wallet:read');
    const [groups, wallets, stats] = await Promise.all([
      this.groups.refsOf(
        db,
        rows.map((row) => row.client.groupId),
      ),
      finance ? this.wallets.viewsOf(db, ids) : undefined,
      finance ? this.stats.of(db, ids, this.clock.now()) : undefined,
    ]);
    return rows.map((row) =>
      toView(row, groups.get(row.client.groupId), wallets?.get(row.client.id), stats?.get(row.client.id)),
    );
  }
}

function toView(
  { client, referredBy }: ClientRow,
  group: ClientGroupRef | undefined,
  wallet: ClientView['wallet'],
  stats: ClientStats | undefined,
): ClientView {
  return {
    id: client.id,
    createdAt: client.createdAt.toISOString(),
    name: client.name,
    email: client.email,
    country: client.country,
    username: client.username,
    company: client.company,
    phone: client.phone,
    groupId: client.groupId,
    referralCode: client.referralCode,
    emailVerifiedAt: client.emailVerifiedAt?.toISOString() ?? null,
    status: client.status,
    kycStatus: client.kycStatus,
    group: group ? { id: group.id, name: group.name, discountPercent: group.discountPercent } : null,
    referredBy,
    ...(wallet ? { wallet } : {}),
    ...(stats ? { stats } : {}),
  };
}
