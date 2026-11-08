// Drizzle queries on `service_listings` (the storefront module's own table): the public catalog reads (the page of listed service
// pages, one page by slug, the FAQs of a service; feature 14a) and the admin writes (insert, switch on or off, conflict checks;
// feature 15). The joined reads of the console rows are in foreign-reads.repository.ts.
import { and, asc, eq, inArray, sql } from 'drizzle-orm';
import type { ParsedListQuery } from '../../../common/contract';
import { type DbExecutor, type ListColumns, listOrderBy, listWhere } from '../../../infra/db';
import {
  type HelpArticle,
  type NewServiceListing,
  type ServiceListing,
  helpArticles,
  serviceListings,
} from '../db/schema';

/** The sort fields of the public service list. */
export type ListingSort = 'featured' | 'sort' | 'title';

/** The wire fields the public list filters and searches, mapped to columns. */
const COLUMNS: ListColumns = {
  featured: serviceListings.isFeatured,
  sort: serviceListings.sort,
  title: serviceListings.publicTitle,
  summary: serviceListings.summary,
  brand: serviceListings.brand,
  network: serviceListings.carrier,
  country: serviceListings.country,
  locale: serviceListings.locale,
};

/** The language a request without one reads. */
export const DEFAULT_LOCALE = 'en';

/**
 * Lists one page of the listed service pages that can be sold.
 *
 * Why: the public list shows a listing only when it is switched on (`is_listed`) and its service is one the catalog says the
 * storefront may sell and has priced (`serviceIds`), so the total is exact. The language defaults to English; `brand`,
 * `network` and `country` match case-insensitively.
 *
 * @param db the database or a transaction
 * @param serviceIds the sellable and priced service ids (catalog)
 * @param query the parsed list request (filters, search, sort, range)
 * @returns the page of listings and the exact total
 */
export async function pageListings(
  db: DbExecutor,
  serviceIds: readonly number[],
  query: ParsedListQuery<ListingSort, unknown>,
): Promise<{ rows: ServiceListing[]; total: number }> {
  if (serviceIds.length === 0) return { rows: [], total: 0 };
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
  const where = listWhere(
    { filters, search: query.search },
    lowered,
    eq(serviceListings.isListed, true),
    hasLocale ? undefined : eq(serviceListings.locale, DEFAULT_LOCALE),
    inArray(serviceListings.serviceId, [...serviceIds]),
  );
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
 * @param db the caller's transaction
 * @param id the listing id
 * @param isListed the new value
 * @returns the updated row
 */
export async function setListed(db: DbExecutor, id: number, isListed: boolean): Promise<ServiceListing> {
  const [row] = await db.update(serviceListings).set({ isListed }).where(eq(serviceListings.id, id)).returning();
  return row!;
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
