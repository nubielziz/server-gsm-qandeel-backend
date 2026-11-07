// MerchantAccountService: the use cases of GET /client/auth/me and PATCH /client/profile (map domain A, stage 2; MISMATCHES B129,
// B130). The merchant is read from the database, so an approval or a suspension shows at once.
import { Injectable } from '@nestjs/common';
import { AppError } from '../../../common/errors';
import { DbService } from '../../../infra/db';
import { ClientGroupDirectory } from '../../catalog';
import type { Client } from '../db/schema';
import { type ClientProfilePatch, saveClientProfile } from '../infra/merchant-auth.repository';
import type { MerchantPrincipal } from '../security/principal';
import { MerchantAccountReader } from './merchant-account-reader';

/** The merchant's own account, before the contract serialises it (B129). */
export interface MerchantMe {
  readonly id: number;
  readonly username: string;
  readonly email: string;
  readonly name: string;
  readonly company: string;
  readonly phone: string;
  readonly country: string;
  readonly status: Client['status'];
  readonly kycStatus: Client['kycStatus'];
  readonly emailVerifiedAt: Date | null;
  readonly twofaEnabled: boolean;
  readonly referralCode: string;
  readonly group: { readonly id: number; readonly name: string; readonly discountPercent: string };
  readonly createdAt: Date;
}

/**
 * Describes the signed-in merchant and edits its profile.
 *
 * Why: B129/B130. `GET /client/auth/me` is how the portal learns the approval status (`pending`, `active`) of a merchant that
 * signed in (B153), so it works for a pending merchant; the profile edit never touches the email, username, group or status.
 *
 * Side effects: `updateProfile` updates `clients`; `me` reads `clients` and `client_groups` (through the catalog directory).
 *
 * @see docs/contract/MISMATCHES.md (B129, B130)
 */
@Injectable()
export class MerchantAccountService {
  constructor(
    private readonly db: DbService,
    private readonly reader: MerchantAccountReader,
    private readonly groups: ClientGroupDirectory,
  ) {}

  /**
   * Describes the merchant of a session.
   *
   * @param principal the signed-in merchant
   * @returns the merchant, its approval status and its group
   * @throws {AppError} `UNAUTHORIZED` (401) when the merchant is gone, `ACCOUNT_SUSPENDED` (403) when it is suspended
   */
  async me(principal: MerchantPrincipal): Promise<MerchantMe> {
    return this.describe(await this.reader.current(principal.clientId));
  }

  /**
   * Changes the name, company, phone and country of the signed-in merchant.
   *
   * @param principal the signed-in merchant
   * @param patch the fields to change; a missing field stays as it is
   * @returns the merchant after the change
   * @throws {AppError} `UNAUTHORIZED` (401), `ACCOUNT_SUSPENDED` (403)
   */
  async updateProfile(principal: MerchantPrincipal, patch: ClientProfilePatch): Promise<MerchantMe> {
    await this.reader.current(principal.clientId);
    const updated = await saveClientProfile(this.db.db, principal.clientId, patch);
    if (!updated) throw new AppError('UNAUTHORIZED');
    return this.describe(updated);
  }

  private async describe(client: Client): Promise<MerchantMe> {
    const group = await this.groups.find(this.db.db, client.groupId);
    if (!group)
      throw new AppError('INTERNAL_ERROR', { detail: `Merchant ${client.id} belongs to a group that is gone.` });
    return {
      id: client.id,
      username: client.username,
      email: client.email,
      name: client.name,
      company: client.company,
      phone: client.phone,
      country: client.country,
      status: client.status,
      kycStatus: client.kycStatus,
      emailVerifiedAt: client.emailVerifiedAt,
      twofaEnabled: client.twofaEnabled,
      referralCode: client.referralCode,
      group: { id: group.id, name: group.name, discountPercent: group.discountPercent },
      createdAt: client.createdAt,
    };
  }
}
