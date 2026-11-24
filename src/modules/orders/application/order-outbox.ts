// OrderOutbox: writes the outbox rows of the order engine (ids only) and registers their queue routes. Loaded by the API (it
// writes) and by the worker (its relay only knows the routes registered in its own process).
import { Injectable, type OnModuleInit } from '@nestjs/common';
import type { DbExecutor } from '../../../infra/db';
import { OutboxRouteRegistry, OutboxService } from '../../platform';
import type { OrderSource, OrderStatus } from '../db/schema';

/**
 * The outbox event types of the order engine.
 *
 * Why: decision 020 and the lead's ownership rule for feature 5: `order.status_changed` goes to the `notifications` queue (the
 * platform's `NotificationRoutes` registers that route) and `order.dispatch_requested` to `supplier-dispatch` (feature 6 builds the
 * dispatch job). Feature 5 only writes them and registers where `order.dispatch_requested` goes; it adds no processor for either queue.
 */
export const ORDER_OUTBOX_EVENTS = {
  statusChanged: 'order.status_changed',
  dispatchRequested: 'order.dispatch_requested',
} as const;

/**
 * What `order.status_changed` carries: ids and status words only.
 *
 * Why: decision 064: the buyer is always an account, and the door (`source`) says whose notices apply: a merchant's notice goes only for an
 * order held from a wallet (any door but `store`), never for a shop order, whatever rank its account has today.
 */
export interface StatusChangedPayload {
  readonly orderId: number;
  /** The buyer account of the order. */
  readonly accountId: number;
  /** The door the order came through (`store` is paid first through the shop). */
  readonly source: OrderSource;
  readonly fromStatus: OrderStatus;
  readonly toStatus: OrderStatus;
}

/**
 * Writes order events to the transactional outbox.
 *
 * Why: a status change must reach the merchant's notifications and a new automatic order must reach the dispatch job exactly when the
 * change commits, never otherwise, so both are `outbox_events` rows written in the transition's own transaction. The payloads
 * are ids and status words: the consumers re-read everything else from Postgres, so no price, IMEI or name sits in Redis.
 *
 * Side effects: registers `order.dispatch_requested` with its queue at boot; `statusChanged` and `dispatchRequested` insert one
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

  /** Registers `order.dispatch_requested` with its queue (`order.status_changed` is routed by the notifications module). */
  onModuleInit(): void {
    this.routes.register({ type: ORDER_OUTBOX_EVENTS.dispatchRequested, queue: 'supplier-dispatch' });
  }

  /**
   * Writes `order.status_changed`.
   *
   * @param tx the transition's transaction
   * @param payload the order, its buyer account and door, and the two statuses
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
