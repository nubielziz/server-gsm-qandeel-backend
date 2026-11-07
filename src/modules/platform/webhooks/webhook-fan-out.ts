// WebhookFanOut: turns one outbox event of a merchant into one delivery per subscribed endpoint and queues their first attempts
// (decision 020, ALIGNMENT § 7).
import { Inject, Injectable } from '@nestjs/common';
import { CLOCK, type Clock } from '../../../common/clock';
import { TokenService } from '../../../infra/crypto';
import { DbService } from '../../../infra/db';
import { UnrecoverableError } from '../../../infra/queues';
import type { OutboxJobData } from '../outbox/outbox.types';
import { EVENT_CONTRACTS, buildEventData } from './webhook-event-data';
import { buildEnvelope, eventIdOf, eventKeyOf, isWebhookEvent } from './webhook-delivery.rules';
import { insertDeliveryOnce, outboxEventTime, pendingDeliveriesOfEvent } from './webhook-delivery.repository';
import { activeEndpointsFor } from './webhook-endpoint.repository';
import { WebhookDeliveries } from './webhook-deliveries';

/** What one fan-out job did (kept briefly with the BullMQ job). */
export interface FanOutResult {
  /** Endpoints the event was meant for. */
  readonly endpoints: number;
  /** Deliveries created now (the others existed from an earlier run of the same job). */
  readonly created: number;
  /** Why nothing was sent. */
  readonly skipped?: 'unknown_event' | 'no_subscriber' | 'source_gone';
}

/**
 * Creates the deliveries of a merchant event.
 *
 * Why: decision 020: the outbox row of an event reaches the `merchant-webhooks` queue (feature 5 registers `order.status_changed`,
 * feature 8 `invoice.paid`, this feature `wallet.low_balance` and `service.price_changed`); this job reads which of the merchant's
 * endpoints are on and subscribed, builds the public `data` once, and inserts one `webhook_deliveries` row per endpoint, each with
 * the signed envelope as its payload. It fans out ANY event type that carries a `clientId` and has a contract; a type no endpoint
 * can subscribe to has no subscriber and is dropped. The job is safe to run twice: the unique `(endpoint_id, event_id)` makes
 * the second run insert nothing, and it still makes sure every pending delivery has its job (so a first run that failed after
 * the insert is completed by the retry).
 *
 * Side effects: reads `outbox_events`, `webhook_endpoints` and the foreign tables of `webhook-foreign-reads.ts`; inserts
 * `webhook_deliveries`; adds jobs to the `merchant-webhooks` queue.
 *
 * @see docs/queues.md (merchant-webhooks)
 */
@Injectable()
export class WebhookFanOut {
  constructor(
    private readonly db: DbService,
    private readonly tokens: TokenService,
    private readonly deliveries: WebhookDeliveries,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  /**
   * Handles one outbox event.
   *
   * @param job the outbox job (`type`, `aggregateId`, ids in `payload`; the merchant is `payload.clientId`)
   * @returns what was done
   * @throws {UnrecoverableError} when the event has no merchant, or the data built for it breaks its contract (a programming
   *   error: retrying cannot help)
   * @throws {Error} when Postgres or the queue Redis fails (the job is retried; the unique key makes that safe)
   */
  async run(job: OutboxJobData): Promise<FanOutResult> {
    if (!isWebhookEvent(job.type)) return { endpoints: 0, created: 0, skipped: 'unknown_event' };
    const clientId = job.payload['clientId'];
    if (typeof clientId !== 'number') {
      throw new UnrecoverableError(
        `The ${job.type} event ${job.eventId} carries no clientId, so no merchant can be found.`,
      );
    }

    const endpoints = await activeEndpointsFor(this.db.db, clientId, job.type);
    if (endpoints.length === 0) return { endpoints: 0, created: 0, skipped: 'no_subscriber' };

    const createdAt = (await outboxEventTime(this.db.db, job.eventId)) ?? this.clock.now();
    const built = await buildEventData(this.db.db, job, createdAt);
    if (!built || built.clientId !== clientId)
      return { endpoints: endpoints.length, created: 0, skipped: 'source_gone' };
    const parsed = EVENT_CONTRACTS[job.type].payload.safeParse(built.data);
    if (!parsed.success) {
      throw new UnrecoverableError(
        `The data built for ${job.type} (event ${job.eventId}) breaks its contract: ${parsed.error.message}`,
      );
    }

    const eventId = eventIdOf(this.tokens.hash(`webhook-event:${eventKeyOf(job.type, job.eventId, job.payload)}`));
    const payload = buildEnvelope(eventId, job.type, createdAt, built.data);
    const now = this.clock.now();
    const created = await this.db.runInTransaction(async ({ tx }) => {
      let count = 0;
      for (const endpoint of endpoints) {
        const row = await insertDeliveryOnce(tx, {
          endpointId: endpoint.id,
          event: job.type,
          eventId,
          payload: { ...payload },
          nextRetryAt: now,
        });
        if (row) count += 1;
      }
      return count;
    });
    // Also for deliveries an earlier run inserted: the job id makes a second add a no-op.
    await this.deliveries.ensureJobs(
      await pendingDeliveriesOfEvent(
        this.db.db,
        eventId,
        endpoints.map((endpoint) => endpoint.id),
      ),
    );
    return { endpoints: endpoints.length, created };
  }
}
