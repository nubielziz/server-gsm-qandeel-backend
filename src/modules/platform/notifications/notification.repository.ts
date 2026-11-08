// Drizzle queries on `notifications` (platform module, feature 12a): a row made once per occurrence, the guarded writes of a send's result,
// the digest row that collects a day's price changes, and the staff's log with its recipient joins. Every function takes a DbExecutor.
//
// DEVIATION (decision 016, same as notification-foreign-reads.ts): the log joins `clients`, `staff_users` and `customers` read-only, because the
// server masks the recipient's address and the list searches and counts by it in one query; the owners export no reader, and the platform
// module imports no module (decision 032). Replace the joins with the owners' public reads when they exist.
import { type SQL, and, eq, sql } from 'drizzle-orm';
import type { ParsedListQuery } from '../../../common/contract';
import { type DbExecutor, type ListColumns, escapeLike, listOrderBy, listWhere, schema as s } from '../../../infra/db';
import {
  type NewNotification,
  type Notification,
  type NotificationChannel,
  type NotificationRecipientType,
  notifications,
} from '../db/schema';

/** The columns the log may be sorted by (wire names). */
export type NotificationSortField = 'createdAt' | 'id';

/**
 * What `notifications.payload` holds: ids and display values, never a secret.
 *
 * Why: the console shows the payload as it is stored (the "Data" box of the log drawer), so a secret or a clear token must never
 * be written into it. `variables` are the values of the template's placeholders; the digest row also keeps its items.
 */
export interface NotificationPayload {
  readonly variables?: Readonly<Record<string, string>>;
  /** A Telegram chat that overrides the recipient's linked chat (the bot's answer to `/stop` goes to a chat that is no longer linked). */
  readonly chatId?: string;
  /** The addresses of an email that goes to the ops mailbox named by configuration, joined by commas (an alert's message, feature 12b). */
  readonly to?: string;
  /** The price changes of a digest row. */
  readonly items?: readonly unknown[];
  /** The digest period (`YYYY-MM-DD`). */
  readonly cycle?: string;
  /** Set when the digest is being sent: later changes join the next day's row. */
  readonly closed?: boolean;
  readonly [key: string]: unknown;
}

/** A row and whether this call created it. */
export interface OnceResult {
  readonly row: Notification;
  readonly created: boolean;
}

/**
 * Inserts a notification unless its dedupe key exists.
 *
 * Why: a job that runs twice (a retry, a crash after the insert) and an update that Telegram repeats must not make a second
 * message. The partial unique index on `dedupe_key` is the final word; a row without a key is always inserted.
 *
 * @param db the database or the caller's transaction
 * @param row the new row (status `queued`)
 * @returns the row, and `created: false` when the key already had one
 */
export async function insertNotificationOnce(db: DbExecutor, row: NewNotification): Promise<OnceResult> {
  if (row.dedupeKey === undefined || row.dedupeKey === null) {
    const [created] = await db.insert(notifications).values(row).returning();
    return { row: created!, created: true };
  }
  const [created] = await db
    .insert(notifications)
    .values(row)
    .onConflictDoNothing({ target: notifications.dedupeKey, where: sql`${notifications.dedupeKey} is not null` })
    .returning();
  if (created) return { row: created, created: true };
  const [existing] = await db.select().from(notifications).where(eq(notifications.dedupeKey, row.dedupeKey)).limit(1);
  return { row: existing!, created: false };
}

/**
 * Reads a notification.
 *
 * @param db the database or a transaction
 * @param id the row id
 * @param lock lock the row `FOR UPDATE` for the rest of the transaction
 * @returns the row, or `undefined`
 */
export async function findNotification(db: DbExecutor, id: number, lock = false): Promise<Notification | undefined> {
  const query = db.select().from(notifications).where(eq(notifications.id, id)).limit(1);
  const [row] = await (lock ? query.for('update') : query);
  return row;
}

/**
 * Reads a notification by its dedupe key.
 *
 * @param db the database or a transaction
 * @param key the dedupe key
 * @param lock lock the row `FOR UPDATE`
 * @returns the row, or `undefined`
 */
export async function findNotificationByKey(
  db: DbExecutor,
  key: string,
  lock = false,
): Promise<Notification | undefined> {
  const query = db.select().from(notifications).where(eq(notifications.dedupeKey, key)).limit(1);
  const [row] = await (lock ? query.for('update') : query);
  return row;
}

/**
 * Records that a send was tried and did not end the notification.
 *
 * @param db the database or a transaction
 * @param id the row
 * @param attempts the attempt number now reached
 * @param now the time from the injected clock
 * @returns true when a queued row was updated
 */
export async function recordAttempt(db: DbExecutor, id: number, attempts: number, now: Date): Promise<boolean> {
  const rows = await db
    .update(notifications)
    .set({ attempts, updatedAt: now })
    .where(and(eq(notifications.id, id), eq(notifications.status, 'queued')))
    .returning({ id: notifications.id });
  return rows.length > 0;
}

/**
 * Marks a queued notification sent.
 *
 * Why: the guard `status = 'queued'` makes a job that runs twice record one send (decision 020).
 *
 * @param db the database or a transaction
 * @param id the row
 * @param attempts the attempt that succeeded
 * @param now the time from the injected clock (`sent_at`)
 * @returns true when this call marked it
 */
export async function markSent(db: DbExecutor, id: number, attempts: number, now: Date): Promise<boolean> {
  const rows = await db
    .update(notifications)
    .set({ status: 'sent', sentAt: now, attempts, error: null, updatedAt: now })
    .where(and(eq(notifications.id, id), eq(notifications.status, 'queued')))
    .returning({ id: notifications.id });
  return rows.length > 0;
}

/**
 * Marks a queued notification failed for good.
 *
 * @param db the database or a transaction
 * @param id the row
 * @param attempts the attempt that ended it
 * @param error the reason (already free of addresses and secrets)
 * @param now the time from the injected clock
 * @returns true when this call marked it
 */
export async function markFailed(
  db: DbExecutor,
  id: number,
  attempts: number,
  error: string,
  now: Date,
): Promise<boolean> {
  const rows = await db
    .update(notifications)
    .set({ status: 'failed', attempts, error, updatedAt: now })
    .where(and(eq(notifications.id, id), eq(notifications.status, 'queued')))
    .returning({ id: notifications.id });
  return rows.length > 0;
}

/**
 * Replaces the payload of a queued notification.
 *
 * @param db the caller's transaction
 * @param id the row
 * @param payload the new payload
 * @param now the time from the injected clock
 */
export async function setPayload(db: DbExecutor, id: number, payload: NotificationPayload, now: Date): Promise<void> {
  await db.update(notifications).set({ payload, updatedAt: now }).where(eq(notifications.id, id));
}

/**
 * Closes a digest row: later price changes will join the next period's row.
 *
 * Why: the send job reads the items after this call and nothing can add one afterwards, so no change is lost between the read and
 * the send. The guard keeps a repeated job from closing a row twice.
 *
 * @param db the database or a transaction
 * @param id the digest row
 * @param now the time from the injected clock
 * @returns the row with `closed: true`, or `undefined` when it is not queued any more
 */
export async function closeDigest(db: DbExecutor, id: number, now: Date): Promise<Notification | undefined> {
  const [row] = await db
    .update(notifications)
    .set({ payload: sql`${notifications.payload} || '{"closed": true}'::jsonb`, updatedAt: now })
    .where(and(eq(notifications.id, id), eq(notifications.status, 'queued')))
    .returning();
  return row;
}

/** The recipient's current address (the join the log masks); never put into an answer unmasked. */
const RECIPIENT_ADDRESS = sql`coalesce(${s.clients.email}, ${s.staffUsers.email}, ${s.customers.email})`;

const LOG_COLUMNS: ListColumns = {
  id: notifications.id,
  createdAt: notifications.createdAt,
  status: notifications.status,
  channel: notifications.channel,
  event: notifications.event,
  recipientType: notifications.recipientType,
  recipient: RECIPIENT_ADDRESS,
};

/**
 * The `WHERE` of the log: the filters, and `q` as "the event contains it, or the address equals it".
 *
 * Why: the answer shows only a masked address, so a contains-search over the real address would let repeated searches rebuild it one
 * letter at a time. The address matches only when `q` is the whole address (any letter case), which proves nothing staff did not know.
 */
function logWhere(query: ParsedListQuery<NotificationSortField>): SQL | undefined {
  const { search } = query;
  const base = listWhere({ filters: query.filters, search: undefined }, LOG_COLUMNS);
  if (!search) return base;
  const matchesSearch = sql`(${notifications.event} ilike ${`%${escapeLike(search.text)}%`} or lower(${RECIPIENT_ADDRESS}) = lower(${search.text}))`;
  return base ? sql`${base} and ${matchesSearch}` : matchesSearch;
}

/** A log row with what the masks need: the recipient's current address and linked chat. */
export interface LogRow {
  readonly notification: Notification;
  readonly email: string | null;
  readonly telegramChatId: string | null;
}

function logSelect(db: DbExecutor) {
  return db
    .select({
      notification: notifications,
      email: sql<string | null>`${RECIPIENT_ADDRESS}`,
      telegramChatId: s.clients.telegramChatId,
    })
    .from(notifications)
    .leftJoin(
      s.clients,
      and(eq(notifications.recipientType, sql`'client'`), eq(s.clients.id, notifications.recipientId)),
    )
    .leftJoin(
      s.staffUsers,
      and(eq(notifications.recipientType, sql`'staff'`), eq(s.staffUsers.id, notifications.recipientId)),
    )
    .leftJoin(
      s.customers,
      and(eq(notifications.recipientType, sql`'customer'`), eq(s.customers.id, notifications.recipientId)),
    );
}

/**
 * Lists the notification log.
 *
 * @param db the database or a transaction
 * @param query the parsed list request (filters `status`, `channel`, `event`, `recipientType`; `q` contains-search over the event, equals-search over the address)
 * @returns the page of rows with their recipients, and the exact total for the filter
 */
export async function listLogRows(
  db: DbExecutor,
  query: ParsedListQuery<NotificationSortField>,
): Promise<{ rows: LogRow[]; total: number }> {
  const where = logWhere(query);
  const [rows, [count]] = await Promise.all([
    logSelect(db)
      .where(where)
      .orderBy(...listOrderBy(query.sort, LOG_COLUMNS, notifications.id))
      .limit(query.range.limit)
      .offset(query.range.start),
    db
      .select({ total: sql<number>`count(*)::int` })
      .from(notifications)
      .leftJoin(
        s.clients,
        and(eq(notifications.recipientType, sql`'client'`), eq(s.clients.id, notifications.recipientId)),
      )
      .leftJoin(
        s.staffUsers,
        and(eq(notifications.recipientType, sql`'staff'`), eq(s.staffUsers.id, notifications.recipientId)),
      )
      .leftJoin(
        s.customers,
        and(eq(notifications.recipientType, sql`'customer'`), eq(s.customers.id, notifications.recipientId)),
      )
      .where(where),
  ]);
  return { rows, total: count?.total ?? 0 };
}

/**
 * Reads one log row with its recipient.
 *
 * @param db the database or a transaction
 * @param id the notification id
 * @returns the row, or `undefined`
 */
export async function findLogRow(db: DbExecutor, id: number): Promise<LogRow | undefined> {
  const [row] = await logSelect(db).where(eq(notifications.id, id)).limit(1);
  return row;
}

/** What counts toward "sent in the last 30 days" for one template. */
export interface SentCountKey {
  readonly event: string;
  readonly channel: NotificationChannel;
  readonly recipientType: NotificationRecipientType;
}

/**
 * Builds the key a count is stored under.
 *
 * @param key the event, channel and recipient type
 * @returns the three joined with `|`
 */
export function sentCountKey(key: SentCountKey): string {
  return `${key.event}|${key.channel}|${key.recipientType}`;
}

/**
 * Counts the notifications sent since a moment, per event, channel and recipient type.
 *
 * Why: identity-platform-11: `sentLast30Days` of a template is the count of `sent` notifications with the same event, channel and
 * recipient type since `now - 30 days`, across all locales. One grouped query serves a whole page of templates.
 *
 * @param db the database or a transaction
 * @param since the start of the window, from the injected clock
 * @param events the event keys on the page
 * @returns counts by {@link sentCountKey}; a missing key means zero
 */
export async function sentCountsSince(
  db: DbExecutor,
  since: Date,
  events: readonly string[],
): Promise<Map<string, number>> {
  const counts = new Map<string, number>();
  if (events.length === 0) return counts;
  const rows = await db
    .select({
      event: notifications.event,
      channel: notifications.channel,
      recipientType: notifications.recipientType,
      total: sql<number>`count(*)::int`,
    })
    .from(notifications)
    .where(
      and(
        eq(notifications.status, 'sent'),
        sql`${notifications.sentAt} >= ${since}`,
        sql`${notifications.event} in (${sql.join(
          events.map((event) => sql`${event}`),
          sql`, `,
        )})`,
      ),
    )
    .groupBy(notifications.event, notifications.channel, notifications.recipientType);
  for (const row of rows) counts.set(sentCountKey(row), row.total);
  return counts;
}
