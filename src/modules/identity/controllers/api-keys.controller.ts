// HTTP controllers of the API key routes (map domain A, stage 7): the merchant's own keys under /client/api-keys (B155) and the
// staff's view and revocation under /admin. Thin; the rules live in MerchantApiKeyService and ApiKeyAdminService.
import { Body, Controller, Header, Param, Query } from '@nestjs/common';
import { type BodyOf, type ParamsOf, type QueryOf, type ResultOf, Route } from '../../../common/contract';
import { ApiKeyAdminService } from '../application/api-key-admin.service';
import { MerchantApiKeyService } from '../application/merchant-api-key.service';
import {
  adminListClientApiKeys,
  adminRevokeApiKey,
  portalCreateApiKey,
  portalListApiKeys,
  portalRevokeApiKey,
  portalUpdateApiKey,
} from '../contracts/api-keys.contracts';
import { CurrentMerchant } from '../security/access-state';
import type { MerchantPrincipal } from '../security/principal';

/**
 * The merchant portal's API key routes.
 *
 * Why: B155. A merchant manages the keys its integration uses. The answer that carries the full key says
 * `Cache-Control: no-store`.
 *
 * @route GET /client/api-keys
 * @route POST /client/api-keys
 * @route PATCH /client/api-keys/:id
 * @route DELETE /client/api-keys/:id
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
    @CurrentMerchant() merchant: MerchantPrincipal,
    @Query() query: QueryOf<typeof portalListApiKeys>,
  ): Promise<ResultOf<typeof portalListApiKeys>> {
    return this.keys.list(merchant, { offset: query.range.start, limit: query.range.limit, sort: query.sort });
  }

  /**
   * Creates a key and answers the full key once.
   *
   * @param merchant the signed-in merchant
   * @param body the name, scopes, allowed addresses and expiry
   * @returns the key and its secret
   * @route POST /client/api-keys
   */
  @Route(portalCreateApiKey)
  @Header('Cache-Control', 'no-store')
  create(
    @CurrentMerchant() merchant: MerchantPrincipal,
    @Body() body: BodyOf<typeof portalCreateApiKey>,
  ): Promise<ResultOf<typeof portalCreateApiKey>> {
    return this.keys.create(merchant, body);
  }

  /**
   * Renames a key or changes its allowed addresses.
   *
   * @param merchant the signed-in merchant
   * @param params the key id
   * @param body the fields to change
   * @returns the key after the change
   * @route PATCH /client/api-keys/:id
   */
  @Route(portalUpdateApiKey)
  update(
    @CurrentMerchant() merchant: MerchantPrincipal,
    @Param() params: ParamsOf<typeof portalUpdateApiKey>,
    @Body() body: BodyOf<typeof portalUpdateApiKey>,
  ): Promise<ResultOf<typeof portalUpdateApiKey>> {
    return this.keys.update(merchant, params.id, body);
  }

  /**
   * Revokes a key.
   *
   * @param merchant the signed-in merchant
   * @param params the key id
   * @returns nothing: the route answers 204
   * @route DELETE /client/api-keys/:id
   */
  @Route(portalRevokeApiKey)
  revoke(
    @CurrentMerchant() merchant: MerchantPrincipal,
    @Param() params: ParamsOf<typeof portalRevokeApiKey>,
  ): Promise<void> {
    return this.keys.revoke(merchant, params.id);
  }
}

/**
 * The admin API key routes.
 *
 * Why: the merchants tab of the console reads a merchant's keys and revokes one (MISMATCHES B31, M45).
 *
 * @route GET /admin/clients/:id/api-keys
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
