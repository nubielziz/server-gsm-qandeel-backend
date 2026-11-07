// The routes and use cases of the orders module (stage 5): the admin order reads and actions, the bulk reply, the exports and the merchant
// portal's orders, plus the services other features call (placement, transitions). Separate from OrdersModule so a test app built without
// a database can leave it out.
import { Global, Module } from '@nestjs/common';
import { BulkReplyService } from './application/bulk-reply.service';
import { ClientOrdersService } from './application/client-orders.service';
import { OrderActionsService } from './application/order-actions.service';
import { OrderClientStats } from './application/order-client-stats';
import { OrderExportService } from './application/order-export.service';
import { OrderLedger } from './application/order-ledger';
import { OrderPlacement } from './application/order-placement';
import { OrderReadService } from './application/order-read.service';
import { OrderTransitions } from './application/order-transitions';
import { ClientOrdersController } from './controllers/client-orders.controller';
import { OrderActionsController } from './controllers/order-actions.controller';
import { OrdersController } from './controllers/orders.controller';
import { OrdersOutboxModule } from './orders-outbox.module';

/**
 * Provides `/admin/orders*` and the merchant portal's `/client/dashboard` and `/client/orders*`.
 *
 * Why: these use cases need the global database, audit, settings, crypto and clock providers, the merchant stats seam of identity and the
 * ledger writer of money, which a database-less test app does not have. It is global because the Dhru and REST v1 order paths (7a), the
 * dispatch and poll jobs (6) and the risk actions (18) place and move orders through `OrderPlacement` and `OrderTransitions`.
 */
@Global()
@Module({
  imports: [OrdersOutboxModule],
  controllers: [OrdersController, OrderActionsController, ClientOrdersController],
  providers: [
    OrderLedger,
    OrderTransitions,
    OrderPlacement,
    OrderReadService,
    OrderActionsService,
    BulkReplyService,
    ClientOrdersService,
    OrderExportService,
    OrderClientStats,
  ],
  exports: [OrderPlacement, OrderTransitions, OrderReadService],
})
export class OrdersAdminModule {}
