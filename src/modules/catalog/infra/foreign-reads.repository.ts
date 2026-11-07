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
