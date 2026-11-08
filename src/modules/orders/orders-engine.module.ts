// The order engine's transition services without any route: what the supplier jobs of the worker (and the suppliers module's use
// cases) need to move an order, built from plain providers so the worker can load it (it never loads the API's route modules).
import { Module } from '@nestjs/common';
import {
  B2cRefunds,
  LedgerPoster,
  MoneyOutboxModule,
  OrderSettlements,
  StorefrontMailsModule,
  StorefrontOrderPorts,
  WalletLowBalanceWatch,
} from '../money';
import { AuditService } from '../platform';
import { OrderLedger } from './application/order-ledger';
import { OrderSupplierMoves } from './application/order-supplier-moves';
import { StorefrontOrderPortImpl } from './application/storefront-order-port';
import { OrderTransitions } from './application/order-transitions';
import { StorefrontPolicies } from '../storefront';
import { OrderCompletionModule } from './order-completion.module';
import { OrdersOutboxModule } from './orders-outbox.module';

/**
 * Provides {@link OrderTransitions} and {@link OrderSupplierMoves} (and the ledger writer they need) without controllers.
 *
 * Why: decision 020 and the dispatch and poll jobs of feature 6: the worker moves orders (a supplier's result settles the order's
 * money) but must not load `OrdersAdminModule`, whose controllers need the API's guards. The ledger classes are stateless and take
 * the caller's transaction, so building them here costs nothing; the API process, which already has them through the global money
 * and orders modules, simply gets a second copy.
 */
@Module({
  imports: [OrdersOutboxModule, MoneyOutboxModule, OrderCompletionModule, StorefrontMailsModule],
  providers: [
    LedgerPoster,
    B2cRefunds,
    StorefrontOrderPorts,
    StorefrontOrderPortImpl,
    WalletLowBalanceWatch,
    OrderSettlements,
    AuditService,
    StorefrontPolicies,
    OrderLedger,
    OrderTransitions,
    OrderSupplierMoves,
  ],
  exports: [OrderTransitions, OrderSupplierMoves],
})
export class OrdersEngineModule {}
