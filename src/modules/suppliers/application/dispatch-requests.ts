// DispatchRequests: tells whether the dispatch request of an order is still on its way (suppliers module, decision 044).
import { Injectable } from '@nestjs/common';
import type { DbExecutor } from '../../../infra/db';
import { QueuesService, queueJobId } from '../../../infra/queues';
import { ORDER_OUTBOX_EVENTS } from '../../orders';
import { OutboxService } from '../../platform';

/** Whether an order has a dispatch request on its way: `live`, `none`, or `unknown` when the queue Redis could not be read. */
export type DispatchRequestState = 'live' | 'none' | 'unknown';

/** What {@link DispatchRequests.inspect} found. */
export interface DispatchRequestInfo {
  readonly state: DispatchRequestState;
  /** When the newest dispatch request of the order was written; `null` when it has none. */
  readonly lastRequestedAt: Date | null;
}

/** How many of an order's newest dispatch requests are looked at. */
export const RECENT_DISPATCH_REQUESTS = 10;

/** The job states in which a dispatch job will still run (or is running): the request is on its way. */
const LIVE_JOB_STATES: ReadonlySet<string> = new Set([
  'waiting',
  'active',
  'delayed',
  'prioritized',
  'waiting-children',
]);

/**
 * Tells whether the dispatch request of an order is still on its way.
 *
 * Why: decision 044 and docs/queues.md: the relay's job id is `outbox-<event id>`, so a request is live while the relay has not handed
 * it over, or its job waits, is delayed or runs. The dispatch sweep asks again only for an order with no live request; staff "send
 * again" leaves an order with a live request alone. The same rule as `notification_reconcile`.
 *
 * Side effects: reads `outbox_events` through the platform and the job states on the queue Redis; writes nothing.
 */
@Injectable()
export class DispatchRequests {
  constructor(
    private readonly outbox: OutboxService,
    private readonly queues: QueuesService,
  ) {}

  /**
   * Looks at the newest dispatch requests of an order.
   *
   * @param db the database or a transaction
   * @param orderId the order
   * @returns the state and when the newest request was written. `live`: a request is not relayed yet or its job is waiting, active,
   *   delayed, prioritized or waiting for children; `none`: no request is live; `unknown`: the queue Redis did not answer
   */
  async inspect(db: DbExecutor, orderId: number): Promise<DispatchRequestInfo> {
    const events = await this.outbox.recentEvents(
      db,
      ORDER_OUTBOX_EVENTS.dispatchRequested,
      'orders',
      orderId,
      RECENT_DISPATCH_REQUESTS,
    );
    const lastRequestedAt = events[0]?.createdAt ?? null;
    if (events.some((event) => event.processedAt === null)) return { state: 'live', lastRequestedAt };
    try {
      for (const event of events) {
        const state = await this.queues.queue('supplier-dispatch').getJobState(queueJobId('outbox', event.id));
        if (LIVE_JOB_STATES.has(state)) return { state: 'live', lastRequestedAt };
      }
    } catch {
      return { state: 'unknown', lastRequestedAt };
    }
    return { state: 'none', lastRequestedAt };
  }
}
