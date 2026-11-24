// Drizzle queries on `notification_campaigns` and the campaign rows of `notifications` (platform module, feature 23): CRUD, the guarded
// transitions of the state machine, the list, the delivery counters, the recipients list and the fan-out's writes.
//
// DEVIATION (decision 016, same as notification.repository.ts): the recipients list joins `clients`, `staff_users` and `customers` read-only
// to mask the address; platform imports no module (decision 032).
import { type SQL, and, asc, desc, eq, inArray, isNotNull, isNull, sql } from 'drizzle-orm';
import type { ParsedListQuery } from '../../../../common/contract';
import { type DbExecutor, type ListColumns, listOrderBy, listWhere, schema as s } from '../../../../infra/db';
import {
  type NewNotificationCampaign,
  type NotificationCampaign,
  type NotificationCampaignStatus,
  type NotificationRecipientType,
  notificationCampaigns,
  notificationInbox,
  notifications,
} from '../../db/schema';

/** The fields the campaign list may be sorted by. */
export type CampaignSortField = 'createdAt' | 'scheduledAt' | 'id';

const CAMPAIGN_COLUMNS: ListColumns = {
  id: notificationCampaigns.id,
  createdAt: notificationCampaigns.createdAt,
  scheduledAt: notificationCampaigns.scheduledAt,
  status: notificationCampaigns.status,
  purpose: notificationCampaigns.purpose,
  createdBy: notificationCampaigns.createdBy,
  name: notificationCampaigns.name,
};

/**
 * Inserts a campaign.
 *
 * @param db the use case's transaction
 * @param row the new campaign
 * @returns the stored row
 */
export async function insertCampaign(db: DbExecutor, row: NewNotificationCampaign): Promise<NotificationCampaign> {
  const [created] = await db.insert(notificationCampaigns).values(row).returning();
  return created!;
}

/**
 * Reads a campaign.
 *
 * @param db the pool or a transaction
 * @param id the campaign
 * @param lock true to lock the row (`FOR UPDATE`; the fan-out's chunk)
 * @returns the row, or `undefined`
 */
export async function findCampaign(
  db: DbExecutor,
  id: number,
  lock = false,
): Promise<NotificationCampaign | undefined> {
  const query = db.select().from(notificationCampaigns).where(eq(notificationCampaigns.id, id)).limit(1);
  const [row] = lock ? await query.for('update') : await query;
  return row;
}

/**
 * Changes a campaign only while it is in one of some statuses.
 *
 * Why: every transition of the state machine is `UPDATE ... WHERE status = ANY(from)`: of two racing requests (a double click, a
 * send during a cancel, two sweep ticks) exactly one moves the row; the other finds nothing to do.
 *
 * @param db the use case's transaction
 * @param id the campaign
 * @param from the statuses the change is allowed from
 * @param set the new values
 * @param extra one more condition (the send compares the audience it counted)
 * @returns the changed row, or `undefined` when the row is gone or in another status
 */
export async function updateCampaignIf(
  db: DbExecutor,
  id: number,
  from: readonly NotificationCampaignStatus[],
  set: Partial<NewNotificationCampaign>,
  extra?: SQL,
): Promise<NotificationCampaign | undefined> {
  const [row] = await db
    .update(notificationCampaigns)
    .set(set)
    .where(and(eq(notificationCampaigns.id, id), inArray(notificationCampaigns.status, [...from]), extra))
    .returning();
  return row;
}

/**
 * Deletes a draft.
 *
 * @param db the use case's transaction
 * @param id the campaign
 * @returns the deleted row, or `undefined` when gone or not a draft
 */
export async function deleteDraft(db: DbExecutor, id: number): Promise<NotificationCampaign | undefined> {
  const [row] = await db
    .delete(notificationCampaigns)
    .where(and(eq(notificationCampaigns.id, id), eq(notificationCampaigns.status, 'draft')))
    .returning();
  return row;
}

/**
 * Lists campaigns.
 *
 * @param db the pool
 * @param query filters `status` (eq/ne, repeatable), `purpose`, `createdBy`; `q` over the name; sorts `createdAt`, `scheduledAt`, `id`
 * @returns the page and the exact total
 */
export async function listCampaigns(
  db: DbExecutor,
  query: ParsedListQuery<CampaignSortField>,
): Promise<{ rows: NotificationCampaign[]; total: number }> {
  const where = listWhere(query, CAMPAIGN_COLUMNS);
  const [rows, [count]] = await Promise.all([
    db
      .select()
      .from(notificationCampaigns)
      .where(where)
      .orderBy(...listOrderBy(query.sort, CAMPAIGN_COLUMNS, notificationCampaigns.id))
      .limit(query.range.limit)
      .offset(query.range.start),
    db
      .select({ total: sql<number>`count(*)::int` })
      .from(notificationCampaigns)
      .where(where),
  ]);
  return { rows, total: count?.total ?? 0 };
}

/** The email counters of a campaign. */
export interface ChannelDelivery {
  readonly queued: number;
  readonly sent: number;
  readonly failed: number;
}

/**
 * Counts a campaign's email rows by status.
 *
 * Why: the detail's `delivery` is live (index-only on `notifications_campaign_idx`); the list never computes it. Only email rows count:
 * a row of a retired channel that an older campaign still has is history, not delivery.
 *
 * @param db the pool or a transaction
 * @param campaignId the campaign
 * @returns the email counters
 */
export async function campaignDelivery(db: DbExecutor, campaignId: number): Promise<ChannelDelivery> {
  const rows = await db
    .select({ status: notifications.status, n: sql<number>`count(*)::int` })
    .from(notifications)
    .where(and(eq(notifications.campaignId, campaignId), eq(notifications.channel, 'email')))
    .groupBy(notifications.status);
  const result = { queued: 0, sent: 0, failed: 0 };
  for (const row of rows) result[row.status] = row.n;
  return result;
}

/** One row of a campaign's recipients list, before masking. */
export interface RecipientRow {
  readonly id: number;
  readonly recipientType: NotificationRecipientType;
  readonly recipientId: number;
  /** The person's current address (never answered unmasked). */
  readonly email: string | null;
  readonly status: string;
  readonly error: string | null;
  readonly attempts: number | null;
  readonly sentAt: Date | null;
  readonly readAt: Date | null;
  readonly createdAt: Date;
}

/** The status filter of the recipients list: `read`/`delivered` for in-app, `queued`/`sent`/`failed` for the others. */
export type RecipientStatus = 'delivered' | 'read' | 'queued' | 'sent' | 'failed';

const ADDRESS = sql<string | null>`coalesce(${s.clients.email}, ${s.staffUsers.email}, ${s.customers.email})`;

/**
 * Lists the recipients of a campaign on one channel.
 *
 * @param db the pool
 * @param campaignId the campaign
 * @param channel `in_app` (the inbox) or `email` (the log)
 * @param statuses the status filter (empty = every status)
 * @param range the page
 * @param order `asc` or `desc` by id
 * @returns the page and the exact total
 */
export async function listRecipients(
  db: DbExecutor,
  campaignId: number,
  channel: 'in_app' | 'email',
  statuses: readonly RecipientStatus[],
  range: { start: number; limit: number },
  order: 'asc' | 'desc',
): Promise<{ rows: RecipientRow[]; total: number }> {
  const sort = order === 'asc' ? asc : desc;
  if (channel === 'in_app') {
    const t = notificationInbox;
    const wantRead = statuses.includes('read');
    const wantDelivered = statuses.includes('delivered');
    const statusSql: SQL | undefined =
      statuses.length === 0 || (wantRead && wantDelivered)
        ? undefined
        : wantRead
          ? isNotNull(t.readAt)
          : wantDelivered
            ? isNull(t.readAt)
            : sql`false`;
    const where = and(eq(t.campaignId, campaignId), statusSql);
    const [rows, [count]] = await Promise.all([
      db
        .select({
          id: t.id,
          recipientType: t.recipientType,
          recipientId: t.recipientId,
          email: ADDRESS,
          readAt: t.readAt,
          createdAt: t.createdAt,
        })
        .from(t)
        .leftJoin(s.clients, and(eq(t.recipientType, sql`'client'`), eq(s.clients.id, t.recipientId)))
        .leftJoin(s.staffUsers, and(eq(t.recipientType, sql`'staff'`), eq(s.staffUsers.id, t.recipientId)))
        .leftJoin(s.customers, and(eq(t.recipientType, sql`'customer'`), eq(s.customers.id, t.recipientId)))
        .where(where)
        .orderBy(sort(t.id))
        .limit(range.limit)
        .offset(range.start),
      db
        .select({ total: sql<number>`count(*)::int` })
        .from(t)
        .where(where),
    ]);
    return {
      rows: rows.map((row) => ({
        ...row,
        status: row.readAt ? 'read' : 'delivered',
        error: null,
        attempts: null,
        sentAt: null,
      })),
      total: count?.total ?? 0,
    };
  }
  const n = notifications;
  const logStatuses = statuses.filter((status): status is 'queued' | 'sent' | 'failed' =>
    ['queued', 'sent', 'failed'].includes(status),
  );
  const statusSql =
    statuses.length === 0 ? undefined : logStatuses.length === 0 ? sql`false` : inArray(n.status, logStatuses);
  const where = and(eq(n.campaignId, campaignId), eq(n.channel, channel), statusSql);
  const [rows, [count]] = await Promise.all([
    db
      .select({
        id: n.id,
        recipientType: n.recipientType,
        recipientId: n.recipientId,
        email: ADDRESS,
        status: n.status,
        error: n.error,
        attempts: n.attempts,
        sentAt: n.sentAt,
        createdAt: n.createdAt,
      })
      .from(n)
      .leftJoin(s.clients, and(eq(n.recipientType, sql`'client'`), eq(s.clients.id, n.recipientId)))
      .leftJoin(s.staffUsers, and(eq(n.recipientType, sql`'staff'`), eq(s.staffUsers.id, n.recipientId)))
      .leftJoin(s.customers, and(eq(n.recipientType, sql`'customer'`), eq(s.customers.id, n.recipientId)))
      .where(where)
      .orderBy(sort(n.id))
      .limit(range.limit)
      .offset(range.start),
    db
      .select({ total: sql<number>`count(*)::int` })
      .from(n)
      .where(where),
  ]);
  return {
    rows: rows.map((row) => ({ ...row, error: row.status === 'failed' ? row.error : null, readAt: null })),
    total: count?.total ?? 0,
  };
}

/** One email row the fan-out makes. */
export interface CampaignMessageRow {
  readonly recipientType: NotificationRecipientType;
  readonly recipientId: number;
  readonly channel: 'email';
  readonly dedupeKey: string;
}

/**
 * Inserts the email rows of a fan-out chunk, once each.
 *
 * Why: a chunk that runs twice inserts nothing twice (`ON CONFLICT (dedupe_key) DO NOTHING`); only the rows made by this call come
 * back, so only they get a send job.
 *
 * @param db the chunk's transaction
 * @param campaignId the campaign
 * @param event the event key (`broadcast.announcement`)
 * @param rows the rows
 * @param now the clock's time
 * @returns the ids of the rows this call made
 */
export async function insertCampaignMessages(
  db: DbExecutor,
  campaignId: number,
  event: string,
  rows: readonly CampaignMessageRow[],
  now: Date,
): Promise<Array<{ id: number }>> {
  if (rows.length === 0) return [];
  return db
    .insert(notifications)
    .values(
      rows.map((row) => ({
        ...row,
        event,
        payload: {},
        status: 'queued' as const,
        campaignId,
        createdAt: now,
        updatedAt: now,
      })),
    )
    .onConflictDoNothing({ target: notifications.dedupeKey, where: sql`${notifications.dedupeKey} is not null` })
    .returning({ id: notifications.id });
}

/**
 * Lists campaigns due to be sent.
 *
 * @param db the sweep's transaction
 * @param now the clock's time
 * @returns the ids and names of the campaigns that moved from `scheduled` to `queued`
 */
export async function claimDueCampaigns(db: DbExecutor, now: Date): Promise<Array<{ id: number; name: string }>> {
  return db
    .update(notificationCampaigns)
    .set({ status: 'queued', queuedAt: now, updatedAt: now })
    .where(and(eq(notificationCampaigns.status, 'scheduled'), sql`${notificationCampaigns.scheduledAt} <= ${now}`))
    .returning({ id: notificationCampaigns.id, name: notificationCampaigns.name });
}

/**
 * Lists running campaigns whose fan-out has not moved since a time.
 *
 * @param db the pool
 * @param before the heartbeat limit (`updated_at` older than this)
 * @returns the ids
 */
export async function stalledCampaigns(db: DbExecutor, before: Date): Promise<number[]> {
  const rows = await db
    .select({ id: notificationCampaigns.id })
    .from(notificationCampaigns)
    .where(
      and(
        inArray(notificationCampaigns.status, ['queued', 'sending']),
        sql`${notificationCampaigns.updatedAt} < ${before}`,
      ),
    )
    .orderBy(asc(notificationCampaigns.id))
    .limit(100);
  return rows.map((row) => row.id);
}

/**
 * Marks running campaigns queued before a time `failed`.
 *
 * @param db the pool
 * @param queuedBefore the limit (`queued_at` older than this)
 * @param error the reason
 * @param now the clock's time
 * @returns the ids that failed
 */
export async function failOverdueCampaigns(
  db: DbExecutor,
  queuedBefore: Date,
  error: string,
  now: Date,
): Promise<number[]> {
  const rows = await db
    .update(notificationCampaigns)
    .set({ status: 'failed', error, finishedAt: now, fanoutCursor: null, updatedAt: now })
    .where(
      and(
        inArray(notificationCampaigns.status, ['queued', 'sending']),
        sql`${notificationCampaigns.queuedAt} < ${queuedBefore}`,
      ),
    )
    .returning({ id: notificationCampaigns.id });
  return rows.map((row) => row.id);
}

/**
 * Tells whether the sweep has anything to do.
 *
 * @param db the pool
 * @param now the clock's time
 * @param stalledBefore the heartbeat limit
 * @param queuedBefore the give-up limit
 * @returns true when a campaign is due, stalled or overdue
 */
export async function sweepHasWork(
  db: DbExecutor,
  now: Date,
  stalledBefore: Date,
  queuedBefore: Date,
): Promise<boolean> {
  const c = notificationCampaigns;
  const [row] = await db
    .select({ id: c.id })
    .from(c)
    .where(
      sql`(${c.status} = 'scheduled' and ${c.scheduledAt} <= ${now}) or (${c.status} in ('queued','sending') and (${c.updatedAt} < ${stalledBefore} or ${c.queuedAt} < ${queuedBefore}))`,
    )
    .limit(1);
  return row !== undefined;
}
