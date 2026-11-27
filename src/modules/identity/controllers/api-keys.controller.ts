// HTTP controllers of the API key routes (map domain A, stage 7): the read-only list of the own keys of an account of a merchant rank
// under /client/api-keys (B155, decision 067) and the staff's view, creation, edits and revocation under /admin. Thin; the rules live in
// MerchantApiKeyService and ApiKeyAdminService.
import { Body, Controller, Header, Param, Query } from '@nestjs/common';
import { type BodyOf, type ParamsOf, type QueryOf, type ResultOf, Route } from '../../../common/contract';
import { ApiKeyAdminService } from '../application/api-key-admin.service';
import { MerchantApiKeyService } from '../application/merchant-api-key.service';
import {
  adminCreateClientApiKey,
  adminListClientApiKeys,
  adminRevokeApiKey,
  adminUpdateApiKey,
  portalListApiKeys,
} from '../contracts/api-keys.contracts';
import { type AccountPrincipal, CurrentAccount } from '../ports/account-principal';
import { CurrentStaff } from '../security/access-state';
import type { StaffPrincipal } from '../security/principal';

/**
 * The merchant portal's API key route: a read-only list.
 *
 * Why: B155 and decision 067. A merchant sees the keys its integration uses (the prefix, the allowed addresses, the last use); it no
 * longer creates, changes or revokes them: staff make every key in the console, so `POST /client/api-keys`,
 * `PATCH /client/api-keys/:id` and `DELETE /client/api-keys/:id` have no handler and answer `404`.
 *
 * @route GET /client/api-keys
 */
@Controller()
export class MerchantApiKeysController {
  constructor(private readonly keys: MerchantApiKeyService) {}

  /**
   * Lists the merchant's keys.
   *
   * @param merchant the signed-in merchant
   * @param query the parsed range and sort
   * @returns the rows and the exact total
   * @route GET /client/api-keys
   */
  @Route(portalListApiKeys)
  list(
    @CurrentAccount() merchant: AccountPrincipal,
    @Query() query: QueryOf<typeof portalListApiKeys>,
  ): Promise<ResultOf<typeof portalListApiKeys>> {
    return this.keys.list(merchant, { offset: query.range.start, limit: query.range.limit, sort: query.sort });
  }
}

/**
 * The admin API key routes.
 *
 * Why: the merchants tab of the console reads a merchant's keys, creates one (shown once, `Cache-Control: no-store`), changes a key's
 * name, limits and expiry and revokes one (MISMATCHES B31, M45; feature 20, R5 and R6).
 *
 * @route GET /admin/clients/:id/api-keys
 * @route POST /admin/clients/:id/api-keys
 * @route PATCH /admin/api-keys/:id
 * @route DELETE /admin/api-keys/:id
 */
@Controller()
export class ApiKeysAdminController {
  constructor(private readonly keys: ApiKeyAdminService) {}

  /**
   * Lists every key of a merchant.
   *
   * @param params the merchant id
   * @returns the keys, newest first
   * @route GET /admin/clients/:id/api-keys
   */
  @Route(adminListClientApiKeys)
  list(@Param() params: ParamsOf<typeof adminListClientApiKeys>): Promise<ResultOf<typeof adminListClientApiKeys>> {
    return this.keys.list(params.id);
  }

  /**
   * Creates a key for a merchant and answers the full key once.
   *
   * @param staff the signed-in staff member
   * @param params the merchant id
   * @param body the name (optional, decision 078), allowed addresses, expiry and limit
   * @returns the key and its secret
   * @route POST /admin/clients/:id/api-keys
   */
  @Route(adminCreateClientApiKey)
  @Header('Cache-Control', 'no-store')
  create(
    @CurrentStaff() staff: StaffPrincipal,
    @Param() params: ParamsOf<typeof adminCreateClientApiKey>,
    @Body() body: BodyOf<typeof adminCreateClientApiKey>,
  ): Promise<ResultOf<typeof adminCreateClientApiKey>> {
    return this.keys.create(staff, params.id, body);
  }

  /**
   * Changes a key's name, per-minute limit, allowed addresses and expiry (decision 078).
   *
   * @param staff the signed-in staff member
   * @param params the key id
   * @param body the fields to change
   * @returns the key after the change
   * @route PATCH /admin/api-keys/:id
   */
  @Route(adminUpdateApiKey)
  update(
    @CurrentStaff() staff: StaffPrincipal,
    @Param() params: ParamsOf<typeof adminUpdateApiKey>,
    @Body() body: BodyOf<typeof adminUpdateApiKey>,
  ): Promise<ResultOf<typeof adminUpdateApiKey>> {
    return this.keys.update(staff, params.id, body);
  }

  /**
   * Revokes a key.
   *
   * @param params the key id
   * @returns nothing: the route answers 204
   * @route DELETE /admin/api-keys/:id
   */
  @Route(adminRevokeApiKey)
  revoke(@Param() params: ParamsOf<typeof adminRevokeApiKey>): Promise<void> {
    return this.keys.revoke(params.id);
  }
}
