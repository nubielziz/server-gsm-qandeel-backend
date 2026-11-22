// OutboxRequests: tells whether the outbox request of a row is still on its way, for any event type (platform module, decision 055).
import { Injectable } from '@nestjs/common';
import type { DbExecutor } from '../../../infra/db';
import { QueuesService, queueJobId } from '../../../infra/queues';
import { OutboxRouteRegistry } from '../outbox/outbox-routes';
import { OutboxService } from '../outbox/outbox.service';
import type { OutboxPayload } from '../outbox/outbox.types';
import type { OutboxRequestState } from './lost-work-rules';

/** How many of a row's newest requests are looked at. */
const RECENT_REQUESTS = 10;

/**
 * The job states in which a job will still run (or is running): the request is on its way.
 *
 * Why: decision 044 and 055: `waiting`, `active`, `delayed`, `prioritized` and `waiting-children`; `completed`, `failed` and
 * BullMQ's `unknown` (no such job) are not.
 */
export const LIVE_JOB_STATES: ReadonlySet<string> = new Set([
  'waiting',
  'active',
  'delayed',
  'prioritized',
  'waiting-children',
]);

/** What {@link OutboxRequests.inspect} found. */
export interface OutboxRequestInfo {
  readonly state: OutboxRequestState;
  /** When the newest request was written; `null` when the row has none. */
  readonly newestAt: Date | null;
  /** How many of the newest requests were written by the reconcile (`reconcile: true`). */
  readonly reconcileRequests: number;
  /** The payload of the newest request (without `meta`), or `null`. */
  readonly newestPayload: OutboxPayload | null;
}

/**
 * Reads the outbox requests of a row and the states of their jobs.
 *
 * Why: decision 055 applies the rule of `DispatchRequests` (decision 044) to any event type: a request is live while the relay has not
 * handed it over, or while its job `outbox-<id>` waits, runs or is delayed on one of the type's queues. A type no route names in this
 * process, or a queue Redis that does not answer, is `unknown`, so nothing is asked for again on a guess.
 *
 * Side effects: reads `outbox_events` and the job states on the queue Redis; writes nothing.
 */
@Injectable()
export class OutboxRequests {
  constructor(
    private readonly outbox: OutboxService,
    private readonly routes: OutboxRouteRegistry,
    private readonly queues: QueuesService,
  ) {}

  /**
   * Looks at the newest requests of a row.
   *
   * @param db the database or a transaction (a pass re-checks under its row lock with the transaction)
   * @param type the event type of the requests
   * @param aggregateType the aggregate of the requests
   * @param aggregateId the row
   * @returns the state, the time and payload of the newest request, and how many requests the reconcile wrote
   */
  async inspect(db: DbExecutor, type: string, aggregateType: string, aggregateId: number): Promise<OutboxRequestInfo> {
    const events = await this.outbox.recentEvents(db, type, aggregateType, aggregateId, RECENT_REQUESTS);
    const newest = events[0];
    const facts = {
      newestAt: newest?.createdAt ?? null,
      newestPayload: newest?.payload ?? null,
      reconcileRequests: events.filter((event) => event.payload.reconcile === true).length,
    };
    if (events.some((event) => event.processedAt === null)) return { state: 'live', ...facts };
    const queues = this.routes.routesOf(type).map((route) => route.queue);
    // Without a route this process cannot know where the jobs are: never "none" on a guess.
    if (queues.length === 0) return { state: 'unknown', ...facts };
    try {
      for (const event of events) {
        for (const queue of queues) {
          const state = await this.queues.queue(queue).getJobState(queueJobId('outbox', event.id));
          if (LIVE_JOB_STATES.has(state)) return { state: 'live', ...facts };
        }
      }
    } catch {
      return { state: 'unknown', ...facts };
    }
    return { state: 'none', ...facts };
  }
}
