// Drizzle queries on `service_listings` (the storefront module's own table): the public catalog reads (the page of listed service
// pages, one page by slug, the FAQs of a service; feature 14a), the admin writes (insert, switch on or off, conflict checks; feature
// 15) and the bulk publish's lock and slug reads (feature 31). One listing per service since feature 30 (decision 039). The joined
// reads of the console rows are in foreign-reads.repository.ts.
import { type SQL, and, asc, eq, inArray, like, ne, sql } from 'drizzle-orm';
import type { ParsedListQuery } from '../../../common/contract';
import { type DbExecutor, type ListColumns, escapeLike, listOrderBy, listWhere } from '../../../infra/db';
import {
  type HelpArticle,
  type NewServiceListing,
  type ServiceListing,
  helpArticles,
  serviceListings,
} from '../db/schema';

/** The sort fields of the public service list; `price` is applied in code (the price is not a column), see `allListings`. */
export type ListingSort = 'featured' | 'sort' | 'title' | 'popular' | 'listedAt' | 'price';

/** The wire fields the public list filters and searches, mapped to columns. */
const COLUMNS: ListColumns = {
  featured: serviceListings.isFeatured,
  sort: serviceListings.sort,
  title: serviceListings.publicTitle,
  popular: serviceListings.sales30d,
  listedAt: serviceListings.listedAt,
  summary: serviceListings.summary,
  brand: serviceListings.brand,
  network: serviceListings.carrier,
  country: serviceListings.country,
};

/** The filters and conditions of a public list: only listed rows of the sellable ids, case-insensitive text filters. */
function publicWhere(
  serviceIds: readonly number[],
  query: Pick<ParsedListQuery, 'filters' | 'search'>,
): SQL | undefined {
  // brand, network and country compare case-insensitively: staff type them by hand.
  const filters = query.filters.map((filter) =>
    ['brand', 'network', 'country'].includes(filter.field) && filter.op === 'eq'
      ? { ...filter, values: filter.values.map((value) => String(value).toLowerCase()) }
      : filter,
  );
  const lowered: ListColumns = {
    ...COLUMNS,
    brand: sql`lower(${serviceListings.brand})`,
    network: sql`lower(${serviceListings.carrier})`,
    country: sql`lower(${serviceListings.country})`,
  };
  return listWhere(
    { filters, search: query.search },
    lowered,
    eq(serviceListings.isListed, true),
    inArray(serviceListings.serviceId, [...serviceIds]),
  );
}

/**
 * Lists one page of the listed service pages that can be sold.
 *
 * Why: the public list shows a listing only when it is switched on (`is_listed`) and its service is one the catalog says the
 * storefront may sell and has priced (`serviceIds`), so the total is exact. `brand`, `network` and `country` match
 * case-insensitively. The sorts `popular` (the stored 30-day sales) and `listedAt` are columns;
 * `price` is not, so a request that sorts by it goes through {@link allListings} instead.
 *
 * @param db the database or a transaction
 * @param serviceIds the sellable and priced service ids (catalog)
 * @param query the parsed list request (filters, search, sort, range); its sort must not name `price`
 * @returns the page of listings and the exact total
 */
export async function pageListings(
  db: DbExecutor,
  serviceIds: readonly number[],
  query: ParsedListQuery<ListingSort, unknown>,
): Promise<{ rows: ServiceListing[]; total: number }> {
  if (serviceIds.length === 0) return { rows: [], total: 0 };
  const where = publicWhere(serviceIds, query);
  const [rows, [count]] = await Promise.all([
    db
      .select()
      .from(serviceListings)
      .where(where)
      .orderBy(...listOrderBy(query.sort, COLUMNS, serviceListings.id))
      .limit(query.range.limit)
      .offset(query.range.start),
    db
      .select({ total: sql<number>`count(*)::int` })
      .from(serviceListings)
      .where(where),
  ]);
  return { rows, total: count?.total ?? 0 };
}

/** The most listings {@link allListings} returns: the same ceiling as the priced ids of the catalog. */
export const MAX_ALL_LISTINGS = 10_000;

/**
 * Reads every listed service page that matches a public list request, in the request's order, without paging.
 *
 * Why: a filter or sort on the price cannot be SQL (the price is `max(retail row, floor)` worked out in code, plus tax and the
 * exchange rate), so those requests read all matches, price them, filter and sort in code and slice the page themselves. The
 * `price` sort key is left out of the SQL order; the caller applies it (stable, so ties keep this order).
 *
 * @param db the database or a transaction
 * @param serviceIds the sellable and priced service ids (catalog)
 * @param query the parsed list request; the range is ignored
 * @returns the matching listings, at most {@link MAX_ALL_LISTINGS}
 */
export async function allListings(
  db: DbExecutor,
  serviceIds: readonly number[],
  query: ParsedListQuery<ListingSort, unknown>,
): Promise<ServiceListing[]> {
  if (serviceIds.length === 0) return [];
  const sort = query.sort.filter((key) => key.field !== 'price');
  return db
    .select()
    .from(serviceListings)
    .where(publicWhere(serviceIds, query))
    .orderBy(...listOrderBy(sort, COLUMNS, serviceListings.id))
    .limit(MAX_ALL_LISTINGS);
}

/**
 * Finds which of some services have a switched-on service page.
 *
 * Why: catalog-3 and the checkout rule of feature 14a: a service is public only when staff switched its `service_listings` row
 * on, so the list, the page, the checkout (and the pre-order IMEI check), the category menu and the search (its searchable rule,
 * decision 038) all ask this one question. A service has one listing (decision 039), so what is buyable and what is searchable
 * cannot drift apart by language.
 *
 * @param db the database or a transaction
 * @param serviceIds the services to check
 * @returns the ids whose listing has `is_listed = true`
 */
export async function listedServiceIds(db: DbExecutor, serviceIds: readonly number[]): Promise<Set<number>> {
  if (serviceIds.length === 0) return new Set();
  const rows = await db
    .selectDistinct({ serviceId: serviceListings.serviceId })
    .from(serviceListings)
    .where(and(eq(serviceListings.isListed, true), inArray(serviceListings.serviceId, [...serviceIds])));
  return new Set(rows.map((row) => row.serviceId));
}

/**
 * Finds which of some services have a listing, switched on or off.
 *
 * Why: plan 31 sections 3.1 and 5.2: a service has one listing (decision 039), and a draft row for a service that has one is
 * `blocked: already_listed` whether or not the listing is on the shop (`listedServiceIds` asks only about the switch).
 *
 * @param db the database or a transaction
 * @param serviceIds the services to check
 * @returns the ids that have a listing
 */
export async function servicesWithListing(db: DbExecutor, serviceIds: readonly number[]): Promise<Set<number>> {
  if (serviceIds.length === 0) return new Set();
  const rows = await db
    .select({ serviceId: serviceListings.serviceId })
    .from(serviceListings)
    .where(inArray(serviceListings.serviceId, [...serviceIds]));
  return new Set(rows.map((row) => row.serviceId));
}

/** The public title and the slug of a listing. */
export interface ListingNames {
  readonly publicTitle: string;
  readonly slug: string;
}

/**
 * Reads the public title and the slug of every listing.
 *
 * Why: plan 31 sections 3.5 and 6.1: the cut and the uniqueness checks of the naming compare a draft's titles with the listings'
 * (`listingTitles`), and the slug ladder needs every slug held. Two columns, at most {@link MAX_ALL_LISTINGS} rows (fact 22).
 *
 * @param db the database or a transaction
 * @returns the titles and slugs, in id order
 */
export async function listingNamesOfAll(db: DbExecutor): Promise<ListingNames[]> {
  return db
    .select({ publicTitle: serviceListings.publicTitle, slug: serviceListings.slug })
    .from(serviceListings)
    .orderBy(asc(serviceListings.id))
    .limit(MAX_ALL_LISTINGS);
}

/**
 * Finds a listed service page by its slug.
 *
 * @param db the database or a transaction
 * @param slug the slug
 * @returns the listing, or `undefined` when it does not exist or is not switched on
 */
export async function findListedBySlug(db: DbExecutor, slug: string): Promise<ServiceListing | undefined> {
  const [row] = await db
    .select()
    .from(serviceListings)
    .where(and(eq(serviceListings.slug, slug), eq(serviceListings.isListed, true)))
    .limit(1);
  return row;
}

/**
 * Finds the switched-on listing of a service.
 *
 * Why: an old address of a service (`legacy_slugs`, decision 039) leads to the English page of the same service; a service has
 * one listing, found by its id.
 *
 * @param db the database or a transaction
 * @param serviceId the service
 * @returns the listing, or `undefined` when the service has none or it is not switched on
 */
export async function findListedOfService(db: DbExecutor, serviceId: number): Promise<ServiceListing | undefined> {
  const [row] = await db
    .select()
    .from(serviceListings)
    .where(and(eq(serviceListings.serviceId, serviceId), eq(serviceListings.isListed, true)))
    .limit(1);
  return row;
}

/**
 * Reads the published FAQs linked to a service.
 *
 * @param db the database or a transaction
 * @param serviceId the service
 * @returns the articles by `sort`, then id
 */
export async function findServiceFaqs(db: DbExecutor, serviceId: number): Promise<HelpArticle[]> {
  return db
    .select()
    .from(helpArticles)
    .where(and(eq(helpArticles.serviceId, serviceId), eq(helpArticles.isPublished, true)))
    .orderBy(asc(helpArticles.sort), asc(helpArticles.id));
}

/**
 * Finds a listing row without its service.
 *
 * @param db the database or a transaction
 * @param id the listing id
 * @returns the row, or `undefined`
 */
export async function findListing(db: DbExecutor, id: number): Promise<ServiceListing | undefined> {
  const [row] = await db.select().from(serviceListings).where(eq(serviceListings.id, id)).limit(1);
  return row;
}

/**
 * Inserts a listing.
 *
 * @param db the caller's transaction
 * @param values the new row
 * @returns the stored row
 * @throws a unique violation of `service_listings_service_uq` or `service_listings_slug_uq`
 */
export async function insertListing(db: DbExecutor, values: NewServiceListing): Promise<ServiceListing> {
  const [row] = await db.insert(serviceListings).values(values).returning();
  return row!;
}

/**
 * Switches a listing on or off the site.
 *
 * Why: `listed_at` is the first publication (feature 22, "new arrivals"): switching on sets it when it is empty and never moves
 * it again, so off and on does not make a service new.
 *
 * @param db the caller's transaction
 * @param id the listing id
 * @param isListed the new value
 * @param now the injected clock's now (the moment a first publication gets)
 * @returns the updated row
 */
export async function setListed(db: DbExecutor, id: number, isListed: boolean, now: Date): Promise<ServiceListing> {
  const [row] = await db
    .update(serviceListings)
    .set(
      isListed
        ? { isListed, listedAt: sql`coalesce(${serviceListings.listedAt}, ${now.toISOString()}::timestamptz)` }
        : { isListed },
    )
    .where(eq(serviceListings.id, id))
    .returning();
  return row!;
}

/** The columns of a listing staff edit: its texts and the facts the shop filters and orders by. */
export type ListingChanges = Partial<
  Pick<
    NewServiceListing,
    | 'publicTitle'
    | 'slug'
    | 'summary'
    | 'descriptionMd'
    | 'requirementsMd'
    | 'etaText'
    | 'seoTitle'
    | 'seoDescription'
    | 'brand'
    | 'carrier'
    | 'country'
    | 'isFeatured'
    | 'sort'
  >
>;

/**
 * Locks one listing row.
 *
 * Why: a writer of a listing (the content editor, the switch, the picture) holds the service row lock first and then this row, so
 * two writers of the same listing never interleave; the popularity job locks listing rows in id order and never the service row,
 * so the two cannot deadlock.
 *
 * @param db the caller's transaction
 * @param id the listing id
 * @returns the locked row, or `undefined` when it no longer exists
 */
export async function lockListing(db: DbExecutor, id: number): Promise<ServiceListing | undefined> {
  const [row] = await db.select().from(serviceListings).where(eq(serviceListings.id, id)).for('update');
  return row;
}

/**
 * Locks the listing of a service, when it has one.
 *
 * Why: plan 31 sections 6.2 (step 5) and 6.7: the publisher and the run switch hold the service row lock first and then the
 * service's one listing (decision 039), in the lock order of every listing writer; the row tells the publisher the service is listed
 * already (`already_listed`).
 *
 * @param db the caller's transaction (it holds the service row lock)
 * @param serviceId the service
 * @returns the locked row, or `undefined` when the service has no listing
 */
export async function lockListingOfService(db: DbExecutor, serviceId: number): Promise<ServiceListing | undefined> {
  const [row] = await db.select().from(serviceListings).where(eq(serviceListings.serviceId, serviceId)).for('update');
  return row;
}

/**
 * Reads the slugs of the listings that start with a prefix.
 *
 * Why: plan 31 sections 3.2 and 6.2 (step 8): the publisher gives a proposed slug that a listing took meanwhile the next free
 * suffix (`nextFreeSlug`), which needs every slug of the family at once; the prefix is a little shorter than the base, since a long
 * base is shortened to fit its suffix.
 *
 * @param db the database or the caller's transaction
 * @param prefix the start of the slugs (a slug or a part of one)
 * @returns the slugs held, at most {@link MAX_ALL_LISTINGS}
 */
export async function slugsStartingWith(db: DbExecutor, prefix: string): Promise<Set<string>> {
  const rows = await db
    .select({ slug: serviceListings.slug })
    .from(serviceListings)
    .where(like(serviceListings.slug, `${escapeLike(prefix)}%`))
    .limit(MAX_ALL_LISTINGS);
  return new Set(rows.map((row) => row.slug));
}

/**
 * Changes the editable columns of one listing.
 *
 * @param db the caller's transaction
 * @param id the listing id
 * @param changes the columns to set (at least one)
 * @returns the updated row
 * @throws a unique violation of `service_listings_slug_uq`
 */
export async function updateListingFields(
  db: DbExecutor,
  id: number,
  changes: ListingChanges,
): Promise<ServiceListing> {
  const [row] = await db.update(serviceListings).set(changes).where(eq(serviceListings.id, id)).returning();
  return row!;
}

/**
 * Sets (or clears) the picture of a listing.
 *
 * Why: the shop shows a picture per service (feature 22); it lives on the service's one listing.
 *
 * @param db the caller's transaction (it holds the service lock and the row's lock)
 * @param id the listing id
 * @param fileId the `files` row of the stored picture, or `null` to remove it
 */
export async function setListingImage(db: DbExecutor, id: number, fileId: number | null): Promise<void> {
  await db.update(serviceListings).set({ imageFileId: fileId }).where(eq(serviceListings.id, id));
}

/**
 * Tells whether a slug is used by another listing.
 *
 * @param db the database or a transaction
 * @param slug the slug
 * @param exceptId the listing being changed
 * @returns true when another listing has the slug
 */
export async function slugTaken(db: DbExecutor, slug: string, exceptId: number): Promise<boolean> {
  const [row] = await db
    .select({ id: serviceListings.id })
    .from(serviceListings)
    .where(and(eq(serviceListings.slug, slug), ne(serviceListings.id, exceptId)))
    .limit(1);
  return row !== undefined;
}

/**
 * Tells whether a service already has a listing, or a slug is used.
 *
 * @param db the database or a transaction
 * @param serviceId the service
 * @param slug the slug
 * @returns which rule the new listing would break, or `undefined` when none
 */
export async function listingConflict(
  db: DbExecutor,
  serviceId: number,
  slug: string,
): Promise<'serviceId' | 'slug' | undefined> {
  const [sameService] = await db
    .select({ id: serviceListings.id })
    .from(serviceListings)
    .where(eq(serviceListings.serviceId, serviceId))
    .limit(1);
  if (sameService) return 'serviceId';
  const [sameSlug] = await db
    .select({ id: serviceListings.id })
    .from(serviceListings)
    .where(eq(serviceListings.slug, slug))
    .limit(1);
  return sameSlug ? 'slug' : undefined;
}
