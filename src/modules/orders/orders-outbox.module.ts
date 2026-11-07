// The outbox side of the order engine: the event types `order.status_changed` and `order.dispatch_requested` and the queues they go to.
// Loaded by the API (it writes the rows) and by the worker (src/worker.module.ts: its relay only knows routes registered in its own process).
import { Module } from '@nestjs/common';
import { OrderOutbox } from './application/order-outbox';

/**
 * Provides {@link OrderOutbox}.
 *
 * Why: decision 020: an event type must be registered in a module the worker loads, or the relay cannot route its rows. The module
 * needs only the global outbox providers and no database or Redis of its own, so a test app built without the infrastructure still
 * builds. Feature 5 adds no processor for the two queues: 7b builds the webhook fan-out, 6 the dispatch job.
 */
@Module({ providers: [OrderOutbox], exports: [OrderOutbox] })
export class OrdersOutboxModule {}
