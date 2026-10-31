// Types of the transactional outbox (platform module, decision 020): what a use case writes and what a job receives.
import type { QueueName } from '../../../infra/queues';

/**
 * One value of an outbox payload: an id, a code, a flag or a short list of ids.
 *
 * Why: decision 020 and CLAUDE.md say jobs carry ids only (no secrets, no personal data, no money). The type states it and
 * `assertOutboxPayload` enforces it at run time: whole numbers only, strings up to 64 characters.
 */
export type OutboxPayloadValue = string | number | boolean | null | ReadonlyArray<string | number>;

/** The payload of an outbox event: a flat object of {@link OutboxPayloadValue}. */
export type OutboxPayload = { readonly [key: string]: OutboxPayloadValue };

/**
 * What a use case hands to `OutboxService.add`.
 *
 * Why: the use case that changes state writes the event in the same transaction; the aggregate says what changed, the
 * type says what happened, and the payload carries only what a consumer cannot get from the aggregate id.
 */
export interface OutboxEventInput {
  /** Dotted lower case name registered in the `OutboxRouteRegistry`, for example `order.status_changed`. */
  readonly type: string;
  /** The table-like name of the aggregate, for example `orders`, `invoices`, `checkout_sessions`. */
  readonly aggregateType: string;
  /** The id of the aggregate row. */
  readonly aggregateId: number;
  /** Ids and codes only; the consumer re-reads the rest from Postgres. */
  readonly payload?: OutboxPayload;
}

/**
 * The data of the BullMQ job the relay creates for an event.
 *
 * Why: processors of every queue receive events in this one shape; `requestId` joins the logs of the request that wrote
 * the event with the logs of the worker that handles it (decision 012).
 */
export interface OutboxJobData {
  /** `outbox_events.id`; the job id is `outbox-<eventId>`. */
  readonly eventId: number;
  readonly type: string;
  readonly aggregateType: string;
  readonly aggregateId: number;
  readonly payload: OutboxPayload;
  /** The request id of the request or job that wrote the event, else `outbox-<eventId>`. */
  readonly requestId: string;
}

/**
 * Where an event type goes.
 *
 * Why: a module that produces an event type registers the queue (and, if it wants, the job name) that handles it; the
 * relay reads this registry for every row. One event type maps to one queue; fan-out (webhook and notification for one
 * order change) is the consumer's job.
 */
export interface OutboxRoute {
  /** The event type, as passed to `OutboxService.add`. */
  readonly type: string;
  /** The queue that handles it. */
  readonly queue: QueueName;
  /** The BullMQ job name; the event type when omitted. A `@QueueProcessor(queue, jobName)` can select on it. */
  readonly jobName?: string;
}

/** How many events wait to be relayed, and for how long the oldest has waited. */
export interface OutboxBacklog {
  readonly pending: number;
  /** Seconds since the oldest pending event was written; 0 when nothing waits. */
  readonly oldestAgeSeconds: number;
}
