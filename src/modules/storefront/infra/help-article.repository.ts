// Drizzle queries on `help_articles` (the storefront module's own table): the console list and reads, the writes, and the
// published articles the public routes serve.
import { and, eq, sql } from 'drizzle-orm';
import type { ParsedListQuery } from '../../../common/contract';
import { type DbExecutor, type ListColumns, listOrderBy, listWhere } from '../../../infra/db';
import { type HelpArticle, type NewHelpArticle, helpArticles } from '../db/schema';

const COLUMNS: ListColumns = {
  id: helpArticles.id,
  sort: helpArticles.sort,
  question: helpArticles.question,
  answerMd: helpArticles.answerMd,
  category: helpArticles.category,
  isPublished: helpArticles.isPublished,
  locale: helpArticles.locale,
  createdAt: helpArticles.createdAt,
};

/** The sorts the console list accepts. */
export type HelpArticleSort = 'sort' | 'question' | 'category' | 'isPublished' | 'createdAt' | 'id';

/**
 * Lists articles for `GET /admin/help-articles`, or, with `onlyPublishedIn`, the published ones of a language for the public
 * list.
 *
 * @param db the database or a transaction
 * @param query the parsed list request
 * @param onlyPublishedIn a language: restricts the list to published articles of that language (the public route)
 * @returns the page of rows and the exact total
 */
export async function listArticles(
  db: DbExecutor,
  query: ParsedListQuery<string, unknown>,
  onlyPublishedIn?: string,
): Promise<{ rows: HelpArticle[]; total: number }> {
  const where = listWhere(
    query,
    COLUMNS,
    onlyPublishedIn === undefined
      ? undefined
      : and(eq(helpArticles.isPublished, true), eq(helpArticles.locale, onlyPublishedIn)),
  );
  const [rows, [count]] = await Promise.all([
    db
      .select()
      .from(helpArticles)
      .where(where)
      .orderBy(...listOrderBy(query.sort, COLUMNS, helpArticles.id))
      .limit(query.range.limit)
      .offset(query.range.start),
    db
      .select({ total: sql<number>`count(*)::int` })
      .from(helpArticles)
      .where(where),
  ]);
  return { rows, total: count?.total ?? 0 };
}

/**
 * Finds an article, optionally locking it for the rest of the transaction.
 *
 * @param db the database or a transaction
 * @param id the article id
 * @param lock `true` takes `FOR UPDATE`
 * @returns the article, or `undefined`
 */
export async function findArticle(db: DbExecutor, id: number, lock = false): Promise<HelpArticle | undefined> {
  const query = db.select().from(helpArticles).where(eq(helpArticles.id, id)).limit(1);
  const [row] = await (lock ? query.for('update') : query);
  return row;
}

/**
 * Finds a published article for the public route.
 *
 * @param db the database or a transaction
 * @param id the article id
 * @returns the article, or `undefined` when it is unknown or not published
 */
export async function findPublishedArticle(db: DbExecutor, id: number): Promise<HelpArticle | undefined> {
  const [row] = await db
    .select()
    .from(helpArticles)
    .where(and(eq(helpArticles.id, id), eq(helpArticles.isPublished, true)))
    .limit(1);
  return row;
}

/**
 * Inserts an article at the end of the order.
 *
 * Why: a new article goes last (`sort` = the largest plus one); the subquery keeps the choice in the same statement as the
 * insert.
 *
 * @param db the caller's transaction
 * @param values the new row without `sort`
 * @returns the stored row
 */
export async function insertArticle(db: DbExecutor, values: Omit<NewHelpArticle, 'sort'>): Promise<HelpArticle> {
  const [row] = await db
    .insert(helpArticles)
    .values({ ...values, sort: sql`(select coalesce(max(${helpArticles.sort}), 0) + 1 from ${helpArticles})` })
    .returning();
  return row!;
}

/**
 * Updates an article.
 *
 * @param db the caller's transaction
 * @param id the article id
 * @param changes the columns to set
 * @returns the updated row
 */
export async function updateArticle(
  db: DbExecutor,
  id: number,
  changes: Partial<NewHelpArticle>,
): Promise<HelpArticle> {
  const [row] = await db.update(helpArticles).set(changes).where(eq(helpArticles.id, id)).returning();
  return row!;
}
