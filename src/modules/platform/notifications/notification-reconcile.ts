// NotificationReconcile: finds queued notification rows whose send job was lost and adds the job again (feature 23, plan section 8.4).
import { Inject, Injectable, Logger } from '@nestjs/common';
import { CLOCK, type Clock } from '../../../common/clock';
import { DbService } from '../../../infra/db';
import { QueuesService, queueJobId } from '../../../infra/queues';
import { BROADCAST_QUEUE, BROADCAST_SEND_JOB } from './campaigns/broadcast-send.processor';
import { NOTIFICATION_SEND_JOB } from './event-notifier';
import {
  type ReconcileCutoffs,
  type StaleRow,
  expireQueuedRows,
  reconcileHasWork,
  staleCampaignRows,
  staleDigestRows,
  staleEventRows,
} from './notification.repository';

/** A campaign row is stale after this long without an update (the fan-out added its job minutes ago at most). */
export const CAMPAIGN_ROW_STALE_MS = 15 * 60_000;
/** An event row is stale after this long (a retrying job updates the row at every attempt, 30 s apart). */
export const EVENT_ROW_STALE_MS = 30 * 60_000;
/** A digest is re-sent once its period ended this long ago. */
export const DIGEST_GRACE_MS = 30 * 60_000;
/** A queued row older than this is given up. */
export const EXPIRE_AFTER_MS = 48 * 60 * 60_000;
/** At most this many rows per rule and run; the rest wait for the next run. */
export const RECONCILE_BATCH = 1000;
/** The reason written on a row that waited too long. */
export const EXPIRED_REASON = 'The message was not sent in time.';

/** What one run did. */
export interface ReconcileResult {
  /** Campaign rows whose job was added again. */
  readonly campaignRows: number;
  /** Event rows whose job was missing or finished and was added again. */
  readonly eventRows: number;
  /** Digest rows whose job was added again. */
  readonly digests: number;
  /** Rows failed for being too old. */
  readonly expired: number;
}

/**
 * Re-adds the lost jobs of queued notifications.
 *
 * Why: a message is a `queued` row plus a job (the relay's `outbox-<event id>`, the fan-out's `notification-<row id>`, a digest's delayed
 * job). When the queue Redis is lost the row stays `queued` for ever and the log shows a message that never leaves. Every re-add is a no-op while the original job exists (the job id is deterministic) and the delivery
 * guards the row, so a repeat or a parallel run cannot send twice. Rows made by `sendNow` hold a secret link, have no outbox event and
 * are never re-sent: a generic job has no secret. Expiry runs first, so a row that old is ended instead of sent.
 *
 * Side effects: updates `notifications` (expiry); adds `notification.send` jobs to `notifications` and `notification-broadcasts`.
 */
@Injectable()
export class NotificationReconcile {
  private readonly logger = new Logger(NotificationReconcile.name);

  constructor(
    private readonly db: DbService,
    private readonly queues: QueuesService,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  private cutoffs(now: Date): ReconcileCutoffs {
    const ms = now.getTime();
    return {
      campaign: new Date(ms - CAMPAIGN_ROW_STALE_MS),
      event: new Date(ms - EVENT_ROW_STALE_MS),
      digest: new Date(ms - DIGEST_GRACE_MS),
      expired: new Date(ms - EXPIRE_AFTER_MS),
    };
  }

  /**
   * Tells whether a run would find a stale row, cheaply.
   *
   * @returns true when some queued row is stale
   */
  hasWork(): Promise<boolean> {
    return reconcileHasWork(this.db.db, this.cutoffs(this.clock.now()));
  }

  /**
   * Runs the four rules once.
   *
   * @returns how many rows each rule touched
   * @throws {AppError} `UNAVAILABLE` when the queue Redis is down (the next run tries again)
   */
  async run(): Promise<ReconcileResult> {
    const now = this.clock.now();
    const cutoffs = this.cutoffs(now);
    const db = this.db.db;

    const expired = await expireQueuedRows(db, cutoffs.expired, EXPIRED_REASON, now, RECONCILE_BATCH);

    const campaignRows = await staleCampaignRows(db, cutoffs.campaign, RECONCILE_BATCH);
    await this.queues.addBulk(
      BROADCAST_QUEUE,
      campaignRows.map((row) => ({
        jobName: BROADCAST_SEND_JOB,
        data: { notificationId: row.id, channel: row.channel },
        options: { jobId: queueJobId('notification', row.id) },
      })),
    );

    const events = await staleEventRows(db, cutoffs.event, RECONCILE_BATCH);
    let eventRows = 0;
    for (const row of events) if (await this.readd(row)) eventRows += 1;

    const digestRows = await staleDigestRows(db, cutoffs.digest, RECONCILE_BATCH);
    await this.queues.addBulk(
      'notifications',
      digestRows.map((row) => ({
        jobName: NOTIFICATION_SEND_JOB,
        data: { notificationId: row.id },
        options: { jobId: queueJobId('notification', row.id) },
      })),
    );

    const result = { campaignRows: campaignRows.length, eventRows, digests: digestRows.length, expired };
    if (result.campaignRows + result.eventRows + result.digests + result.expired > 0)
      this.logger.warn(`Notification reconcile: ${JSON.stringify(result)}`);
    return result;
  }

  /** Adds the send job of an event row when the relay's job is gone or finished; returns whether it did. */
  private async readd(row: StaleRow): Promise<boolean> {
    if (row.eventId === undefined) return false;
    const queue = this.queues.queue('notifications');
    const job = await queue.getJob(queueJobId('outbox', row.eventId));
    const state = job ? await job.getState() : undefined;
    // A live job (waiting, active, delayed, a retry in its backoff) will send the row: leave it alone.
    if (job && state !== 'failed' && state !== 'completed') return false;
    await this.queues.add(
      'notifications',
      NOTIFICATION_SEND_JOB,
      { notificationId: row.id },
      { jobId: queueJobId('notification', row.id) },
    );
    return true;
  }
}
