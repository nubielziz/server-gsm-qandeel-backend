// Read-only lookups into tables other modules own, kept in this one file: the supplier chain of a service, whether anything
// refers to a service, and the merchants the price routes name. The catalog screens show who supplies a service, deleting a
// service archives it when orders, supplier links, listings or other records refer to it (RESOLUTIONS catalog-3), and a client
// price or a merchant's catalog needs the merchant's name and group.
//
// DEVIATION to resolve when those features land: decision 016 wants these reads through the owning module's public service.
// Orders (5), suppliers (6), storefront (14a/15), customers, risk (18) and support export nothing yet, so this file reads
// `service_supplier_links`, `supplier_services`, `suppliers`, `orders`, `service_listings`, `checkout_sessions`,
// `help_articles` and `imei_checks`, and identity's `clients`, with plain selects, like money's foreign-directory repository.
// Replace the bodies with calls to their services; nothing outside this file knows.
import { eq, inArray, sql } from 'drizzle-orm';
import { type DbExecutor, schema as s } from '../../../infra/db';

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
 * with `RESTRICT` (orders, listings, checkout sessions, help articles, IMEI checks), the supplier links (they cascade, but
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
      or exists (select 1 from ${s.imeiChecks} where service_id = ${serviceId})
    ) as referenced`);
  return result.rows[0]?.referenced === true;
}

/** A merchant as the price routes need it. */
export interface MerchantRef {
  readonly id: number;
  readonly name: string;
  readonly groupId: number;
  readonly status: string;
}

/**
 * Reads one merchant: its name, group and status.
 *
 * Why: a client price is checked against the floor of the merchant's group, the resolver prices for that group, and the
 * merchant catalog lists what the group may see (RESOLUTIONS catalog-1, catalog-4, catalog-16).
 *
 * @param db the database or a transaction
 * @param id the merchant id
 * @returns the merchant, or `undefined` when there is none
 */
export async function merchantOf(db: DbExecutor, id: number): Promise<MerchantRef | undefined> {
  const [row] = await db
    .select({ id: s.clients.id, name: s.clients.name, groupId: s.clients.groupId, status: s.clients.status })
    .from(s.clients)
    .where(eq(s.clients.id, id))
    .limit(1);
  return row;
}

/**
 * Reads several merchants in one query (a page of client prices).
 *
 * @param db the database or a transaction
 * @param ids the merchant ids; duplicates are fine
 * @returns the merchants that exist, by id
 */
export async function merchantsOf(db: DbExecutor, ids: readonly number[]): Promise<Map<number, MerchantRef>> {
  const unique = [...new Set(ids)];
  if (unique.length === 0) return new Map();
  const rows = await db
    .select({ id: s.clients.id, name: s.clients.name, groupId: s.clients.groupId, status: s.clients.status })
    .from(s.clients)
    .where(inArray(s.clients.id, unique));
  return new Map(rows.map((row) => [row.id, row]));
}

/** The last price a merchant paid for a service, with the merchant's group (what the price change scan compares). */
export interface RecentOrderPrice {
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
 * pay changes. The price of its latest order is the price it knows. Only active merchants are read, and the page after a key is
 * returned so a scan can walk the whole set in small steps (one row per merchant and service, ordered by both ids).
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
  const result = await db.execute<{ client_id: string; service_id: string; group_id: string; unit_price: string }>(sql`
    select distinct on (o.client_id, o.service_id) o.client_id, o.service_id, c.group_id, o.unit_price
    from ${s.orders} o
    join ${s.clients} c on c.id = o.client_id
    where o.client_id is not null and c.status = 'active' and o.created_at >= ${since}
      ${after ? sql`and (o.client_id, o.service_id) > (${after.clientId}, ${after.serviceId})` : sql``}
    order by o.client_id, o.service_id, o.created_at desc, o.id desc
    limit ${limit}`);
  return result.rows.map((row) => ({
    clientId: Number(row.client_id),
    serviceId: Number(row.service_id),
    groupId: Number(row.group_id),
    lastPrice: row.unit_price,
  }));
}
