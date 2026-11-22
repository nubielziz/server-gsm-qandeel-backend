// OutboxPurge: deletes outbox rows handed to their queues long ago (platform module, decision 055).
import { Inject, Injectable } from '@nestjs/common';
import { CLOCK, type Clock } from '../../../common/clock';
import { DbService } from '../../../infra/db';
import { purgeRelayedOutboxEvents } from './outbox.repository';

/**
 * How long a relayed outbox row is kept, in days.
 *
 * Why: decision 055: longer than every reader of relayed rows looks back (the price change scan's window is 30 days, the notification
 * reconcile reads 48 hours, the dispatch sweep and the lost-work reconcile hours); a unit test pins "retention > scan window". Pending
 * rows are never purged, so the health view of the backlog is not touched either.
 */
export const OUTBOX_RETENTION_DAYS = 45;
/** Rows one delete statement removes at most (short statements, short locks). */
export const OUTBOX_PURGE_BATCH = 5_000;
/** Delete statements one run makes at most; the rest waits for the next day. */
export const OUTBOX_PURGE_MAX_BATCHES = 20;

const DAY_MS = 86_400_000;

/**
 * Purges relayed outbox rows older than the retention.
 *
 * Why: decision 055: `outbox_events` grew without end; a row whose job was handed over is history after a few days.
 *
 * Side effects: deletes `outbox_events` rows whose `processed_at` is more than 45 days before the clock's time, in batches.
 */
@Injectable()
export class OutboxPurge {
  constructor(
    private readonly db: DbService,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  /**
   * Runs one purge.
   *
   * @returns how many rows were deleted and in how many statements
   */
  async run(): Promise<{ deleted: number; batches: number }> {
    const before = new Date(this.clock.nowMs() - OUTBOX_RETENTION_DAYS * DAY_MS);
    let deleted = 0;
    let batches = 0;
    while (batches < OUTBOX_PURGE_MAX_BATCHES) {
      const removed = await purgeRelayedOutboxEvents(this.db.db, before, OUTBOX_PURGE_BATCH);
      batches += 1;
      deleted += removed;
      if (removed < OUTBOX_PURGE_BATCH) break;
    }
    return { deleted, batches };
  }
}
