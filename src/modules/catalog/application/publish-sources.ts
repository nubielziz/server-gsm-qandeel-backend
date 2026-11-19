// The catalog's reads for the bulk publish (feature 31, plan 31 sections 3.2, 5.2 and 6.1): whether a service can be fulfilled by a
// supplier now (`supplyStates`), the service ids of a scope in keyset pages (every live service, a category, a supplier, a Quick add
// run), the existence of a category, a supplier and a Quick add run, and the labels of the rules a draft row names.
//
// DEVIATION to resolve when suppliers exports a read: decision 016 wants this through the suppliers' public service. The
// storefront cannot import suppliers (suppliers imports orders, orders imports storefront: a cycle, decision 032), and the catalog
// already reads `service_supplier_links`, `supplier_services` and `suppliers` in SQL next to `recomputeEffectiveCost`
// (`effective-cost.ts`), so this file reads the same three tables, and `supplier_import_runs` for the existence of a Quick add run,
// with plain selects. Nothing outside this file knows.
import { and, asc, eq, exists, gt, inArray, isNull, sql } from 'drizzle-orm';
import { type DbExecutor, schema as s } from '../../../infra/db';
import { ruleRowsOf } from '../infra/retail-price-rule.repository';
import { retailRuleOf } from './retail-rules';

/**
 * Whether a supplier can take an order of a service now: `ok`, `no_link` (no active link), or `supplier_unavailable` (every
 * active link's supplier is paused or disabled, or no longer lists the service).
 *
 * Why: plan 31 section 3.2 (`supplier_unavailable`): the rule of `pickLink` without the price test.
 */
export type SupplyState = 'ok' | 'no_link' | 'supplier_unavailable';

/**
 * Tells, for several services, whether a supplier can take an order of each now.
 *
 * Why: plan 31 section 3.2: the shop's sellable rule does not look at the supplier, so a service with no usable supplier link could
 * be listed and sold, and the paid order would wait in `needs_attention`. The publisher refuses such a row (`supplier_unavailable`)
 * when the service is fulfilled automatically. The rule is `pickLink`'s (suppliers/domain/link-selection.ts) without the price test:
 * an active link whose supplier is `active` and whose supplier service is still available.
 *
 * Side effects: none (reads only, no lock).
 *
 * @param db the database or the caller's transaction
 * @param serviceIds the services
 * @returns one state per service id asked (an unknown service reads `no_link`)
 */
export async function supplyStates(db: DbExecutor, serviceIds: readonly number[]): Promise<Map<number, SupplyState>> {
  const ids = [...new Set(serviceIds)];
  const out = new Map<number, SupplyState>(ids.map((id) => [id, 'no_link']));
  if (ids.length === 0) return out;
  const rows = await db
    .select({
      serviceId: s.serviceSupplierLinks.serviceId,
      supplierStatus: s.suppliers.status,
      available: s.supplierServices.isAvailable,
    })
    .from(s.serviceSupplierLinks)
    .innerJoin(s.supplierServices, eq(s.supplierServices.id, s.serviceSupplierLinks.supplierServiceId))
    .innerJoin(s.suppliers, eq(s.suppliers.id, s.supplierServices.supplierId))
    .where(and(inArray(s.serviceSupplierLinks.serviceId, ids), eq(s.serviceSupplierLinks.isActive, true)));
  for (const row of rows) {
    if (row.supplierStatus === 'active' && row.available) out.set(row.serviceId, 'ok');
    else if (out.get(row.serviceId) === 'no_link') out.set(row.serviceId, 'supplier_unavailable');
  }
  return out;
}

/** The most ids one page of a scope read returns: the keyset page of plan 31 section 6.1. */
export const SCOPE_PAGE_SIZE = 1000;

/**
 * Reads the ids of live services (not archived) after an id, in id order.
 *
 * Why: plan 31 sections 5.2 and 6.1: the scope `all` of a bulk publish, walked in keyset pages so a run of thousands never holds one
 * long statement. The storefront drops the services that have a listing (its own table).
 *
 * Side effects: none (reads only, no lock).
 *
 * @param db the database or a transaction
 * @param afterId the last id of the previous page, or 0
 * @param limit the page size (at most {@link SCOPE_PAGE_SIZE})
 * @returns the ids in ascending order
 */
export async function liveServiceIds(db: DbExecutor, afterId: number, limit: number): Promise<number[]> {
  const rows = await db
    .select({ id: s.services.id })
    .from(s.services)
    .where(and(isNull(s.services.archivedAt), gt(s.services.id, afterId)))
    .orderBy(asc(s.services.id))
    .limit(Math.min(limit, SCOPE_PAGE_SIZE));
  return rows.map((row) => row.id);
}

/**
 * Reads the ids of the live services of a category after an id, in id order.
 *
 * Why: plan 31 sections 5.2 and 6.1: the scope `category`.
 *
 * Side effects: none (reads only, no lock).
 *
 * @param db the database or a transaction
 * @param categoryId the category
 * @param afterId the last id of the previous page, or 0
 * @param limit the page size (at most {@link SCOPE_PAGE_SIZE})
 * @returns the ids in ascending order
 */
export async function serviceIdsOfCategory(
  db: DbExecutor,
  categoryId: number,
  afterId: number,
  limit: number,
): Promise<number[]> {
  const rows = await db
    .select({ id: s.services.id })
    .from(s.services)
    .where(and(eq(s.services.categoryId, categoryId), isNull(s.services.archivedAt), gt(s.services.id, afterId)))
    .orderBy(asc(s.services.id))
    .limit(Math.min(limit, SCOPE_PAGE_SIZE));
  return rows.map((row) => row.id);
}

/**
 * Reads the ids of the live services linked to a service of a supplier after an id, in id order.
 *
 * Why: plan 31 sections 5.2 and 6.1: the scope `supplier`. A service counts once however many of the supplier's services it is
 * linked to, and a link counts whether or not it is switched on: the choice is "this supplier's services", and a paused link shows
 * later as `supplier_unavailable`. The join of `service_supplier_links` and `supplier_services` sits next to `recomputeEffectiveCost`,
 * which reads them too (fact 17).
 *
 * Side effects: none (reads only, no lock).
 *
 * @param db the database or a transaction
 * @param supplierId the supplier
 * @param afterId the last id of the previous page, or 0
 * @param limit the page size (at most {@link SCOPE_PAGE_SIZE})
 * @returns the ids in ascending order
 */
export async function serviceIdsOfSupplier(
  db: DbExecutor,
  supplierId: number,
  afterId: number,
  limit: number,
): Promise<number[]> {
  const linked = db
    .select({ one: sql`1` })
    .from(s.serviceSupplierLinks)
    .innerJoin(s.supplierServices, eq(s.supplierServices.id, s.serviceSupplierLinks.supplierServiceId))
    .where(and(eq(s.serviceSupplierLinks.serviceId, s.services.id), eq(s.supplierServices.supplierId, supplierId)));
  const rows = await db
    .select({ id: s.services.id })
    .from(s.services)
    .where(and(isNull(s.services.archivedAt), gt(s.services.id, afterId), exists(linked)))
    .orderBy(asc(s.services.id))
    .limit(Math.min(limit, SCOPE_PAGE_SIZE));
  return rows.map((row) => row.id);
}

/**
 * Reads the ids of the live services a Quick add run created, after an id, in id order.
 *
 * Why: plan 31 sections 4.3, 5.2 and 6.1: the scope `quickAddRun`. The exact record of "what this run made" is the link a Quick add
 * writes with its service (`service_supplier_links.import_run_id`, written by `insertFirstLink`).
 *
 * The column arrived with migration `0045_quick_add_publish` (suppliers' schema, written by `insertFirstLink`). A service whose chain
 * staff replaced keeps the link that stayed, so it stays in its run; one whose Quick add link was removed has left it.
 *
 * Side effects: none (reads only, no lock).
 *
 * @param db the database or a transaction
 * @param runId the Quick add run (`supplier_import_runs.id`)
 * @param afterId the last id of the previous page, or 0
 * @param limit the page size (at most {@link SCOPE_PAGE_SIZE})
 * @returns the ids in ascending order
 */
export async function serviceIdsOfImportRun(
  db: DbExecutor,
  runId: number,
  afterId: number,
  limit: number,
): Promise<number[]> {
  const created = db
    .select({ one: sql`1` })
    .from(s.serviceSupplierLinks)
    .where(and(eq(s.serviceSupplierLinks.serviceId, s.services.id), eq(s.serviceSupplierLinks.importRunId, runId)));
  const rows = await db
    .select({ id: s.services.id })
    .from(s.services)
    .where(and(isNull(s.services.archivedAt), gt(s.services.id, afterId), exists(created)))
    .orderBy(asc(s.services.id))
    .limit(Math.min(limit, SCOPE_PAGE_SIZE));
  return rows.map((row) => row.id);
}

/**
 * Tells whether a category exists.
 *
 * Why: plan 31 section 5.2: the storefront cannot read the catalog's tables, so an unknown `scope.categoryId` is answered from here
 * (`422`, code `invalid`).
 *
 * @param db the database or a transaction
 * @param categoryId the category
 * @returns true when the category exists
 */
export async function categoryExists(db: DbExecutor, categoryId: number): Promise<boolean> {
  const [row] = await db
    .select({ id: s.serviceCategories.id })
    .from(s.serviceCategories)
    .where(eq(s.serviceCategories.id, categoryId))
    .limit(1);
  return row !== undefined;
}

/**
 * Tells whether a supplier exists.
 *
 * Why: plan 31 section 5.2 and fact 17: the storefront cannot read the suppliers' tables, so an unknown `scope.supplierId` is
 * answered from here (`422`, code `invalid`).
 *
 * @param db the database or a transaction
 * @param supplierId the supplier
 * @returns true when the supplier exists
 */
export async function supplierExists(db: DbExecutor, supplierId: number): Promise<boolean> {
  const [row] = await db
    .select({ id: s.suppliers.id })
    .from(s.suppliers)
    .where(eq(s.suppliers.id, supplierId))
    .limit(1);
  return row !== undefined;
}

/**
 * Tells whether a Quick add run exists.
 *
 * Why: plan 31 section 5.2 and fact 17: an unknown `scope.runId` of the scope `quickAddRun` is answered from here (`422`, code
 * `invalid`); a publish run is the storefront's own row.
 *
 * @param db the database or a transaction
 * @param runId the Quick add run
 * @returns true when the run exists
 */
export async function importRunExists(db: DbExecutor, runId: number): Promise<boolean> {
  const [row] = await db
    .select({ id: s.supplierImportRuns.id })
    .from(s.supplierImportRuns)
    .where(eq(s.supplierImportRuns.id, runId))
    .limit(1);
  return row !== undefined;
}

/**
 * Reads the labels of retail price rules by id, deleted rules included.
 *
 * Why: plan 31 section 5.2: a draft row names the rule that priced it (`rule: { id, label }`), and the name stays after the rule is
 * deleted (a deleted rule keeps its row for the history).
 *
 * Side effects: none (reads only).
 *
 * @param db the database or a transaction
 * @param ruleIds the rules a page of rows names (repeats are fine)
 * @returns the server's words for each rule found (`IMEI +30%`); an id with no row is absent
 */
export async function ruleLabelsOf(db: DbExecutor, ruleIds: readonly number[]): Promise<Map<number, string>> {
  const rows = await ruleRowsOf(db, ruleIds);
  return new Map([...rows].map(([id, row]) => [id, retailRuleOf(row).label]));
}
