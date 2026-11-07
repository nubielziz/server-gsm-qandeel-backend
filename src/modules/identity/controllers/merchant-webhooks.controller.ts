// HTTP controller of the merchant portal's webhook routes (map domain G, stage 7, MISMATCHES B156): /client/webhooks. It lives in the identity
// module because it needs identity's `CurrentMerchant` and the platform module imports no other module (decision 032); the rules are
// the platform's `MerchantWebhookService`.
import { Body, Controller, Header, Param, Query } from '@nestjs/common';
import { type BodyOf, type ParamsOf, type QueryOf, type ResultOf, Route } from '../../../common/contract';
import {
  MerchantWebhookService,
  portalCreateWebhook,
  portalDeleteWebhook,
  portalListWebhookDeliveries,
  portalListWebhooks,
  portalTestWebhook,
  portalUpdateWebhook,
} from '../../platform';
import { CurrentMerchant } from '../security/access-state';
import type { MerchantPrincipal } from '../security/principal';

/**
 * The merchant portal's webhook routes.
 *
 * Why: B156. A merchant registers where its events go and checks that the receiver works. The answer that carries the signing
 * secret says `Cache-Control: no-store`.
 *
 * @route GET /client/webhooks
 * @route POST /client/webhooks
 * @route PATCH /client/webhooks/:id
 * @route DELETE /client/webhooks/:id
 * @route POST /client/webhooks/:id/test
 * @route GET /client/webhooks/:id/deliveries
 */
@Controller()
export class MerchantWebhooksController {
  constructor(private readonly webhooks: MerchantWebhookService) {}

  /**
   * Lists the merchant's endpoints.
   *
   * @param merchant the signed-in merchant
   * @param query the parsed range and sort
   * @returns the rows and the exact total
   * @route GET /client/webhooks
   */
  @Route(portalListWebhooks)
  list(
    @CurrentMerchant() merchant: MerchantPrincipal,
    @Query() query: QueryOf<typeof portalListWebhooks>,
  ): Promise<ResultOf<typeof portalListWebhooks>> {
    return this.webhooks.list(merchant, { offset: query.range.start, limit: query.range.limit, sort: query.sort });
  }

  /**
   * Creates an endpoint and answers its signing secret once.
   *
   * @param merchant the signed-in merchant
   * @param body the address, the events and the switch
   * @returns the endpoint and its secret
   * @route POST /client/webhooks
   */
  @Route(portalCreateWebhook)
  @Header('Cache-Control', 'no-store')
  create(
    @CurrentMerchant() merchant: MerchantPrincipal,
    @Body() body: BodyOf<typeof portalCreateWebhook>,
  ): Promise<ResultOf<typeof portalCreateWebhook>> {
    return this.webhooks.create(merchant, body);
  }

  /**
   * Changes or pauses an endpoint.
   *
   * @param merchant the signed-in merchant
   * @param params the endpoint id
   * @param body the fields to change
   * @returns the endpoint after the change
   * @route PATCH /client/webhooks/:id
   */
  @Route(portalUpdateWebhook)
  update(
    @CurrentMerchant() merchant: MerchantPrincipal,
    @Param() params: ParamsOf<typeof portalUpdateWebhook>,
    @Body() body: BodyOf<typeof portalUpdateWebhook>,
  ): Promise<ResultOf<typeof portalUpdateWebhook>> {
    return this.webhooks.update(merchant, params.id, body);
  }

  /**
   * Deletes an endpoint.
   *
   * @param merchant the signed-in merchant
   * @param params the endpoint id
   * @returns nothing: the route answers 204
   * @route DELETE /client/webhooks/:id
   */
  @Route(portalDeleteWebhook)
  remove(
    @CurrentMerchant() merchant: MerchantPrincipal,
    @Param() params: ParamsOf<typeof portalDeleteWebhook>,
  ): Promise<void> {
    return this.webhooks.remove(merchant, params.id);
  }

  /**
   * Queues a test delivery.
   *
   * @param merchant the signed-in merchant
   * @param params the endpoint id
   * @returns the id of the queued delivery
   * @route POST /client/webhooks/:id/test
   */
  @Route(portalTestWebhook)
  test(
    @CurrentMerchant() merchant: MerchantPrincipal,
    @Param() params: ParamsOf<typeof portalTestWebhook>,
  ): Promise<ResultOf<typeof portalTestWebhook>> {
    return this.webhooks.test(merchant, params.id);
  }

  /**
   * Lists the deliveries of an endpoint.
   *
   * @param merchant the signed-in merchant
   * @param params the endpoint id
   * @param query the parsed range and sort
   * @returns the rows and the exact total
   * @route GET /client/webhooks/:id/deliveries
   */
  @Route(portalListWebhookDeliveries)
  deliveries(
    @CurrentMerchant() merchant: MerchantPrincipal,
    @Param() params: ParamsOf<typeof portalListWebhookDeliveries>,
    @Query() query: QueryOf<typeof portalListWebhookDeliveries>,
  ): Promise<ResultOf<typeof portalListWebhookDeliveries>> {
    return this.webhooks.deliveriesOf(merchant, params.id, {
      offset: query.range.start,
      limit: query.range.limit,
      sort: query.sort,
    });
  }
}
