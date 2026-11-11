// NotificationRetention: the daily clean-up of the notification center's tables (feature 23, plan section 8.4, owner decision O6).
import { Inject, Injectable } from '@nestjs/common';
import { CLOCK, type Clock } from '../../../common/clock';
import { DbService } from '../../../infra/db';
import {
  INBOX_READ_RETENTION_DAYS_KEY,
  INBOX_RETENTION_DAYS_KEY,
  LOG_RETENTION_DAYS_KEY,
  NOTIFICATION_RETENTION,
} from '../settings/settings-registry';
import { SettingsReader } from '../settings/settings-reader';
import { deleteOldBatch, deleteReadBatch } from './inbox/inbox.repository';
import { deleteLogBatch } from './notification.repository';

/** Rows deleted per statement. */
export const RETENTION_BATCH = 1000;
/** Statements per table and run: at most 50 000 rows; a larger backlog is finished by the next nights. */
export const RETENTION_MAX_BATCHES = 50;
const DAY_MS = 24 * 60 * 60_000;

/** What one run deleted. */
export interface RetentionResult {
  /** Inbox items read longer ago than `notifications.inbox_read_retention_days`. */
  readonly inboxRead: number;
  /** Inbox items older than `notifications.inbox_retention_days`, read or not. */
  readonly inboxOld: number;
  /** Sent or failed log rows older than `notifications.log_retention_days`. */
  readonly log: number;
}

/**
 * Deletes old inbox items and old log rows.
 *
 * Why: O6: the inbox keeps read items 90 days and every item 365 days, the log keeps sent and failed rows 180 days (all three are
 * settings). Campaigns are kept for history and audit; after the log retention a campaign's `delivery` counters shrink while its stored
 * `planned` counters stay. The log's minimum of 30 days keeps the template list's "sent in the last 30 days" whole. Deletion is in
 * batches by id, so no run holds a long lock; a deleted row cannot be deleted twice, so a repeat or a parallel run only finds fewer rows.
 *
 * Side effects: deletes `notification_inbox` and `notifications` rows.
 */
@Injectable()
export class NotificationRetention {
  constructor(
    private readonly db: DbService,
    private readonly settings: SettingsReader,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  /**
   * Runs the clean-up once.
   *
   * @returns how many rows each table lost
   */
  async run(): Promise<RetentionResult> {
    const days = await this.settings.integers({
      [INBOX_READ_RETENTION_DAYS_KEY]: NOTIFICATION_RETENTION.inboxRead,
      [INBOX_RETENTION_DAYS_KEY]: NOTIFICATION_RETENTION.inbox,
      [LOG_RETENTION_DAYS_KEY]: NOTIFICATION_RETENTION.log,
    });
    const nowMs = this.clock.nowMs();
    const before = (key: keyof typeof days) => new Date(nowMs - days[key] * DAY_MS);
    const db = this.db.db;
    const inboxRead = await this.drain((limit) => deleteReadBatch(db, before(INBOX_READ_RETENTION_DAYS_KEY), limit));
    const inboxOld = await this.drain((limit) => deleteOldBatch(db, before(INBOX_RETENTION_DAYS_KEY), limit));
    const log = await this.drain((limit) => deleteLogBatch(db, before(LOG_RETENTION_DAYS_KEY), limit));
    return { inboxRead, inboxOld, log };
  }

  /** Runs a batch delete until a batch comes back short or the run's cap is reached. */
  private async drain(batch: (limit: number) => Promise<number>): Promise<number> {
    let total = 0;
    for (let round = 0; round < RETENTION_MAX_BATCHES; round += 1) {
      const deleted = await batch(RETENTION_BATCH);
      total += deleted;
      if (deleted < RETENTION_BATCH) break;
    }
    return total;
  }
}
