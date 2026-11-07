// Orders module (map domain D): the order engine for B2B and B2C: orders and order events, placement and the balance hold, the status state
// machine (decision 025), the staff and merchant order actions, bulk reply and exports (docs/ARCHITECTURE.md § 2).
import { Module } from '@nestjs/common';
import { OrdersAdminModule } from './orders-admin.module';
import { OrdersOutboxModule } from './orders-outbox.module';

/**
 * Nest module for Orders (map domain D).
 *
 * Why: one module per map domain, each owning its tables and exposing a public service through `index.ts` (decision 016). The outbox
 * routes (`OrdersOutboxModule`, also loaded by the worker) and the routes with their use cases (`OrdersAdminModule`) are separate so a
 * test app built without a database or the infrastructure can leave out what needs them.
 */
@Module({ imports: [OrdersOutboxModule, OrdersAdminModule] })
export class OrdersModule {}
