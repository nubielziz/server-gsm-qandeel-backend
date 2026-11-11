// The outbox side of billing and storefront money: the event types `invoice.paid`, `refund.process` and `receipt.render`, and the customer
// wallet notification events (feature 21). Loaded by the API (it writes the rows) and by the worker (src/worker.module.ts: its relay and
// its notification delivery only know what is registered in their own process).
import { Module } from '@nestjs/common';
import { CustomerWalletEventRegistration } from './application/customer-wallet-event-registration';
import { InvoiceOutbox } from './application/invoice-outbox';
import { ReceiptOutbox } from './application/receipt-outbox';
import { RefundOutbox } from './application/refund-outbox';

/**
 * Provides {@link InvoiceOutbox}, {@link RefundOutbox} and {@link ReceiptOutbox}, and registers the customer wallet events
 * ({@link CustomerWalletEventRegistration}).
 *
 * Why: decision 020: an event type must be registered in a module the worker loads, or the relay cannot route its rows. The module
 * needs only the global outbox providers, so a test app built without a database still builds.
 */
@Module({
  providers: [InvoiceOutbox, RefundOutbox, ReceiptOutbox, CustomerWalletEventRegistration],
  exports: [InvoiceOutbox, RefundOutbox, ReceiptOutbox],
})
export class MoneyOutboxModule {}
