// CampaignFanOut: turns a queued campaign into in-app items and queued email rows, chunk by chunk (feature 23, plan
// section 8.1). Each chunk is one transaction that locks the campaign row, reads one keyset page of one recipient type, inserts its rows
// idempotently and moves the cursor; after the commit the chunk rings the inbox doorbell (decision 037) and adds the send jobs to the
// bulk queue.
import { Inject, Injectable, Logger } from '@nestjs/common';
import { Counter } from 'prom-client';
import { CLOCK, type Clock } from '../../../../common/clock';
import { DbService, type DbExecutor } from '../../../../infra/db';
import { MetricsService } from '../../../../infra/metrics';
import { QueuesService, UnrecoverableError, queueJobId } from '../../../../infra/queues';
import type { NotificationCampaign, NotificationRecipientType } from '../../db/schema';
import { InboxDoorbell } from '../inbox/inbox-doorbell';
import { insertCampaignItems } from '../inbox/inbox.repository';
import {
  AUDIENCE_KIND_ORDER,
  type AudienceKind,
  audienceOfKind,
  parseStoredAudience,
  selectionsOf,
} from './audience-spec';
import { BROADCAST_ANNOUNCEMENT_EVENT } from './broadcast-events';
import { BROADCAST_QUEUE, BROADCAST_SEND_JOB } from './broadcast-send.processor';
import {
  CAMPAIGN_FANOUT_EVENT,
  type CampaignStats,
  EMPTY_STATS,
  FANOUT_STATUSES,
  addStats,
  campaignDedupeKey,
  categoryOf,
  rowsFor,
  statsOf,
} from './campaign-rules';
import { type CampaignMessageRow, findCampaign, insertCampaignMessages, updateCampaignIf } from './campaign.repository';
import { channelsOf } from './campaign-views';
import { NotificationAudiences } from './notification-audiences';

/** How the fan-out paces itself; tests override it through {@link CAMPAIGN_FANOUT_OPTIONS}. */
export interface CampaignFanOutOptions {
  /** People per chunk transaction. */
  readonly chunkSize: number;
  /** After this long, the job hands the rest to a continuation job, so one job never holds a worker slot for long. */
  readonly timeBudgetMs: number;
  /** When the bulk queue holds more waiting jobs than this, the fan-out pauses. */
  readonly highWater: number;
  /** How long a paused fan-out waits before it looks again. */
  readonly waitMs: number;
}

/** The Nest token of the {@link CampaignFanOutOptions}. */
export const CAMPAIGN_FANOUT_OPTIONS = Symbol('CAMPAIGN_FANOUT_OPTIONS');

/** The pacing of production. */
export const DEFAULT_FANOUT_OPTIONS: CampaignFanOutOptions = {
  chunkSize: 500,
  timeBudgetMs: 20_000,
  highWater: 20_000,
  waitMs: 15_000,
};

/** Where the next chunk starts: a group of people (staff, merchant ranks, retail) and the last id done. */
export interface FanOutCursor {
  readonly kind: AudienceKind;
  readonly afterId: number;
}

/** What one run of the fan-out job did. */
export interface FanOutResult {
  readonly chunks: number;
  /** Email rows made (and handed to the bulk queue). */
  readonly rows: number;
  /** `sent` when the campaign finished, `continued` when a continuation took over, `paused` for backpressure, `stopped` when there was nothing to do. */
  readonly outcome: 'sent' | 'continued' | 'paused' | 'stopped';
}

/** The data of a fan-out job that is not the relay's: a continuation or a re-kick by the sweep. */
export interface FanOutJobData {
  readonly campaignId: number;
  /** How many backpressure pauses came before (part of the next pause's job id). */
  readonly round?: number;
}

/** What one chunk did. */
interface ChunkResult {
  readonly state: 'more' | 'sent' | 'stopped' | 'failed';
  readonly rows: Array<{ id: number; channel: 'email' }>;
  readonly chunksDone: number;
  readonly error?: string;
  /** The people of one type who got an in-app item in this chunk (none when the chunk ran before). */
  readonly inApp?: { readonly type: NotificationRecipientType; readonly ids: readonly number[] };
}

const isKind = (value: unknown): value is AudienceKind =>
  typeof value === 'string' && (AUDIENCE_KIND_ORDER as readonly string[]).includes(value);

/**
 * Reads the stored cursor.
 *
 * @param value `notification_campaigns.fanout_cursor`
 * @returns the cursor, or `undefined` when there is none or it does not parse
 */
export function cursorOf(value: unknown): FanOutCursor | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const { kind, afterId } = value as Record<string, unknown>;
  return isKind(kind) && typeof afterId === 'number' && Number.isInteger(afterId) ? { kind, afterId } : undefined;
}

/**
 * Fans campaigns out.
 *
 * Why: L5 and plan 8.1: never one outbox event per recipient (the relay is FIFO and would hold order dispatch behind a broadcast).
 * One job walks the audience by primary key in short transactions; the campaign row lock serializes two jobs of one campaign, the
 * unique keys of the inbox and of `notifications.dedupe_key` make a repeated chunk a no-op, and the cursor moves in the chunk's own
 * transaction, so a crash resumes where the last commit left. A cancelled campaign stops at the next chunk. When the bulk queue is
 * full the job pauses (the noeviction Redis stays bounded); after its time budget it hands over to a continuation.
 *
 * Side effects: per chunk, inserts `notification_inbox` and `notifications` rows and updates the campaign; after its commit rings the
 * `inbox created` doorbell with the ids that got an item (decision 037); adds send jobs to `notification-broadcasts` and
 * continuation jobs to `notifications`; counts `notification_campaign_fanout_rows_total{channel}`.
 */
@Injectable()
export class CampaignFanOut {
  private readonly logger = new Logger(CampaignFanOut.name);
  private readonly counter: Counter<'channel'>;

  constructor(
    private readonly db: DbService,
    private readonly queues: QueuesService,
    private readonly audiences: NotificationAudiences,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(CAMPAIGN_FANOUT_OPTIONS) private readonly options: CampaignFanOutOptions,
    metrics: MetricsService,
    private readonly doorbell: InboxDoorbell,
  ) {
    this.counter = new Counter({
      name: 'notification_campaign_fanout_rows_total',
      help: 'Rows the campaign fan-out made, by channel (in_app, email).',
      labelNames: ['channel'],
      registers: [metrics.registry],
    });
  }

  /**
   * Fans a campaign out until it is done, stopped, paused or out of its time budget.
   *
   * @param campaignId the campaign
   * @param round how many backpressure pauses came before
   * @returns what the run did
   * @throws {UnrecoverableError} when the stored audience no longer parses or a group of people has no provider (the campaign is `failed`)
   * @throws {Error} a Postgres or Redis error (the queue retries; the sweep re-kicks a stalled campaign)
   */
  async run(campaignId: number, round = 0): Promise<FanOutResult> {
    const startedMs = this.clock.nowMs();
    let chunks = 0;
    let rows = 0;
    for (;;) {
      if (await this.backlogIsFull()) {
        const current = await findCampaign(this.db.db, campaignId);
        if (!current || !FANOUT_STATUSES.includes(current.status)) return { chunks, rows, outcome: 'stopped' };
        await this.continueLater(campaignId, current.chunksDone, round + 1, this.options.waitMs);
        return { chunks, rows, outcome: 'paused' };
      }
      const chunk = await this.db.runInTransaction(({ tx }) => this.chunk(tx, campaignId));
      if (chunk.state === 'failed') {
        this.logger.error(`Campaign ${campaignId} failed: ${chunk.error ?? ''}`);
        throw new UnrecoverableError(chunk.error ?? 'The campaign cannot be fanned out.');
      }
      if (chunk.state === 'stopped') return { chunks, rows, outcome: 'stopped' };
      chunks += 1;
      rows += chunk.rows.length;
      // The chunk committed: its recipients' open pages show the item at once (a repeated chunk made none and rings nothing).
      if (chunk.inApp && chunk.inApp.ids.length > 0) {
        this.doorbell.campaignChunk(campaignId, chunk.inApp.type, chunk.inApp.ids);
      }
      await this.handOver(chunk.rows);
      if (chunk.state === 'sent') return { chunks, rows, outcome: 'sent' };
      if (this.clock.nowMs() - startedMs >= this.options.timeBudgetMs) {
        await this.continueLater(campaignId, chunk.chunksDone, round, 0);
        return { chunks, rows, outcome: 'continued' };
      }
    }
  }

  /** One chunk, inside its transaction. */
  private async chunk(tx: DbExecutor, campaignId: number): Promise<ChunkResult> {
    // Lock order: only this one campaign row is ever locked (plan 7); the inserts below take no other row lock that a use case holds.
    const campaign = await findCampaign(tx, campaignId, true);
    if (!campaign || !FANOUT_STATUSES.includes(campaign.status)) return { state: 'stopped', rows: [], chunksDone: 0 };
    const now = this.clock.now();
    const spec = parseStoredAudience(campaign.audience);
    if (!spec) return this.fail(tx, campaign, 'The stored audience is no longer valid.');
    const selections = selectionsOf(spec);
    const missing = selections.find((selection) => !this.audiences.has(selection.kind));
    if (missing) return this.fail(tx, campaign, `No audience provider is registered for "${missing.kind}".`);

    let cursor = campaign.status === 'queued' ? undefined : cursorOf(campaign.fanoutCursor);
    if (!cursor) {
      const first = selections[0];
      if (!first) return this.finish(tx, campaign, EMPTY_STATS, 0, now, []);
      cursor = { kind: first.kind, afterId: 0 };
    }
    const index = selections.findIndex((selection) => selection.kind === cursor.kind);
    const selection = selections[index];
    if (!selection) return this.finish(tx, campaign, EMPTY_STATS, 0, now, []);

    const channels = channelsOf(campaign);
    const members = await this.audiences
      .get(selection.kind)
      .page(tx, { ...selection, purpose: campaign.purpose, channels }, cursor.afterId, this.options.chunkSize);

    const inbox: number[] = [];
    const messages: CampaignMessageRow[] = [];
    let reached = 0;
    let stats: CampaignStats = EMPTY_STATS;
    for (const member of members) {
      const plan = rowsFor(member, channels);
      if (plan.inApp) inbox.push(member.id);
      if (plan.email) {
        messages.push({
          recipientType: selection.type,
          recipientId: member.id,
          channel: 'email',
          dedupeKey: campaignDedupeKey(campaign.id, 'email', selection.type, member.id),
          // The group the person was selected in: the send-time check asks the same one (a rank change in between is no new audience).
          audience: audienceOfKind(selection.kind),
        });
      }
      if (plan.inApp || plan.email) reached += 1;
      stats = addStats(stats, {
        planned: { inApp: plan.inApp ? 1 : 0, email: plan.email ? 1 : 0 },
        skipped: {
          optedOut: plan.skipped.optedOut ? 1 : 0,
          noAccount: plan.skipped.noAccount ? 1 : 0,
        },
      });
    }
    // Both inserts are ON CONFLICT DO NOTHING on their unique keys: a chunk that runs again makes nothing twice.
    const items = await insertCampaignItems(tx, campaign.id, categoryOf(campaign.purpose), selection.type, inbox, now);
    const created = await insertCampaignMessages(tx, campaign.id, BROADCAST_ANNOUNCEMENT_EVENT, messages, now);
    this.counter.inc({ channel: 'in_app' }, items.length);
    const inApp = { type: selection.type, ids: items };
    this.counter.inc({ channel: 'email' }, created.length);

    const last = members[members.length - 1];
    let next: FanOutCursor | undefined =
      members.length >= this.options.chunkSize && last ? { kind: selection.kind, afterId: last.id } : undefined;
    if (!next) {
      const following = selections[index + 1];
      next = following ? { kind: following.kind, afterId: 0 } : undefined;
    }
    const rows = created.map((row) => ({ id: row.id, channel: 'email' as const }));
    if (!next) return { ...(await this.finish(tx, campaign, stats, reached, now, rows)), inApp };

    const updated = await updateCampaignIf(tx, campaign.id, FANOUT_STATUSES, {
      status: 'sending',
      ...(campaign.startedAt === null ? { startedAt: now } : {}),
      stats: { ...addStats(statsOf(campaign.stats), stats) },
      recipients: campaign.recipients + reached,
      chunksDone: campaign.chunksDone + 1,
      fanoutCursor: { ...next },
      updatedAt: now,
    });
    return { state: 'more', rows, chunksDone: updated?.chunksDone ?? campaign.chunksDone + 1, inApp };
  }

  /** The last chunk: the campaign is `sent` (every in-app item exists and every message is queued). */
  private async finish(
    tx: DbExecutor,
    campaign: NotificationCampaign,
    stats: CampaignStats,
    reached: number,
    now: Date,
    rows: ChunkResult['rows'],
  ): Promise<ChunkResult> {
    await updateCampaignIf(tx, campaign.id, FANOUT_STATUSES, {
      status: 'sent',
      ...(campaign.startedAt === null ? { startedAt: now } : {}),
      finishedAt: now,
      stats: { ...addStats(statsOf(campaign.stats), stats) },
      recipients: campaign.recipients + reached,
      chunksDone: campaign.chunksDone + 1,
      fanoutCursor: null,
      updatedAt: now,
    });
    return { state: 'sent', rows, chunksDone: campaign.chunksDone + 1 };
  }

  /** A campaign that cannot be fanned out: `failed` with the reason, in the chunk's transaction. */
  private async fail(tx: DbExecutor, campaign: NotificationCampaign, error: string): Promise<ChunkResult> {
    const now = this.clock.now();
    await updateCampaignIf(tx, campaign.id, FANOUT_STATUSES, {
      status: 'failed',
      error,
      finishedAt: now,
      fanoutCursor: null,
      updatedAt: now,
    });
    return { state: 'failed', rows: [], chunksDone: campaign.chunksDone, error };
  }

  /** Adds the send jobs of a committed chunk; an id that exists is left alone. */
  private async handOver(rows: ChunkResult['rows']): Promise<void> {
    if (rows.length === 0) return;
    await this.queues.addBulk(
      BROADCAST_QUEUE,
      rows.map((row) => ({
        jobName: BROADCAST_SEND_JOB,
        data: { notificationId: row.id, channel: row.channel },
        options: { jobId: queueJobId('notification', row.id) },
      })),
    );
  }

  /** Whether the bulk queue holds more waiting jobs than the high-water mark. */
  private async backlogIsFull(): Promise<boolean> {
    const counts = await this.queues.queue(BROADCAST_QUEUE).getJobCounts('waiting', 'delayed', 'prioritized');
    const waiting = (counts['waiting'] ?? 0) + (counts['delayed'] ?? 0) + (counts['prioritized'] ?? 0);
    return waiting > this.options.highWater;
  }

  /** Adds the job that goes on later: after a pause (`delay`) or at once after the time budget. */
  private async continueLater(campaignId: number, chunksDone: number, round: number, delay: number): Promise<void> {
    const jobId =
      delay > 0
        ? queueJobId('campaign-fanout', campaignId, chunksDone, `w${round}`)
        : queueJobId('campaign-fanout', campaignId, chunksDone);
    await this.queues.add(
      'notifications',
      CAMPAIGN_FANOUT_EVENT,
      { campaignId, round },
      { jobId, ...(delay > 0 ? { delay } : {}) },
    );
  }
}
