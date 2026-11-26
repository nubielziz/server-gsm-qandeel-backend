// Read-only lookups into tables other modules own (services and their fields and supplier links, categories, accounts and their ranks,
// the map of old account numbers, suppliers, staff and files), kept in this one file: the order read model joins them and placement checks
// them.
//
// DEVIATION to resolve when those features land: decision 016 wants these reads through the owning module's public service.
// Catalog exports the merchant catalog and the price resolver but not the service row, its fields or its supplier links;
// identity exports no account lookup that joins in SQL; suppliers (6) and platform files export nothing yet. So this file reads
// `services`, `service_categories`, `service_fields`, `service_supplier_links`, `service_listings`, `clients`, `client_groups`,
// `account_legacy_ids`, `suppliers`, `staff_users` and `files` with plain selects, like catalog's and money's foreign-read files.
// Replace the bodies with calls to their services; nothing outside this file knows (the read model imports the table handles from here).
import { and, asc, eq, inArray } from 'drizzle-orm';
import { type DbExecutor, schema as s } from '../../../infra/db';
import type { PlacementFieldType } from '../domain/placement-rules';

/** The table handles the read model joins, so no other file of this module names a foreign table. */
export const foreignTables = {
  services: s.services,
  categories: s.serviceCategories,
  listings: s.serviceListings,
  /** The accounts: the buyer of every order, whatever its rank (decision 064). */
  clients: s.clients,
  /** The ranks of the accounts. */
  groups: s.clientGroups,
  /** The map from the old merchant and customer numbers to accounts (append-only). */
  legacyAccounts: s.accountLegacyIds,
  suppliers: s.suppliers,
  staff: s.staffUsers,
} as const;

/** An account as placement and the portal need it: the merchant's id is the account id. */
export interface MerchantRecord {
  readonly id: number;
  readonly name: string;
  readonly groupId: number;
  readonly status: string;
}

/**
 * Reads one account by its id.
 *
 * Why: a merchant is an account of a merchant rank and keeps its old id (decision 064), so the placement and the Dhru surface read it by the
 * account id. This reads the row only; the rank gate and the placement check the kind and the status.
 *
 * @param db the database or a transaction
 * @param id the account id
 * @returns the account, or `undefined` when there is none
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
  readonly fieldType: PlacementFieldType;
  readonly options: string[];
  readonly required: boolean;
  readonly regex: string;
  readonly sort: number;
  /** The field's Name (decision 065): never empty, unique in its service ignoring case, what a supplier receives. */
  readonly supplierKey: string;
  /** The field is the service's main input: its value travels as the IMEI parameter (decision 065). */
  readonly isMainInput: boolean;
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
      supplierKey: s.serviceFields.supplierKey,
      isMainInput: s.serviceFields.isMainInput,
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
 * Reads a file the account uploaded.
 *
 * Why: a File service order names an input file; it must be the account's own upload (`owner_type account`), or any merchant
 * could attach another's document to an order and read it back through the order.
 *
 * @param db the database or a transaction
 * @param accountId the account that places the order
 * @param fileId the file id from the request
 * @returns the file, or `undefined` when it does not exist or belongs to someone else
 */
export async function merchantFileOf(
  db: DbExecutor,
  accountId: number,
  fileId: number,
): Promise<FileRecord | undefined> {
  const [row] = await db
    .select({ id: s.files.id, filename: s.files.filename })
    .from(s.files)
    .where(and(eq(s.files.id, fileId), eq(s.files.ownerType, 'account'), eq(s.files.ownerId, accountId)))
    .limit(1);
  return row;
}

/**
 * A lookup key of an actor of an order event: `staff:3`, `account:12`, `client:8`, `customer:8`, `supplier:2`.
 *
 * @param type the actor type of the event (a row written before the accounts merged may still say `client` or `customer`)
 * @param id the actor's id as the event stored it
 * @returns the key of the map {@link actorFactsOf} returns
 */
export function actorKey(type: string, id: number): string {
  return `${type}:${id}`;
}

/** What a timeline line knows of its actor once the map has been read. */
export interface ActorFacts {
  /** The actor's name now (the name of the account, the staff member or the supplier). */
  readonly name: string;
  /** The account the actor is: the id itself for `account` and `client`, the mapped account for an old `customer`; null for staff, suppliers. */
  readonly accountId: number | null;
}

/**
 * Looks up the names of the actors of order events and the accounts they stand for.
 *
 * Why: decision 064. An event written after the accounts merged names its actor `account` with the account id. An event written before it
 * keeps its old words: `client` (an old merchant number, which is the account id because merchants kept their ids) and `customer` (an old
 * customer number, which is NOT an account id: it goes through `account_legacy_ids`, so customer 7 never reads as account 7). A pair the map
 * does not know has no entry, shown as an unknown actor and never as another person.
 *
 * @param db the database or a transaction
 * @param actors the actors (system events have none)
 * @returns facts by {@link actorKey}; an actor whose row is gone, or whose old number the map does not know, has no entry
 */
export async function actorFactsOf(
  db: DbExecutor,
  actors: ReadonlyArray<{ type: string; id: number }>,
): Promise<Map<string, ActorFacts>> {
  const facts = new Map<string, ActorFacts>();
  const idsOf = (type: string) => [...new Set(actors.filter((actor) => actor.type === type).map((actor) => actor.id))];
  // One query per word that has ids, one after the other: the caller may hand over a transaction, which runs one statement at a time.
  const staff = idsOf('staff');
  if (staff.length > 0) {
    const rows = await db
      .select({ id: s.staffUsers.id, name: s.staffUsers.name })
      .from(s.staffUsers)
      .where(inArray(s.staffUsers.id, staff));
    for (const row of rows) facts.set(actorKey('staff', row.id), { name: row.name, accountId: null });
  }
  // `account` and the old `client` word name the same number space: an account id.
  for (const type of ['account', 'client']) {
    const ids = idsOf(type);
    if (ids.length === 0) continue;
    const rows = await db
      .select({ id: s.clients.id, name: s.clients.name })
      .from(s.clients)
      .where(inArray(s.clients.id, ids));
    for (const row of rows) facts.set(actorKey(type, row.id), { name: row.name, accountId: row.id });
  }
  const customers = idsOf('customer');
  if (customers.length > 0) {
    const rows = await db
      .select({ legacyId: s.accountLegacyIds.legacyId, accountId: s.clients.id, name: s.clients.name })
      .from(s.accountLegacyIds)
      .innerJoin(s.clients, eq(s.clients.id, s.accountLegacyIds.accountId))
      .where(and(eq(s.accountLegacyIds.legacyType, 'customer'), inArray(s.accountLegacyIds.legacyId, customers)));
    for (const row of rows) facts.set(actorKey('customer', row.legacyId), { name: row.name, accountId: row.accountId });
  }
  const suppliers = idsOf('supplier');
  if (suppliers.length > 0) {
    const rows = await db
      .select({ id: s.suppliers.id, name: s.suppliers.name })
      .from(s.suppliers)
      .where(inArray(s.suppliers.id, suppliers));
    for (const row of rows) facts.set(actorKey('supplier', row.id), { name: row.name, accountId: null });
  }
  return facts;
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
