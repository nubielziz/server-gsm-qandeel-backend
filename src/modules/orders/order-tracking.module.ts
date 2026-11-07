// The route and use case of the public order tracking (stage 14), and the tracking token resolver. Separate from OrdersModule so a
// test app built without a database can leave it out.
import { Module } from '@nestjs/common';
import { OrderTrackingService } from './application/order-tracking.service';
import { TrackingTokenResolver } from './application/tracking-token.resolver';
import { OrderTrackingController } from './controllers/order-tracking.controller';

/**
 * Provides `GET /store/v1/orders/:token`.
 *
 * Why: the use case needs the global database and crypto providers and the identity guard's resolver registry, which a
 * database-less test app does not have.
 */
@Module({
  controllers: [OrderTrackingController],
  providers: [OrderTrackingService, TrackingTokenResolver],
})
export class OrderTrackingModule {}
