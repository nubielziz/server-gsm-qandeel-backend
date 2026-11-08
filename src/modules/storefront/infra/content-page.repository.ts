// Drizzle queries on `content_pages` (the storefront module's own table): the console list and reads, the writes, and the
// published page the public route serves.
import { and, eq, inArray, ne, sql } from 'drizzle-orm';
import type { ParsedListQuery } from '../../../common/contract';
import { type DbExecutor, type ListColumns, listOrderBy, listWhere } from '../../../infra/db';
import { type ContentPage, type NewContentPage, contentPages } from '../db/schema';

const COLUMNS: ListColumns = {
  id: contentPages.id,
  kind: contentPages.kind,
  slug: contentPages.slug,
  locale: contentPages.locale,
  title: contentPages.title,
  status: contentPages.status,
  updatedAt: contentPages.updatedAt,
  createdAt: contentPages.createdAt,
  publishedAt: contentPages.publishedAt,
};

/** The sorts `GET /admin/content-pages` accepts. */
export type ContentPageSort = 'updatedAt' | 'title' | 'status' | 'createdAt' | 'publishedAt' | 'slug' | 'id';

/**
 * Lists pages for `GET /admin/content-pages`.
 *
 * @param db the database or a transaction
 * @param query the parsed list request
 * @returns the page of rows and the exact total
 */
export async function listPages(
  db: DbExecutor,
  query: ParsedListQuery<ContentPageSort>,
): Promise<{ rows: ContentPage[]; total: number }> {
  const where = listWhere(query, COLUMNS);
  const [rows, [count]] = await Promise.all([
    db
      .select()
      .from(contentPages)
      .where(where)
      .orderBy(...listOrderBy(query.sort, COLUMNS, contentPages.id))
      .limit(query.range.limit)
      .offset(query.range.start),
    db
      .select({ total: sql<number>`count(*)::int` })
      .from(contentPages)
      .where(where),
  ]);
  return { rows, total: count?.total ?? 0 };
}

/**
 * Finds a page, optionally locking it for the rest of the transaction.
 *
 * @param db the database or a transaction
 * @param id the page id
 * @param lock `true` takes `FOR UPDATE` (a change or a publish must not interleave with another)
 * @returns the page, or `undefined`
 */
export async function findPage(db: DbExecutor, id: number, lock = false): Promise<ContentPage | undefined> {
  const query = db.select().from(contentPages).where(eq(contentPages.id, id)).limit(1);
  const [row] = await (lock ? query.for('update') : query);
  return row;
}

/**
 * Tells whether a slug is used in a language, ignoring one page.
 *
 * @param db the database or a transaction
 * @param locale the language
 * @param slug the slug
 * @param exceptId the page being changed
 * @returns true when another page uses it
 */
export async function pageSlugTaken(db: DbExecutor, locale: string, slug: string, exceptId?: number): Promise<boolean> {
  const same = and(eq(contentPages.locale, locale), eq(contentPages.slug, slug));
  const [row] = await db
    .select({ id: contentPages.id })
    .from(contentPages)
    .where(exceptId === undefined ? same : and(same, ne(contentPages.id, exceptId)))
    .limit(1);
  return row !== undefined;
}

/**
 * Inserts a page.
 *
 * @param db the caller's transaction
 * @param values the new row
 * @returns the stored row
 * @throws a unique violation of `content_pages_slug_uq`
 */
export async function insertPage(db: DbExecutor, values: NewContentPage): Promise<ContentPage> {
  const [row] = await db.insert(contentPages).values(values).returning();
  return row!;
}

/**
 * Updates a page.
 *
 * @param db the caller's transaction
 * @param id the page id
 * @param changes the columns to set
 * @returns the updated row
 * @throws a unique violation of `content_pages_slug_uq`
 */
export async function updatePage(db: DbExecutor, id: number, changes: Partial<NewContentPage>): Promise<ContentPage> {
  const [row] = await db.update(contentPages).set(changes).where(eq(contentPages.id, id)).returning();
  return row!;
}

/**
 * Finds the page the public route serves: live (`published` or `noindex`) for a slug and language.
 *
 * @param db the database or a transaction
 * @param slug the slug
 * @param locale the language
 * @returns the page, or `undefined` for an unknown slug or a draft
 */
export async function findLivePage(db: DbExecutor, slug: string, locale: string): Promise<ContentPage | undefined> {
  const [row] = await db
    .select()
    .from(contentPages)
    .where(
      and(
        eq(contentPages.slug, slug),
        eq(contentPages.locale, locale),
        inArray(contentPages.status, ['published', 'noindex']),
      ),
    )
    .limit(1);
  return row;
}

/**
 * Inserts several pages, leaving out the ones whose slug is taken in their language.
 *
 * Why: the landing-page generator makes up to 50 drafts in one statement; a draft that another request created a moment earlier is
 * skipped instead of failing the whole run (`ON CONFLICT (locale, slug) DO NOTHING`).
 *
 * @param db the caller's transaction
 * @param values the new rows (at least one)
 * @returns the rows that were created, by ascending id
 */
export async function insertPagesSkippingTaken(db: DbExecutor, values: NewContentPage[]): Promise<ContentPage[]> {
  if (values.length === 0) return [];
  const rows = await db
    .insert(contentPages)
    .values(values)
    .onConflictDoNothing({ target: [contentPages.locale, contentPages.slug] })
    .returning();
  return rows.sort((a, b) => a.id - b.id);
}

/**
 * Lists which of some slugs are already used in a language.
 *
 * @param db the database or a transaction
 * @param locale the language
 * @param slugs the slugs to look for
 * @returns the slugs that exist
 */
export async function takenSlugs(db: DbExecutor, locale: string, slugs: readonly string[]): Promise<Set<string>> {
  if (slugs.length === 0) return new Set();
  const rows = await db
    .select({ slug: contentPages.slug })
    .from(contentPages)
    .where(and(eq(contentPages.locale, locale), inArray(contentPages.slug, [...slugs])));
  return new Set(rows.map((row) => row.slug));
}
