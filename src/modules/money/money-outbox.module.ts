// The outbox side of billing: the event type `invoice.paid` and its queue. Loaded by the API (it writes the rows) and by the worker
// (src/worker.module.ts: its relay only knows routes registered in its own process).
import { Module } from '@nestjs/common';
import { InvoiceOutbox } from './application/invoice-outbox';

/**
 * Provides {@link InvoiceOutbox}.
 *
 * Why: decision 020: an event type must be registered in a module the worker loads, or the relay cannot route its rows. The module
 * needs only the global outbox providers, so a test app built without a database still builds.
 */
@Module({ providers: [InvoiceOutbox], exports: [InvoiceOutbox] })
export class MoneyOutboxModule {}
