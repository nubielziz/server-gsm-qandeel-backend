// Drizzle queries on `content_pages` (the storefront module's own table): the console list and reads, the writes, and the
// published page the public route serves. Every read keeps to the two kinds a page can have (decision 068, see `isKnownKind`).
import { and, eq, inArray, ne, sql } from 'drizzle-orm';
import type { ParsedListQuery } from '../../../common/contract';
import { type DbExecutor, type ListColumns, listOrderBy, listWhere } from '../../../infra/db';
import { CONTENT_PAGE_KINDS, type ContentPage, type NewContentPage, contentPages } from '../db/schema';

/**
 * Keeps a read to the kinds a page can have: `static` and `blog`.
 *
 * Why: decision 068 retired the five landing kinds and deletes their rows in migration 0069. The check constraint then refuses them, so this
 * only matters for the moments before that migration ran (a new API on an old database) or for a backup restored from before it:
 * a landing row is then invisible, never answered as a page the wire schema no longer describes.
 */
const isKnownKind = inArray(contentPages.kind, [...CONTENT_PAGE_KINDS]);

const COLUMNS: ListColumns = {
  id: contentPages.id,
  kind: contentPages.kind,
  slug: contentPages.slug,
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
  const where = listWhere(query, COLUMNS, isKnownKind);
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
  const query = db
    .select()
    .from(contentPages)
    .where(and(eq(contentPages.id, id), isKnownKind))
    .limit(1);
  const [row] = await (lock ? query.for('update') : query);
  return row;
}

/**
 * Tells whether a slug is used, ignoring one page.
 *
 * Why: a slug is unique for the site (decision 039: `content_pages_slug_uq (slug)`).
 *
 * @param db the database or a transaction
 * @param slug the slug
 * @param exceptId the page being changed
 * @returns true when another page uses it
 */
export async function pageSlugTaken(db: DbExecutor, slug: string, exceptId?: number): Promise<boolean> {
  const same = eq(contentPages.slug, slug);
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
 * Finds the page the public route serves: live (`published` or `noindex`) for a slug.
 *
 * @param db the database or a transaction
 * @param slug the slug
 * @returns the page, or `undefined` for an unknown slug or a draft
 */
export async function findLivePage(db: DbExecutor, slug: string): Promise<ContentPage | undefined> {
  const [row] = await db
    .select()
    .from(contentPages)
    .where(and(eq(contentPages.slug, slug), inArray(contentPages.status, ['published', 'noindex']), isKnownKind))
    .limit(1);
  return row;
}

/** The sorts the public page list accepts. */
export type PublicPageSort = 'publishedAt' | 'title' | 'id';

/**
 * Lists the live pages for `GET /store/v1/pages`.
 *
 * Why: the storefront builds its blog index and sitemap from this list (feature 22, D-15a). Only `published` and `noindex` pages are
 * live; a draft never is, and legal documents are a different table, so they are not listed.
 *
 * @param db the database or a transaction
 * @param query the parsed list request (`kind` filter, `q` over the title, sort, range)
 * @returns the page of rows and the exact total
 */
export async function listLivePages(
  db: DbExecutor,
  query: ParsedListQuery<PublicPageSort, unknown>,
): Promise<{ rows: ContentPage[]; total: number }> {
  const where = listWhere(query, COLUMNS, and(inArray(contentPages.status, ['published', 'noindex']), isKnownKind));
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
