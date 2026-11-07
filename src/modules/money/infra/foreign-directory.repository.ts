// Read-only lookups into tables other modules own (merchants, groups, suppliers, customers, staff), kept in this one file.
// The money screens show who owns an account and who posted a journal, and rule 2 needs the merchant's group.
//
// DEVIATION to resolve at merge: decision 016 wants these reads through the owning module's public service. identity,
// catalog and suppliers export no directory yet (features 2a and 4a add `ClientGroupDirectory`; suppliers arrive in 6),
// so this file reads `clients`, `client_groups`, `suppliers`, `customers` and `staff_users` with plain selects. Replace its
// bodies with calls to those services once they exist; nothing outside this file knows.
import { eq, ilike, inArray, sql } from 'drizzle-orm';
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

/** What REST v1 and Dhru say about the merchant behind an API key. */
export interface MerchantProfile {
  readonly email: string;
  readonly group: { readonly id: number; readonly name: string };
}

/**
 * Reads the email and the group of a merchant.
 *
 * Why: `GET /v1/account` names the merchant's client group and Dhru's `accountinfo` its email (decision 026, the map rows).
 *
 * @param db the database or a transaction
 * @param id the merchant id
 * @returns the profile, or `undefined` when there is no such merchant
 */
export async function findMerchantProfile(db: DbExecutor, id: number): Promise<MerchantProfile | undefined> {
  const [row] = await db
    .select({ email: s.clients.email, groupId: s.clientGroups.id, groupName: s.clientGroups.name })
    .from(s.clients)
    .innerJoin(s.clientGroups, eq(s.clientGroups.id, s.clients.groupId))
    .where(eq(s.clients.id, id))
    .limit(1);
  return row ? { email: row.email, group: { id: row.groupId, name: row.groupName } } : undefined;
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

/**
 * Reads the notification preferences of a merchant (where its low-balance threshold lives).
 *
 * Why: the `wallet.low_balance` event compares the available balance with the merchant's own threshold
 * (`notification_prefs.lowBalanceThreshold`); the preferences belong to identity, which exports no reader yet (same deviation as
 * the rest of this file).
 *
 * @param db the transaction of the posting
 * @param clientId the merchant id
 * @returns the preferences object, or `undefined` when there is no such merchant
 */
export async function notificationPrefsOf(
  db: DbExecutor,
  clientId: number,
): Promise<Record<string, unknown> | undefined> {
  const [row] = await db
    .select({ prefs: s.clients.notificationPrefs })
    .from(s.clients)
    .where(eq(s.clients.id, clientId))
    .limit(1);
  return row?.prefs;
}

/** A merchant as billing shows and checks it: who it is, where it is billed and which group it is in. */
export interface BillingMerchant {
  readonly id: number;
  readonly name: string;
  readonly email: string;
  /** The billing country (ISO code); empty when the merchant has none (a manual invoice is refused then). */
  readonly country: string;
  readonly groupId: number;
  /** `pending`, `active` or `suspended`. */
  readonly status: string;
}

/**
 * Reads merchants for the invoice and payment screens.
 *
 * Why: invoices and top-ups name the merchant (`client {id, name}`), the portal checks the merchant's group for the payment
 * methods and the deposit limit, and a manual invoice needs the billing country (RESOLUTIONS money-7). Identity owns `clients`
 * and exports no reader for these fields yet (same deviation as the rest of this file).
 *
 * @param db the database or a transaction
 * @param ids the merchant ids
 * @returns the merchants that exist, by id
 */
export async function loadBillingMerchants(
  db: DbExecutor,
  ids: readonly number[],
): Promise<Map<number, BillingMerchant>> {
  const unique = [...new Set(ids)];
  if (unique.length === 0) return new Map();
  const rows = await db
    .select({
      id: s.clients.id,
      name: s.clients.name,
      email: s.clients.email,
      country: s.clients.country,
      groupId: s.clients.groupId,
      status: s.clients.status,
    })
    .from(s.clients)
    .where(inArray(s.clients.id, unique));
  return new Map(rows.map((row) => [row.id, row]));
}

/** A storefront customer as a receipt invoice names it. */
export interface BillingCustomer {
  readonly id: number;
  readonly name: string;
  readonly email: string;
}

/**
 * Reads storefront customers for the receipt invoices of the admin list.
 *
 * @param db the database or a transaction
 * @param ids the customer ids
 * @returns the customers that exist, by id
 */
export async function loadBillingCustomers(
  db: DbExecutor,
  ids: readonly number[],
): Promise<Map<number, BillingCustomer>> {
  const unique = [...new Set(ids)];
  if (unique.length === 0) return new Map();
  const rows = await db
    .select({ id: s.customers.id, name: s.customers.name, email: s.customers.email })
    .from(s.customers)
    .where(inArray(s.customers.id, unique));
  return new Map(rows.map((row) => [row.id, row]));
}

/**
 * The merchants whose name matches a search text.
 *
 * Why: the invoice and payment lists search by merchant name (money.md `q`); the repositories then look for rows of those merchants.
 *
 * @param db the database or a transaction
 * @param pattern a `LIKE` pattern (already escaped, with the wildcards)
 * @returns up to 200 merchant ids
 */
export async function findMerchantIdsByName(db: DbExecutor, pattern: string): Promise<number[]> {
  const rows = await db
    .select({ id: s.clients.id })
    .from(s.clients)
    .where(ilike(s.clients.name, pattern))
    .limit(MATCH_LIMIT);
  return rows.map((row) => row.id);
}

/**
 * The customers whose name matches a search text (for the receipt invoices of the admin list).
 *
 * @param db the database or a transaction
 * @param pattern a `LIKE` pattern (already escaped, with the wildcards)
 * @returns up to 200 customer ids
 */
export async function findCustomerIdsByName(db: DbExecutor, pattern: string): Promise<number[]> {
  const rows = await db
    .select({ id: s.customers.id })
    .from(s.customers)
    .where(ilike(s.customers.name, pattern))
    .limit(MATCH_LIMIT);
  return rows.map((row) => row.id);
}

/**
 * The base-currency amount of each storefront payment taken through some gateways in a window.
 *
 * Why: RESOLUTIONS money-5: `volume30d` converts an order payment with the fx rate locked in its checkout session (B111). The
 * rate is the checkout's units of the payment currency per unit of base currency, as `currencies.rate_to_base`, so the base amount
 * is the payment amount divided by it. The orders and checkout tables belong to the orders and customers modules (same deviation as
 * the rest of this file).
 *
 * @param db the database or a transaction
 * @param gatewayIds the gateways
 * @param since the start of the window (`captured_at >=`)
 * @returns one row per payment: its gateway and its amount in the base currency
 */
export async function orderPaymentBaseAmounts(
  db: DbExecutor,
  gatewayIds: readonly number[],
  since: Date,
): Promise<Array<{ gatewayId: number; base: string }>> {
  if (gatewayIds.length === 0) return [];
  const result = await db.execute<{ gateway_id: number; base: string }>(sql`
    select p.gateway_id, round(p.amount / coalesce(cs.fx_rate, 1), 4)::text as base
    from ${s.payments} p
    left join ${s.orders} o on o.id = p.order_id
    left join ${s.checkoutSessions} cs on cs.id = o.checkout_session_id
    where p.purpose = 'order'
      and p.gateway_id in (${sql.join(
        gatewayIds.map((id) => sql`${id}`),
        sql`, `,
      )})
      and p.captured_at >= ${since}
      and p.status not in ('pending', 'failed', 'rejected')
  `);
  return result.rows.map((row) => ({ gatewayId: Number(row.gateway_id), base: row.base }));
}
