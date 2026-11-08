// Drizzle queries on `reply_templates` (feature 17): the list with its filters, one template, the writes, and the shortcut lookup that
// names the template that already owns a shortcut.
import { and, count, eq, ne, sql } from 'drizzle-orm';
import type { ParsedListQuery } from '../../../common/contract';
import { type DbExecutor, type ListColumns, listOrderBy, listWhere } from '../../../infra/db';
import { type NewReplyTemplate, type ReplyTemplate, replyTemplates } from '../db/schema';

/** The sorts of the template list. */
export type TemplateSortField = 'title' | 'category' | 'createdAt' | 'updatedAt' | 'id';

/** The name of the unique index on the lower-cased shortcut. */
export const SHORTCUT_UNIQUE = 'reply_templates_shortcut_uq';

const COLUMNS: ListColumns = {
  id: replyTemplates.id,
  title: replyTemplates.title,
  body: replyTemplates.body,
  shortcut: replyTemplates.shortcut,
  category: replyTemplates.category,
  locale: replyTemplates.locale,
  createdAt: replyTemplates.createdAt,
  updatedAt: replyTemplates.updatedAt,
};

/**
 * Lists reply templates for `GET /admin/reply-templates`.
 *
 * @param db the database or a transaction
 * @param query the parsed list request (`q` matches the title, the body and the shortcut)
 * @returns the page of templates and the exact total
 */
export async function listTemplateRows(
  db: DbExecutor,
  query: ParsedListQuery<TemplateSortField>,
): Promise<{ rows: ReplyTemplate[]; total: number }> {
  const where = listWhere(query, COLUMNS);
  const [rows, [total]] = await Promise.all([
    db
      .select()
      .from(replyTemplates)
      .where(where)
      .orderBy(...listOrderBy(query.sort, COLUMNS, replyTemplates.id))
      .limit(query.range.limit)
      .offset(query.range.start),
    db.select({ total: count() }).from(replyTemplates).where(where),
  ]);
  return { rows, total: total?.total ?? 0 };
}

/**
 * Reads one template.
 *
 * @param db the database or a transaction
 * @param id the template id
 * @returns the template, or `undefined`
 */
export async function findTemplate(db: DbExecutor, id: number): Promise<ReplyTemplate | undefined> {
  const [row] = await db.select().from(replyTemplates).where(eq(replyTemplates.id, id)).limit(1);
  return row;
}

/**
 * Reads one template and locks it for the rest of the transaction.
 *
 * @param db the transaction
 * @param id the template id
 * @returns the template, or `undefined`
 */
export async function lockTemplate(db: DbExecutor, id: number): Promise<ReplyTemplate | undefined> {
  const [row] = await db.select().from(replyTemplates).where(eq(replyTemplates.id, id)).limit(1).for('update');
  return row;
}

/**
 * Finds the template that has a shortcut, ignoring case.
 *
 * Why: SHORTCUT_TAKEN names the template that owns the shortcut (the mock's detail: "/refund already belongs to “title”").
 *
 * @param db the database or a transaction
 * @param shortcut the trimmed, non-empty shortcut
 * @param exceptId the template being changed, left out
 * @returns the owner, or `undefined`
 */
export async function findShortcutOwner(
  db: DbExecutor,
  shortcut: string,
  exceptId?: number,
): Promise<ReplyTemplate | undefined> {
  const same = sql`lower(${replyTemplates.shortcut}) = lower(${shortcut})`;
  const [row] = await db
    .select()
    .from(replyTemplates)
    .where(exceptId === undefined ? same : and(same, ne(replyTemplates.id, exceptId)))
    .limit(1);
  return row;
}

/**
 * Inserts a template.
 *
 * @param db the transaction
 * @param row the new template
 * @returns the stored template
 */
export async function insertTemplate(db: DbExecutor, row: NewReplyTemplate): Promise<ReplyTemplate> {
  const [created] = await db.insert(replyTemplates).values(row).returning();
  return created!;
}

/**
 * Changes a template.
 *
 * @param db the transaction
 * @param id the template id
 * @param changes the columns to set (callers always set `updatedAt` from the clock)
 * @returns the stored template
 */
export async function updateTemplate(
  db: DbExecutor,
  id: number,
  changes: Partial<Omit<NewReplyTemplate, 'id'>>,
): Promise<ReplyTemplate> {
  const [row] = await db.update(replyTemplates).set(changes).where(eq(replyTemplates.id, id)).returning();
  return row!;
}

/**
 * Deletes a template.
 *
 * @param db the transaction
 * @param id the template id
 */
export async function deleteTemplate(db: DbExecutor, id: number): Promise<void> {
  await db.delete(replyTemplates).where(eq(replyTemplates.id, id));
}
