// Drizzle queries on `supplier_services` and `service_supplier_links` (stage 6): the synced copy of a supplier's services (list, the
// upsert of a sync), the links of a service (read the chain, replace it) and the routing links the dispatch job chooses from.
import { and, asc, eq, inArray, sql } from 'drizzle-orm';
import type { ParsedListQuery } from '../../../common/contract';
import { type DbExecutor, type ListColumns, listOrderBy, listWhere, schema as s } from '../../../infra/db';
import type { RemoteService } from '../domain/dhru-protocol';
import type { RoutingLink } from '../domain/link-selection';
import type { StoredSupplierService } from '../domain/sync-plan';
import { type SupplierService, serviceSupplierLinks, supplierServices, suppliers } from '../db/schema';

/** The list fields `GET /admin/suppliers/:id/services` can sort on. */
export type SupplierServiceListField = 'id' | 'name' | 'credit' | 'lastSeenAt';

/** A synced supplier service with the two figures the catalogue page adds. */
export interface SupplierServiceRow {
  readonly service: SupplierService;
  readonly imported: boolean;
  readonly linkedServiceId: number | null;
}

// The outer id is written as text: in a select from one table Drizzle prints columns inside a selected `sql` without their table name,
// which would bind `id` to the links table inside the subquery.
const IMPORTED = sql<boolean>`exists (select 1 from ${serviceSupplierLinks} l where l.supplier_service_id = "supplier_services"."id")`;
const LINKED_SERVICE = sql<
  number | null
>`(select min(l.service_id) from ${serviceSupplierLinks} l where l.supplier_service_id = "supplier_services"."id")`;

const COLUMNS: ListColumns = {
  id: supplierServices.id,
  name: supplierServices.name,
  credit: supplierServices.credit,
  lastSeenAt: supplierServices.lastSeenAt,
  remoteGroup: supplierServices.remoteGroup,
  remoteId: supplierServices.remoteId,
  imported: IMPORTED,
};

/**
 * Lists a supplier's synced services.
 *
 * @param db the database or a transaction
 * @param supplierId the supplier
 * @param query the parsed list request (filter `imported`)
 * @returns the page and the exact total
 */
export async function listSupplierServiceRows(
  db: DbExecutor,
  supplierId: number,
  query: ParsedListQuery<SupplierServiceListField>,
): Promise<{ rows: SupplierServiceRow[]; total: number }> {
  const where = listWhere(query, COLUMNS, eq(supplierServices.supplierId, supplierId));
  const [rows, [count]] = await Promise.all([
    db
      .select({ service: supplierServices, imported: IMPORTED, linkedServiceId: LINKED_SERVICE })
      .from(supplierServices)
      .where(where)
      .orderBy(...listOrderBy(query.sort, COLUMNS, supplierServices.id))
      .limit(query.range.limit)
      .offset(query.range.start),
    db
      .select({ total: sql<number>`count(*)::int` })
      .from(supplierServices)
      .where(where),
  ]);
  return { rows, total: count?.total ?? 0 };
}

/**
 * Reads picked supplier services of one supplier.
 *
 * @param db the database or a transaction
 * @param supplierId the supplier
 * @param ids the supplier service ids picked (ids of another supplier are left out)
 * @returns the rows in id order
 */
export async function supplierServicesByIds(
  db: DbExecutor,
  supplierId: number,
  ids: readonly number[],
): Promise<SupplierService[]> {
  if (ids.length === 0) return [];
  return db
    .select()
    .from(supplierServices)
    .where(and(eq(supplierServices.supplierId, supplierId), inArray(supplierServices.id, [...ids])))
    .orderBy(asc(supplierServices.id));
}

/**
 * Reads what a supplier's services were before a sync.
 *
 * @param db the sync's transaction
 * @param supplierId the supplier
 * @returns every stored row's remote id, price and availability
 */
export async function storedSupplierServices(db: DbExecutor, supplierId: number): Promise<StoredSupplierService[]> {
  return db
    .select({
      remoteId: supplierServices.remoteId,
      credit: supplierServices.credit,
      isAvailable: supplierServices.isAvailable,
    })
    .from(supplierServices)
    .where(eq(supplierServices.supplierId, supplierId));
}

const UPSERT_CHUNK = 500;

/**
 * Writes a supplier's list into `supplier_services`.
 *
 * Why: the sync (orders-suppliers-6): rows are inserted or updated by `(supplier_id, remote_id)`, `last_seen_at` is the sync's
 * time, and `price_changed_at` is set when the credit differs from the stored one; a service that was gone and is listed again
 * is available again. Services not listed this time are then marked unavailable (`is_available` false): they were not seen at `now`.
 *
 * @param db the sync's transaction
 * @param supplierId the supplier
 * @param items the supplier's list
 * @param now the sync's time
 * @returns how many rows were marked unavailable
 */
export async function upsertSupplierServices(
  db: DbExecutor,
  supplierId: number,
  items: readonly RemoteService[],
  now: Date,
): Promise<number> {
  for (let start = 0; start < items.length; start += UPSERT_CHUNK) {
    const chunk = items.slice(start, start + UPSERT_CHUNK);
    await db
      .insert(supplierServices)
      .values(
        chunk.map((item) => ({
          supplierId,
          remoteId: item.remoteId,
          remoteGroup: item.group,
          type: item.type,
          name: item.name,
          credit: item.credit,
          time: item.time,
          requires: item.requires,
          customFields: item.customFields,
          raw: item.raw,
          isAvailable: true,
          lastSeenAt: now,
        })),
      )
      .onConflictDoUpdate({
        target: [supplierServices.supplierId, supplierServices.remoteId],
        set: {
          remoteGroup: sql`excluded.remote_group`,
          type: sql`excluded.type`,
          name: sql`excluded.name`,
          credit: sql`excluded.credit`,
          time: sql`excluded.time`,
          requires: sql`excluded.requires`,
          customFields: sql`excluded.custom_fields`,
          raw: sql`excluded.raw`,
          isAvailable: true,
          lastSeenAt: now,
          priceChangedAt: sql`case when ${supplierServices.credit} <> excluded.credit then ${now.toISOString()}::timestamptz else ${supplierServices.priceChangedAt} end`,
        },
      });
  }
  const gone = await db
    .update(supplierServices)
    .set({ isAvailable: false })
    .where(
      and(
        eq(supplierServices.supplierId, supplierId),
        eq(supplierServices.isAvailable, true),
        sql`${supplierServices.lastSeenAt} < ${now}`,
      ),
    )
    .returning({ id: supplierServices.id });
  return gone.length;
}

/**
 * Finds the services linked to any of a supplier's services.
 *
 * Why: after a sync their effective cost is recomputed (user rule 9, catalog-1).
 *
 * @param db the sync's transaction
 * @param supplierId the supplier
 * @returns the service ids, each once
 */
export async function serviceIdsLinkedToSupplier(db: DbExecutor, supplierId: number): Promise<number[]> {
  const rows = await db
    .selectDistinct({ serviceId: serviceSupplierLinks.serviceId })
    .from(serviceSupplierLinks)
    .innerJoin(supplierServices, eq(supplierServices.id, serviceSupplierLinks.supplierServiceId))
    .where(eq(supplierServices.supplierId, supplierId));
  return rows.map((row) => row.serviceId);
}

/** One step of a service's supplier chain. */
export interface ChainRow {
  readonly serviceId: number;
  readonly priority: number;
  readonly supplierId: number;
  readonly supplierName: string;
  readonly supplierServiceId: number;
  readonly supplierServiceName: string;
}

/**
 * Reads the supplier chains of services, ordered by priority.
 *
 * @param db the database or a transaction
 * @param serviceIds the services
 * @returns the steps of all the services, by service then priority then link id
 */
export async function chainsOf(db: DbExecutor, serviceIds: readonly number[]): Promise<ChainRow[]> {
  if (serviceIds.length === 0) return [];
  return db
    .select({
      serviceId: serviceSupplierLinks.serviceId,
      priority: serviceSupplierLinks.priority,
      supplierId: suppliers.id,
      supplierName: suppliers.name,
      supplierServiceId: supplierServices.id,
      supplierServiceName: supplierServices.name,
    })
    .from(serviceSupplierLinks)
    .innerJoin(supplierServices, eq(supplierServices.id, serviceSupplierLinks.supplierServiceId))
    .innerJoin(suppliers, eq(suppliers.id, supplierServices.supplierId))
    .where(inArray(serviceSupplierLinks.serviceId, [...serviceIds]))
    .orderBy(serviceSupplierLinks.serviceId, serviceSupplierLinks.priority, serviceSupplierLinks.id);
}

/** A link of a supplier, with the service it serves. */
export interface SupplierLinkRow {
  readonly serviceId: number;
  readonly serviceName: string;
  readonly serviceCode: string;
  readonly serviceStatus: string;
  readonly slaMinutes: number;
  readonly supplierServiceId: number;
  readonly supplierServiceName: string;
  readonly credit: string;
  readonly priority: number;
}

/**
 * Reads the links that point at a supplier's services.
 *
 * Why: `GET /admin/suppliers/:id` lists them as `links` (B23): no other route lists a supplier's linked services. Archived
 * services are left out.
 *
 * @param db the database or a transaction
 * @param supplierId the supplier
 * @returns one row per link, by service name then priority
 */
export async function linksOfSupplier(db: DbExecutor, supplierId: number): Promise<SupplierLinkRow[]> {
  return db
    .select({
      serviceId: s.services.id,
      serviceName: s.services.name,
      serviceCode: s.services.code,
      serviceStatus: s.services.status,
      slaMinutes: s.services.slaMinutes,
      supplierServiceId: supplierServices.id,
      supplierServiceName: supplierServices.name,
      credit: supplierServices.credit,
      priority: serviceSupplierLinks.priority,
    })
    .from(serviceSupplierLinks)
    .innerJoin(supplierServices, eq(supplierServices.id, serviceSupplierLinks.supplierServiceId))
    .innerJoin(s.services, eq(s.services.id, serviceSupplierLinks.serviceId))
    .where(and(eq(supplierServices.supplierId, supplierId), sql`${s.services.archivedAt} is null`))
    .orderBy(asc(s.services.name), serviceSupplierLinks.priority, serviceSupplierLinks.id);
}

/** An existing link, as a replace keeps what staff cannot see in the chain editor. */
interface KeptLink {
  readonly fieldMap: Record<string, unknown>;
  readonly isActive: boolean;
}

/**
 * Replaces the whole chain of a service.
 *
 * Why: `PUT /admin/services/:id/supplier-links`: the chain in the order given, priorities renumbered 1..n; a link that stays keeps
 * its field map and its switch, a new one starts with `{}` and active.
 *
 * @param db the transaction (the service row is locked)
 * @param serviceId the service
 * @param supplierServiceIds the new chain, first is priority 1
 */
export async function replaceChain(
  db: DbExecutor,
  serviceId: number,
  supplierServiceIds: readonly number[],
): Promise<void> {
  const existing = await db.select().from(serviceSupplierLinks).where(eq(serviceSupplierLinks.serviceId, serviceId));
  const kept = new Map<number, KeptLink>(
    existing.map((row) => [row.supplierServiceId, { fieldMap: row.fieldMap, isActive: row.isActive }]),
  );
  await db.delete(serviceSupplierLinks).where(eq(serviceSupplierLinks.serviceId, serviceId));
  if (supplierServiceIds.length === 0) return;
  await db.insert(serviceSupplierLinks).values(
    supplierServiceIds.map((supplierServiceId, index) => ({
      serviceId,
      supplierServiceId,
      priority: index + 1,
      fieldMap: kept.get(supplierServiceId)?.fieldMap ?? {},
      isActive: kept.get(supplierServiceId)?.isActive ?? true,
    })),
  );
}

/**
 * Adds a link at the end of a service's chain.
 *
 * Why: an import creates a service with its link at priority 1; an existing service is not touched.
 *
 * @param db the import's transaction
 * @param serviceId the new service
 * @param supplierServiceId the supplier service it comes from
 */
export async function insertFirstLink(db: DbExecutor, serviceId: number, supplierServiceId: number): Promise<void> {
  await db
    .insert(serviceSupplierLinks)
    .values({ serviceId, supplierServiceId, priority: 1, fieldMap: {}, isActive: true });
}

/**
 * Tells which of some supplier services exist, with their supplier.
 *
 * @param db the database or a transaction
 * @param ids the supplier service ids
 * @returns the rows found by id
 */
export async function supplierServicesWithSupplier(
  db: DbExecutor,
  ids: readonly number[],
): Promise<Map<number, { id: number; supplierId: number }>> {
  if (ids.length === 0) return new Map();
  const rows = await db
    .select({ id: supplierServices.id, supplierId: supplierServices.supplierId })
    .from(supplierServices)
    .where(inArray(supplierServices.id, [...ids]));
  return new Map(rows.map((row) => [row.id, row]));
}

/**
 * Reads the active links of a service for routing, by priority.
 *
 * Why: the dispatch job and the staff dispatch choose among them (resolution orders-suppliers-11).
 *
 * @param db the database or a transaction
 * @param serviceId the service
 * @returns the active links with their supplier's state and price, ordered by priority then link id
 */
export async function routingLinks(db: DbExecutor, serviceId: number): Promise<RoutingLink[]> {
  return db
    .select({
      linkId: serviceSupplierLinks.id,
      priority: serviceSupplierLinks.priority,
      supplierId: suppliers.id,
      supplierName: suppliers.name,
      supplierStatus: suppliers.status,
      supplierServiceId: supplierServices.id,
      available: supplierServices.isAvailable,
      credit: supplierServices.credit,
      creditRate: suppliers.creditRate,
    })
    .from(serviceSupplierLinks)
    .innerJoin(supplierServices, eq(supplierServices.id, serviceSupplierLinks.supplierServiceId))
    .innerJoin(suppliers, eq(suppliers.id, supplierServices.supplierId))
    .where(and(eq(serviceSupplierLinks.serviceId, serviceId), eq(serviceSupplierLinks.isActive, true)))
    .orderBy(serviceSupplierLinks.priority, serviceSupplierLinks.id);
}

/** What the dispatch needs to know about the supplier service an order goes to. */
export interface DispatchTarget {
  readonly supplierServiceId: number;
  readonly supplierId: number;
  readonly remoteId: string;
  /** The price in supplier credits (4 decimals). */
  readonly credit: string;
  readonly available: boolean;
  /** Our field key to the supplier's field name, from the link of the order's service (`{}` when none). */
  readonly fieldMap: Record<string, unknown>;
}

/**
 * Reads the target of a dispatch: the supplier service an order was assigned, with the link's field map for the order's service.
 *
 * @param db the database or a transaction
 * @param serviceId the order's service
 * @param supplierServiceId the supplier service the order was assigned
 * @returns the supplier service, its supplier and the field map, or `undefined` when the supplier service is gone
 */
export async function dispatchTarget(
  db: DbExecutor,
  serviceId: number,
  supplierServiceId: number,
): Promise<DispatchTarget | undefined> {
  const [row] = await db
    .select({
      supplierServiceId: supplierServices.id,
      supplierId: supplierServices.supplierId,
      remoteId: supplierServices.remoteId,
      credit: supplierServices.credit,
      available: supplierServices.isAvailable,
      fieldMap: sql<Record<
        string,
        unknown
      > | null>`(select l.field_map from ${serviceSupplierLinks} l where l.service_id = ${serviceId} and l.supplier_service_id = "supplier_services"."id" limit 1)`,
    })
    .from(supplierServices)
    .where(eq(supplierServices.id, supplierServiceId))
    .limit(1);
  return row ? { ...row, fieldMap: row.fieldMap ?? {} } : undefined;
}
