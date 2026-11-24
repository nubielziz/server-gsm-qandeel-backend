// MerchantAccountService: the use cases of GET /client/auth/me and PATCH /client/profile (map domain A, stage 2; MISMATCHES B129, B130) and,
// for the shop, the account's own view and the retail profile write (decision 064). The account is read from the database, so a suspension
// shows at once.
import { Injectable } from '@nestjs/common';
import { AppError } from '../../../common/errors';
import { type DbExecutor, DbService, type Transaction } from '../../../infra/db';
import { ClientGroupDirectory } from '../../catalog';
import { sessionStateOf } from '../accounts/account-status';
import { rankKindOf } from '../ports/rank-kind';
import type { Client } from '../db/schema';
import { type ClientProfilePatch, lockClientById, saveClientProfile } from '../infra/merchant-auth.repository';
import { saveRetailProfileColumns } from '../infra/merchant-notification.repository';
import { type AccountMeView, AccountOwnProfile, type RetailProfileColumns } from '../ports/account-own-profile';
import type { AccountPrincipal } from '../ports/account-principal';
import { AccountSessions } from '../ports/account-sessions';
import { ApiKeyDirectory } from '../security/machine/api-keys/api-key.directory';
import { MerchantAccountReader } from './merchant-account-reader';

const iso = (date: Date | null): string | null => (date === null ? null : date.toISOString());

/**
 * Describes the signed-in account and edits a merchant's profile.
 *
 * Why: B129/B130. `GET /client/auth/me` is how the portal learns the state of the account that signed in; the profile edit never touches
 * the email, username, rank or status. It also serves the shop's retail account page (`AccountOwnProfile`), so the one builder of
 * `AccountMe` answers both families.
 *
 * Side effects: `updateProfile` updates `clients`; `me` reads `clients` and `client_groups` (through the catalog directory);
 * `saveRetailProfile` updates `clients` inside the caller's transaction.
 *
 * @see docs/contract/MISMATCHES.md (B129, B130)
 */
@Injectable()
export class MerchantAccountService implements AccountOwnProfile {
  constructor(
    private readonly db: DbService,
    private readonly reader: MerchantAccountReader,
    private readonly groups: ClientGroupDirectory,
    private readonly sessions: AccountSessions,
    private readonly apiKeys: ApiKeyDirectory,
  ) {}

  /**
   * Describes the account of a session.
   *
   * @param principal the signed-in account
   * @returns the account and its rank
   * @throws {AppError} `UNAUTHORIZED` (401) when the account is gone, `ACCOUNT_SUSPENDED` (403) when it is suspended
   */
  async me(principal: AccountPrincipal): Promise<AccountMeView> {
    return this.meOf(principal.accountId);
  }

  /**
   * Describes an account for the wire.
   *
   * @param accountId the signed-in account
   * @returns the account as `AccountMe` shows it
   * @throws {AppError} `UNAUTHORIZED` (401), `ACCOUNT_SUSPENDED` (403)
   */
  async meOf(accountId: number): Promise<AccountMeView> {
    return this.describe(this.db.db, await this.reader.current(accountId));
  }

  /**
   * Reads an account and locks its row.
   *
   * @param tx the caller's transaction
   * @param accountId the signed-in account
   * @returns the account as it is now
   * @throws {AppError} `UNAUTHORIZED` (401) when the account is gone or anonymized, `ACCOUNT_SUSPENDED` (403) when it is suspended or blocked
   */
  async lockMeOf(tx: Transaction, accountId: number): Promise<AccountMeView> {
    const client = await lockClientById(tx, accountId);
    if (!client) throw new AppError('UNAUTHORIZED');
    const state = sessionStateOf(client.status);
    if (state === 'gone') throw new AppError('UNAUTHORIZED');
    if (state === 'suspended') throw new AppError('ACCOUNT_SUSPENDED', { detail: 'This account is suspended.' });
    return this.describe(tx, client);
  }

  /**
   * Writes the columns of the shop's own profile edit.
   *
   * @param tx the caller's transaction (it holds the row lock of `lockMeOf`)
   * @param accountId the signed-in account
   * @param columns the columns to change
   * @param now the time of the change
   * @returns the account after the write
   * @throws {AppError} `UNAUTHORIZED` (401) when the account is gone
   */
  async saveRetailProfile(
    tx: Transaction,
    accountId: number,
    columns: RetailProfileColumns,
    now: Date,
  ): Promise<AccountMeView> {
    const updated = await saveRetailProfileColumns(tx, accountId, columns, now);
    if (!updated) throw new AppError('UNAUTHORIZED');
    return this.describe(tx, updated);
  }

  /**
   * Changes the name, company, phone, country, address and tax id of the signed-in merchant.
   *
   * Side effects: updates `clients`; a changed name drops the cached session and API key views of the account (both hold the name).
   *
   * @param principal the signed-in account
   * @param patch the fields to change; a missing field stays as it is
   * @returns the account after the change
   * @throws {AppError} `UNAUTHORIZED` (401), `ACCOUNT_SUSPENDED` (403)
   */
  async updateProfile(principal: AccountPrincipal, patch: ClientProfilePatch): Promise<AccountMeView> {
    const before = await this.reader.current(principal.accountId);
    const updated = await saveClientProfile(this.db.db, principal.accountId, patch);
    if (!updated) throw new AppError('UNAUTHORIZED');
    if (patch.name !== undefined && patch.name !== before.name) {
      await this.sessions.invalidate(updated.id);
      await this.apiKeys.invalidateClient(updated.id);
    }
    return this.describe(this.db.db, updated);
  }

  private async describe(db: DbExecutor, client: Client): Promise<AccountMeView> {
    const group = await this.groups.find(db, client.groupId);
    if (!group)
      throw new AppError('INTERNAL_ERROR', { detail: `Account ${client.id} belongs to a rank that is gone.` });
    return {
      id: client.id,
      name: client.name,
      email: client.email,
      status: client.status,
      rank: {
        id: group.id,
        name: group.name,
        kind: rankKindOf(group.kind),
        discountPercent: group.discountPercent,
      },
      hasPassword: client.passwordHash !== null,
      mustChangePassword: client.mustChangePassword,
      twofaEnabled: client.twofaEnabled,
      currency: client.currency,
      marketingOptIn: client.marketingOptIn,
      company: client.company,
      username: client.username ?? '',
      phone: client.phone,
      country: client.country,
      address: client.address,
      taxId: client.taxId,
      emailVerifiedAt: iso(client.emailVerifiedAt),
      createdAt: client.createdAt.toISOString(),
    };
  }
}
