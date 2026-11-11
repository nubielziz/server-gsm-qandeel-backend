// Drizzle queries on `service_listings` (the storefront module's own table): the public catalog reads (the page of listed service
// pages, one page by slug, the FAQs of a service; feature 14a) and the admin writes (insert, switch on or off, conflict checks;
// feature 15). The joined reads of the console rows are in foreign-reads.repository.ts.
import { type SQL, and, asc, eq, inArray, ne, sql } from 'drizzle-orm';
import type { ParsedListQuery } from '../../../common/contract';
import { type DbExecutor, type ListColumns, listOrderBy, listWhere } from '../../../infra/db';
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
  locale: serviceListings.locale,
};

/** The language a request without one reads. */
export const DEFAULT_LOCALE = 'en';

/** The filters and conditions of a public list: only listed rows of the sellable ids, a language, case-insensitive text filters. */
function publicWhere(
  serviceIds: readonly number[],
  query: Pick<ParsedListQuery, 'filters' | 'search'>,
): SQL | undefined {
  const hasLocale = query.filters.some((filter) => filter.field === 'locale');
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
    hasLocale ? undefined : eq(serviceListings.locale, DEFAULT_LOCALE),
    inArray(serviceListings.serviceId, [...serviceIds]),
  );
}

/**
 * Lists one page of the listed service pages that can be sold.
 *
 * Why: the public list shows a listing only when it is switched on (`is_listed`) and its service is one the catalog says the
 * storefront may sell and has priced (`serviceIds`), so the total is exact. The language defaults to English; `brand`,
 * `network` and `country` match case-insensitively. The sorts `popular` (the stored 30-day sales) and `listedAt` are columns;
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
 * Finds which of some services have a switched-on service page in any language.
 *
 * Why: catalog-3 and the checkout rule of feature 14a: a service is public only when staff switched a `service_listings` row
 * on for it, so the list, the page and the checkout (and the pre-order IMEI check) all ask this one question. A service whose
 * only switched-on page is in another language than the buyer's is still one the shop sells.
 *
 * @param db the database or a transaction
 * @param serviceIds the services to check
 * @returns the ids that have at least one listing with `is_listed = true`
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
 * Finds a listed service page by its slug in a language.
 *
 * @param db the database or a transaction
 * @param locale the language
 * @param slug the slug
 * @returns the listing, or `undefined` when it does not exist or is not switched on
 */
export async function findListedBySlug(
  db: DbExecutor,
  locale: string,
  slug: string,
): Promise<ServiceListing | undefined> {
  const [row] = await db
    .select()
    .from(serviceListings)
    .where(and(eq(serviceListings.locale, locale), eq(serviceListings.slug, slug), eq(serviceListings.isListed, true)))
    .limit(1);
  return row;
}

/**
 * Reads the published FAQs linked to a service in a language.
 *
 * @param db the database or a transaction
 * @param serviceId the service
 * @param locale the language
 * @returns the articles by `sort`, then id
 */
export async function findServiceFaqs(db: DbExecutor, serviceId: number, locale: string): Promise<HelpArticle[]> {
  return db
    .select()
    .from(helpArticles)
    .where(
      and(eq(helpArticles.serviceId, serviceId), eq(helpArticles.locale, locale), eq(helpArticles.isPublished, true)),
    )
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
 * @throws a unique violation of `service_listings_service_locale_uq` or `service_listings_slug_uq`
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

/** The columns of a listing that belong to one language. */
export type ListingLanguageChanges = Partial<
  Pick<
    NewServiceListing,
    'publicTitle' | 'slug' | 'summary' | 'descriptionMd' | 'requirementsMd' | 'etaText' | 'seoTitle' | 'seoDescription'
  >
>;

/** The columns of a listing that describe the service, written to every language row. */
export type ListingServiceFacts = Partial<
  Pick<NewServiceListing, 'brand' | 'carrier' | 'country' | 'isFeatured' | 'sort'>
>;

/**
 * Locks every listing row of a service, in id order.
 *
 * Why: neutral facts are written to every language row, so a writer takes all of them before it reads or writes (the popularity
 * job also locks rows in id order, so the two cannot deadlock). The caller already holds the service row lock.
 *
 * @param db the caller's transaction
 * @param serviceId the service
 * @returns the rows, oldest first
 */
export async function lockServiceListings(db: DbExecutor, serviceId: number): Promise<ServiceListing[]> {
  return db
    .select()
    .from(serviceListings)
    .where(eq(serviceListings.serviceId, serviceId))
    .orderBy(asc(serviceListings.id))
    .for('update');
}

/**
 * Changes the per-language columns of one listing.
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
  changes: ListingLanguageChanges,
): Promise<ServiceListing> {
  const [row] = await db.update(serviceListings).set(changes).where(eq(serviceListings.id, id)).returning();
  return row!;
}

/**
 * Writes the facts of a service to every listing row of the service.
 *
 * @param db the caller's transaction (it holds the service lock and the rows' locks)
 * @param serviceId the service
 * @param facts the columns to set (at least one)
 */
export async function updateServiceFacts(db: DbExecutor, serviceId: number, facts: ListingServiceFacts): Promise<void> {
  await db.update(serviceListings).set(facts).where(eq(serviceListings.serviceId, serviceId));
}

/**
 * Sets (or clears) the picture of a service on every listing row of the service.
 *
 * Why: the picture describes the service, not a translation (feature 22), like the other facts.
 *
 * @param db the caller's transaction (it holds the service lock and the rows' locks)
 * @param serviceId the service
 * @param fileId the `files` row of the stored picture, or `null` to remove it
 */
export async function setServiceImage(db: DbExecutor, serviceId: number, fileId: number | null): Promise<void> {
  await db.update(serviceListings).set({ imageFileId: fileId }).where(eq(serviceListings.serviceId, serviceId));
}

/** The facts a new listing copies from the service's oldest listing: the editable ones and the picture. */
export type InheritedListingFacts = Required<ListingServiceFacts> & { readonly imageFileId: number | null };

/**
 * Reads the facts of the oldest listing of a service, which a new listing in another language copies.
 *
 * @param db the caller's transaction
 * @param serviceId the service
 * @returns the facts and the picture, or `undefined` when the service has no listing yet
 */
export async function siblingFacts(db: DbExecutor, serviceId: number): Promise<InheritedListingFacts | undefined> {
  const [row] = await db
    .select({
      brand: serviceListings.brand,
      carrier: serviceListings.carrier,
      country: serviceListings.country,
      isFeatured: serviceListings.isFeatured,
      sort: serviceListings.sort,
      imageFileId: serviceListings.imageFileId,
    })
    .from(serviceListings)
    .where(eq(serviceListings.serviceId, serviceId))
    .orderBy(asc(serviceListings.id))
    .limit(1);
  return row;
}

/**
 * Tells whether a slug is used by another listing of a language.
 *
 * @param db the database or a transaction
 * @param locale the language
 * @param slug the slug
 * @param exceptId the listing being changed
 * @returns true when another listing of the language has the slug
 */
export async function slugTaken(db: DbExecutor, locale: string, slug: string, exceptId: number): Promise<boolean> {
  const [row] = await db
    .select({ id: serviceListings.id })
    .from(serviceListings)
    .where(and(eq(serviceListings.locale, locale), eq(serviceListings.slug, slug), ne(serviceListings.id, exceptId)))
    .limit(1);
  return row !== undefined;
}

/** A switched-on page of a service in another language: what the language switch needs. */
export interface ListingAlternate {
  readonly locale: string;
  readonly slug: string;
}

/**
 * Finds the switched-on pages of a service in the other languages.
 *
 * @param db the database or a transaction
 * @param serviceId the service
 * @param exceptLocale the language of the page being read
 * @returns the other languages' listed slugs, by language
 */
export async function findSiblingSlugs(
  db: DbExecutor,
  serviceId: number,
  exceptLocale: string,
): Promise<ListingAlternate[]> {
  return db
    .select({ locale: serviceListings.locale, slug: serviceListings.slug })
    .from(serviceListings)
    .where(
      and(
        eq(serviceListings.serviceId, serviceId),
        eq(serviceListings.isListed, true),
        ne(serviceListings.locale, exceptLocale),
      ),
    )
    .orderBy(asc(serviceListings.locale));
}

/**
 * Finds which of some services have a switched-on page in a language.
 *
 * Why: the storefront menu counts categories per language, and a service whose only page is in another language must not count.
 *
 * @param db the database or a transaction
 * @param serviceIds the services to check
 * @param locale the language
 * @returns the service ids that have a listed page in the language
 */
export async function listedServiceIdsIn(
  db: DbExecutor,
  serviceIds: readonly number[],
  locale: string,
): Promise<Set<number>> {
  if (serviceIds.length === 0) return new Set();
  const rows = await db
    .select({ serviceId: serviceListings.serviceId })
    .from(serviceListings)
    .where(
      and(
        eq(serviceListings.isListed, true),
        eq(serviceListings.locale, locale),
        inArray(serviceListings.serviceId, [...serviceIds]),
      ),
    );
  return new Set(rows.map((row) => row.serviceId));
}

/**
 * Tells whether a listing already exists for a service and language, or a slug is used in a language.
 *
 * @param db the database or a transaction
 * @param serviceId the service
 * @param locale the language
 * @param slug the slug
 * @returns which rule the new listing would break, or `undefined` when none
 */
export async function listingConflict(
  db: DbExecutor,
  serviceId: number,
  locale: string,
  slug: string,
): Promise<'serviceId' | 'slug' | undefined> {
  const [sameService] = await db
    .select({ id: serviceListings.id })
    .from(serviceListings)
    .where(and(eq(serviceListings.serviceId, serviceId), eq(serviceListings.locale, locale)))
    .limit(1);
  if (sameService) return 'serviceId';
  const [sameSlug] = await db
    .select({ id: serviceListings.id })
    .from(serviceListings)
    .where(and(eq(serviceListings.locale, locale), eq(serviceListings.slug, slug)))
    .limit(1);
  return sameSlug ? 'slug' : undefined;
}
