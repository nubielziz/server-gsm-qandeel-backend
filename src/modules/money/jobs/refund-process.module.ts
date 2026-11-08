// Nest module of the storefront refund job (money module). Import it in the worker process only (src/worker.module.ts).
import { Module } from '@nestjs/common';
import { B2cRefunds } from '../application/b2c-refunds';
import { GatewayCredentialsVault } from '../application/gateway-credentials';
import { LedgerPoster } from '../application/post-transaction';
import { RefundSettlement } from '../application/refund-settlement';
import { StorefrontOrderPorts } from '../application/storefront-ports';
import { MoneyOutboxModule } from '../money-outbox.module';
import { RefundProcessProcessor } from './refund-process.processor';
import { RefundSender } from './refund-sender';

/**
 * Provides the refund sender, its processor and the outbox route of `refund.process`.
 *
 * Why: the API never calls a gateway inside a staff request (decision 020); the worker does. The classes the job needs are plain
 * services, so the worker builds them here instead of loading the API's money module. The orders module's port is found through the
 * process-wide slot of {@link StorefrontOrderPorts}, filled when the orders engine module boots.
 */
@Module({
  imports: [MoneyOutboxModule],
  providers: [
    LedgerPoster,
    B2cRefunds,
    StorefrontOrderPorts,
    GatewayCredentialsVault,
    RefundSettlement,
    RefundSender,
    RefundProcessProcessor,
  ],
  exports: [RefundSender],
})
export class RefundProcessModule {}
