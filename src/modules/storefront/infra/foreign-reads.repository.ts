// Read-only lookups into tables other modules own, kept in this one file: the service, its category and the retail group behind a
// listing, the storefront sales of a service, the consents that reference a legal document, and the TAC catalogue's brands and model
// names for the landing-page generator.
//
// DEVIATION to resolve when those modules export a read: decision 016 wants these reads through the owning module's public
// service. Catalog exports the price resolver and `RetailPrices` (used for every price figure and every write; the retail price
// itself is never read here) but no join that can be filtered, sorted and searched by service name and code, and no list of the TAC
// catalogue's brands and model names (`TacDirectory` finds one TAC), and orders and customers export no counts yet, so this file reads
// `services`, `service_categories`, `client_groups`, `orders`, `consent_records` and `tac_catalog` with plain selects, like catalog's
// foreign-reads file. Replace the bodies with calls to their services;
// nothing outside this file knows.
import { type SQL, and, asc, eq, gte, inArray, isNotNull, isNull, ne, sql } from 'drizzle-orm';
import type { ParsedListQuery } from '../../../common/contract';
import { type DbExecutor, type ListColumns, listOrderBy, listWhere, schema as s } from '../../../infra/db';
import type { ServiceListing } from '../db/schema';

/** A listing with the service, category and retail group facts the console row and the lock rule need. */
export interface ListingRow {
  readonly listing: ServiceListing;
  readonly service: {
    readonly id: number;
    readonly name: string;
    readonly code: string;
    readonly status: string;
  };
  readonly category: { readonly name: string; readonly allowedGroupIds: number[] };
  /** The storefront retail group, or `null` when it does not exist. */
  readonly retailGroupId: number | null;
}

/**
 * The SQL twin of `lockOf` (domain/listing-rules.ts): the category's group list excludes the retail group, or the service is
 * not active. A test keeps the two equal.
 */
export const LOCKED_SQL: SQL = sql`(
  (cardinality(${s.serviceCategories.allowedGroupIds}) > 0
    and (${s.clientGroups.id} is null or not (${s.clientGroups.id} = any(${s.serviceCategories.allowedGroupIds}))))
  or ${s.services.status} <> 'active')`;

const COLUMNS: ListColumns = {
  id: s.serviceListings.id,
  publicTitle: s.serviceListings.publicTitle,
  slug: s.serviceListings.slug,
  isListed: s.serviceListings.isListed,
  isFeatured: s.serviceListings.isFeatured,
  listedAt: s.serviceListings.listedAt,
  sort: s.serviceListings.sort,
  'service.name': s.services.name,
  'service.code': s.services.code,
  locked: LOCKED_SQL,
};

/** The sorts of `GET /admin/service-listings`. */
export type AdminListingSort = 'publicTitle' | 'isListed' | 'slug' | 'id' | 'listedAt' | 'sort';

/** The columns every listing read selects, and the joins that make an archived service disappear (RESOLUTIONS catalog-3). */
function listingSelect(db: DbExecutor) {
  return db
    .select({
      listing: s.serviceListings,
      serviceId: s.services.id,
      serviceName: s.services.name,
      serviceCode: s.services.code,
      serviceStatus: s.services.status,
      categoryName: s.serviceCategories.name,
      allowedGroupIds: s.serviceCategories.allowedGroupIds,
      retailGroupId: s.clientGroups.id,
    })
    .from(s.serviceListings)
    .innerJoin(s.services, and(eq(s.services.id, s.serviceListings.serviceId), isNull(s.services.archivedAt)))
    .innerJoin(s.serviceCategories, eq(s.serviceCategories.id, s.services.categoryId))
    .leftJoin(s.clientGroups, eq(s.clientGroups.kind, 'b2c_retail'));
}

type Selected = Awaited<ReturnType<ReturnType<typeof listingSelect>['limit']>>[number];

const toRow = (row: Selected): ListingRow => ({
  listing: row.listing,
  service: { id: row.serviceId, name: row.serviceName, code: row.serviceCode, status: row.serviceStatus },
  category: { name: row.categoryName, allowedGroupIds: row.allowedGroupIds },
  retailGroupId: row.retailGroupId,
});

/**
 * Lists listings with their service facts for `GET /admin/service-listings`.
 *
 * @param db the database or a transaction
 * @param query the parsed list request (filters `isListed`, `locked` and `isFeatured`, search over title, slug, service name and code)
 * @returns the page of rows and the exact total; listings of archived services are left out
 */
export async function listListingRows(
  db: DbExecutor,
  query: ParsedListQuery<AdminListingSort>,
): Promise<{ rows: ListingRow[]; total: number }> {
  const where = listWhere(query, COLUMNS);
  const [rows, [count]] = await Promise.all([
    listingSelect(db)
      .where(where)
      .orderBy(...listOrderBy(query.sort, COLUMNS, s.serviceListings.id))
      .limit(query.range.limit)
      .offset(query.range.start),
    db
      .select({ total: sql<number>`count(*)::int` })
      .from(s.serviceListings)
      .innerJoin(s.services, and(eq(s.services.id, s.serviceListings.serviceId), isNull(s.services.archivedAt)))
      .innerJoin(s.serviceCategories, eq(s.serviceCategories.id, s.services.categoryId))
      .leftJoin(s.clientGroups, eq(s.clientGroups.kind, 'b2c_retail'))
      .where(where),
  ]);
  return { rows: rows.map(toRow), total: count?.total ?? 0 };
}

/**
 * Finds one listing with its service facts.
 *
 * @param db the database or a transaction
 * @param id the listing id
 * @returns the row, or `undefined` when there is no such listing or its service is archived
 */
export async function findListingRow(db: DbExecutor, id: number): Promise<ListingRow | undefined> {
  const [row] = await listingSelect(db).where(eq(s.serviceListings.id, id)).limit(1);
  return row ? toRow(row) : undefined;
}

/** What the lock rule needs about a service that has no listing yet. */
export interface ServiceFacts {
  readonly status: string;
  readonly categoryName: string;
  readonly allowedGroupIds: number[];
  readonly retailGroupId: number | null;
}

/**
 * Reads the status and category of a live service and the retail group, for the lock check of a new listing.
 *
 * @param db the caller's transaction (the service row is already locked)
 * @param serviceId the service
 * @returns the facts, or `undefined` when the service is unknown or archived
 */
export async function findServiceFacts(db: DbExecutor, serviceId: number): Promise<ServiceFacts | undefined> {
  const [row] = await db
    .select({
      status: s.services.status,
      categoryName: s.serviceCategories.name,
      allowedGroupIds: s.serviceCategories.allowedGroupIds,
      retailGroupId: s.clientGroups.id,
    })
    .from(s.services)
    .innerJoin(s.serviceCategories, eq(s.serviceCategories.id, s.services.categoryId))
    .leftJoin(s.clientGroups, eq(s.clientGroups.kind, 'b2c_retail'))
    .where(and(eq(s.services.id, serviceId), isNull(s.services.archivedAt)))
    .limit(1);
  return row ? { ...row, retailGroupId: row.retailGroupId ?? null } : undefined;
}

/** The storefront orders of a service over a window. */
export interface Sales {
  readonly orders: number;
  /** Net `total_price`, as the database prints it. */
  readonly revenue: string;
}

/**
 * Counts the non-rejected storefront orders of some services since a moment, with their net revenue.
 *
 * Why: `orders30d` and `revenue30d` of a listing row (ANSWERS storefront Q1). A storefront order has a customer and no merchant.
 *
 * @param db the database or a transaction
 * @param serviceIds the services of a page
 * @param since the start of the window (the injected clock's now minus 30 days)
 * @returns the figures per service; a service without orders is absent
 */
export async function salesOf(db: DbExecutor, serviceIds: readonly number[], since: Date): Promise<Map<number, Sales>> {
  if (serviceIds.length === 0) return new Map();
  const rows = await db
    .select({
      serviceId: s.orders.serviceId,
      orders: sql<number>`count(*)::int`,
      revenue: sql<string>`coalesce(sum(${s.orders.totalPrice}), 0)::numeric(18,4)::text`,
    })
    .from(s.orders)
    .where(
      and(
        inArray(s.orders.serviceId, [...serviceIds]),
        isNotNull(s.orders.customerId),
        ne(s.orders.status, 'rejected'),
        gte(s.orders.placedAt, since),
      ),
    )
    .groupBy(s.orders.serviceId);
  return new Map(rows.map((row) => [row.serviceId, { orders: row.orders, revenue: row.revenue }]));
}

/**
 * Counts the non-rejected orders of every service created since a moment, whatever the channel (merchant, REST, Dhru, storefront).
 *
 * Why: the storefront's best-seller order (feature 22). It lives here, beside `salesOf`, instead of behind an orders service: the
 * orders module imports this module (its ledger reads the storefront policies), so an import of the orders barrel from the storefront
 * closed a load-order cycle (decision 032; seen as "Cannot access 'OrderLedger' before initialization" when a test imported the
 * orders ledger first). `created_at` equals `placed_at` at placement and has the index `orders_created_idx`, so the window is a range
 * scan.
 *
 * @param db the database or a transaction
 * @param since the start of the window (inclusive)
 * @returns the count per service id; services without orders are absent
 */
export async function salesCountsByService(db: DbExecutor, since: Date): Promise<Map<number, number>> {
  const rows = await db
    .select({ serviceId: s.orders.serviceId, total: sql<number>`count(*)::int` })
    .from(s.orders)
    .where(and(gte(s.orders.createdAt, since), ne(s.orders.status, 'rejected')))
    .groupBy(s.orders.serviceId);
  return new Map(rows.map((row) => [row.serviceId, row.total]));
}

/**
 * Counts the granted consents that reference each of some legal documents.
 *
 * @param db the database or a transaction
 * @param documentIds the versions of a page
 * @returns the count per version; a version nobody accepted is absent
 */
export async function acceptedCounts(db: DbExecutor, documentIds: readonly number[]): Promise<Map<number, number>> {
  if (documentIds.length === 0) return new Map();
  const rows = await db
    .select({ documentId: s.consentRecords.legalDocumentId, accepted: sql<number>`count(*)::int` })
    .from(s.consentRecords)
    .where(and(inArray(s.consentRecords.legalDocumentId, [...documentIds]), eq(s.consentRecords.granted, true)))
    .groupBy(s.consentRecords.legalDocumentId);
  return new Map(rows.flatMap((row) => (row.documentId === null ? [] : [[row.documentId, row.accepted] as const])));
}

/** A model name of the TAC catalogue with its brand. */
export interface TacName {
  readonly brand: string;
  readonly name: string;
}

/**
 * Lists the distinct (brand, model name) pairs of the TAC catalogue, optionally narrowed by brand or by name.
 *
 * Why: the landing-page generator (`POST /admin/content-pages/generate`): the model name of an entry is its marketing name, else its model
 * code (the endpoint doc). Matching ignores case; the answer carries the catalogue's own spelling.
 *
 * @param db the database or a transaction
 * @param filter `brands` keeps entries of those brands, `names` keeps entries with those model names (both lower case)
 * @param limit the most pairs to read
 * @returns the pairs by brand then name
 */
export async function listTacNames(
  db: DbExecutor,
  filter: { readonly brands?: readonly string[]; readonly names?: readonly string[] },
  limit: number,
): Promise<TacName[]> {
  const t = s.tacCatalog;
  const name = sql<string>`coalesce(nullif(btrim(${t.marketingName}), ''), ${t.model})`;
  const brand = sql<string>`lower(${t.brand})`;
  const lowerName = sql<string>`lower(${name})`;
  const conditions: SQL[] = [];
  if (filter.brands !== undefined) conditions.push(inArray(brand, [...filter.brands]));
  if (filter.names !== undefined) conditions.push(inArray(lowerName, [...filter.names]));
  return db
    .selectDistinct({ brand: t.brand, name })
    .from(s.tacCatalog)
    .where(conditions.length === 0 ? undefined : and(...conditions))
    .orderBy(asc(t.brand), asc(name))
    .limit(limit);
}
