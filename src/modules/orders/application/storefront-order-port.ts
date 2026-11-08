// StorefrontOrderPortImpl: what the orders module gives the money module for storefront refunds and disputes (feature 16): cancel an open
// order because its refund was approved, and add a line to an order's timeline. Registered with money's port slot at boot.
import { Injectable, type OnModuleInit } from '@nestjs/common';
import type { DbExecutor } from '../../../infra/db';
import { type PortActor, type PortTimelineLine, type StorefrontOrderPort, StorefrontOrderPorts } from '../../money';
import { insertEvents } from '../infra/order.repository';
import { OrderTransitions } from './order-transitions';

/**
 * The orders side of the storefront money seam.
 *
 * Why: decision 032: money cannot import orders, so it asks through a port. A refund of an open order is one state machine
 * transition (`refundApproved`: the order is rejected and its money posts through the refund), so the rules of decision 025 hold; the
 * timeline lines of refunds and disputes are written here because `order_events` is orders' table.
 *
 * Side effects: registers itself with `StorefrontOrderPorts` at boot; `cancelForRefund` applies a transition (updates `orders`, writes
 * ledger rows, timeline lines and an `order.status_changed` outbox row); `addTimeline` inserts one `order_events` row.
 */
@Injectable()
export class StorefrontOrderPortImpl implements StorefrontOrderPort, OnModuleInit {
  constructor(
    private readonly ports: StorefrontOrderPorts,
    private readonly transitions: OrderTransitions,
  ) {}

  /** Fills money's port slot. */
  onModuleInit(): void {
    this.ports.set(this);
  }

  /**
   * Cancels an open storefront order for an approved refund.
   *
   * @param tx the approval's transaction
   * @param input the order, who approved, the refund being paid out and the reason
   */
  async cancelForRefund(
    tx: DbExecutor,
    input: { orderId: number; actor: PortActor; refundId: number; reason: string },
  ): Promise<void> {
    await this.transitions.apply(tx, {
      orderId: input.orderId,
      action: { kind: 'refundApproved' },
      actor: { type: input.actor.type, id: input.actor.id },
      reason: input.reason,
      refundId: input.refundId,
    });
  }

  /**
   * Adds a refund or dispute line to the timeline.
   *
   * @param tx the caller's transaction
   * @param orderId the order
   * @param actor who caused it
   * @param line the line
   */
  async addTimeline(tx: DbExecutor, orderId: number, actor: PortActor, line: PortTimelineLine): Promise<void> {
    await insertEvents(tx, [
      {
        orderId,
        type: line.type,
        fromStatus: null,
        toStatus: null,
        actorType: actor.type,
        actorId: actor.id,
        data: { message: line.message, ...line.data },
      },
    ]);
  }
}
