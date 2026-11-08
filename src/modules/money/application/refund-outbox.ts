// RefundOutbox: registers the outbox route of the storefront refund job (`refund.process`) and writes its rows (ids only). Loaded by the API (it writes) and by the worker (its relay only knows the routes registered in its own process).
import { Injectable, type OnModuleInit } from '@nestjs/common';
import type { DbExecutor } from '../../../infra/db';
import { OutboxRouteRegistry, OutboxService } from '../../platform';

/** The outbox event type that sends an approved refund to its gateway. */
export const REFUND_PROCESS_EVENT = 'refund.process';

/**
 * Writes the storefront refund event to the transactional outbox.
 *
 * Why: scenario b2c-refund step 6, decision 020: the API never calls a gateway inside a staff request's
 * transaction; the approval writes a row in the same commit and the worker's job does the call, with an
 * idempotency key so a retry never refunds twice. The payload is the record's id only.
 *
 * Side effects: registers the event type with the `maintenance` queue at boot; `refund` inserts one `outbox_events` row on the
 * caller's transaction.
 *
 * @see docs/queues.md (outbox event types)
 */
@Injectable()
export class RefundOutbox implements OnModuleInit {
  constructor(
    private readonly outbox: OutboxService,
    private readonly routes: OutboxRouteRegistry,
  ) {}

  /** Registers `refund.process`. */
  onModuleInit(): void {
    this.routes.register({ type: REFUND_PROCESS_EVENT, queue: 'maintenance' });
  }

  /**
   * Queues the gateway call of an approved refund.
   *
   * @param tx the approval's transaction
   * @param refundId the refund
   */
  async refund(tx: DbExecutor, refundId: number): Promise<void> {
    await this.outbox.add(tx, {
      type: REFUND_PROCESS_EVENT,
      aggregateType: 'refunds',
      aggregateId: refundId,
      payload: { refundId },
    });
  }
}
