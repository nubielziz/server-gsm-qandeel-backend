// WebhookDeliveryRetention: the daily deletion of merchant webhook deliveries older than 90 days (decision 053).
import { Inject, Injectable } from '@nestjs/common';
import { CLOCK, type Clock } from '../../../common/clock';
import { DbService } from '../../../infra/db';
import { deleteOldDeliveries } from './webhook-delivery.repository';
import { WEBHOOK_DELIVERY_RETENTION_DAYS } from './webhook-delivery.rules';

/** Rows deleted per statement. */
export const WEBHOOK_RETENTION_BATCH = 1000;
/** Statements per run: at most 100 000 rows; a larger backlog is finished by the next nights. */
export const WEBHOOK_RETENTION_MAX_BATCHES = 100;
const DAY_MS = 24 * 60 * 60_000;

/**
 * Deletes finished webhook deliveries older than 90 days.
 *
 * Why: decision 053. The delivery log (the merchant's and staff's) held every attempt result for ever; 90 days is far longer than the
 * retry ladder (about 21 hours) and than a merchant needs to investigate. A delivery that is still `pending` is never deleted. Batches
 * by id, so no run holds a long lock; a deleted row cannot be deleted twice, so a repeat or a parallel run only finds fewer rows.
 *
 * Side effects: deletes `webhook_deliveries` rows.
 */
@Injectable()
export class WebhookDeliveryRetention {
  constructor(
    private readonly db: DbService,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  /**
   * Runs the clean-up once.
   *
   * @returns how many deliveries were deleted
   */
  async run(): Promise<{ deleted: number }> {
    const before = new Date(this.clock.nowMs() - WEBHOOK_DELIVERY_RETENTION_DAYS * DAY_MS);
    let deleted = 0;
    for (let round = 0; round < WEBHOOK_RETENTION_MAX_BATCHES; round += 1) {
      const batch = await deleteOldDeliveries(this.db.db, before, WEBHOOK_RETENTION_BATCH);
      deleted += batch;
      if (batch < WEBHOOK_RETENTION_BATCH) break;
    }
    return { deleted };
  }
}
