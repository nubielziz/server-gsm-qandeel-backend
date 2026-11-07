// WebhookDeliveryAdminService: what staff do with the log of merchant webhooks (routes /admin/webhook-deliveries): read it and
// send a delivery again, audited.
import { Inject, Injectable } from '@nestjs/common';
import { CLOCK, type Clock } from '../../../common/clock';
import type { ParsedListQuery } from '../../../common/contract';
import { AppError } from '../../../common/errors';
import { DbService } from '../../../infra/db';
import { RateLimitService } from '../../../infra/rate-limit';
import { AuditService } from '../audit/audit.service';
import {
  type DeliverySortField,
  findDeliveryRow,
  listDeliveryRows,
  lockDelivery,
  requeueDelivery,
} from './webhook-delivery.repository';
import { WebhookDeliveries } from './webhook-deliveries';
import { adminDeliveryToWire } from './webhook-wire';

/**
 * Reads the webhook log and retries deliveries.
 *
 * Why: the console's Webhook deliveries tab (a tab the demo lacks) lists what was sent to merchants and lets staff resend a
 * delivery that failed (`GET /admin/webhook-deliveries`, `/:id`, `POST /:id/retry`). A retry is one more attempt of the same
 * payload: the row becomes `pending` with the attempt number one higher and a due time of now, and its job is added after the
 * commit; the worker signs it again with a fresh timestamp. One retry a minute per delivery (limiter `webhook-retry`).
 *
 * Side effects: `retry` updates `webhook_deliveries`, writes `audit_logs` (`retried webhook delivery of`, entity `merchant`), counts
 * a point on the `webhook-retry` limiter and adds a job to the `merchant-webhooks` queue after the commit.
 *
 * @see docs/contract/endpoints/platform.md (the webhook delivery routes)
 */
@Injectable()
export class WebhookDeliveryAdminService {
  constructor(
    private readonly db: DbService,
    private readonly audit: AuditService,
    private readonly deliveries: WebhookDeliveries,
    private readonly limits: RateLimitService,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  /**
   * Lists deliveries, newest first by default.
   *
   * @param query the parsed list request
   * @returns the page and the exact total for the filter
   */
  async list(query: ParsedListQuery<DeliverySortField>) {
    const { rows, total } = await listDeliveryRows(this.db.db, query);
    return { rows: rows.map(adminDeliveryToWire), total };
  }

  /**
   * Shows one delivery with its request and the merchant's answer.
   *
   * @param id the delivery id
   * @returns the delivery
   * @throws {AppError} `NOT_FOUND` (404)
   */
  async show(id: number) {
    const row = await findDeliveryRow(this.db.db, id);
    if (!row) throw new AppError('NOT_FOUND', { detail: 'No webhook delivery has this id.' });
    return adminDeliveryToWire(row);
  }

  /**
   * Queues one more attempt of a delivery.
   *
   * @param id the delivery id
   * @returns the delivery after the change: `pending`, one attempt further, due now
   * @throws {AppError} `NOT_FOUND` (404); `DELIVERY_SUCCEEDED` (409) for a delivery that already worked; `RATE_LIMITED` (429)
   *   for a second retry of the same delivery within a minute; `UNAVAILABLE` (503) when the queue cannot take the job (the row
   *   is already updated: retrying the request is safe, the attempt is queued again with the same job id)
   */
  async retry(id: number) {
    const row = await this.db.runInTransaction(async ({ tx }) => {
      const found = await lockDelivery(tx, id);
      if (!found) throw new AppError('NOT_FOUND', { detail: 'No webhook delivery has this id.' });
      if (found.status === 'delivered') {
        throw new AppError('DELIVERY_SUCCEEDED', {
          detail: 'This delivery already worked, so there is nothing to send again.',
        });
      }
      await this.limits.enforce('webhook-retry', String(id));
      const queued = await requeueDelivery(tx, id, this.clock.now());
      const joined = await findDeliveryRow(tx, id);
      if (!joined) throw new Error(`Webhook delivery ${id} vanished inside its own transaction.`);
      await this.audit.record(tx, {
        action: 'retried webhook delivery of',
        entityType: 'merchant',
        entityId: joined.client.id,
        entityLabel: joined.client.name,
        before: { deliveryId: id, status: found.status, attempt: found.attempt },
        after: { deliveryId: id, event: found.event, status: queued.status, attempt: queued.attempt },
      });
      return joined;
    });
    await this.deliveries.ensureJobs([row.delivery]);
    return adminDeliveryToWire(row);
  }
}
