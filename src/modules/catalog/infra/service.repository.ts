// Drizzle queries of the service routes on `services` and the parts of a service (`service_fields`, `service_options`,
// `service_group_prices`): the list and the single row with the figures worked out in SQL, the locks and writes, the stored order
// of services (decision 063) and the pricing-rule switches of the archive and delete paths.
import { and, asc, eq, gt, inArray, isNull, ne, sql } from 'drizzle-orm';
import type { ListSort, ParsedListQuery } from '../../../common/contract';
import { type DbExecutor, type ListColumns, listOrderBy, listWhere } from '../../../infra/db';
import {
  type NewService,
  type NewServiceField,
  type NewServiceOption,
  type Service,
  type ServiceField,
  type ServiceGroupPrice,
  type ServiceOption,
  clientGroups,
  pricingRules,
  serviceCategories,
  serviceFields,
  serviceGroupPrices,
  serviceOptions,
  services,
} from '../db/schema';
import type { AttentionReason } from '../domain/service-attention';
import { hasActiveSupplierLinkSql, isListedSql, primarySupplierIdSql } from './foreign-reads.repository';
import { availableCodeCountSql } from './inventory.repository';
import { needsAttentionSql, notOnShopSql, retailPriceSql } from './service-attention.sql';
import { belowFloorSql, floorPriceSql, marginPctSql, minProfitSql } from './service-figures.sql';
import { categoryPositionSql, expandSortField } from './service-order.sql';

/** A service with its category name and the figures worked out in SQL. */
export interface ServiceRow {
  readonly service: Service;
  readonly categoryName: string;
  /** The minimum profit that counts, four decimals. */
  readonly minProfit: string;
  readonly floorPrice: string;
  readonly marginPct: string;
  readonly belowFloor: boolean;
  /** How many of its codes are `available` now (decision 069; 0 for a service without codes). */
  readonly stockAvailable: number;
}

/** The sorts of `GET /admin/services` (the price grid reads `name`, `sort` and `id`). */
export type ServiceListSort = 'name' | 'type' | 'cost' | 'basePrice' | 'retailPrice' | 'sort' | 'id';

/**
 * The wire fields of the list and the columns they map to; `belowFloor` and `needsAttention` depend on the moment (rule windows),
 * `needsAttention` also on the reasons the caller may see (decision 060). Every declared filter has a column, whoever asks: the
 * use case refuses a filter the caller may not use before this map is read.
 */
const columnsAt = (at: Date, reasons: readonly AttentionReason[]): ListColumns => ({
  id: services.id,
  name: services.name,
  type: services.type,
  status: services.status,
  categoryId: services.categoryId,
  basePrice: services.basePrice,
  // `cost` on the wire is the effective cost (RESOLUTIONS catalog-1), so the sort uses it too.
  cost: services.effectiveCost,
  code: services.code,
  'category.name': serviceCategories.name,
  belowFloor: belowFloorSql(at),
  needsAttention: needsAttentionSql(reasons, at),
  hasSupplier: hasActiveSupplierLinkSql,
  supplierId: primarySupplierIdSql,
  isListed: isListedSql,
  notOnShop: notOnShopSql,
  // Decision 069: the console's Inventory menu lists the services delivered from code stock.
  stockDelivery: services.stockDelivery,
  retailPrice: retailPriceSql,
  // `sort` stands for "category position, then the service's own position, then name": the order merchants read (decision 063).
  categoryPosition: categoryPositionSql,
  sort: services.sort,
});

const live = isNull(services.archivedAt);

/**
 * The keys a list sort orders by: `sort` stands for the category position, the service's own position and the name, in the
 * direction asked for (decision 063).
 */
function serviceOrderOf(sort: readonly ListSort[]): ListSort[] {
  return expandSortField(sort, 'sort', { before: ['categoryPosition'], after: ['name'] });
}

function selectRows(db: DbExecutor, at: Date) {
  return db
    .select({
      service: services,
      categoryName: serviceCategories.name,
      minProfit: minProfitSql(at),
      floorPrice: floorPriceSql(at),
      marginPct: marginPctSql,
      belowFloor: belowFloorSql(at),
      stockAvailable: availableCodeCountSql,
    })
    .from(services)
    .innerJoin(serviceCategories, eq(serviceCategories.id, services.categoryId));
}

/**
 * Lists live services for `GET /admin/services`.
 *
 * @param db the database or a transaction
 * @param query the parsed list request (filters, search, sort, range)
 * @param at the clock's now: the pricing rules in force at it set the minimum profit
 * @param reasons the attention reasons the caller may see: `needsAttention` is their union (decision 060)
 * @returns the page of services with their figures, and the exact total
 */
export async function listServiceRows(
  db: DbExecutor,
  query: ParsedListQuery<ServiceListSort>,
  at: Date,
  reasons: readonly AttentionReason[],
): Promise<{ rows: ServiceRow[]; total: number }> {
  const columns = columnsAt(at, reasons);
  const where = listWhere(query, columns, live);
  const [rows, [count]] = await Promise.all([
    selectRows(db, at)
      .where(where)
      .orderBy(...listOrderBy(serviceOrderOf(query.sort), columns, services.id))
      .limit(query.range.limit)
      .offset(query.range.start),
    db
      .select({ total: sql<number>`count(*)::int` })
      .from(services)
      .innerJoin(serviceCategories, eq(serviceCategories.id, services.categoryId))
      .where(where),
  ]);
  return { rows, total: count?.total ?? 0 };
}

/**
 * Finds a live service with its figures.
 *
 * @param db the database or a transaction
 * @param id the service id
 * @param at the clock's now: the pricing rules in force at it set the minimum profit
 * @returns the service, or `undefined` when it is unknown or archived
 */
export async function findServiceRow(db: DbExecutor, id: number, at: Date): Promise<ServiceRow | undefined> {
  const [row] = await selectRows(db, at)
    .where(and(eq(services.id, id), live))
    .limit(1);
  return row;
}

/**
 * Finds live services by id or by category, with their figures, in id order.
 *
 * Why: the bulk price change reads the services it will touch (a category, or the ticked ones) with the floor of each.
 *
 * @param db the database or a transaction
 * @param scope `{ serviceIds }` or `{ categoryId }`
 * @param at the clock's now: the pricing rules in force at it set the minimum profit
 * @returns the live services of the scope that exist
 */
export async function findServiceRowsInScope(
  db: DbExecutor,
  scope: { readonly serviceIds: readonly number[] } | { readonly categoryId: number },
  at: Date,
): Promise<ServiceRow[]> {
  if ('serviceIds' in scope && scope.serviceIds.length === 0) return [];
  const target =
    'serviceIds' in scope ? inArray(services.id, [...scope.serviceIds]) : eq(services.categoryId, scope.categoryId);
  return selectRows(db, at).where(and(target, live)).orderBy(asc(services.id));
}

/**
 * Locks the live services of a scope for the rest of the transaction, in id order.
 *
 * Why: a bulk price apply recomputes from the current prices and writes them back; locking in id order keeps two applies (or a
 * price edit) from interleaving or deadlocking.
 *
 * @param db the transaction
 * @param scope `{ serviceIds }` or `{ categoryId }`
 * @returns the ids that were locked
 */
export async function lockLiveServicesInScope(
  db: DbExecutor,
  scope: { readonly serviceIds: readonly number[] } | { readonly categoryId: number },
): Promise<number[]> {
  if ('serviceIds' in scope && scope.serviceIds.length === 0) return [];
  const target =
    'serviceIds' in scope ? inArray(services.id, [...scope.serviceIds]) : eq(services.categoryId, scope.categoryId);
  const rows = await db
    .select({ id: services.id })
    .from(services)
    .where(and(target, live))
    .orderBy(asc(services.id))
    .for('update');
  return rows.map((row) => row.id);
}

/** A live service as the order of services reads it. */
export interface ServicePosition {
  readonly id: number;
  readonly code: string;
  readonly sort: number;
}

/**
 * Locks the given live services for the rest of the transaction, in id order, and reads their position.
 *
 * Why: decision 063: a new order of services is written from the positions nobody can change until the transaction ends, so two
 * saves (or a save and a delete) never interleave; the id order keeps two saves from deadlocking.
 *
 * @param db the transaction
 * @param ids the service ids to lock (duplicates are fine)
 * @returns the live services among them, by id; an unknown or archived id is not in the list
 */
export async function lockServicePositions(db: DbExecutor, ids: readonly number[]): Promise<ServicePosition[]> {
  const unique = [...new Set(ids)];
  if (unique.length === 0) return [];
  return db
    .select({ id: services.id, code: services.code, sort: services.sort })
    .from(services)
    .where(and(inArray(services.id, unique), live))
    .orderBy(asc(services.id))
    .for('update');
}

/**
 * Writes the positions of services that changed.
 *
 * @param db the transaction (the services are locked)
 * @param items the services and their new position
 * @returns the ids of the services whose position changed (a service already at its position is left alone)
 */
export async function writeServicePositions(
  db: DbExecutor,
  items: ReadonlyArray<{ readonly id: number; readonly sort: number }>,
): Promise<number[]> {
  if (items.length === 0) return [];
  const result = await db.execute<{ id: string }>(sql`
    update ${services} as target
    set sort = changed.sort, updated_at = now()
    from (values ${sql.join(
      items.map((item) => sql`(${item.id}::bigint, ${item.sort}::integer)`),
      sql`, `,
    )}) as changed(id, sort)
    where target.id = changed.id and target.sort is distinct from changed.sort
    returning target.id`);
  return result.rows.map((row) => Number(row.id)).sort((a, b) => a - b);
}

/**
 * Finds a live service and locks it for the rest of the transaction.
 *
 * Why: a change, a delete, a replace-all of its parts and an inventory import on the same service must not interleave (the
 * delete decides between archiving and deleting from what refers to it).
 *
 * @param db the transaction
 * @param id the service id
 * @param mode `update` for writers (default), `share` for readers that insert children (inventory import)
 * @returns the service, or `undefined` when it is unknown or archived
 */
export async function lockLiveService(
  db: DbExecutor,
  id: number,
  mode: 'update' | 'share' = 'update',
): Promise<Service | undefined> {
  const query = db
    .select()
    .from(services)
    .where(and(eq(services.id, id), live))
    .limit(1);
  const [row] = await query.for(mode === 'update' ? 'update' : 'share');
  return row;
}

/**
 * Finds the live service that holds a code, ignoring case.
 *
 * @param db the database or a transaction
 * @param code the trimmed code
 * @param exceptId a service to leave out (the one being changed)
 * @returns the id and name of the service that holds the code, or `undefined`
 */
export async function findServiceByCode(
  db: DbExecutor,
  code: string,
  exceptId?: number,
): Promise<{ id: number; name: string } | undefined> {
  const same = and(sql`lower(${services.code}) = lower(${code})`, live);
  const [row] = await db
    .select({ id: services.id, name: services.name })
    .from(services)
    .where(exceptId === undefined ? same : and(same, ne(services.id, exceptId)))
    .limit(1);
  return row;
}

/**
 * Inserts a service.
 *
 * @param db the transaction
 * @param row the new service
 * @returns the stored service
 */
export async function insertServiceRow(db: DbExecutor, row: NewService): Promise<Service> {
  const [created] = await db.insert(services).values(row).returning();
  return created!;
}

/**
 * Changes a service.
 *
 * @param db the transaction
 * @param id the service id
 * @param changes the columns that change
 * @returns the updated service, or `undefined` when it is gone
 */
export async function updateServiceRow(
  db: DbExecutor,
  id: number,
  changes: Partial<Omit<NewService, 'id'>>,
): Promise<Service | undefined> {
  const [row] = await db.update(services).set(changes).where(eq(services.id, id)).returning();
  return row;
}

/**
 * Switches the pricing rules of one service off.
 *
 * @param db the transaction
 * @param serviceId the archived service
 * @returns the ids of the rules that were active
 */
export async function deactivateServiceRules(db: DbExecutor, serviceId: number): Promise<number[]> {
  const rows = await db
    .update(pricingRules)
    .set({ isActive: false })
    .where(
      and(eq(pricingRules.scope, 'service'), eq(pricingRules.targetId, serviceId), eq(pricingRules.isActive, true)),
    )
    .returning({ id: pricingRules.id });
  return rows.map((row) => row.id).sort((a, b) => a - b);
}

/**
 * Deletes the pricing rules of one service.
 *
 * @param db the transaction
 * @param serviceId the service about to be deleted
 * @returns the ids of the deleted rules
 */
export async function deleteServiceRules(db: DbExecutor, serviceId: number): Promise<number[]> {
  const rows = await db
    .delete(pricingRules)
    .where(and(eq(pricingRules.scope, 'service'), eq(pricingRules.targetId, serviceId)))
    .returning({ id: pricingRules.id });
  return rows.map((row) => row.id).sort((a, b) => a - b);
}

/**
 * Deletes a service row (its fields, options and prices go with it).
 *
 * @param db the transaction
 * @param id the service id
 * @returns true when a row was deleted
 */
export async function deleteServiceRow(db: DbExecutor, id: number): Promise<boolean> {
  const rows = await db.delete(services).where(eq(services.id, id)).returning({ id: services.id });
  return rows.length > 0;
}

/**
 * Reads the custom fields of a service in order.
 *
 * @param db the database or a transaction
 * @param serviceId the service
 * @returns the fields by `sort`
 */
export async function listFieldRows(db: DbExecutor, serviceId: number): Promise<ServiceField[]> {
  return db
    .select()
    .from(serviceFields)
    .where(eq(serviceFields.serviceId, serviceId))
    .orderBy(asc(serviceFields.sort), asc(serviceFields.id));
}

/**
 * Reads the custom fields of several services at once, by `sort`.
 *
 * Why: the Dhru service list shows the fields of every service (`Requires.Custom`); one query for the whole list, not one per service.
 *
 * @param db the database or a transaction
 * @param serviceIds the services
 * @returns the fields grouped by service, each list in `sort` order (a service without fields has no entry)
 */
export async function listFieldRowsOf(
  db: DbExecutor,
  serviceIds: readonly number[],
): Promise<Map<number, ServiceField[]>> {
  const byService = new Map<number, ServiceField[]>();
  if (serviceIds.length === 0) return byService;
  const rows = await db
    .select()
    .from(serviceFields)
    .where(inArray(serviceFields.serviceId, [...serviceIds]))
    .orderBy(asc(serviceFields.sort), asc(serviceFields.id));
  for (const row of rows) byService.set(row.serviceId, [...(byService.get(row.serviceId) ?? []), row]);
  return byService;
}

/**
 * Reads the option lists of a service in the order they were saved.
 *
 * @param db the database or a transaction
 * @param serviceId the service
 * @returns the options by id (insertion order)
 */
export async function listOptionRows(db: DbExecutor, serviceId: number): Promise<ServiceOption[]> {
  return db
    .select()
    .from(serviceOptions)
    .where(eq(serviceOptions.serviceId, serviceId))
    .orderBy(asc(serviceOptions.id));
}

/**
 * Reads the fixed group prices of a service.
 *
 * @param db the database or a transaction
 * @param serviceId the service
 * @returns the prices by group id
 */
export async function listGroupPriceRows(db: DbExecutor, serviceId: number): Promise<ServiceGroupPrice[]> {
  return db
    .select()
    .from(serviceGroupPrices)
    .where(eq(serviceGroupPrices.serviceId, serviceId))
    .orderBy(asc(serviceGroupPrices.groupId));
}

/** Rows inserted per statement when a replace-all list is written. */
const INSERT_CHUNK = 500;

/**
 * Replaces all custom fields of a service: deletes the old ones and inserts the new list in order.
 *
 * @param db the transaction (the service row is locked)
 * @param serviceId the service
 * @param rows the new fields; `sort` is set from the list order
 * @returns the saved fields in order
 */
export async function replaceFieldRows(
  db: DbExecutor,
  serviceId: number,
  rows: ReadonlyArray<Omit<NewServiceField, 'serviceId' | 'sort' | 'id'>>,
): Promise<ServiceField[]> {
  await db.delete(serviceFields).where(eq(serviceFields.serviceId, serviceId));
  const saved: ServiceField[] = [];
  for (let start = 0; start < rows.length; start += INSERT_CHUNK) {
    const chunk = rows
      .slice(start, start + INSERT_CHUNK)
      .map((row, offset) => ({ ...row, serviceId, sort: start + offset }));
    saved.push(...(await db.insert(serviceFields).values(chunk).returning()));
  }
  return saved.sort((a, b) => a.sort - b.sort);
}

/**
 * Puts a field before the service's other fields: their `sort` moves up by one and the new field takes `sort` 0.
 *
 * Why: decision 042 (feature 33): the supplier's main box becomes the first field of an adopted service; the other fields keep their
 * keys, values and order.
 *
 * @param db the transaction (the service row is locked)
 * @param serviceId the service
 * @param row the new field
 * @returns the saved field
 */
export async function insertFirstFieldRow(
  db: DbExecutor,
  serviceId: number,
  row: Omit<NewServiceField, 'serviceId' | 'sort' | 'id'>,
): Promise<ServiceField> {
  await db
    .update(serviceFields)
    .set({ sort: sql`${serviceFields.sort} + 1` })
    .where(eq(serviceFields.serviceId, serviceId));
  const [saved] = await db
    .insert(serviceFields)
    .values({ ...row, serviceId, sort: 0 })
    .returning();
  return saved!;
}

/**
 * Makes a field of a service its first field and gives it new values: the other fields keep their order behind it (`sort` 1, 2, ...).
 *
 * Why: decision 071: the supplier sync's adoption turns an IMEI service's main-input field (its IMEI) into the supplier's main box, in
 * full (Name, label, type, options, pattern, `required`); the field keeps its id and its key, so the answers older orders stored under that
 * key now show under the box's label.
 *
 * @param db the transaction (the service row is locked)
 * @param serviceId the service
 * @param fieldId the field to put first (a field of the service)
 * @param row its new values
 * @returns the saved field
 */
export async function makeFirstFieldRow(
  db: DbExecutor,
  serviceId: number,
  fieldId: number,
  row: Pick<NewServiceField, 'label' | 'fieldType' | 'options' | 'required' | 'regex' | 'supplierKey'>,
): Promise<ServiceField> {
  const others = (await listFieldRows(db, serviceId)).filter((field) => field.id !== fieldId);
  for (const [index, field] of others.entries()) {
    if (field.sort !== index + 1) {
      await db
        .update(serviceFields)
        .set({ sort: index + 1 })
        .where(eq(serviceFields.id, field.id));
    }
  }
  const [saved] = await db
    .update(serviceFields)
    .set({ ...row, sort: 0 })
    .where(and(eq(serviceFields.id, fieldId), eq(serviceFields.serviceId, serviceId)))
    .returning();
  return saved!;
}

/**
 * Replaces all option lists of a service: deletes the old entries and inserts the new list in order.
 *
 * @param db the transaction (the service row is locked)
 * @param serviceId the service
 * @param rows the new entries
 * @returns the saved options in order
 */
export async function replaceOptionRows(
  db: DbExecutor,
  serviceId: number,
  rows: ReadonlyArray<Omit<NewServiceOption, 'serviceId' | 'id'>>,
): Promise<ServiceOption[]> {
  await db.delete(serviceOptions).where(eq(serviceOptions.serviceId, serviceId));
  const saved: ServiceOption[] = [];
  for (let start = 0; start < rows.length; start += INSERT_CHUNK) {
    const chunk = rows.slice(start, start + INSERT_CHUNK).map((row) => ({ ...row, serviceId }));
    saved.push(...(await db.insert(serviceOptions).values(chunk).returning()));
  }
  return saved.sort((a, b) => a.id - b.id);
}

/**
 * Locks merchant groups against a delete or a rename for the rest of the transaction (`FOR SHARE`, in id order) and reads them.
 *
 * Why: a group-price save names groups; the group delete takes the row `FOR UPDATE` and then removes the group's prices, so a
 * save that holds the shared lock either finishes first or sees the group gone (`422`), never a foreign key error.
 *
 * @param db the transaction
 * @param ids the group ids; duplicates are fine
 * @returns the groups that exist, by id
 */
export async function lockGroupsShared(
  db: DbExecutor,
  ids: readonly number[],
): Promise<Map<number, { id: number; name: string; kind: string }>> {
  const unique = [...new Set(ids)].sort((a, b) => a - b);
  if (unique.length === 0) return new Map();
  const rows = await db
    .select({ id: clientGroups.id, name: clientGroups.name, kind: clientGroups.kind })
    .from(clientGroups)
    .where(inArray(clientGroups.id, unique))
    .orderBy(asc(clientGroups.id))
    .for('share');
  return new Map(rows.map((row) => [row.id, row]));
}

/**
 * Replaces all group prices of a service: deletes the old ones and inserts the new set.
 *
 * @param db the transaction (the service row is locked)
 * @param serviceId the service
 * @param rows the new prices, one per group
 * @returns the saved prices by group id
 */
export async function replaceGroupPriceRows(
  db: DbExecutor,
  serviceId: number,
  rows: ReadonlyArray<{ groupId: number; price: string }>,
): Promise<ServiceGroupPrice[]> {
  await db.delete(serviceGroupPrices).where(eq(serviceGroupPrices.serviceId, serviceId));
  if (rows.length === 0) return [];
  const saved = await db
    .insert(serviceGroupPrices)
    .values(rows.map((row) => ({ ...row, serviceId })))
    .returning();
  return saved.sort((a, b) => a.groupId - b.groupId);
}

/** A stored field pattern with the service it belongs to (the review of decision 051). */
export interface FieldPatternRow {
  readonly id: number;
  readonly serviceId: number;
  readonly serviceName: string;
  readonly key: string;
  readonly regex: string;
}

/**
 * Reads a page of the fields that carry a pattern, in id order.
 *
 * Why: decision 051: the one-time review of stored patterns walks every field with a pattern, archived services included, so a pattern
 * that comes back to life with its service is already in the supported form.
 *
 * @param db the database or a transaction
 * @param afterId the last field id of the previous page, or 0
 * @param limit the size of the page
 * @returns the fields with a non-empty pattern after `afterId`, with their service's id and name
 */
export function fieldPatternsAfter(db: DbExecutor, afterId: number, limit: number): Promise<FieldPatternRow[]> {
  return db
    .select({
      id: serviceFields.id,
      serviceId: serviceFields.serviceId,
      serviceName: services.name,
      key: serviceFields.key,
      regex: serviceFields.regex,
    })
    .from(serviceFields)
    .innerJoin(services, eq(services.id, serviceFields.serviceId))
    .where(and(ne(serviceFields.regex, ''), gt(serviceFields.id, afterId)))
    .orderBy(asc(serviceFields.id))
    .limit(limit);
}

/**
 * Clears the pattern of one field, only while it still holds the pattern that was judged.
 *
 * Why: decision 051: a staff save that replaced the pattern after the review read it must win, so the update names the old text.
 *
 * @param db the transaction of the clearing
 * @param fieldId the field
 * @param regex the pattern that was judged
 * @returns true when the field still held that pattern and now has none
 */
export async function clearFieldPattern(db: DbExecutor, fieldId: number, regex: string): Promise<boolean> {
  const rows = await db
    .update(serviceFields)
    .set({ regex: '' })
    .where(and(eq(serviceFields.id, fieldId), eq(serviceFields.regex, regex)))
    .returning({ id: serviceFields.id });
  return rows.length > 0;
}
