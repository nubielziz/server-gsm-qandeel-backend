// Read-only lookups into tables other modules own, kept in this one file: the services a supplier service is linked to (name, code,
// status, SLA, cost), the custom fields of a service (to map an order's inputs to the supplier's field names), whether it exists, the
// services the sync may bring in line with their supplier (decision 042, feature 33), the category staff pick for an import
// (decision 063; where the import puts a service without a pick is the catalog's `ServiceImporter.categoriesForGroups`) and whether a
// service is delivered from code stock (decision 069, for the dispatch's reason).
//
// DEVIATION to resolve later: decision 016 wants these reads through the owning module's public service. The catalog exports no
// service or category reader, so this file reads `services`, `service_fields` and `service_categories` with plain selects, like the
// other modules' foreign-read files. Writes to the catalog (the import) go through `ServiceImporter`.
import { and, asc, eq, inArray, sql } from 'drizzle-orm';
import { type DbExecutor, schema as s } from '../../../infra/db';
import type { LinkedService } from '../domain/import-plan';

/** A service as the supplier pages need it. */
export interface ServiceInfo {
  readonly id: number;
  readonly name: string;
  readonly code: string;
  readonly status: string;
  readonly slaMinutes: number;
  readonly type: string;
  readonly archived: boolean;
}

/**
 * Reads a live (not archived) service.
 *
 * @param db the database or a transaction
 * @param id the service id
 * @returns the service, or `undefined` when it does not exist or is archived
 */
export async function liveServiceInfo(db: DbExecutor, id: number): Promise<ServiceInfo | undefined> {
  const [row] = await db
    .select({
      id: s.services.id,
      name: s.services.name,
      code: s.services.code,
      status: s.services.status,
      slaMinutes: s.services.slaMinutes,
      type: s.services.type,
      archivedAt: s.services.archivedAt,
    })
    .from(s.services)
    .where(and(eq(s.services.id, id), sql`${s.services.archivedAt} is null`))
    .limit(1);
  return row ? { ...row, archived: false } : undefined;
}

/**
 * Tells whether a service is delivered from code stock.
 *
 * Why: decision 069: an automatic order of such a service that reaches the dispatch with no usable supplier says that staff deliver it
 * by hand (its stock was short at placement).
 *
 * @param db the database or a transaction
 * @param id the service id
 * @returns `services.stock_delivery`; false for an unknown service
 */
export async function isStockDeliveryService(db: DbExecutor, id: number): Promise<boolean> {
  const [row] = await db
    .select({ stockDelivery: s.services.stockDelivery })
    .from(s.services)
    .where(eq(s.services.id, id))
    .limit(1);
  return row?.stockDelivery ?? false;
}

/**
 * Locks a live service row for the rest of the transaction.
 *
 * Why: replacing a service's links must not interleave with another change of the same service's chain.
 *
 * @param db the transaction
 * @param id the service id
 * @returns true when the live service exists
 */
export async function lockLiveServiceRow(db: DbExecutor, id: number): Promise<boolean> {
  const [row] = await db
    .select({ id: s.services.id })
    .from(s.services)
    .where(and(eq(s.services.id, id), sql`${s.services.archivedAt} is null`))
    .limit(1)
    .for('update');
  return row !== undefined;
}

/**
 * Finds, for supplier services, the service linked to each (the lowest service id when several).
 *
 * Why: the import's classification: `new` when no service links the supplier service, else `matching` or `changed` by cost.
 *
 * @param db the database or a transaction
 * @param supplierServiceIds the supplier services
 * @returns the linked service by supplier service id
 */
export async function linkedServicesOf(
  db: DbExecutor,
  supplierServiceIds: readonly number[],
): Promise<Map<number, LinkedService>> {
  const found = new Map<number, LinkedService>();
  if (supplierServiceIds.length === 0) return found;
  const rows = await db
    .selectDistinctOn([s.serviceSupplierLinks.supplierServiceId], {
      supplierServiceId: s.serviceSupplierLinks.supplierServiceId,
      serviceId: s.services.id,
      name: s.services.name,
      cost: s.services.cost,
      archivedAt: s.services.archivedAt,
      minQty: s.services.minQty,
      maxQty: s.services.maxQty,
      qtyOptions: s.services.qtyOptions,
    })
    .from(s.serviceSupplierLinks)
    .innerJoin(s.services, eq(s.services.id, s.serviceSupplierLinks.serviceId))
    .where(inArray(s.serviceSupplierLinks.supplierServiceId, [...supplierServiceIds]))
    .orderBy(s.serviceSupplierLinks.supplierServiceId, asc(s.services.id));
  for (const row of rows) {
    found.set(row.supplierServiceId, {
      serviceId: row.serviceId,
      name: row.name,
      cost: row.cost,
      archived: row.archivedAt !== null,
      minQty: row.minQty,
      maxQty: row.maxQty,
      qtyOptions: row.qtyOptions,
    });
  }
  return found;
}

/** A custom field of a service, for the mapping to the supplier's field names. */
export interface ServiceFieldMap {
  readonly key: string;
  /** The field's Name (decision 065): what a supplier receives in CUSTOMFIELD. */
  readonly supplierKey: string;
  /** The field is the service's main input: its value travels as the IMEI parameter (decision 065). */
  readonly isMainInput: boolean;
}

/**
 * Reads the custom fields of a service.
 *
 * @param db the database or a transaction
 * @param serviceId the service
 * @returns each field's key, its Name and its main-input flag, in form order
 */
export async function serviceFieldMaps(db: DbExecutor, serviceId: number): Promise<ServiceFieldMap[]> {
  return db
    .select({
      key: s.serviceFields.key,
      supplierKey: s.serviceFields.supplierKey,
      isMainInput: s.serviceFields.isMainInput,
    })
    .from(s.serviceFields)
    .where(eq(s.serviceFields.serviceId, serviceId))
    .orderBy(asc(s.serviceFields.sort), asc(s.serviceFields.id));
}

/** A service the supplier sync may bring in line with its supplier (feature 33): the one active link's stored entry and field map, and its fields. */
export interface AlignmentCandidate {
  readonly serviceId: number;
  /** The service's type: only an `imei` service can adopt the supplier's main box. */
  readonly type: string;
  /** The supplier's stored entry of the linked supplier service (`supplier_services.raw`). */
  readonly raw: Record<string, unknown>;
  /** The linked supplier service's `Requires.Custom` list (`supplier_services.custom_fields`). */
  readonly customFields: unknown[];
  /** The one active link's `field_map` (the service's field key to the supplier's name). */
  readonly fieldMap: Record<string, unknown>;
  /** The service's fields in order: their keys, Names, whether they are required and whether each is the main input. */
  readonly fields: Array<{ key: string; supplierKey: string; required: boolean; isMainInput: boolean }>;
}

/**
 * Finds the services the sync of a supplier may bring in line with what the supplier asks for.
 *
 * Why: decision 042 and feature 33 (brief section 6, second review round): a live service whose only active link (in all) points at a
 * service of this supplier. Whether it adopts the main box (`adoptable`) or has fields to make required (`fieldsToRequire`) are the
 * caller's pure rules, so the type, the stored entry, the `Requires.Custom` list, the field map and the fields ride along.
 *
 * @param db the sync's transaction
 * @param supplierId the supplier
 * @param serviceIds when given, only these services (the re-read under the row locks)
 * @returns the candidates, by service id
 */
export async function alignmentCandidates(
  db: DbExecutor,
  supplierId: number,
  serviceIds?: readonly number[],
): Promise<AlignmentCandidate[]> {
  if (serviceIds !== undefined && serviceIds.length === 0) return [];
  return db
    .select({
      serviceId: s.services.id,
      type: s.services.type,
      raw: s.supplierServices.raw,
      customFields: s.supplierServices.customFields,
      fieldMap: s.serviceSupplierLinks.fieldMap,
      fields: sql<
        Array<{ key: string; supplierKey: string; required: boolean; isMainInput: boolean }>
      >`coalesce((select json_agg(json_build_object('key', f.key, 'supplierKey', f.supplier_key, 'required', f.required, 'isMainInput', f.is_main_input) order by f.sort, f.id) from ${s.serviceFields} f where f.service_id = ${s.services.id}), '[]'::json)`,
    })
    .from(s.serviceSupplierLinks)
    .innerJoin(s.supplierServices, eq(s.supplierServices.id, s.serviceSupplierLinks.supplierServiceId))
    .innerJoin(s.services, eq(s.services.id, s.serviceSupplierLinks.serviceId))
    .where(
      and(
        eq(s.supplierServices.supplierId, supplierId),
        eq(s.serviceSupplierLinks.isActive, true),
        sql`${s.services.archivedAt} is null`,
        ...(serviceIds === undefined ? [] : [inArray(s.services.id, [...serviceIds])]),
        sql`(select count(*) from ${s.serviceSupplierLinks} l where l.service_id = ${s.services.id} and l.is_active) = 1`,
      ),
    )
    .orderBy(asc(s.services.id));
}

/** A service category as the import's category choice reads it. */
export interface CategoryChoice {
  readonly id: number;
  readonly name: string;
  /** The service type the category holds (`imei`, `server`, `remote` or `file`). */
  readonly type: string;
}

/**
 * Reads a service category, and optionally holds it still for the rest of the transaction.
 *
 * Why: decision 063: an import that puts its new services into a category staff picked decides on the category's type and finds it
 * again by its name; a `share` lock makes a concurrent type change or rename of that category wait for the import (the catalog's own
 * writers take the row for update, `catalog-13`).
 *
 * @param db the database or a transaction
 * @param id the category id
 * @param lock `share` to lock the row for the rest of the transaction (needs a transaction); omitted for a plain read
 * @returns the category, or `undefined` when there is none
 */
export async function findCategoryChoice(
  db: DbExecutor,
  id: number,
  lock?: 'share',
): Promise<CategoryChoice | undefined> {
  const query = db
    .select({ id: s.serviceCategories.id, name: s.serviceCategories.name, type: s.serviceCategories.type })
    .from(s.serviceCategories)
    .where(eq(s.serviceCategories.id, id))
    .limit(1);
  const [row] = lock === undefined ? await query : await query.for(lock);
  return row;
}

/**
 * Reads the category of each of some services.
 *
 * Why: decision 063: after the import made services in the category staff picked, one read proves every one of them landed there (the
 * importer finds a category by name, and a mismatch would otherwise go unseen).
 *
 * @param db the transaction
 * @param serviceIds the services
 * @returns the category id by service id
 */
export async function categoryIdsOfServices(
  db: DbExecutor,
  serviceIds: readonly number[],
): Promise<Map<number, number>> {
  if (serviceIds.length === 0) return new Map();
  const rows = await db
    .select({ id: s.services.id, categoryId: s.services.categoryId })
    .from(s.services)
    .where(inArray(s.services.id, [...serviceIds]));
  return new Map(rows.map((row) => [row.id, row.categoryId]));
}
