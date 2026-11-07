// HTTP controller of the pricing actions (map domain B, stage 4): the group prices of a service, the bulk price change and the
// price resolver. Thin: the rules live in GroupPriceAdminService, BulkPriceAdminService and PricingResolveService.
import { Body, Controller, Param, Query } from '@nestjs/common';
import { type BodyOf, type ParamsOf, type QueryOf, type ResultOf, Route } from '../../../common/contract';
import { BulkPriceAdminService } from '../application/bulk-price-admin.service';
import { GroupPriceAdminService } from '../application/group-price-admin.service';
import { PricingResolveService } from '../application/pricing-resolve.service';
import {
  applyBulkPrice,
  previewBulkPrice,
  replaceServiceGroupPrices,
  resolvePrice,
} from '../contracts/pricing.contracts';

/**
 * The pricing action routes.
 *
 * Why: staff set a service's price per merchant group, change many base prices at once (preview, then apply) and ask the
 * server what a merchant would pay and why.
 *
 * @route PUT /admin/services/:id/group-prices
 * @route POST /admin/services/bulk-price/preview
 * @route POST /admin/services/bulk-price/apply
 * @route GET /admin/pricing/resolve
 */
@Controller()
export class PricingController {
  constructor(
    private readonly groupPrices: GroupPriceAdminService,
    private readonly bulk: BulkPriceAdminService,
    private readonly resolution: PricingResolveService,
  ) {}

  /**
   * Replaces the group prices of a service.
   *
   * @param params the service id
   * @param body the whole set of group prices
   * @returns the saved prices
   * @route PUT /admin/services/:id/group-prices
   */
  @Route(replaceServiceGroupPrices)
  replaceGroupPrices(
    @Param() params: ParamsOf<typeof replaceServiceGroupPrices>,
    @Body() body: BodyOf<typeof replaceServiceGroupPrices>,
  ): Promise<ResultOf<typeof replaceServiceGroupPrices>> {
    return this.groupPrices.replace(params.id, body.prices);
  }

  /**
   * Previews a bulk price change.
   *
   * @param body the scope and the change
   * @returns the lines and the number under the floor
   * @route POST /admin/services/bulk-price/preview
   */
  @Route(previewBulkPrice)
  preview(@Body() body: BodyOf<typeof previewBulkPrice>): Promise<ResultOf<typeof previewBulkPrice>> {
    return this.bulk.preview(body);
  }

  /**
   * Applies a bulk price change.
   *
   * @param body the scope and the change
   * @returns how many prices were saved and how many are under the floor
   * @route POST /admin/services/bulk-price/apply
   */
  @Route(applyBulkPrice)
  apply(@Body() body: BodyOf<typeof applyBulkPrice>): Promise<ResultOf<typeof applyBulkPrice>> {
    return this.bulk.apply(body);
  }

  /**
   * Resolves the price of a service for a merchant.
   *
   * @param query the service and merchant ids
   * @returns the resolution with its steps
   * @route GET /admin/pricing/resolve
   */
  @Route(resolvePrice)
  resolve(@Query() query: QueryOf<typeof resolvePrice>): Promise<ResultOf<typeof resolvePrice>> {
    return this.resolution.resolve(query.serviceId, query.clientId);
  }
}
