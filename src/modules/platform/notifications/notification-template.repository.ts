// Drizzle queries on `notification_templates` (platform module, feature 12a): the list with its filters, the row a change locks, the
// writes, and the one lookup the delivery needs: the template of an event, channel and audience (one each, decision 039).
import { and, eq, ne, sql } from 'drizzle-orm';
import type { ParsedListQuery } from '../../../common/contract';
import { type DbExecutor, type ListColumns, listOrderBy, listWhere } from '../../../infra/db';
import {
  type NewNotificationTemplate,
  type NotificationAudience,
  type NotificationChannel,
  type NotificationTemplate,
  notificationTemplates,
} from '../db/schema';

/** The columns the template list may be sorted by (wire names). */
export type TemplateSortField = 'event' | 'channel' | 'audience' | 'createdAt' | 'id';

/** The name of the unique constraint on (event, channel, audience). */
export const TEMPLATE_UNIQUE = 'notification_templates_event_uq';

const COLUMNS: ListColumns = {
  id: notificationTemplates.id,
  event: notificationTemplates.event,
  channel: notificationTemplates.channel,
  audience: notificationTemplates.audience,
  subject: notificationTemplates.subject,
  isActive: notificationTemplates.isActive,
  createdAt: notificationTemplates.createdAt,
};

/**
 * Lists templates.
 *
 * @param db the database or a transaction
 * @param query the parsed list request (filters `audience`, `channel`, `isActive`, `event`; `q` over event and subject)
 * @returns the page and the exact total for the filter
 */
export async function listTemplateRows(
  db: DbExecutor,
  query: ParsedListQuery<TemplateSortField>,
): Promise<{ rows: NotificationTemplate[]; total: number }> {
  const where = listWhere(query, COLUMNS);
  const [rows, [count]] = await Promise.all([
    db
      .select()
      .from(notificationTemplates)
      .where(where)
      .orderBy(...listOrderBy(query.sort, COLUMNS, notificationTemplates.id))
      .limit(query.range.limit)
      .offset(query.range.start),
    db
      .select({ total: sql<number>`count(*)::int` })
      .from(notificationTemplates)
      .where(where),
  ]);
  return { rows, total: count?.total ?? 0 };
}

/**
 * Reads a template.
 *
 * @param db the database or a transaction
 * @param id the row id
 * @param lock lock the row `FOR UPDATE` for the rest of the transaction
 * @returns the row, or `undefined`
 */
export async function findTemplate(
  db: DbExecutor,
  id: number,
  lock = false,
): Promise<NotificationTemplate | undefined> {
  const query = db.select().from(notificationTemplates).where(eq(notificationTemplates.id, id)).limit(1);
  const [row] = await (lock ? query.for('update') : query);
  return row;
}

/** What makes a template unique: its event, channel and audience. */
export interface TemplateKey {
  readonly event: string;
  readonly channel: NotificationChannel;
  readonly audience: NotificationAudience;
}

/**
 * Tells whether another template has the same event, channel and audience.
 *
 * @param db the database or a transaction
 * @param key the three fields that make a template unique
 * @param exceptId a row to leave out (the one being changed)
 * @returns true when such a row exists
 */
export async function templateExists(db: DbExecutor, key: TemplateKey, exceptId?: number): Promise<boolean> {
  const [row] = await db
    .select({ id: notificationTemplates.id })
    .from(notificationTemplates)
    .where(
      and(
        eq(notificationTemplates.event, key.event),
        eq(notificationTemplates.channel, key.channel),
        eq(notificationTemplates.audience, key.audience),
        exceptId === undefined ? undefined : ne(notificationTemplates.id, exceptId),
      ),
    )
    .limit(1);
  return row !== undefined;
}

/**
 * Inserts a template.
 *
 * @param db the caller's transaction
 * @param row the new row
 * @returns the stored row
 */
export async function insertTemplate(db: DbExecutor, row: NewNotificationTemplate): Promise<NotificationTemplate> {
  const [created] = await db.insert(notificationTemplates).values(row).returning();
  return created!;
}

/**
 * Updates a template.
 *
 * @param db the caller's transaction
 * @param id the row id
 * @param changes the columns to set
 * @returns the stored row
 */
export async function updateTemplate(
  db: DbExecutor,
  id: number,
  changes: Partial<NewNotificationTemplate>,
): Promise<NotificationTemplate> {
  const [updated] = await db
    .update(notificationTemplates)
    .set(changes)
    .where(eq(notificationTemplates.id, id))
    .returning();
  return updated!;
}

/**
 * Deletes a template.
 *
 * @param db the caller's transaction
 * @param id the row id
 */
export async function deleteTemplate(db: DbExecutor, id: number): Promise<void> {
  await db.delete(notificationTemplates).where(eq(notificationTemplates.id, id));
}

/**
 * Finds the template a message is written with.
 *
 * Why: RULES settings 10: the template of (event, channel, audience); there is one, because templates have no language (decision 039,
 * B226). The caller reads `isActive` of the row it gets back: a switched-off template sends nothing (`template_off`), a missing one
 * nothing either (`no_template`).
 *
 * @param db the database or a transaction
 * @param key the event, channel and audience
 * @returns the template, switched on or off, or `undefined`
 */
export async function findTemplateFor(db: DbExecutor, key: TemplateKey): Promise<NotificationTemplate | undefined> {
  const [row] = await db
    .select()
    .from(notificationTemplates)
    .where(
      and(
        eq(notificationTemplates.event, key.event),
        eq(notificationTemplates.channel, key.channel),
        eq(notificationTemplates.audience, key.audience),
      ),
    )
    .limit(1);
  return row;
}
