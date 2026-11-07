// HTTP controller of the public order tracking (map domain D, stage 14). Thin: the rules live in OrderTrackingService.
import { Controller, Res } from '@nestjs/common';
import type { FastifyReply } from 'fastify';
import { type ResultOf, Route } from '../../../common/contract';
import { AppError } from '../../../common/errors';
import { CurrentPrincipal, type Principal } from '../../identity';
import { OrderTrackingService } from '../application/order-tracking.service';
import { trackStoreOrder } from '../contracts/order-tracking.contracts';

/**
 * The public order tracking route.
 *
 * Why: a storefront buyer follows an order by a link with a token and no account (map stage 14); the per-IP token limit and the
 * capability guard run before this.
 *
 * @route GET /store/v1/orders/:token
 */
@Controller()
export class OrderTrackingController {
  constructor(private readonly tracking: OrderTrackingService) {}

  /**
   * Reads the order a tracking token names.
   *
   * @param principal the holder of the tracking token
   * @param reply the reply, for the cache header
   * @returns the tracking view
   * @route GET /store/v1/orders/:token
   */
  @Route(trackStoreOrder)
  show(
    @CurrentPrincipal() principal: Principal | undefined,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<ResultOf<typeof trackStoreOrder>> {
    if (principal?.kind !== 'capability' || principal.access !== 'tracking-token') throw new AppError('NOT_FOUND');
    // The page changes while the order runs and its URL holds a credential: nothing keeps a copy.
    reply.header('cache-control', 'no-store');
    return this.tracking.show(principal.resourceId);
  }
}
