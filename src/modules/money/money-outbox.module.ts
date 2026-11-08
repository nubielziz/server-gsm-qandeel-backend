// The outbox side of billing and storefront money: the event types `invoice.paid`, `refund.process` and `receipt.render`. Loaded by the API (it writes the rows) and by the worker
// (src/worker.module.ts: its relay only knows routes registered in its own process).
import { Module } from '@nestjs/common';
import { InvoiceOutbox } from './application/invoice-outbox';
import { ReceiptOutbox } from './application/receipt-outbox';
import { RefundOutbox } from './application/refund-outbox';

/**
 * Provides {@link InvoiceOutbox}, {@link RefundOutbox} and {@link ReceiptOutbox}.
 *
 * Why: decision 020: an event type must be registered in a module the worker loads, or the relay cannot route its rows. The module
 * needs only the global outbox providers, so a test app built without a database still builds.
 */
@Module({
  providers: [InvoiceOutbox, RefundOutbox, ReceiptOutbox],
  exports: [InvoiceOutbox, RefundOutbox, ReceiptOutbox],
})
export class MoneyOutboxModule {}
