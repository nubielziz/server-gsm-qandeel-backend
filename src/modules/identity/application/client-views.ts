// ClientViews: turns account rows into the wire view of the staff routes (`AccountView`): rank, wallet and 30-day figures from their own
// modules, plus the security facts, the suspension and the order figures. Used by the list, show, create and update use cases.
import { Inject, Injectable } from '@nestjs/common';
import { CLOCK, type Clock } from '../../../common/clock';
import { AppError } from '../../../common/errors';
import type { DbExecutor } from '../../../infra/db';
import { ClientGroupDirectory, type ClientGroupRef } from '../../catalog';
import { AccountWallets, type AccountWalletView } from '../../money';
import { canAct } from '../accounts/account-status';
import { type RankKind, rankKindOf } from '../ports/rank-kind';
import type { ClientStatus } from '../db/schema';
import { type ClientRow, findClientRow } from '../infra/client-admin.repository';
import { countLiveSessionsOf } from '../infra/session-admin.repository';
import { AccountListSql } from '../ports/account-list-sql';
import { grants } from '../security/permission-grammar';
import type { StaffPrincipal } from '../security/principal';
import { SessionPolicy } from '../security/session-policy';
import { type ClientStats, ClientStatsDirectory } from './client-stats';
import { idleLimitsOf } from './idle-limits';

/** What staff may see about how an account signs in (`AccountView.security`). */
export interface ClientSecurityView {
  readonly hasPassword: boolean;
  readonly mustChangePassword: boolean;
  readonly passwordChangedAt: string | null;
  readonly twofaEnabled: boolean;
  readonly lastLoginAt: string | null;
  readonly lastLoginIp: string | null;
  /** Live, fully signed-in sessions (the rule of `GET /admin/sessions`). */
  readonly activeSessions: number;
  /** When the newest open invite or reset link was sent. */
  readonly linkSentAt: string | null;
  /** When the newest open verification link was sent. */
  readonly verificationSentAt: string | null;
}

/** Why, when and by whom an account is suspended (`AccountView.suspension`). */
export interface ClientSuspensionView {
  readonly at: string | null;
  readonly reason: string | null;
  readonly by: { id: number; name: string } | null;
}

/** The rank of an account as the staff routes show it. */
export interface AccountRankView {
  readonly id: number;
  readonly name: string;
  readonly kind: RankKind;
  readonly discountPercent: string;
  readonly creditAllowed: boolean;
}

/** The live wallet of an account (only for staff who hold `wallet:read`; none for a guest). */
export interface AccountWalletFigures {
  readonly kind: AccountWalletView['kind'];
  readonly balance: string;
  readonly reserved: string;
  readonly creditLimit: string;
  readonly available: string;
  readonly frozen: boolean;
}

/**
 * An account as the console reads it, whatever its rank: a merchant, a retail account or a guest. `wallet` and `stats` only for staff who
 * hold `wallet:read`; `wallet` never for a guest.
 */
export interface AccountView {
  readonly id: number;
  readonly createdAt: string;
  readonly name: string;
  readonly email: string;
  readonly emailVerifiedAt: string | null;
  readonly phone: string;
  readonly country: string;
  readonly company: string;
  readonly address: string;
  readonly taxId: string;
  readonly internalNotes: string;
  /** The Dhru username; `null` until the account holds a merchant rank. */
  readonly username: string | null;
  readonly status: ClientStatus;
  readonly rank: AccountRankView;
  /** False for a guest: a row a signed-out checkout or a support form left for an email address. */
  readonly hasAccount: boolean;
  /** True for an account with a login, no password yet and an active status. */
  readonly invitationPending: boolean;
  readonly currencyCode: string | null;
  readonly marketingOptIn: boolean;
  readonly createdBy: { id: number; name: string } | null;
  /** `null` unless a suspension is on record (set by a suspension, cleared by a reactivation). */
  readonly suspension: ClientSuspensionView | null;
  readonly anonymizedAt: string | null;
  readonly lastLoginAt: string | null;
  /** Every order of the account, whatever the door and the status. */
  readonly ordersCount: number;
  readonly lastOrderAt: string | null;
  /** `null` for a guest. */
  readonly security: ClientSecurityView | null;
  readonly wallet?: AccountWalletFigures;
  readonly stats?: ClientStats;
}

/** The earlier name of {@link AccountView}, kept for the services that answer with it until they are renamed. */
export type ClientView = AccountView;

/**
 * Builds account views.
 *
 * Why: one place decides what the account row of `GET /admin/clients`, `GET /admin/clients/:id`, `POST` and `PATCH` carries, so the list,
 * the page and every answer of a change agree (decision 064).
 *
 * Side effects: reads only: `clients`, `staff_users`, `auth_tokens`, `sessions` and the rank, wallet and order figures of their modules.
 */
@Injectable()
export class ClientViews {
  constructor(
    private readonly groups: ClientGroupDirectory,
    private readonly wallets: AccountWallets,
    private readonly stats: ClientStatsDirectory,
    private readonly policy: SessionPolicy,
    private readonly listSql: AccountListSql,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  /**
   * Reads one account as a view.
   *
   * @param db the database or a transaction
   * @param caller the signed-in staff member (wallet and stats only with `wallet:read`)
   * @param id the account id
   * @returns the view
   * @throws {AppError} `NOT_FOUND` (404)
   */
  async one(db: DbExecutor, caller: StaffPrincipal, id: number): Promise<AccountView> {
    const row = await findClientRow(db, id, this.clock.now(), this.listSql);
    if (!row) throw new AppError('NOT_FOUND', { detail: 'No account has this id.' });
    return (await this.many(db, caller, [row]))[0]!;
  }

  /**
   * Turns rows into views, with one query per kind of figure for the whole page.
   *
   * @param db the database or a transaction
   * @param caller the signed-in staff member
   * @param rows the account rows
   * @returns the views, in the order of `rows`
   */
  async many(db: DbExecutor, caller: StaffPrincipal, rows: readonly ClientRow[]): Promise<AccountView[]> {
    const ids = rows.map((row) => row.client.id);
    // A guest has no login, so no session and no wallet to ask for.
    const loginIds = rows.filter((row) => row.client.hasAccount).map((row) => row.client.id);
    const finance = grants(caller.permissions, 'wallet:read');
    const now = this.clock.now();
    const [ranks, wallets, stats] = await Promise.all([
      this.groups.refsOf(
        db,
        rows.map((row) => row.client.groupId),
      ),
      finance ? this.wallets.viewsOf(db, loginIds) : undefined,
      finance ? this.stats.of(db, ids, now) : undefined,
    ]);
    // After the others, not beside them: `db` may be a transaction, which runs one query at a time.
    const sessionCounts = await countLiveSessionsOf(db, 'account', loginIds, now, await idleLimitsOf(this.policy));
    return rows.map((row) => {
      const id = row.client.id;
      const wallet = wallets?.get(id);
      return toView(
        row,
        rankOf(row, ranks.get(row.client.groupId)),
        sessionCounts.get(id) ?? 0,
        wallet === undefined ? undefined : walletFigures(wallet),
        stats?.get(id),
      );
    });
  }
}

/**
 * Names the rank of a row.
 *
 * @param row the account row
 * @param group the group the account belongs to
 * @returns the rank as the wire shows it
 * @throws {Error} when the group is missing: `clients.group_id` is a foreign key, so a missing group is a corrupt database, never a request
 */
function rankOf(row: ClientRow, group: ClientGroupRef | undefined): AccountRankView {
  if (!group) throw new Error(`Account ${row.client.id} names a rank that does not exist.`);
  return {
    id: group.id,
    name: group.name,
    kind: rankKindOf(group.kind),
    discountPercent: group.discountPercent,
    creditAllowed: group.overdraftAllowed,
  };
}

function walletFigures(wallet: AccountWalletView): AccountWalletFigures {
  return {
    kind: wallet.kind,
    balance: wallet.balance,
    reserved: wallet.reserved,
    creditLimit: wallet.creditLimit,
    available: wallet.available,
    frozen: wallet.frozen !== null,
  };
}

function toView(
  { client, suspendedBy, createdBy, linkSentAt, verificationSentAt, ordersCount, lastOrderAt }: ClientRow,
  rank: AccountRankView,
  activeSessions: number,
  wallet: AccountWalletFigures | undefined,
  stats: ClientStats | undefined,
): AccountView {
  return {
    id: client.id,
    createdAt: client.createdAt.toISOString(),
    name: client.name,
    email: client.email,
    emailVerifiedAt: client.emailVerifiedAt?.toISOString() ?? null,
    phone: client.phone,
    country: client.country,
    company: client.company,
    address: client.address,
    taxId: client.taxId,
    internalNotes: client.internalNotes,
    username: client.username,
    status: client.status,
    rank,
    hasAccount: client.hasAccount,
    invitationPending: client.hasAccount && client.passwordHash === null && canAct(client.status),
    currencyCode: client.currency,
    marketingOptIn: client.marketingOptIn,
    createdBy,
    // The suspension columns are written by a suspension and cleared by a reactivation, so they are the record of whether one is on.
    suspension:
      client.suspendedAt === null
        ? null
        : { at: client.suspendedAt.toISOString(), reason: client.suspendedReason, by: suspendedBy },
    anonymizedAt: client.anonymizedAt?.toISOString() ?? null,
    lastLoginAt: client.lastLoginAt?.toISOString() ?? null,
    ordersCount,
    lastOrderAt: lastOrderAt?.toISOString() ?? null,
    security: client.hasAccount
      ? {
          hasPassword: client.passwordHash !== null,
          mustChangePassword: client.mustChangePassword,
          passwordChangedAt: client.passwordChangedAt?.toISOString() ?? null,
          twofaEnabled: client.twofaEnabled,
          lastLoginAt: client.lastLoginAt?.toISOString() ?? null,
          lastLoginIp: client.lastLoginIp,
          activeSessions,
          linkSentAt: linkSentAt?.toISOString() ?? null,
          verificationSentAt: verificationSentAt?.toISOString() ?? null,
        }
      : null,
    ...(wallet ? { wallet } : {}),
    ...(stats ? { stats } : {}),
  };
}
