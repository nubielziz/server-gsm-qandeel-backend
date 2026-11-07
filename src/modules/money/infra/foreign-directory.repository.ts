// Read-only lookups into tables other modules own (merchants, groups, suppliers, customers, staff), kept in this one file.
// The money screens show who owns an account and who posted a journal, and rule 2 needs the merchant's group.
//
// DEVIATION to resolve at merge: decision 016 wants these reads through the owning module's public service. identity,
// catalog and suppliers export no directory yet (features 2a and 4a add `ClientGroupDirectory`; suppliers arrive in 6),
// so this file reads `clients`, `client_groups`, `suppliers`, `customers` and `staff_users` with plain selects. Replace its
// bodies with calls to those services once they exist; nothing outside this file knows.
import { eq, ilike, inArray } from 'drizzle-orm';
import { type DbExecutor, schema as s } from '../../../infra/db';
import type { LedgerOwnerType } from '../db/schema';

/** A merchant as the wallet use cases need it. */
export interface MerchantRecord {
  readonly id: number;
  readonly name: string;
  /** `client_groups.overdraft_allowed` of the merchant's group (user rule 2). */
  readonly overdraftAllowed: boolean;
}

/**
 * The key of a name in the maps below.
 *
 * @param ownerType `client`, `supplier`, `customer` or `staff`
 * @param ownerId the id of that record
 * @returns the key, for example `client:12`
 */
export function ownerKey(ownerType: string, ownerId: number): string {
  return `${ownerType}:${ownerId}`;
}

/**
 * Finds a merchant and whether its group allows credit, and keeps the group row locked (`FOR SHARE`) until the transaction ends.
 *
 * Why: user rule 2 must hold when staff turn `overdraftAllowed` off for a group at the same moment as another request gives
 * one of its merchants a credit limit; the group routes lock the row `FOR UPDATE` (catalog module), so one of the two waits and
 * then sees the other's result. Called inside a transaction, as the lock lasts until it ends.
 *
 * @param db the database or a transaction
 * @param id the merchant id
 * @returns the merchant, or `undefined` when there is none
 */
export async function findMerchant(db: DbExecutor, id: number): Promise<MerchantRecord | undefined> {
  const [row] = await db
    .select({ id: s.clients.id, name: s.clients.name, overdraftAllowed: s.clientGroups.overdraftAllowed })
    .from(s.clients)
    .innerJoin(s.clientGroups, eq(s.clientGroups.id, s.clients.groupId))
    .where(eq(s.clients.id, id))
    .limit(1)
    .for('share', { of: s.clientGroups });
  return row;
}

/**
 * Looks up the names of account owners.
 *
 * @param db the database or a transaction
 * @param owners the owners to name
 * @returns names by {@link ownerKey}; an owner with no row has no entry
 */
export async function loadOwnerNames(
  db: DbExecutor,
  owners: ReadonlyArray<{ ownerType: LedgerOwnerType; ownerId: number }>,
): Promise<Map<string, string>> {
  const idsOf = (type: LedgerOwnerType) => [
    ...new Set(owners.filter((owner) => owner.ownerType === type).map((owner) => owner.ownerId)),
  ];
  const names = new Map<string, string>();
  const clientIds = idsOf('client');
  if (clientIds.length > 0) {
    const rows = await db
      .select({ id: s.clients.id, name: s.clients.name })
      .from(s.clients)
      .where(inArray(s.clients.id, clientIds));
    for (const row of rows) names.set(ownerKey('client', row.id), row.name);
  }
  const supplierIds = idsOf('supplier');
  if (supplierIds.length > 0) {
    const rows = await db
      .select({ id: s.suppliers.id, name: s.suppliers.name })
      .from(s.suppliers)
      .where(inArray(s.suppliers.id, supplierIds));
    for (const row of rows) names.set(ownerKey('supplier', row.id), row.name);
  }
  const customerIds = idsOf('customer');
  if (customerIds.length > 0) {
    const rows = await db
      .select({ id: s.customers.id, name: s.customers.name })
      .from(s.customers)
      .where(inArray(s.customers.id, customerIds));
    for (const row of rows) if (row.name !== '') names.set(ownerKey('customer', row.id), row.name);
  }
  return names;
}

/**
 * Looks up the names of the people who posted journals.
 *
 * @param db the database or a transaction
 * @param actors staff members, merchants and customers
 * @returns names by {@link ownerKey} (`staff:3`, `client:12`, `customer:8`)
 */
export async function loadActorNames(
  db: DbExecutor,
  actors: ReadonlyArray<{ type: 'staff' | 'client' | 'customer'; id: number }>,
): Promise<Map<string, string>> {
  const names = new Map<string, string>();
  const idsOf = (type: string) => [...new Set(actors.filter((actor) => actor.type === type).map((actor) => actor.id))];
  const staffIds = idsOf('staff');
  if (staffIds.length > 0) {
    const rows = await db
      .select({ id: s.staffUsers.id, name: s.staffUsers.name })
      .from(s.staffUsers)
      .where(inArray(s.staffUsers.id, staffIds));
    for (const row of rows) names.set(ownerKey('staff', row.id), row.name);
  }
  const rest = await loadOwnerNames(db, [
    ...idsOf('client').map((ownerId) => ({ ownerType: 'client' as const, ownerId })),
    ...idsOf('customer').map((ownerId) => ({ ownerType: 'customer' as const, ownerId })),
  ]);
  for (const [key, name] of rest) names.set(key, name);
  return names;
}

/** Owner ids whose name matches a search text, per owner type. */
export interface OwnerMatches {
  readonly client: number[];
  readonly supplier: number[];
  readonly customer: number[];
}

/** How many owners per type a text search may expand to (the search stays a bounded `IN` list). */
const MATCH_LIMIT = 200;

/**
 * Finds owners by name.
 *
 * Why: resolution money-15: a text `q` of the ledger list matches the owner names of the lines; the list repository then
 * looks for entries on those owners' accounts.
 *
 * @param db the database or a transaction
 * @param pattern a `LIKE` pattern (already escaped, with the wildcards)
 * @returns up to 200 ids per owner type
 */
export async function findOwnersByName(db: DbExecutor, pattern: string): Promise<OwnerMatches> {
  const [client, supplier, customer] = await Promise.all([
    db.select({ id: s.clients.id }).from(s.clients).where(ilike(s.clients.name, pattern)).limit(MATCH_LIMIT),
    db.select({ id: s.suppliers.id }).from(s.suppliers).where(ilike(s.suppliers.name, pattern)).limit(MATCH_LIMIT),
    db.select({ id: s.customers.id }).from(s.customers).where(ilike(s.customers.name, pattern)).limit(MATCH_LIMIT),
  ]);
  return {
    client: client.map((row) => row.id),
    supplier: supplier.map((row) => row.id),
    customer: customer.map((row) => row.id),
  };
}
