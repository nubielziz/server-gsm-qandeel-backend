// The routes and use cases of the orders module (stages 5 and 7): the admin order reads and actions, the bulk reply, the exports, the merchant
// portal's orders and the merchant's REST v1 and Dhru orders, plus the services other features call (placement, transitions). Separate from OrdersModule so a test app built without
// a database can leave it out.
import { Global, Module } from '@nestjs/common';
import { ApiOrdersService } from './application/api-orders.service';
import { BulkReplyService } from './application/bulk-reply.service';
import { ClientOrdersService } from './application/client-orders.service';
import { CustomerOrderPlacement } from './application/customer-placement';
import { DhruOrders } from './application/dhru-orders';
import { IdempotencyStore } from './application/idempotency-store';
import { OrderActionsService } from './application/order-actions.service';
import { OrderClientStats } from './application/order-client-stats';
import { OrderExportService } from './application/order-export.service';
import { OrderLedger } from './application/order-ledger';
import { OrderPlacement } from './application/order-placement';
import { OrderReadService } from './application/order-read.service';
import { OrderTransitions } from './application/order-transitions';
import { StorefrontOrderPortImpl } from './application/storefront-order-port';
import { ClientOrdersController } from './controllers/client-orders.controller';
import { DhruController } from './controllers/dhru.controller';
import { OrderActionsController } from './controllers/order-actions.controller';
import { OrdersController } from './controllers/orders.controller';
import { OrderCompletionModule } from './order-completion.module';
import { V1OrdersController } from './controllers/v1-orders.controller';
import { StorefrontMailsModule } from '../money';
import { StorefrontPolicies } from '../storefront';
import { OrdersOutboxModule } from './orders-outbox.module';

/**
 * Provides `/admin/orders*`, the merchant portal's `/client/dashboard` and `/client/orders*`, REST v1's `/v1/orders*` and the Dhru
 * endpoint `POST /api/index.php` (the order actions here; `accountinfo` and `imeiservicelist` are bound by money and catalog).
 *
 * Why: these use cases need the global database, audit, settings, crypto and clock providers, the merchant stats seam of identity and the
 * ledger writer of money, which a database-less test app does not have. It is global because the Dhru and REST v1 order paths (7a), the
 * dispatch and poll jobs (6) and the risk actions (18) place and move orders through `OrderPlacement` and `OrderTransitions`.
 */
@Global()
@Module({
  imports: [OrdersOutboxModule, OrderCompletionModule, StorefrontMailsModule],
  controllers: [OrdersController, OrderActionsController, ClientOrdersController, V1OrdersController, DhruController],
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
    ApiOrdersService,
    IdempotencyStore,
    DhruOrders,
    OrderExportService,
    OrderClientStats,
  ],
  exports: [OrderPlacement, CustomerOrderPlacement, OrderTransitions, OrderReadService],
})
export class OrdersAdminModule {}
