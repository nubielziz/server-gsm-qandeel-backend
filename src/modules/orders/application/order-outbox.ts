// OrderOutbox: writes the outbox rows of the order engine (ids only) and registers their queue routes. Loaded by the API (it
// writes) and by the worker (its relay only knows the routes registered in its own process).
import { Injectable, type OnModuleInit } from '@nestjs/common';
import type { DbExecutor } from '../../../infra/db';
import { OutboxRouteRegistry, OutboxService } from '../../platform';
import type { OrderStatus } from '../db/schema';

/**
 * The outbox event types of the order engine.
 *
 * Why: decision 020 and the lead's ownership rule for feature 5: `order.status_changed` goes to `merchant-webhooks` (feature 7b
 * builds the webhook fan-out) and `order.dispatch_requested` to `supplier-dispatch` (feature 6 builds the dispatch job). Feature
 * 5 only writes them and registers where they go; it adds no processor for either queue.
 */
export const ORDER_OUTBOX_EVENTS = {
  statusChanged: 'order.status_changed',
  dispatchRequested: 'order.dispatch_requested',
} as const;

/** What `order.status_changed` carries: ids and status words only. */
export interface StatusChangedPayload {
  readonly orderId: number;
  /** The merchant; `null` for a storefront order. */
  readonly clientId: number | null;
  readonly fromStatus: OrderStatus;
  readonly toStatus: OrderStatus;
}

/**
 * Writes order events to the transactional outbox.
 *
 * Why: a status change must reach the merchant's webhook and a new automatic order must reach the dispatch job exactly when the
 * change commits, never otherwise, so both are `outbox_events` rows written in the transition's own transaction. The payloads
 * are ids and status words: the consumers re-read everything else from Postgres, so no price, IMEI or name sits in Redis.
 *
 * Side effects: registers the two event types with their queues at boot; `statusChanged` and `dispatchRequested` insert one
 * `outbox_events` row each on the caller's transaction.
 *
 * @see docs/queues.md (outbox event types)
 */
@Injectable()
export class OrderOutbox implements OnModuleInit {
  constructor(
    private readonly outbox: OutboxService,
    private readonly routes: OutboxRouteRegistry,
  ) {}

  /** Registers `order.status_changed` and `order.dispatch_requested` with their queues. */
  onModuleInit(): void {
    this.routes.register({ type: ORDER_OUTBOX_EVENTS.statusChanged, queue: 'merchant-webhooks' });
    this.routes.register({ type: ORDER_OUTBOX_EVENTS.dispatchRequested, queue: 'supplier-dispatch' });
  }

  /**
   * Writes `order.status_changed`.
   *
   * @param tx the transition's transaction
   * @param payload the order, its merchant and the two statuses
   */
  async statusChanged(tx: DbExecutor, payload: StatusChangedPayload): Promise<void> {
    await this.outbox.add(tx, {
      type: ORDER_OUTBOX_EVENTS.statusChanged,
      aggregateType: 'orders',
      aggregateId: payload.orderId,
      payload: { ...payload },
    });
  }

  /**
   * Writes `order.dispatch_requested`.
   *
   * @param tx the transaction that made the order dispatchable
   * @param orderId the order the dispatch job must send
   */
  async dispatchRequested(tx: DbExecutor, orderId: number): Promise<void> {
    await this.outbox.add(tx, {
      type: ORDER_OUTBOX_EVENTS.dispatchRequested,
      aggregateType: 'orders',
      aggregateId: orderId,
      payload: { orderId },
    });
  }
}
