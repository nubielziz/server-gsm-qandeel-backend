// Drizzle queries on `notification_inbox` (platform module, feature 23): the writes of campaign items (fan-out) and event items
// (`NotificationInbox`), each idempotent on its unique key, the read counters of a campaign, and the reads of the live stream
// (feature 27: one item, a chunk's items, the items after a cursor, batched unread counts). Every function takes a DbExecutor.
import { type SQL, and, asc, eq, gt, inArray, isNull, lte, max, sql } from 'drizzle-orm';
import type { ParsedListQuery } from '../../../../common/contract';
import { type DbExecutor, type ListColumns, listOrderBy, listWhere } from '../../../../infra/db';
import {
  type NotificationCampaign,
  type NotificationInboxCategory,
  type NotificationInboxItem,
  type NotificationRecipientType,
  notificationCampaigns,
  notificationInbox,
} from '../../db/schema';

/**
 * Inserts the in-app items of a campaign for some people, once each.
 *
 * Why: the fan-out may run a chunk twice; the partial unique key `(campaign_id, recipient_type, recipient_id)` makes the second
 * insert a no-op. The people who got an item now are the audience of the chunk's doorbell (decision 037), so a repeated chunk
 * rings nothing.
 *
 * @param db the fan-out's transaction
 * @param campaignId the campaign
 * @param category `announcement` or `marketing`
 * @param recipientType the type of every id
 * @param recipientIds the people
 * @param now the clock's time
 * @returns the recipient ids this call made an item for
 */
export async function insertCampaignItems(
  db: DbExecutor,
  campaignId: number,
  category: NotificationInboxCategory,
  recipientType: NotificationRecipientType,
  recipientIds: readonly number[],
  now: Date,
): Promise<number[]> {
  if (recipientIds.length === 0) return [];
  const rows = await db
    .insert(notificationInbox)
    .values(
      recipientIds.map((recipientId) => ({
        recipientType,
        recipientId,
        campaignId,
        category,
        createdAt: now,
        updatedAt: now,
      })),
    )
    .onConflictDoNothing({
      target: [notificationInbox.campaignId, notificationInbox.recipientType, notificationInbox.recipientId],
      where: sql`${notificationInbox.campaignId} is not null`,
    })
    .returning({ recipientId: notificationInbox.recipientId });
  return rows.map((row) => row.recipientId);
}

/** An event item to insert. */
export interface NewEventItem {
  readonly recipientType: NotificationRecipientType;
  readonly recipientId: number;
  readonly event: string;
  readonly category: NotificationInboxCategory;
  readonly variables: Readonly<Record<string, string>>;
  /** `inapp:<audience>:<event>:<occurrence>`; null for an item nothing repeats (a campaign test). */
  readonly dedupeKey: string | null;
}

/**
 * Inserts an event item unless its dedupe key exists.
 *
 * @param db the caller's transaction
 * @param item the item
 * @param now the clock's time
 * @returns the new id, or `undefined` when the key already had an item
 */
export async function insertEventItem(db: DbExecutor, item: NewEventItem, now: Date): Promise<number | undefined> {
  const [row] = await db
    .insert(notificationInbox)
    .values({ ...item, variables: { ...item.variables }, createdAt: now, updatedAt: now })
    .onConflictDoNothing({
      target: notificationInbox.dedupeKey,
      where: sql`${notificationInbox.dedupeKey} is not null`,
    })
    .returning({ id: notificationInbox.id });
  return row?.id;
}

/**
 * Counts a campaign's in-app items and how many were read.
 *
 * @param db the pool or a transaction
 * @param campaignId the campaign
 * @returns delivered (every item) and read
 */
export async function campaignReadCounts(
  db: DbExecutor,
  campaignId: number,
): Promise<{ delivered: number; read: number }> {
  const [row] = await db
    .select({
      delivered: sql<number>`count(*)::int`,
      read: sql<number>`count(${notificationInbox.readAt})::int`,
    })
    .from(notificationInbox)
    .where(eq(notificationInbox.campaignId, campaignId));
  return { delivered: row?.delivered ?? 0, read: row?.read ?? 0 };
}

/**
 * Tells whether a person has an item of a campaign.
 *
 * @param db the pool or a transaction
 * @param campaignId the campaign
 * @param recipientType the person's type
 * @param recipientId the person
 * @returns true when the item exists
 */
export async function hasCampaignItem(
  db: DbExecutor,
  campaignId: number,
  recipientType: NotificationRecipientType,
  recipientId: number,
): Promise<boolean> {
  const [row] = await db
    .select({ id: notificationInbox.id })
    .from(notificationInbox)
    .where(
      and(
        eq(notificationInbox.campaignId, campaignId),
        eq(notificationInbox.recipientType, recipientType),
        eq(notificationInbox.recipientId, recipientId),
      ),
    )
    .limit(1);
  return row !== undefined;
}

/** Who an inbox belongs to: the signed-in person, never a request parameter. */
export interface InboxOwner {
  readonly type: NotificationRecipientType;
  readonly id: number;
}

/** An item of a person's inbox, with the campaign it came from (when it did). */
export interface InboxRow {
  readonly item: NotificationInboxItem;
  readonly campaign: NotificationCampaign | null;
}

/** The columns an inbox list may sort or filter by (wire names). */
const INBOX_COLUMNS: ListColumns = {
  id: notificationInbox.id,
  createdAt: notificationInbox.createdAt,
  category: notificationInbox.category,
};

/**
 * The condition every inbox read starts with: the owner's rows, and not those of a cancelled campaign.
 *
 * Why: plan 10.4: the recipient comes from the session only, so both keys are in every `WHERE` (a foreign id finds nothing); O10:
 * cancelling a campaign that is still sending hides the in-app items it already made.
 */
function visibleTo(owner: InboxOwner): SQL {
  return sql`${notificationInbox.recipientType} = ${owner.type} and ${notificationInbox.recipientId} = ${owner.id} and ${notCancelled()}`;
}

/** O10: the items of a cancelled campaign are hidden from every read. */
function notCancelled(): SQL {
  return sql`not exists (select 1 from ${notificationCampaigns} c where c.id = ${notificationInbox.campaignId} and c.status = 'cancelled')`;
}

/**
 * Lists a person's inbox, newest first.
 *
 * @param db the pool
 * @param owner whose inbox
 * @param query the parsed request: `category` filter, `createdAt` or `id` sort, range, and `unread` (`true` for unread items only,
 *   `false` for read ones, absent for all)
 * @returns the page (with each item's campaign) and the exact total
 */
export async function listInboxRows(
  db: DbExecutor,
  owner: InboxOwner,
  query: ParsedListQuery<'createdAt' | 'id', { unread?: 'true' | 'false'; locale?: 'en' | 'ar' }>,
): Promise<{ rows: InboxRow[]; total: number }> {
  const read =
    query.extra.unread === 'true'
      ? sql`${notificationInbox.readAt} is null`
      : query.extra.unread === 'false'
        ? sql`${notificationInbox.readAt} is not null`
        : undefined;
  const where = listWhere({ filters: query.filters, search: undefined }, INBOX_COLUMNS, visibleTo(owner), read);
  const [rows, [count]] = await Promise.all([
    db
      .select({ item: notificationInbox, campaign: notificationCampaigns })
      .from(notificationInbox)
      .leftJoin(notificationCampaigns, eq(notificationCampaigns.id, notificationInbox.campaignId))
      .where(where)
      .orderBy(...listOrderBy(query.sort, INBOX_COLUMNS, notificationInbox.id))
      .limit(query.range.limit)
      .offset(query.range.start),
    db
      .select({ total: sql<number>`count(*)::int` })
      .from(notificationInbox)
      .where(where),
  ]);
  return { rows, total: count?.total ?? 0 };
}

/** The largest unread number the bell shows; the count stops there. */
export const UNREAD_CAP = 100;

/**
 * Counts a person's unread items, up to {@link UNREAD_CAP}.
 *
 * Why: the bell polls this; an index probe on the partial unread index that stops at the cap costs the same for a person with ten
 * thousand unread items as for one with three (plan 13.4).
 *
 * @param db the pool
 * @param owner whose inbox
 * @returns the number, at most 100
 */
export async function countUnread(db: DbExecutor, owner: InboxOwner): Promise<number> {
  const result = await db.execute<{ unread: number }>(
    sql`select count(*)::int as unread from (select 1 from ${notificationInbox} where ${visibleTo(owner)} and ${notificationInbox.readAt} is null limit ${UNREAD_CAP}) x`,
  );
  return result.rows[0]?.unread ?? 0;
}

/**
 * Reads one item of a person's inbox, with its campaign (the live stream, decision 037).
 *
 * Why: a doorbell names the item; the owner's two keys are in the `WHERE`, so a doorbell can never render another person's item.
 *
 * @param db the pool
 * @param owner whose inbox
 * @param itemId the item
 * @returns the item, or `undefined` when the owner has no such visible item
 */
export async function inboxRowFor(db: DbExecutor, owner: InboxOwner, itemId: number): Promise<InboxRow | undefined> {
  const [row] = await db
    .select({ item: notificationInbox, campaign: notificationCampaigns })
    .from(notificationInbox)
    .leftJoin(notificationCampaigns, eq(notificationCampaigns.id, notificationInbox.campaignId))
    .where(and(eq(notificationInbox.id, itemId), visibleTo(owner)))
    .limit(1);
  return row;
}

/**
 * Reads the items one campaign made for some people of one type (a fan-out chunk's doorbell, decision 037).
 *
 * @param db the pool
 * @param campaignId the campaign
 * @param recipientType the type of every id
 * @param recipientIds the people (those with an open stream)
 * @returns their items with the campaign; none when the campaign was cancelled meanwhile
 */
export async function campaignRowsFor(
  db: DbExecutor,
  campaignId: number,
  recipientType: NotificationRecipientType,
  recipientIds: readonly number[],
): Promise<InboxRow[]> {
  if (recipientIds.length === 0) return [];
  return db
    .select({ item: notificationInbox, campaign: notificationCampaigns })
    .from(notificationInbox)
    .leftJoin(notificationCampaigns, eq(notificationCampaigns.id, notificationInbox.campaignId))
    .where(
      and(
        eq(notificationInbox.campaignId, campaignId),
        eq(notificationInbox.recipientType, recipientType),
        inArray(notificationInbox.recipientId, [...recipientIds]),
        notCancelled(),
      ),
    );
}

/**
 * Reads a person's visible items after an id, oldest first (the replay of a reconnecting stream, decision 037).
 *
 * @param db the pool
 * @param owner whose inbox
 * @param afterId the last id the client saw
 * @param limit the most rows to read (the caller reads one more than it replays, to know whether more were missed)
 * @returns the items with their campaigns
 */
export async function inboxRowsAfter(
  db: DbExecutor,
  owner: InboxOwner,
  afterId: number,
  limit: number,
): Promise<InboxRow[]> {
  return db
    .select({ item: notificationInbox, campaign: notificationCampaigns })
    .from(notificationInbox)
    .leftJoin(notificationCampaigns, eq(notificationCampaigns.id, notificationInbox.campaignId))
    .where(and(visibleTo(owner), gt(notificationInbox.id, afterId)))
    .orderBy(asc(notificationInbox.id))
    .limit(limit);
}

/**
 * Counts the unread items of several people of one type at once, each capped at {@link UNREAD_CAP}.
 *
 * Why: a fan-out chunk reaches up to 500 people with open streams; one grouped query instead of one probe each.
 *
 * @param db the pool
 * @param recipientType the type of every id
 * @param recipientIds the people
 * @returns id to unread count (an id without unread items is absent)
 */
export async function countUnreadOf(
  db: DbExecutor,
  recipientType: NotificationRecipientType,
  recipientIds: readonly number[],
): Promise<Map<number, number>> {
  if (recipientIds.length === 0) return new Map();
  const rows = await db
    .select({ recipientId: notificationInbox.recipientId, unread: sql<number>`count(*)::int` })
    .from(notificationInbox)
    .where(
      and(
        eq(notificationInbox.recipientType, recipientType),
        inArray(notificationInbox.recipientId, [...recipientIds]),
        isNull(notificationInbox.readAt),
        notCancelled(),
      ),
    )
    .groupBy(notificationInbox.recipientId);
  return new Map(rows.map((row) => [row.recipientId, Math.min(row.unread, UNREAD_CAP)]));
}

/**
 * The newest item id of the whole table: where a stream without a cursor starts (decision 037).
 *
 * @param db the pool
 * @returns the largest id, or 0 for an empty table
 */
export async function newestInboxId(db: DbExecutor): Promise<number> {
  const [row] = await db.select({ id: max(notificationInbox.id) }).from(notificationInbox);
  return row?.id ?? 0;
}

/**
 * Marks one of a person's items read.
 *
 * Why: idempotent (a second click is a no-op) and isolated (the owner's two keys are in the `WHERE`: another person's id is
 * "missing", never "forbidden", so ids cannot be probed).
 *
 * @param db the pool or a transaction
 * @param owner whose inbox
 * @param id the item
 * @param now the clock's time
 * @returns `updated` (this call read it), `already` (it was read) or `missing` (no such item for this person)
 */
export async function markItemRead(
  db: DbExecutor,
  owner: InboxOwner,
  id: number,
  now: Date,
): Promise<'updated' | 'already' | 'missing'> {
  const owned = and(
    eq(notificationInbox.id, id),
    eq(notificationInbox.recipientType, owner.type),
    eq(notificationInbox.recipientId, owner.id),
  );
  const changed = await db
    .update(notificationInbox)
    .set({ readAt: now, updatedAt: now })
    .where(and(owned, sql`${notificationInbox.readAt} is null`))
    .returning({ id: notificationInbox.id });
  if (changed.length > 0) return 'updated';
  const [found] = await db.select({ id: notificationInbox.id }).from(notificationInbox).where(owned).limit(1);
  return found ? 'already' : 'missing';
}

/**
 * Marks a person's unread items read, up to an id.
 *
 * Why: `upToId` is the newest id the screen showed, so an item that arrives while the person clicks stays unread.
 *
 * @param db the pool or a transaction
 * @param owner whose inbox
 * @param upToId the newest id to mark, or undefined for every visible unread item
 * @param now the clock's time
 * @returns how many items this call marked
 */
export async function markAllRead(
  db: DbExecutor,
  owner: InboxOwner,
  upToId: number | undefined,
  now: Date,
): Promise<number> {
  const rows = await db
    .update(notificationInbox)
    .set({ readAt: now, updatedAt: now })
    .where(
      and(
        visibleTo(owner),
        sql`${notificationInbox.readAt} is null`,
        upToId === undefined ? undefined : lte(notificationInbox.id, upToId),
      ),
    )
    .returning({ id: notificationInbox.id });
  return rows.length;
}

/**
 * Deletes one batch of inbox items read before a moment.
 *
 * @param db the pool
 * @param readBefore items whose `read_at` is before this moment
 * @param limit the batch size
 * @returns how many items were deleted
 */
export async function deleteReadBatch(db: DbExecutor, readBefore: Date, limit: number): Promise<number> {
  const old = db
    .select({ id: notificationInbox.id })
    .from(notificationInbox)
    .where(sql`${notificationInbox.readAt} < ${readBefore}`)
    .orderBy(notificationInbox.id)
    .limit(limit);
  const rows = await db
    .delete(notificationInbox)
    .where(sql`${notificationInbox.id} in (${old})`)
    .returning({ id: notificationInbox.id });
  return rows.length;
}

/**
 * Deletes one batch of inbox items created before a moment, read or not.
 *
 * @param db the pool
 * @param createdBefore items created before this moment
 * @param limit the batch size
 * @returns how many items were deleted
 */
export async function deleteOldBatch(db: DbExecutor, createdBefore: Date, limit: number): Promise<number> {
  const old = db
    .select({ id: notificationInbox.id })
    .from(notificationInbox)
    .where(sql`${notificationInbox.createdAt} < ${createdBefore}`)
    .orderBy(notificationInbox.id)
    .limit(limit);
  const rows = await db
    .delete(notificationInbox)
    .where(sql`${notificationInbox.id} in (${old})`)
    .returning({ id: notificationInbox.id });
  return rows.length;
}
