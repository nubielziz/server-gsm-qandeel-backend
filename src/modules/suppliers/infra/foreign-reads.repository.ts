// Read-only lookups into tables other modules own, kept in this one file: the services a supplier service is linked to (name, code,
// status, SLA, cost), the custom fields of a service (to map an order's inputs to the supplier's field names) and whether it exists.
//
// DEVIATION to resolve later: decision 016 wants these reads through the owning module's public service. The catalog exports no
// service reader, so this file reads `services` and `service_fields` with plain selects, like the other modules' foreign-read files.
// Writes to the catalog (the import) go through `ServiceImporter`.
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
    });
  }
  return found;
}

/** A custom field of a service, for the mapping to the supplier's field names. */
export interface ServiceFieldMap {
  readonly key: string;
  readonly supplierKey: string;
}

/**
 * Reads the custom fields of a service.
 *
 * @param db the database or a transaction
 * @param serviceId the service
 * @returns each field's key and the supplier's name for it (empty when none was set)
 */
export async function serviceFieldMaps(db: DbExecutor, serviceId: number): Promise<ServiceFieldMap[]> {
  return db
    .select({ key: s.serviceFields.key, supplierKey: s.serviceFields.supplierKey })
    .from(s.serviceFields)
    .where(eq(s.serviceFields.serviceId, serviceId))
    .orderBy(asc(s.serviceFields.sort), asc(s.serviceFields.id));
}
