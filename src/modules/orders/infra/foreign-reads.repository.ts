// Read-only lookups into tables other modules own (services and their fields and supplier links, categories, merchants, customers,
// suppliers, staff and files), kept in this one file: the order read model joins them and placement checks them.
//
// DEVIATION to resolve when those features land: decision 016 wants these reads through the owning module's public service.
// Catalog exports the merchant catalog and the price resolver but not the service row, its fields or its supplier links;
// identity exports no merchant lookup; suppliers (6), customers (14b) and platform files export nothing yet. So this file reads
// `services`, `service_categories`, `service_fields`, `service_supplier_links`, `clients`, `customers`, `suppliers`,
// `staff_users` and `files` with plain selects, like catalog's and money's foreign-read files. Replace the bodies with calls to
// their services; nothing outside this file knows (the read model imports the table handles from here).
import { and, asc, eq, inArray } from 'drizzle-orm';
import { type DbExecutor, schema as s } from '../../../infra/db';

/** The table handles the read model joins, so no other file of this module names a foreign table. */
export const foreignTables = {
  services: s.services,
  categories: s.serviceCategories,
  clients: s.clients,
  customers: s.customers,
  suppliers: s.suppliers,
  staff: s.staffUsers,
} as const;

/** A merchant as placement and the portal need it. */
export interface MerchantRecord {
  readonly id: number;
  readonly name: string;
  readonly groupId: number;
  readonly status: string;
}

/**
 * Reads one merchant.
 *
 * @param db the database or a transaction
 * @param id the merchant id
 * @returns the merchant, or `undefined` when there is none
 */
export async function merchantOf(db: DbExecutor, id: number): Promise<MerchantRecord | undefined> {
  const [row] = await db
    .select({ id: s.clients.id, name: s.clients.name, groupId: s.clients.groupId, status: s.clients.status })
    .from(s.clients)
    .where(eq(s.clients.id, id))
    .limit(1);
  return row;
}

/** A custom field of a service as placement reads it. */
export interface ServiceFieldRow {
  readonly id: number;
  readonly key: string;
  readonly label: string;
  readonly fieldType: 'text' | 'number' | 'select' | 'textarea';
  readonly options: string[];
  readonly required: boolean;
  readonly regex: string;
  readonly sort: number;
}

/**
 * Reads the custom fields of a service, in form order.
 *
 * @param db the database or a transaction
 * @param serviceId the service
 * @returns the fields by `sort`, then id
 */
export async function serviceFieldsOf(db: DbExecutor, serviceId: number): Promise<ServiceFieldRow[]> {
  return db
    .select({
      id: s.serviceFields.id,
      key: s.serviceFields.key,
      label: s.serviceFields.label,
      fieldType: s.serviceFields.fieldType,
      options: s.serviceFields.options,
      required: s.serviceFields.required,
      regex: s.serviceFields.regex,
      sort: s.serviceFields.sort,
    })
    .from(s.serviceFields)
    .where(eq(s.serviceFields.serviceId, serviceId))
    .orderBy(asc(s.serviceFields.sort), asc(s.serviceFields.id));
}

/**
 * Tells whether a service has an active supplier link.
 *
 * Why: decision 025 placement row: a service without an active link is `manual`; the dispatch job (feature 6) picks among the
 * links, this only asks whether it would have one to try.
 *
 * @param db the database or a transaction
 * @param serviceId the service
 * @returns true when at least one link is active
 */
export async function hasActiveSupplierLink(db: DbExecutor, serviceId: number): Promise<boolean> {
  const [row] = await db
    .select({ id: s.serviceSupplierLinks.id })
    .from(s.serviceSupplierLinks)
    .where(and(eq(s.serviceSupplierLinks.serviceId, serviceId), eq(s.serviceSupplierLinks.isActive, true)))
    .limit(1);
  return row !== undefined;
}

/** Whether a service exists and can be ordered. */
export interface ServiceAvailability {
  readonly status: string;
  readonly archived: boolean;
  /** `imei`, `server`, `remote` or `file`: Dhru places a File service with another action. */
  readonly type: 'imei' | 'server' | 'remote' | 'file';
}

/**
 * Reads whether a service is archived or disabled.
 *
 * Why: the merchant catalog answers "not visible" for every reason; placement tells a disabled service (`SERVICE_DISABLED`)
 * from an unknown, archived or hidden one (`NOT_FOUND`), so the merchant knows whether to wait or to pick another.
 *
 * @param db the database or a transaction
 * @param serviceId the service
 * @returns its status, or `undefined` when there is no such service
 */
export async function serviceAvailabilityOf(
  db: DbExecutor,
  serviceId: number,
): Promise<ServiceAvailability | undefined> {
  const [row] = await db
    .select({ status: s.services.status, archivedAt: s.services.archivedAt, type: s.services.type })
    .from(s.services)
    .where(eq(s.services.id, serviceId))
    .limit(1);
  return row ? { status: row.status, archived: row.archivedAt !== null, type: row.type } : undefined;
}

/** A stored file as placement and the file routes need it. */
export interface FileRecord {
  readonly id: number;
  readonly filename: string;
}

/**
 * Reads a file the merchant uploaded.
 *
 * Why: a File service order names an input file; it must be the merchant's own upload (`owner_type client`), or any merchant
 * could attach another's document to an order and read it back through the order.
 *
 * @param db the database or a transaction
 * @param clientId the merchant
 * @param fileId the file id from the request
 * @returns the file, or `undefined` when it does not exist or belongs to someone else
 */
export async function merchantFileOf(
  db: DbExecutor,
  clientId: number,
  fileId: number,
): Promise<FileRecord | undefined> {
  const [row] = await db
    .select({ id: s.files.id, filename: s.files.filename })
    .from(s.files)
    .where(and(eq(s.files.id, fileId), eq(s.files.ownerType, 'client'), eq(s.files.ownerId, clientId)))
    .limit(1);
  return row;
}

/**
 * A name lookup key: `staff:3`, `client:12`, `customer:8`, `supplier:2`.
 *
 * @param type the actor type of the event
 * @param id the actor's id
 * @returns the key of the map {@link actorNamesOf} returns
 */
export function actorKey(type: string, id: number): string {
  return `${type}:${id}`;
}

/**
 * Looks up the names of the actors of order events.
 *
 * @param db the database or a transaction
 * @param actors the actors (system events have none)
 * @returns names by {@link actorKey}; an actor whose row is gone has no entry
 */
export async function actorNamesOf(
  db: DbExecutor,
  actors: ReadonlyArray<{ type: string; id: number }>,
): Promise<Map<string, string>> {
  const names = new Map<string, string>();
  const idsOf = (type: string) => [...new Set(actors.filter((actor) => actor.type === type).map((actor) => actor.id))];
  const lookups: Array<[string, Promise<Array<{ id: number; name: string }>>]> = [];
  const staff = idsOf('staff');
  if (staff.length > 0) {
    lookups.push([
      'staff',
      db
        .select({ id: s.staffUsers.id, name: s.staffUsers.name })
        .from(s.staffUsers)
        .where(inArray(s.staffUsers.id, staff)),
    ]);
  }
  const clients = idsOf('client');
  if (clients.length > 0) {
    lookups.push([
      'client',
      db.select({ id: s.clients.id, name: s.clients.name }).from(s.clients).where(inArray(s.clients.id, clients)),
    ]);
  }
  const customers = idsOf('customer');
  if (customers.length > 0) {
    lookups.push([
      'customer',
      db
        .select({ id: s.customers.id, name: s.customers.name })
        .from(s.customers)
        .where(inArray(s.customers.id, customers)),
    ]);
  }
  const suppliers = idsOf('supplier');
  if (suppliers.length > 0) {
    lookups.push([
      'supplier',
      db
        .select({ id: s.suppliers.id, name: s.suppliers.name })
        .from(s.suppliers)
        .where(inArray(s.suppliers.id, suppliers)),
    ]);
  }
  for (const [type, rows] of lookups) for (const row of await rows) names.set(actorKey(type, row.id), row.name);
  return names;
}

/** A service as a paid storefront order needs it. */
export interface StorefrontServiceRecord {
  readonly id: number;
  readonly type: 'imei' | 'server' | 'remote' | 'file';
  readonly fulfillment: 'auto' | 'manual';
  /** The service's effective cost (USD): what the supplier is expected to charge; booked only when a supplier executes the order. */
  readonly effectiveCost: string;
}

/**
 * Reads a service for a paid storefront order, whatever its state.
 *
 * Why: the customer already paid the locked price when this runs (feature 16), so a service switched off or archived since is still
 * delivered or worked by hand: the refusal rules of the merchant's placement do not apply.
 *
 * @param db the database or a transaction
 * @param id the service
 * @returns the service, or `undefined` when it does not exist
 */
export async function storefrontServiceOf(db: DbExecutor, id: number): Promise<StorefrontServiceRecord | undefined> {
  const [row] = await db
    .select({
      id: s.services.id,
      type: s.services.type,
      fulfillment: s.services.fulfillment,
      effectiveCost: s.services.effectiveCost,
    })
    .from(s.services)
    .where(eq(s.services.id, id))
    .limit(1);
  return row;
}
