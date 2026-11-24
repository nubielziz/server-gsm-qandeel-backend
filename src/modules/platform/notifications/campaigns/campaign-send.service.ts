// CampaignSendService: the transitions staff start (feature 23, plan section 7): schedule, send now, cancel, and the test to the
// author. Each is a guarded UPDATE in one transaction with its audit row; `send` writes the one outbox event the fan-out starts from.
import { Inject, Injectable } from '@nestjs/common';
import { and, eq } from 'drizzle-orm';
import { CLOCK, type Clock } from '../../../../common/clock';
import { AppError } from '../../../../common/errors';
import { DbService, type DbExecutor } from '../../../../infra/db';
import { AuditService } from '../../audit/audit.service';
import {
  type NewNotificationCampaign,
  type NotificationCampaign,
  type NotificationCampaignStatus,
  notificationCampaigns,
} from '../../db/schema';
import { OutboxService } from '../../outbox/outbox.service';
import { InboxDoorbell } from '../inbox/inbox-doorbell';
import { NotificationInbox } from '../inbox/notification-inbox';
import { NotificationService } from '../notification.service';
import { AUDIENCE_TYPE_ORDER, type AudienceSpec, parseStoredAudience, selectionsOf } from './audience-spec';
import { AudiencePreviewService } from './audience-preview.service';
import { BROADCAST_TEST_EVENT } from './broadcast-events';
import { CampaignAdminService, campaignNotFound, currentStaff, notNow } from './campaign-admin.service';
import {
  CAMPAIGN_FANOUT_EVENT,
  CANCELLABLE_STATUSES,
  SENDABLE_STATUSES,
  confirmProblem,
  scheduleProblem,
} from './campaign-rules';
import { findCampaign, updateCampaignIf } from './campaign.repository';
import { type WireCampaignDetail, channelsOf, contentOf } from './campaign-views';
import { renderText } from '../template-rules';

/** The channels of a test. */
export type TestChannel = 'in_app' | 'email';

/**
 * Schedules, sends, cancels and tests campaigns.
 *
 * Why: the state machine of plan 7. The API never does slow work inline: `send` and the sweep only write the status and one
 * outbox event; the worker fans out. Every transition is `UPDATE ... WHERE status = ANY(from)`, so a double click, a send during a
 * cancel or a send during an edit leaves one winner; the loser gets 409.
 *
 * Side effects: updates `notification_campaigns`; writes `audit_logs`; `send` writes one `outbox_events` row; `test` writes an
 * inbox item and/or a `notifications` row with its outbox event for the caller.
 */
@Injectable()
export class CampaignSendService {
  constructor(
    private readonly db: DbService,
    private readonly audit: AuditService,
    private readonly outbox: OutboxService,
    private readonly previews: AudiencePreviewService,
    private readonly admin: CampaignAdminService,
    private readonly notifications: NotificationService,
    private readonly inbox: NotificationInbox,
    @Inject(CLOCK) private readonly clock: Clock,
    private readonly doorbell: InboxDoorbell,
  ) {}

  /**
   * Schedules (or reschedules) a draft or scheduled campaign.
   *
   * @param id the campaign
   * @param scheduledAt when to send it
   * @returns the scheduled campaign
   * @throws {AppError} `NOT_FOUND`; `INVALID_TRANSITION`; `VALIDATION_FAILED` on `scheduledAt` (less than a minute or more than 90
   *   days ahead) or on `audience` (nobody reachable)
   */
  async schedule(id: number, scheduledAt: Date): Promise<WireCampaignDetail> {
    const staff = currentStaff();
    const problem = scheduleProblem(scheduledAt, this.clock.nowMs());
    if (problem) throw new AppError('VALIDATION_FAILED', { errors: [problem] });
    const current = await this.sendable(id, 'scheduled');
    const preview = await this.previews.count(audienceOf(current), channelsOf(current), current.purpose);
    if (preview.reachable === 0) throw nobodyReachable();
    return this.db.runInTransaction(async ({ tx }) => {
      const row = await this.transition(tx, current, SENDABLE_STATUSES, 'scheduled', {
        status: 'scheduled',
        scheduledAt,
        expectedRecipients: preview.reachable,
        updatedBy: staff.id,
        updatedAt: this.clock.now(),
      });
      await this.audit.record(tx, {
        action: 'scheduled notification campaign',
        entityType: 'notification_campaign',
        entityId: id,
        entityLabel: row.name,
        before: { status: current.status, scheduledAt: current.scheduledAt?.toISOString() ?? null },
        after: { status: row.status, scheduledAt: scheduledAt.toISOString(), expectedRecipients: preview.reachable },
      });
      return this.admin.detail(row, tx);
    });
  }

  /**
   * Queues a draft or scheduled campaign for sending now.
   *
   * @param id the campaign
   * @param confirmRecipients the reachable number staff saw
   * @returns the queued campaign
   * @throws {AppError} `NOT_FOUND`; `INVALID_TRANSITION`; `VALIDATION_FAILED` on `audience` (nobody reachable); `CONFLICT` when the
   *   audience reaches a different number now (extension `recipients`) or was edited while it was being sent
   */
  async send(id: number, confirmRecipients: number): Promise<WireCampaignDetail> {
    const staff = currentStaff();
    const current = await this.sendable(id, 'sent');
    const preview = await this.previews.count(audienceOf(current), channelsOf(current), current.purpose);
    const problem = confirmProblem(confirmRecipients, preview.reachable);
    if (problem === 'empty') throw nobodyReachable();
    if (problem === 'changed') {
      throw new AppError('CONFLICT', {
        detail: `The audience now reaches ${preview.reachable} people, not ${confirmRecipients}. Check the count and send again.`,
        extensions: { recipients: preview.reachable },
      });
    }
    return this.db.runInTransaction(async ({ tx }) => {
      const now = this.clock.now();
      const row = await this.transition(tx, current, SENDABLE_STATUSES, 'sent', {
        status: 'queued',
        queuedAt: now,
        expectedRecipients: preview.reachable,
        updatedBy: staff.id,
        updatedAt: now,
      });
      await this.audit.record(tx, {
        action: 'sent notification campaign',
        entityType: 'notification_campaign',
        entityId: id,
        entityLabel: row.name,
        before: { status: current.status },
        after: {
          status: row.status,
          channels: row.channels,
          purpose: row.purpose,
          expectedRecipients: preview.reachable,
        },
      });
      await this.outbox.add(tx, {
        type: CAMPAIGN_FANOUT_EVENT,
        aggregateType: 'notification_campaigns',
        aggregateId: id,
      });
      return this.admin.detail(row, tx);
    });
  }

  /**
   * Cancels a scheduled, queued or sending campaign.
   *
   * Side effects: after the commit rings `inbox recount` for the audience's recipient types: the items it already made hide, so
   * the open bells get their new count (decision 037).
   *
   * @param id the campaign
   * @returns the cancelled campaign
   * @throws {AppError} `NOT_FOUND`; `INVALID_TRANSITION` for a draft (delete it) or a campaign that is over
   */
  async cancel(id: number): Promise<WireCampaignDetail> {
    const staff = currentStaff();
    return this.db.runInTransaction(async ({ tx }) => {
      const now = this.clock.now();
      const row = await updateCampaignIf(tx, id, CANCELLABLE_STATUSES, {
        status: 'cancelled',
        cancelledAt: now,
        cancelledBy: staff.id,
        fanoutCursor: null,
        updatedAt: now,
      });
      if (!row) {
        const current = await findCampaign(tx, id);
        if (!current) throw campaignNotFound();
        throw notNow(current, 'cancelled');
      }
      // A stored audience that no longer parses could have reached anyone: every recipient type recounts.
      const spec = parseStoredAudience(row.audience);
      this.doorbell.recount(spec ? selectionsOf(spec).map((selection) => selection.type) : AUDIENCE_TYPE_ORDER);
      await this.audit.record(tx, {
        action: 'cancelled notification campaign',
        entityType: 'notification_campaign',
        entityId: id,
        entityLabel: row.name,
        after: { status: 'cancelled' },
      });
      return this.admin.detail(row, tx);
    });
  }

  /**
   * Sends a campaign to its author only: an in-app item and/or an email.
   *
   * @param id the campaign
   * @param channels `in_app`, `email` (default both)
   * @returns the channels a message was made for
   * @throws {AppError} `NOT_FOUND`; `INVALID_TRANSITION` when the campaign is no longer a draft or scheduled
   */
  async test(id: number, channels: readonly TestChannel[] = ['in_app', 'email']): Promise<{ queued: TestChannel[] }> {
    const staff = currentStaff();
    return this.db.runInTransaction(async ({ tx }) => {
      const row = await findCampaign(tx, id);
      if (!row) throw campaignNotFound();
      if (!SENDABLE_STATUSES.includes(row.status)) throw notNow(row, 'tested');
      const content = contentOf(row);
      const variables = {
        title: renderText(content.title, { name: staff.name }, 'text'),
        body: renderText(content.body, { name: staff.name }, 'text'),
      };
      const queued: TestChannel[] = [];
      const recipient = { type: 'staff' as const, id: staff.id };
      if (channels.includes('in_app')) {
        const item = await this.inbox.add(tx, { recipient, event: BROADCAST_TEST_EVENT, variables });
        if (item !== undefined) queued.push('in_app');
      }
      if (channels.includes('email')) {
        const result = await this.notifications.enqueueInline(
          { tx },
          { event: BROADCAST_TEST_EVENT, recipient, channel: 'email', variables },
        );
        if (result.status === 'queued') queued.push('email');
      }
      await this.audit.record(tx, {
        action: 'sent test notification',
        entityType: 'notification_campaign',
        entityId: id,
        entityLabel: row.name,
        after: { channels: queued },
      });
      return { queued };
    });
  }

  /** Reads a campaign that may be sent or scheduled now. */
  private async sendable(id: number, what: string): Promise<NotificationCampaign> {
    const current = await findCampaign(this.db.db, id);
    if (!current) throw campaignNotFound();
    if (!SENDABLE_STATUSES.includes(current.status)) throw notNow(current, what);
    return current;
  }

  /**
   * Moves a campaign whose audience was counted outside the transaction.
   *
   * Why: the count ran on the pool; the guard also compares the audience, channels and purpose with what was counted, so an edit
   * that slipped in between cannot be sent with a stale number.
   */
  private async transition(
    tx: DbExecutor,
    seen: NotificationCampaign,
    from: readonly NotificationCampaignStatus[],
    what: string,
    set: Partial<NewNotificationCampaign>,
  ): Promise<NotificationCampaign> {
    const row = await updateCampaignIf(
      tx,
      seen.id,
      from,
      set,
      and(
        eq(notificationCampaigns.audience, seen.audience),
        eq(notificationCampaigns.channels, seen.channels),
        eq(notificationCampaigns.purpose, seen.purpose),
      ),
    );
    if (row) return row;
    const current = await findCampaign(tx, seen.id);
    if (!current) throw campaignNotFound();
    if (!from.includes(current.status)) throw notNow(current, what);
    throw new AppError('CONFLICT', {
      detail: 'The audience of the campaign was changed meanwhile. Check the count and try again.',
    });
  }
}

/** The audience of a stored campaign. */
function audienceOf(row: NotificationCampaign): AudienceSpec {
  const spec = parseStoredAudience(row.audience);
  if (!spec) throw new AppError('VALIDATION_FAILED', { errors: [invalidAudience] });
  return spec;
}

const invalidAudience = { field: 'audience', code: 'invalid', message: 'The stored audience is no longer valid.' };

/** The 422 of an audience nobody is reachable in. */
function nobodyReachable(): AppError {
  return new AppError('VALIDATION_FAILED', {
    errors: [
      { field: 'audience', code: 'empty', message: 'Nobody in this audience can be reached by these channels.' },
    ],
  });
}
