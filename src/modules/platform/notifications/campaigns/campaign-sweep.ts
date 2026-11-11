// CampaignSweep: the minute tick of the notification center (feature 23, plan section 8.3): it queues the scheduled campaigns that are
// due (Postgres is the truth), re-kicks a fan-out whose heartbeat stopped, and gives up on one that did not finish within a day.
import { Inject, Injectable, Logger } from '@nestjs/common';
import { CLOCK, type Clock } from '../../../../common/clock';
import { DbService } from '../../../../infra/db';
import { QueuesService, queueJobId } from '../../../../infra/queues';
import { AuditService } from '../../audit/audit.service';
import { OutboxService } from '../../outbox/outbox.service';
import { CAMPAIGN_FANOUT_EVENT } from './campaign-rules';
import { claimDueCampaigns, failOverdueCampaigns, stalledCampaigns, sweepHasWork } from './campaign.repository';

/** A running campaign whose row has not moved for this long gets its fan-out job again. */
export const STALLED_AFTER_MS = 5 * 60_000;
/** A running campaign queued this long ago is given up. */
export const GIVE_UP_AFTER_MS = 24 * 60 * 60_000;
/** The reason written on a campaign the sweep gives up. */
export const GIVE_UP_REASON = 'The fan-out did not finish within 24 hours.';

/** What one tick did. */
export interface SweepResult {
  /** Scheduled campaigns that became `queued` (each with its outbox event). */
  readonly queued: number;
  /** Stalled fan-outs that got a new job. */
  readonly rekicked: number;
  /** Campaigns given up as `failed`. */
  readonly failed: number;
}

/**
 * Sends the scheduled campaigns and watches the running ones.
 *
 * Why: O5: scheduling is a minute sweep over Postgres, not a delayed job (a lost queue Redis loses nothing, a reschedule needs no job
 * to be moved). The claim is one guarded `UPDATE ... WHERE status = 'scheduled' AND scheduled_at <= now`, so two overlapping ticks
 * queue each campaign once; the claim, its outbox event and its audit row (actor `system`) commit together.
 *
 * Side effects: updates `notification_campaigns`; writes `outbox_events` and `audit_logs`; adds fan-out jobs to `notifications`.
 */
@Injectable()
export class CampaignSweep {
  private readonly logger = new Logger(CampaignSweep.name);

  constructor(
    private readonly db: DbService,
    private readonly outbox: OutboxService,
    private readonly audit: AuditService,
    private readonly queues: QueuesService,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  /**
   * Tells whether a tick would do anything, cheaply.
   *
   * @returns true when a campaign is due, stalled or overdue
   */
  hasWork(): Promise<boolean> {
    const nowMs = this.clock.nowMs();
    return sweepHasWork(
      this.db.db,
      new Date(nowMs),
      new Date(nowMs - STALLED_AFTER_MS),
      new Date(nowMs - GIVE_UP_AFTER_MS),
    );
  }

  /**
   * Runs one tick.
   *
   * @returns the counts of what it did
   * @throws {AppError} `UNAVAILABLE` when the queue Redis cannot take a re-kick (the next tick tries again)
   */
  async run(): Promise<SweepResult> {
    const now = this.clock.now();
    const nowMs = now.getTime();
    const claimed = await this.db.runInTransaction(async ({ tx }) => {
      const due = await claimDueCampaigns(tx, now);
      for (const campaign of due) {
        await this.outbox.add(tx, {
          type: CAMPAIGN_FANOUT_EVENT,
          aggregateType: 'notification_campaigns',
          aggregateId: campaign.id,
        });
        await this.audit.record(tx, {
          action: 'sent scheduled notification campaign',
          entityType: 'notification_campaign',
          entityId: campaign.id,
          entityLabel: campaign.name,
          before: { status: 'scheduled' },
          after: { status: 'queued' },
        });
      }
      return due.length;
    });
    const failed = await failOverdueCampaigns(this.db.db, new Date(nowMs - GIVE_UP_AFTER_MS), GIVE_UP_REASON, now);
    for (const id of failed) this.logger.error(`Campaign ${id} failed: ${GIVE_UP_REASON}`);
    const stalled = await stalledCampaigns(this.db.db, new Date(nowMs - STALLED_AFTER_MS));
    const minute = Math.floor(nowMs / 60_000);
    for (const campaignId of stalled) {
      // One re-kick per campaign per minute; the fan-out itself is idempotent.
      await this.queues.add(
        'notifications',
        CAMPAIGN_FANOUT_EVENT,
        { campaignId },
        { jobId: queueJobId('campaign-fanout', campaignId, `r${minute}`) },
      );
    }
    return { queued: claimed, rekicked: stalled.length, failed: failed.length };
  }
}
