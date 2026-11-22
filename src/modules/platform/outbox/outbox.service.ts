// OutboxService: the one way to write an outbox event (platform module, decision 020). It runs inside the caller's
// transaction, so the event exists if and only if the change that caused it was committed.
import { Inject, Injectable } from '@nestjs/common';
import { CLOCK, type Clock } from '../../../common/clock';
import { getRequestId } from '../../../common/request-id';
import type { DbExecutor } from '../../../infra/db';
import type { OutboxEvent } from '../db/schema';
import { assertOutboxEvent, packOutboxPayload } from './outbox-payload';
import { OutboxRouteRegistry } from './outbox-routes';
import { insertOutboxEvent, outboxBacklog, outboxEventExists, outboxEventsOf } from './outbox.repository';
import type { OutboxBacklog, OutboxEventInput, OutboxEventTrace, OutboxPayload } from './outbox.types';

/**
 * Writes outbox events and reports the backlog.
 *
 * Why: decision 020 keeps the API fast and consistent: a state change that needs async work (a supplier call, a webhook,
 * an email) writes an `outbox_events` row in the same database transaction, and the worker's relay turns the row into a
 * BullMQ job. No job is created for a rolled-back change, and no committed change loses its job.
 *
 * Side effects: `add` inserts one `outbox_events` row and sends `pg_notify('outbox', id)` on the caller's transaction (the
 * notification goes out at commit and wakes the relay); the stored payload carries `meta.requestId` of the current request.
 *
 * @see docs/decisions/020-outbox-and-queues.md and docs/queues.md
 */
@Injectable()
export class OutboxService {
  constructor(
    private readonly routes: OutboxRouteRegistry,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  /**
   * Writes an event in the caller's transaction.
   *
   * @param tx the transaction of the use case (pass `tx` from `runInTransaction`)
   * @param event type, aggregate and payload (ids only)
   * @returns the stored row
   * @throws {RangeError} when the event is malformed or its payload is not ids only (a programming error)
   * @throws {Error} when no module registered a queue for the event type (a programming error); either one rolls the
   *   transaction back, so a missing registration is found by the first test of the use case
   */
  async add(tx: DbExecutor, event: OutboxEventInput): Promise<OutboxEvent> {
    assertOutboxEvent(event);
    if (!this.routes.get(event.type)) {
      throw new Error(
        `No queue is registered for the outbox event type "${event.type}". Register it in your module with OutboxRouteRegistry.register() (onModuleInit).`,
      );
    }
    return insertOutboxEvent(
      tx,
      {
        type: event.type,
        aggregateType: event.aggregateType,
        aggregateId: event.aggregateId,
        payload: packOutboxPayload(event.payload, getRequestId()),
      },
      this.clock.now(),
    );
  }

  /**
   * Tells whether an event with the given ids was written before.
   * Why: a producer that can see the same occurrence more than once (the price change scan, which runs after every price change)
   * writes the event only when it is new; the consumer is idempotent as well, so this only saves rows and jobs.
   * @param db the database or a transaction
   * @param type the event type
   * @param aggregateType the aggregate of the event
   * @param aggregateId the id of the aggregate row
   * @param payload the ids the written row must contain (a subset of its payload)
   * @returns true when such a row exists, processed or not
   */
  hasEvent(
    db: DbExecutor,
    type: string,
    aggregateType: string,
    aggregateId: number,
    payload: OutboxPayload,
  ): Promise<boolean> {
    return outboxEventExists(db, type, aggregateType, aggregateId, payload);
  }

  /**
   * Lists the newest events of one type and aggregate with their relay time.
   *
   * Why: a sweep that asks for lost work again (decision 044) must know whether the relay still holds an event and which job ids
   * (`outbox-<id>`) to look for; other modules may not read `outbox_events`.
   *
   * @param db the database or a transaction
   * @param type the event type
   * @param aggregateType the aggregate of the events
   * @param aggregateId the id of the aggregate row
   * @param limit the most events returned (default 10)
   * @returns id, creation time, relay time and payload (without `meta`), newest first; writes nothing
   */
  recentEvents(
    db: DbExecutor,
    type: string,
    aggregateType: string,
    aggregateId: number,
    limit = 10,
  ): Promise<OutboxEventTrace[]> {
    return outboxEventsOf(db, type, aggregateType, aggregateId, limit);
  }

  /**
   * Reads how many events wait to be relayed and how long the oldest has waited.
   *
   * Why: the System health queue board shows the outbox backlog as the `outbox-relay` queue's waiting count and oldest age
   * (contract GET /admin/system/queues); other modules read it here because they may not touch `outbox_events`.
   *
   * @param db the database or a transaction
   * @returns the pending count and the age of the oldest pending event
   */
  backlog(db: DbExecutor): Promise<OutboxBacklog> {
    return outboxBacklog(db, this.clock.now());
  }
}
