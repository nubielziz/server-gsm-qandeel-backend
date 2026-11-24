// The routes and use cases of the orders module (stages 5 and 7): the admin order reads and actions, the bulk reply, the exports, the merchant
// portal's orders and the merchant's Dhru orders, plus the services other features call (placement, transitions). Separate from OrdersModule so a test app built without
// a database can leave it out.
import { Global, Module } from '@nestjs/common';
import { BulkReplyService } from './application/bulk-reply.service';
import { ClientOrdersService } from './application/client-orders.service';
import { CustomerOrderPlacement } from './application/customer-placement';
import { DhruOrders } from './application/dhru-orders';
import { OrdersGuestClaimParticipant } from './application/guest-claim.participant';
import { IdempotencyStore } from './application/idempotency-store';
import { LiveOrdersGuard } from './application/live-orders-guard';
import { OrderActionsService } from './application/order-actions.service';
import { OrderClientStats } from './application/order-client-stats';
import { OrderExportService } from './application/order-export.service';
import { OrderLedger } from './application/order-ledger';
import { OrderPlacement } from './application/order-placement';
import { OrderReadService } from './application/order-read.service';
import { OrderTransitions } from './application/order-transitions';
import { ShopOrderReads } from './application/shop-orders';
import { StorefrontOrderPortImpl } from './application/storefront-order-port';
import { ClientOrdersController } from './controllers/client-orders.controller';
import { DhruController } from './controllers/dhru.controller';
import { OrderActionsController } from './controllers/order-actions.controller';
import { OrdersController } from './controllers/orders.controller';
import { StorefrontMailsModule } from '../money';
import { StorefrontPolicies } from '../storefront';
import { OrdersOutboxModule } from './orders-outbox.module';
import { ShopOrders } from './ports/shop-orders';

/**
 * Provides `/admin/orders*`, the merchant portal's `/client/dashboard` and `/client/orders*` and the Dhru
 * endpoint `POST /api/index.php` (the order actions here; `accountinfo` and `imeiservicelist` are bound by money and catalog).
 *
 * Why: these use cases need the global database, audit, settings, crypto and clock providers, the merchant stats seam of identity and the
 * ledger writer of money, which a database-less test app does not have. It is global because the Dhru order path (7a), the
 * dispatch and poll jobs (6) and the risk actions (18) place and move orders through `OrderPlacement` and `OrderTransitions`, and the
 * customers module reads a shopper's own orders through `ShopOrders` (bound to `ShopOrderReads`, decision 064).
 *
 * Side effects at boot (API process only), each once: `LiveOrdersGuard` registers `live_order` with money's `RankChangeGuards`,
 * `OrdersGuestClaimParticipant` registers `orders` with identity's `GuestClaimParticipants`, and `OrderClientStats` registers its source
 * with `ClientStatsDirectory` and the order figures with `AccountListSql`.
 */
@Global()
@Module({
  imports: [OrdersOutboxModule, StorefrontMailsModule],
  controllers: [OrdersController, OrderActionsController, ClientOrdersController, DhruController],
  providers: [
    StorefrontPolicies,
    OrderLedger,
    OrderTransitions,
    StorefrontOrderPortImpl,
    OrderPlacement,
    CustomerOrderPlacement,
    OrderReadService,
    OrderActionsService,
    BulkReplyService,
    ClientOrdersService,
    IdempotencyStore,
    DhruOrders,
    OrderExportService,
    OrderClientStats,
    LiveOrdersGuard,
    OrdersGuestClaimParticipant,
    ShopOrderReads,
    { provide: ShopOrders, useExisting: ShopOrderReads },
  ],
  exports: [OrderPlacement, CustomerOrderPlacement, OrderTransitions, OrderReadService, ShopOrders],
})
export class OrdersAdminModule {}
