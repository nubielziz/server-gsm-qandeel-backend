// ClientViews: turns merchant rows into the wire view of the admin routes (`ClientView`): group, wallet and 30-day figures from their own
// modules, plus the security facts and the suspension of feature 20. Used by the list, show, create and update use cases.
import { Inject, Injectable } from '@nestjs/common';
import { CLOCK, type Clock } from '../../../common/clock';
import { AppError } from '../../../common/errors';
import type { DbExecutor } from '../../../infra/db';
import { ClientGroupDirectory, type ClientGroupRef } from '../../catalog';
import { MerchantWallets } from '../../money';
import type { Client, ClientStatus } from '../db/schema';
import { type ClientRow, findClientRow } from '../infra/client-admin.repository';
import { countLiveSessionsOf } from '../infra/session-admin.repository';
import { grants } from '../security/permission-grammar';
import type { StaffPrincipal } from '../security/principal';
import { SessionPolicy } from '../security/session-policy';
import { type ClientStats, ClientStatsDirectory } from './client-stats';
import { idleLimitsOf } from './idle-limits';

/** What staff may see about how a merchant signs in (`Client.security`). */
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

/** Why, when and by whom a merchant is suspended (`Client.suspension`). */
export interface ClientSuspensionView {
  readonly at: string | null;
  readonly reason: string | null;
  readonly by: { id: number; name: string } | null;
}

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
  readonly address: string;
  readonly taxId: string;
  readonly internalNotes: string;
  /** Whether a Telegram chat is linked; never the chat id. */
  readonly telegramLinked: boolean;
  readonly security: ClientSecurityView;
  /** `null` unless the status is `suspended`. */
  readonly suspension: ClientSuspensionView | null;
  readonly wallet?: { balance: string; reserved: string; creditLimit: string; available: string };
  readonly stats?: ClientStats;
}

/**
 * Builds merchant views.
 *
 * Why: one place decides what the merchant row of `GET /admin/clients`, `GET /admin/clients/:id`, `POST` and `PATCH` carries, so
 * the list, the page and every answer of a change agree (feature 20, plan section 5.1.1).
 *
 * Side effects: reads only: `clients`, `staff_users`, `auth_tokens`, `sessions` and the group, wallet and order figures of their modules.
 */
@Injectable()
export class ClientViews {
  constructor(
    private readonly groups: ClientGroupDirectory,
    private readonly wallets: MerchantWallets,
    private readonly stats: ClientStatsDirectory,
    private readonly policy: SessionPolicy,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  /**
   * Reads one merchant as a view.
   *
   * @param db the database or a transaction
   * @param caller the signed-in staff member (wallet and stats only with `wallet:read`)
   * @param id the merchant id
   * @returns the view
   * @throws {AppError} `NOT_FOUND` (404)
   */
  async one(db: DbExecutor, caller: StaffPrincipal, id: number): Promise<ClientView> {
    const row = await findClientRow(db, id, this.clock.now());
    if (!row) throw new AppError('NOT_FOUND', { detail: 'No merchant has this id.' });
    return (await this.many(db, caller, [row]))[0]!;
  }

  /**
   * Turns rows into views, with one query per kind of figure for the whole page.
   *
   * @param db the database or a transaction
   * @param caller the signed-in staff member
   * @param rows the merchant rows
   * @returns the views, in the order of `rows`
   */
  async many(db: DbExecutor, caller: StaffPrincipal, rows: readonly ClientRow[]): Promise<ClientView[]> {
    const ids = rows.map((row) => row.client.id);
    const finance = grants(caller.permissions, 'wallet:read');
    const now = this.clock.now();
    const [groups, wallets, stats] = await Promise.all([
      this.groups.refsOf(
        db,
        rows.map((row) => row.client.groupId),
      ),
      finance ? this.wallets.viewsOf(db, ids) : undefined,
      finance ? this.stats.of(db, ids, now) : undefined,
    ]);
    // After the others, not beside them: `db` may be a transaction, which runs one query at a time.
    const sessionCounts = await countLiveSessionsOf(db, 'client', ids, now, await idleLimitsOf(this.policy));
    return rows.map((row) =>
      toView(
        row,
        groups.get(row.client.groupId),
        sessionCounts.get(row.client.id) ?? 0,
        wallets?.get(row.client.id),
        stats?.get(row.client.id),
      ),
    );
  }
}

function toView(
  { client, referredBy, suspendedBy, linkSentAt, verificationSentAt }: ClientRow,
  group: ClientGroupRef | undefined,
  activeSessions: number,
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
    address: client.address,
    taxId: client.taxId,
    internalNotes: client.internalNotes,
    telegramLinked: client.telegramChatId !== null,
    security: {
      hasPassword: client.passwordHash !== null,
      mustChangePassword: client.mustChangePassword,
      passwordChangedAt: client.passwordChangedAt?.toISOString() ?? null,
      twofaEnabled: client.twofaEnabled,
      lastLoginAt: client.lastLoginAt?.toISOString() ?? null,
      lastLoginIp: client.lastLoginIp,
      activeSessions,
      linkSentAt: linkSentAt?.toISOString() ?? null,
      verificationSentAt: verificationSentAt?.toISOString() ?? null,
    },
    suspension:
      client.status === 'suspended'
        ? { at: client.suspendedAt?.toISOString() ?? null, reason: client.suspendedReason, by: suspendedBy }
        : null,
    ...(wallet ? { wallet } : {}),
    ...(stats ? { stats } : {}),
  };
}
