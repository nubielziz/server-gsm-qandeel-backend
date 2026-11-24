// Read-only lookups into tables other modules own, kept in this one file: the supplier chain of a service, whether anything
// refers to a service, the title a service is published under, the merchants the price routes name, and the supplier, shop page and
// publish facts of the Catalog page (decision 060). The catalog screens show who supplies a service, deleting a
// service archives it when orders, supplier links, listings or other records refer to it (RESOLUTIONS catalog-3), a client
// price or a merchant's catalog needs the merchant's name and group, and the catalog list filters and flags services by their
// supplier, their shop page and their last publish attempt.
//
// DEVIATION to resolve when those features land: decision 016 wants these reads through the owning module's public service.
// Orders (5), suppliers (6), storefront (14a/15), customers and support export nothing yet, so this file reads
// `service_supplier_links`, `supplier_services`, `suppliers`, `orders`, `service_listings`, `listing_publish_items`,
// `checkout_sessions` and `help_articles`, and identity's `clients`, with plain selects, like money's
// foreign-directory repository. Storefront imports the catalog, so the catalog cannot call it (decision 032): the SQL fragments of
// decision 060 over `service_supplier_links`, `service_listings` and `listing_publish_items` are built here and composed in
// service-attention.sql.ts.
// Replace the bodies with calls to their services; nothing outside this file knows.
import { type SQL, eq, inArray, sql } from 'drizzle-orm';
import { type DbExecutor, schema as s } from '../../../infra/db';
import { type RankKind, rankKindOf } from '../../identity/ports/rank-kind';

/** An id and a name, as a service row joins a supplier. */
export interface SupplierRef {
  readonly id: number;
  readonly name: string;
}

/** The first two active supplier links of a service by priority. */
export interface SupplierChain {
  readonly supplier: SupplierRef | null;
  readonly fallbackSupplier: SupplierRef | null;
}

/**
 * Reads the supplier chain of several services in one query.
 *
 * Why: a service row shows `supplier` and `fallbackSupplier`: the suppliers of its first and second active links by priority
 * (then link id), the same order the effective cost uses (RESOLUTIONS catalog-1).
 *
 * @param db the database or a transaction
 * @param serviceIds the services of a page
 * @returns the chain of every service that has an active link; others are absent from the map
 */
export async function supplierChainsOf(
  db: DbExecutor,
  serviceIds: readonly number[],
): Promise<Map<number, SupplierChain>> {
  const chains = new Map<number, SupplierChain>();
  if (serviceIds.length === 0) return chains;
  const result = await db.execute<{
    service_id: string;
    supplier_id: string;
    supplier_name: string;
    position: string;
  }>(sql`
    select ranked.service_id, ranked.supplier_id, ranked.supplier_name, ranked.position
    from (
      select link.service_id, supplier.id as supplier_id, supplier.name as supplier_name,
             row_number() over (partition by link.service_id order by link.priority, link.id) as position
      from ${s.serviceSupplierLinks} link
      join ${s.supplierServices} remote on remote.id = link.supplier_service_id
      join ${s.suppliers} supplier on supplier.id = remote.supplier_id
      where link.is_active and link.service_id in (${sql.join(
        serviceIds.map((id) => sql`${id}`),
        sql`, `,
      )})
    ) ranked
    where ranked.position <= 2`);
  const first = new Map<number, SupplierRef>();
  const second = new Map<number, SupplierRef>();
  for (const row of result.rows) {
    const ref = { id: Number(row.supplier_id), name: row.supplier_name };
    (Number(row.position) === 1 ? first : second).set(Number(row.service_id), ref);
  }
  for (const id of new Set([...first.keys(), ...second.keys()])) {
    chains.set(id, { supplier: first.get(id) ?? null, fallbackSupplier: second.get(id) ?? null });
  }
  return chains;
}

/**
 * Tells whether any record outside the catalog's disposable parts refers to a service.
 *
 * Why: RESOLUTIONS catalog-3: such a service is archived, never deleted. The list is every table that points at `services`
 * with `RESTRICT` (orders, listings, checkout sessions, help articles), the supplier links (they cascade, but
 * a service routed to a supplier has history worth keeping) and the catalog's own inventory codes.
 *
 * @param db the transaction that holds the service row locked
 * @param serviceId the service
 * @returns true when something refers to it
 */
export async function isServiceReferenced(db: DbExecutor, serviceId: number): Promise<boolean> {
  const result = await db.execute<{ referenced: boolean }>(sql`
    select (
      exists (select 1 from ${s.orders} where service_id = ${serviceId})
      or exists (select 1 from ${s.serviceSupplierLinks} where service_id = ${serviceId})
      or exists (select 1 from ${s.serviceListings} where service_id = ${serviceId})
      or exists (select 1 from ${s.inventoryCodes} where service_id = ${serviceId})
      or exists (select 1 from ${s.checkoutSessions} where service_id = ${serviceId})
      or exists (select 1 from ${s.helpArticles} where service_id = ${serviceId})
    ) as referenced`);
  return result.rows[0]?.referenced === true;
}

/**
 * Reads the title each of some services is published under.
 *
 * Why: a buyer knows a service by the title the shop showed, and a bulk publish cleans it away from the supplier's name (feature 31), so
 * the checkout and the records made from it name the listing's title. A service has at most one listing.
 *
 * @param db the database or a transaction
 * @param serviceIds the services
 * @returns the public title by service id; a service without a listing is absent
 */
export async function listingTitlesOf(db: DbExecutor, serviceIds: readonly number[]): Promise<Map<number, string>> {
  const ids = [...new Set(serviceIds)];
  if (ids.length === 0) return new Map();
  const rows = await db
    .select({ serviceId: s.serviceListings.serviceId, title: s.serviceListings.publicTitle })
    .from(s.serviceListings)
    .where(inArray(s.serviceListings.serviceId, ids));
  return new Map(rows.map((row) => [row.serviceId, row.title]));
}

/** An account as the price routes need it: its name, rank, rank kind and status. */
export interface MerchantRef {
  readonly id: number;
  readonly name: string;
  readonly groupId: number;
  /** `merchant` or `retail`, told by the kind of the rank (`rankKindOf`); only a merchant rank has fixed prices and a catalog of its own. */
  readonly rankKind: RankKind;
  readonly status: string;
}

/** The columns {@link MerchantRef} is built from: the account and the stored kind of its rank. */
const merchantColumns = {
  id: s.clients.id,
  name: s.clients.name,
  groupId: s.clients.groupId,
  status: s.clients.status,
  groupKind: s.clientGroups.kind,
};

const toMerchantRef = ({ groupKind, ...row }: { groupKind: string } & Omit<MerchantRef, 'rankKind'>): MerchantRef => ({
  ...row,
  rankKind: rankKindOf(groupKind),
});

/**
 * Reads one account: its name, rank, rank kind and status.
 *
 * Why: a client price is checked against the floor of the account's rank, the resolver prices for that rank, the merchant
 * catalog lists what the rank may see, and only an account of a merchant rank may have a fixed price (decision 064; RESOLUTIONS
 * catalog-1, catalog-4, catalog-16). Every account has a rank, so the join never drops a row.
 *
 * @param db the database or a transaction
 * @param id the account id (a merchant id is an account id)
 * @returns the account, or `undefined` when there is none
 */
export async function merchantOf(db: DbExecutor, id: number): Promise<MerchantRef | undefined> {
  const [row] = await db
    .select(merchantColumns)
    .from(s.clients)
    .innerJoin(s.clientGroups, eq(s.clientGroups.id, s.clients.groupId))
    .where(eq(s.clients.id, id))
    .limit(1);
  return row && toMerchantRef(row);
}

/**
 * Reads several accounts in one query (a page of client prices).
 *
 * @param db the database or a transaction
 * @param ids the account ids; duplicates are fine
 * @returns the accounts that exist, by id
 */
export async function merchantsOf(db: DbExecutor, ids: readonly number[]): Promise<Map<number, MerchantRef>> {
  const unique = [...new Set(ids)];
  if (unique.length === 0) return new Map();
  const rows = await db
    .select(merchantColumns)
    .from(s.clients)
    .innerJoin(s.clientGroups, eq(s.clientGroups.id, s.clients.groupId))
    .where(inArray(s.clients.id, unique));
  return new Map(rows.map((row) => [row.id, toMerchantRef(row)]));
}

/** The last price a merchant paid for a service, with the merchant's group (what the price change scan compares). */
export interface RecentOrderPrice {
  /** The merchant's account id. */
  readonly clientId: number;
  readonly serviceId: number;
  readonly groupId: number;
  /** `orders.unit_price` of the merchant's latest order of the service (USD, four decimals). */
  readonly lastPrice: string;
}

/**
 * Reads, for each merchant and service, the unit price of the merchant's latest order since a time.
 *
 * Why: user rule 9 (5) and MISMATCHES B117: a merchant who ordered a service in the last 30 days is told when the price it would
 * pay changes. The price of its latest order is the price it knows. Only active accounts of a merchant rank are read (decision 064: a
 * retail account pays the shop price, which is not a price this scan watches), and only orders of the merchant doors: a shop order
 * (`source = 'store'`) was paid at the retail price, even when its buyer was raised to a merchant rank later, so it is never the price
 * that merchant knows. The page after a key is returned so a scan can walk the whole set in small steps (one row per merchant and
 * service, ordered by both ids).
 *
 * @param db the database or a transaction
 * @param since the start of the window (30 days before now)
 * @param after the last `(clientId, serviceId)` of the previous page; `undefined` for the first page
 * @param limit the page size
 * @returns the next page, ordered by merchant and service
 */
export async function recentOrderPrices(
  db: DbExecutor,
  since: Date,
  after: { readonly clientId: number; readonly serviceId: number } | undefined,
  limit: number,
): Promise<RecentOrderPrice[]> {
  // `b2b` is the one stored rank kind with merchant rights (`rankKindOf`); `store` is the one door that is paid first.
  const result = await db.execute<{ client_id: string; service_id: string; group_id: string; unit_price: string }>(sql`
    select distinct on (o.account_id, o.service_id) o.account_id as client_id, o.service_id, c.group_id, o.unit_price
    from ${s.orders} o
    join ${s.clients} c on c.id = o.account_id
    join ${s.clientGroups} g on g.id = c.group_id
    where g.kind = 'b2b' and o.source <> 'store' and c.status = 'active' and o.created_at >= ${since}
      ${after ? sql`and (o.account_id, o.service_id) > (${after.clientId}, ${after.serviceId})` : sql``}
    order by o.account_id, o.service_id, o.created_at desc, o.id desc
    limit ${limit}`);
  return result.rows.map((row) => ({
    clientId: Number(row.client_id),
    serviceId: Number(row.service_id),
    groupId: Number(row.group_id),
    lastPrice: row.unit_price,
  }));
}

// --- The Catalog page's fragments and reads (decision 060) ------------------------------------------------------------------------
// Each fragment is a boolean or scalar SQL expression over the outer `services` row, written as `"services"."id"` in full (in a
// select from one table Drizzle prints a selected column without its table, which would bind `id` to the inner table), in
// parentheses and NULL-free where it is a condition, because a boolean list filter compiles to `(fragment) = false`.

/**
 * The service has an active supplier link: the links the row's `supplier` and `fallbackSupplier` read.
 *
 * Why: decision 060: the filter `hasSupplier` and the reason `no_supplier` (an automatic service with none).
 */
export const hasActiveSupplierLinkSql: SQL<boolean> = sql`(exists (
  select 1 from ${s.serviceSupplierLinks} link where link.service_id = "services"."id" and link.is_active))`;

/**
 * The supplier of the service's first active link by priority, then link id (the row's `supplier`), or NULL.
 *
 * Why: decision 060: the filter `supplierId` means the primary supplier, the one the Supplier cell shows (eq only: NULL never
 * matches, so a service without one is never found by an id).
 */
export const primarySupplierIdSql: SQL<number | null> = sql`(
  select remote.supplier_id
  from ${s.serviceSupplierLinks} link
  join ${s.supplierServices} remote on remote.id = link.supplier_service_id
  where link.service_id = "services"."id" and link.is_active
  order by link.priority, link.id
  limit 1)`;

/**
 * The service has a listing, switched on or off.
 *
 * Why: decision 060: a publish run blocks any service with a listing (`already_listed`), so a refused attempt counts as a failure only
 * while the service has none; a listing switched off by hand is a person's choice, not a failure.
 */
export const hasListingSql: SQL<boolean> = sql`(exists (
  select 1 from ${s.serviceListings} l where l.service_id = "services"."id"))`;

/**
 * The service has a listing that is switched on (the listing routes' `isListed`).
 *
 * Why: decision 060: the filter and the row field `isListed`, and the "not on the shop" view.
 */
export const isListedSql: SQL<boolean> = sql`(exists (
  select 1 from ${s.serviceListings} l where l.service_id = "services"."id" and l.is_listed))`;

/**
 * The order of a service's publish rows with a result, newest attempt first: `finished_at` (both writers set it; `updated_at` guards a
 * row without it), then the row id. The fragment and the detail read share it, so they name the same row.
 */
const LATEST_RESULT_ORDER = sql`coalesce(i.finished_at, i.updated_at) desc, i.id desc`;

/**
 * The service's latest publish row with a result was `refused`.
 *
 * Why: decision 060: one part of the reason `publish_failed`. A later `published` or `skipped` row clears it; rows never tried
 * have no result and do not count.
 */
export const latestPublishRefusedSql: SQL<boolean> = sql`(coalesce((
  select i.result from ${s.listingPublishItems} i
  where i.service_id = "services"."id" and i.result is not null
  order by ${LATEST_RESULT_ORDER}
  limit 1) = 'refused', false))`;

/** The listing of a service, as the catalog row shows it. */
export interface ListingRef {
  readonly id: number;
  readonly isListed: boolean;
}

/**
 * Reads the listing of several services in one query.
 *
 * Why: decision 060: the row's `listingId` (the listing routes are keyed by it) and `isListed`. A service has at most one listing.
 *
 * @param db the database or a transaction
 * @param serviceIds the services of a page
 * @returns the listing by service id; a service without one is absent
 */
export async function listingsOf(db: DbExecutor, serviceIds: readonly number[]): Promise<Map<number, ListingRef>> {
  const ids = [...new Set(serviceIds)];
  if (ids.length === 0) return new Map();
  const rows = await db
    .select({ id: s.serviceListings.id, serviceId: s.serviceListings.serviceId, isListed: s.serviceListings.isListed })
    .from(s.serviceListings)
    .where(inArray(s.serviceListings.serviceId, ids));
  return new Map(rows.map((row) => [row.serviceId, { id: row.id, isListed: row.isListed }]));
}

/** The latest publish attempt of a service that has a result. */
export interface PublishAttempt {
  readonly runId: number;
  readonly result: string;
  /** One of the storefront's publish result reasons (`failed` when the row holds none). */
  readonly reason: string;
  readonly detail: string | null;
  /** When the attempt finished (`updated_at` for a row without `finished_at`). */
  readonly at: Date;
}

/**
 * Reads the latest publish attempt with a result of several services, in the order of {@link latestPublishRefusedSql}.
 *
 * Why: decision 060: the detail's `publishFailure` says why the last attempt was refused and in which run, so staff can open it.
 *
 * @param db the database or a transaction
 * @param serviceIds the services
 * @returns the latest attempt by service id; a service never tried is absent
 */
export async function latestPublishAttemptsOf(
  db: DbExecutor,
  serviceIds: readonly number[],
): Promise<Map<number, PublishAttempt>> {
  const ids = [...new Set(serviceIds)];
  if (ids.length === 0) return new Map();
  const result = await db.execute<{
    service_id: string;
    run_id: string;
    result: string;
    reason: string | null;
    detail: string | null;
    at: Date | string;
  }>(sql`
    select distinct on (i.service_id) i.service_id, i.run_id, i.result, i.result_reason as reason, i.result_detail as detail,
           coalesce(i.finished_at, i.updated_at) as at
    from ${s.listingPublishItems} i
    where i.result is not null and i.service_id in (${sql.join(
      ids.map((id) => sql`${id}`),
      sql`, `,
    )})
    order by i.service_id, ${LATEST_RESULT_ORDER}`);
  return new Map(
    result.rows.map((row) => [
      Number(row.service_id),
      {
        runId: Number(row.run_id),
        result: row.result,
        reason: row.reason ?? 'failed',
        detail: row.detail,
        at: row.at instanceof Date ? row.at : new Date(row.at),
      },
    ]),
  );
}
