// Read-only lookups into tables other modules own, kept in this one file: the service, its category and the retail group behind a
// listing (and, for the bulk publish, the category's switch), the storefront sales of a service, the consents that reference a legal
// document.
//
// DEVIATION to resolve when those modules export a read: decision 016 wants these reads through the owning module's public
// service. Catalog exports the price resolver and `RetailPrices` (used for every price figure and every write; the retail price
// itself is never read here) but no join that can be filtered, sorted and searched by service name and code, and orders and
// customers export no counts yet, so this file reads
// `services`, `service_categories`, `service_fields`, `client_groups`, `orders`, `consent_records` and `staff_users`
// with plain selects, like catalog's foreign-reads file. Replace the bodies with calls to their services;
// nothing outside this file knows.
import { type SQL, and, eq, gte, inArray, isNull, ne, sql } from 'drizzle-orm';
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
 * @param query the parsed list request (filters `isListed`, `locked` and `isFeatured`, search over title, slug, service name and
 *   code)
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

/** What a publish row is judged on about its live service: the lock facts plus the category's switch, the type and fulfilment. */
export interface PublishServiceFacts extends ServiceFacts {
  readonly serviceId: number;
  readonly name: string;
  readonly type: string;
  readonly fulfillment: string;
  readonly categoryId: number;
  /** `service_categories.is_active`: a listing of a service in a switched-off category is on and invisible. */
  readonly categoryActive: boolean;
  /**
   * The service has a field flagged as the main input (`service_fields.is_main_input`, decision 065; the supplier's main box of decision 042). A
   * `server` service with one is named as `imei`, so it keeps its carrier and device brand (plan 31, correction 1).
   */
  readonly hasMainInput: boolean;
}

/** The select of {@link publishFactsOf} and {@link findPublishFacts}: live services only. */
function publishFactsSelect(db: DbExecutor) {
  return db
    .select({
      serviceId: s.services.id,
      name: s.services.name,
      type: s.services.type,
      fulfillment: s.services.fulfillment,
      status: s.services.status,
      categoryId: s.serviceCategories.id,
      categoryName: s.serviceCategories.name,
      categoryActive: s.serviceCategories.isActive,
      allowedGroupIds: s.serviceCategories.allowedGroupIds,
      retailGroupId: s.clientGroups.id,
    })
    .from(s.services)
    .innerJoin(s.serviceCategories, eq(s.serviceCategories.id, s.services.categoryId))
    .leftJoin(s.clientGroups, eq(s.clientGroups.kind, 'b2c_retail'));
}

/**
 * Reads, for a page of services, what a publish row is judged on: the facts of {@link findServiceFacts} and, unlike the listing
 * routes, the category's `is_active`, with the service's type and fulfilment.
 *
 * Why: plan 31 sections 3.2 and 6.1: the sellable rule reads the category's `is_active` and the lock rule of the listing routes does
 * not, so a published listing of a service in a switched-off category would be on and invisible (`category_inactive`); `file` is not
 * orderable online (`not_orderable`), and only an `auto` service needs a supplier (`supplier_unavailable`). The listing routes keep
 * `findServiceFacts` unchanged.
 *
 * @param db the database or the caller's transaction
 * @param serviceIds the services of a page
 * @returns the facts per live service; an unknown or archived service is absent
 */
export async function publishFactsOf(
  db: DbExecutor,
  serviceIds: readonly number[],
): Promise<Map<number, PublishServiceFacts>> {
  const ids = [...new Set(serviceIds)];
  if (ids.length === 0) return new Map();
  const rows = await publishFactsSelect(db).where(and(inArray(s.services.id, ids), isNull(s.services.archivedAt)));
  const fields = await db
    .select({
      serviceId: s.serviceFields.serviceId,
      isMainInput: s.serviceFields.isMainInput,
    })
    .from(s.serviceFields)
    .where(inArray(s.serviceFields.serviceId, ids));
  const withMainInput = new Set(fields.filter((field) => field.isMainInput).map((field) => field.serviceId));
  return new Map(
    rows.map((row) => [
      row.serviceId,
      { ...row, retailGroupId: row.retailGroupId ?? null, hasMainInput: withMainInput.has(row.serviceId) },
    ]),
  );
}

/**
 * Reads what a publish row is judged on for one live service (see {@link publishFactsOf}).
 *
 * @param db the caller's transaction (the publisher holds the service row lock)
 * @param serviceId the service
 * @returns the facts, or `undefined` when the service is unknown or archived
 */
export async function findPublishFacts(db: DbExecutor, serviceId: number): Promise<PublishServiceFacts | undefined> {
  return (await publishFactsOf(db, [serviceId])).get(serviceId);
}

/**
 * Tells which of some services are live (not archived).
 *
 * Why: plan 31 sections 5.2 and 6.1: the scope `services` of a publish run takes the ticked services that still exist, and a copied row
 * is dropped when its service was archived meanwhile.
 *
 * @param db the database or a transaction
 * @param serviceIds the services
 * @returns the ids that exist and are not archived
 */
export async function liveServiceIdsAmong(db: DbExecutor, serviceIds: readonly number[]): Promise<Set<number>> {
  const ids = [...new Set(serviceIds)];
  if (ids.length === 0) return new Set();
  const rows = await db
    .select({ id: s.services.id })
    .from(s.services)
    .where(and(inArray(s.services.id, ids), isNull(s.services.archivedAt)));
  return new Set(rows.map((row) => row.id));
}

/**
 * Reads the names of staff members.
 *
 * Why: plan 31 section 5.2: a publish run names who asked (`requestedByName`); one batched read for a page, no read per row.
 *
 * @param db the database or a transaction
 * @param ids staff ids (repeats are fine)
 * @returns id to name; a missing id is absent
 */
export async function staffNamesOf(db: DbExecutor, ids: readonly number[]): Promise<Map<number, string>> {
  const unique = [...new Set(ids)];
  if (unique.length === 0) return new Map();
  const rows = await db
    .select({ id: s.staffUsers.id, name: s.staffUsers.name })
    .from(s.staffUsers)
    .where(inArray(s.staffUsers.id, unique));
  return new Map(rows.map((row) => [row.id, row.name]));
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
 * Why: `orders30d` and `revenue30d` of a listing row (ANSWERS storefront Q1). A storefront order is an order of the shop's door
 * (`orders.source` is `store`, decision 064): the door says how the order was paid, whatever rank its buyer holds now. This file does not
 * import the orders barrel (orders imports storefront policies: a load cycle, decision 032), so the one comparison is written here.
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
        eq(s.orders.source, 'store'),
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
