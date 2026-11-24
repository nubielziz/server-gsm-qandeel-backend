// Read-only lookups into tables other modules own (accounts, ranks, suppliers, staff, the legacy number map), kept in this one file.
// The money screens show who owns an account and who posted a journal, and rule 2 needs the account's rank.
//
// DEVIATION to resolve at merge: decision 016 wants these reads through the owning module's public service. identity,
// catalog and suppliers export no directory yet (features 2a and 4a add `ClientGroupDirectory`; suppliers arrive in 6),
// so this file reads `clients`, `client_groups`, `suppliers`, `staff_users` and `account_legacy_ids` with plain selects. Replace its
// bodies with calls to those services once they exist; nothing outside this file knows.
//
// One account type (decision 064): merchants and shoppers are rows of `clients`, so every "customer" lookup here reads `clients` too. The
// names of the functions and of their result types keep their old words for the callers that have not moved yet; the values are account ids.
import { and, eq, ilike, inArray, or, sql } from 'drizzle-orm';
import { type DbExecutor, schema as s } from '../../../infra/db';
import type { LedgerActorType, LedgerOwnerType } from '../db/schema';

/** An account as the wallet use cases need it (a merchant-kind account, or any account for the rank checks of a credit limit). */
export interface MerchantRecord {
  readonly id: number;
  readonly name: string;
  /** `client_groups.overdraft_allowed` of the account's rank (user rule 2; the retail rank never allows credit). */
  readonly overdraftAllowed: boolean;
}

/**
 * The key of a name in the maps below.
 *
 * @param ownerType `account`, `supplier` or `staff`, or the old word of an append-only row (`client`, `customer`)
 * @param ownerId the id of that record
 * @returns the key, for example `account:12`
 */
export function ownerKey(ownerType: string, ownerId: number): string {
  return `${ownerType}:${ownerId}`;
}

/**
 * Finds an account and whether its rank allows credit, and keeps the rank row locked (`FOR SHARE`) until the transaction ends.
 *
 * Why: user rule 2 must hold when staff turn `overdraftAllowed` off for a group at the same moment as another request gives
 * one of its merchants a credit limit; the group routes lock the row `FOR UPDATE` (catalog module), so one of the two waits and
 * then sees the other's result. With `lockMerchant` the merchant row is locked `FOR SHARE` first, in its own statement: a group move
 * locks that row `FOR UPDATE`, so a move and a credit-limit change wait for each other, and the group is
 * read only once the lock is held, after any move that held it. Called inside a transaction, as the locks last until it ends.
 *
 * @param db the database or a transaction
 * @param id the account id
 * @param options `lockMerchant`: also lock the account row (the credit-limit route)
 * @returns the account, or `undefined` when there is none
 */
export async function findMerchant(
  db: DbExecutor,
  id: number,
  options: { readonly lockMerchant?: boolean } = {},
): Promise<MerchantRecord | undefined> {
  if (options.lockMerchant) {
    await db.select({ id: s.clients.id }).from(s.clients).where(eq(s.clients.id, id)).limit(1).for('share');
  }
  const [row] = await db
    .select({ id: s.clients.id, name: s.clients.name, overdraftAllowed: s.clientGroups.overdraftAllowed })
    .from(s.clients)
    .innerJoin(s.clientGroups, eq(s.clientGroups.id, s.clients.groupId))
    .where(eq(s.clients.id, id))
    .limit(1)
    .for('share', { of: s.clientGroups });
  return row;
}

/** A merchant as the client statement header shows it. */
export interface StatementMerchantRecord {
  readonly id: number;
  readonly name: string;
  readonly company: string;
  readonly country: string;
}

/**
 * Reads the header fields of a merchant for the client statement PDF.
 *
 * @param db the database or a transaction
 * @param id the merchant id
 * @returns the name, company and country, or `undefined` when there is no such merchant
 */
export async function findStatementMerchant(db: DbExecutor, id: number): Promise<StatementMerchantRecord | undefined> {
  const [row] = await db
    .select({ id: s.clients.id, name: s.clients.name, company: s.clients.company, country: s.clients.country })
    .from(s.clients)
    .where(eq(s.clients.id, id))
    .limit(1);
  return row;
}

/**
 * Reads the kind of an account's rank.
 *
 * Why: the wallet kind follows the rank kind (decision 064), so a money path that holds the account row lock asks which kind of rank the
 * account has now; `rankKindOf` of identity turns the stored kind into `merchant` or `retail`.
 *
 * @param db the database or the caller's transaction (after it locked the account row)
 * @param id the account id
 * @returns the stored kind of the rank (`client_groups.kind`), or `undefined` when there is no such account
 */
export async function findRankGroupKind(db: DbExecutor, id: number): Promise<string | undefined> {
  const [row] = await db
    .select({ kind: s.clientGroups.kind })
    .from(s.clients)
    .innerJoin(s.clientGroups, eq(s.clientGroups.id, s.clients.groupId))
    .where(eq(s.clients.id, id))
    .limit(1);
  return row?.kind;
}

/** What Dhru says about the merchant behind an API key. */
export interface MerchantProfile {
  readonly email: string;
}

/**
 * Reads the email of a merchant.
 *
 * Why: Dhru's `accountinfo` names the merchant's email (decision 026, the map row).
 *
 * @param db the database or a transaction
 * @param id the merchant id
 * @returns the profile, or `undefined` when there is no such merchant
 */
export async function findMerchantProfile(db: DbExecutor, id: number): Promise<MerchantProfile | undefined> {
  const [row] = await db.select({ email: s.clients.email }).from(s.clients).where(eq(s.clients.id, id)).limit(1);
  return row;
}

/**
 * Looks up the names of ledger account owners.
 *
 * Why: every wallet and hold is owned by `('account', id)` since decision 064, and supplier accounts by `('supplier', id)`; the ledger and
 * reconcile screens show the name next to the line.
 *
 * @param db the database or a transaction
 * @param owners the owners to name
 * @returns names by {@link ownerKey} (`account:12`, `supplier:3`); an owner with no row, or a row with no name, has no entry
 */
export async function loadOwnerNames(
  db: DbExecutor,
  owners: ReadonlyArray<{ ownerType: LedgerOwnerType; ownerId: number }>,
): Promise<Map<string, string>> {
  const idsOf = (type: LedgerOwnerType) => [
    ...new Set(owners.filter((owner) => owner.ownerType === type).map((owner) => owner.ownerId)),
  ];
  const names = new Map<string, string>();
  const accountIds = idsOf('account');
  if (accountIds.length > 0) {
    const rows = await db
      .select({ id: s.clients.id, name: s.clients.name })
      .from(s.clients)
      .where(inArray(s.clients.id, accountIds));
    for (const row of rows) if (row.name !== '') names.set(ownerKey('account', row.id), row.name);
  }
  const supplierIds = idsOf('supplier');
  if (supplierIds.length > 0) {
    const rows = await db
      .select({ id: s.suppliers.id, name: s.suppliers.name })
      .from(s.suppliers)
      .where(inArray(s.suppliers.id, supplierIds));
    for (const row of rows) names.set(ownerKey('supplier', row.id), row.name);
  }
  return names;
}

/** Who posted a journal, as the ledger stores it: staff, an account, or (in a row written before the merge) a merchant or a customer. */
export type ActorRef = { readonly type: Exclude<LedgerActorType, 'system'>; readonly id: number };

/**
 * Looks up the names of the people who posted journals.
 *
 * Why: the journals are append-only, so their actor keeps the word it was written with (decision 064): new rows say `account` with the
 * account id; an old row says `client` with the merchant number (a merchant kept its number as its account id) or `customer` with an old
 * customer number, which is NOT an account id (old customer 7 is not account 7). A customer number is named only through the legacy map
 * (`account_legacy_ids`); a number the map does not know has no name, never another account's.
 *
 * @param db the database or a transaction
 * @param actors staff members, accounts and the old words of earlier rows
 * @returns names by {@link ownerKey} of the stored pair (`staff:3`, `account:12`, `client:12`, `customer:8`)
 */
export async function loadActorNames(db: DbExecutor, actors: readonly ActorRef[]): Promise<Map<string, string>> {
  const names = new Map<string, string>();
  const idsOf = (type: ActorRef['type']) => [
    ...new Set(actors.filter((actor) => actor.type === type).map((actor) => actor.id)),
  ];
  const staffIds = idsOf('staff');
  if (staffIds.length > 0) {
    const rows = await db
      .select({ id: s.staffUsers.id, name: s.staffUsers.name })
      .from(s.staffUsers)
      .where(inArray(s.staffUsers.id, staffIds));
    for (const row of rows) names.set(ownerKey('staff', row.id), row.name);
  }
  const accountIds = idsOf('account');
  const merchantIds = idsOf('client');
  if (accountIds.length > 0 || merchantIds.length > 0) {
    // A merchant number is its account id (the map of a merchant is the identity), so both words read `clients` directly.
    const rows = await db
      .select({ id: s.clients.id, name: s.clients.name })
      .from(s.clients)
      .where(inArray(s.clients.id, [...new Set([...accountIds, ...merchantIds])]));
    const byId = new Map(rows.map((row) => [row.id, row.name]));
    for (const id of accountIds) {
      const name = byId.get(id);
      if (name !== undefined && name !== '') names.set(ownerKey('account', id), name);
    }
    for (const id of merchantIds) {
      const name = byId.get(id);
      if (name !== undefined && name !== '') names.set(ownerKey('client', id), name);
    }
  }
  const customerNumbers = idsOf('customer');
  if (customerNumbers.length > 0) {
    const rows = await db
      .select({ legacyId: s.accountLegacyIds.legacyId, name: s.clients.name })
      .from(s.accountLegacyIds)
      .innerJoin(s.clients, eq(s.clients.id, s.accountLegacyIds.accountId))
      .where(and(eq(s.accountLegacyIds.legacyType, 'customer'), inArray(s.accountLegacyIds.legacyId, customerNumbers)));
    for (const row of rows) if (row.name !== '') names.set(ownerKey('customer', row.legacyId), row.name);
  }
  return names;
}

/** Owner ids whose name matches a search text, per owner type. */
export interface OwnerMatches {
  readonly account: number[];
  readonly supplier: number[];
}

/** How many owners per type a text search may expand to (the search stays a bounded `IN` list). */
const MATCH_LIMIT = 200;

/**
 * Finds owners by name.
 *
 * Why: resolution money-15: a text `q` of the ledger list matches the owner names of the lines; the list repository then
 * looks for entries on those owners' accounts. Every wallet owner is an account (decision 064).
 *
 * @param db the database or a transaction
 * @param pattern a `LIKE` pattern (already escaped, with the wildcards)
 * @returns up to 200 ids per owner type (`account` and `supplier`)
 */
export async function findOwnersByName(db: DbExecutor, pattern: string): Promise<OwnerMatches> {
  const [account, supplier] = await Promise.all([
    db.select({ id: s.clients.id }).from(s.clients).where(ilike(s.clients.name, pattern)).limit(MATCH_LIMIT),
    db.select({ id: s.suppliers.id }).from(s.suppliers).where(ilike(s.suppliers.name, pattern)).limit(MATCH_LIMIT),
  ]);
  return {
    account: account.map((row) => row.id),
    supplier: supplier.map((row) => row.id),
  };
}

/**
 * Reads the notification preferences of an account (where its low-balance threshold lives).
 *
 * Why: the `wallet.low_balance` event compares the available balance with the account's own threshold
 * (`notification_prefs.lowBalanceThreshold`); the preferences belong to identity, which exports no reader yet (same deviation as
 * the rest of this file).
 *
 * @param db the transaction of the posting
 * @param accountId the account id
 * @returns the preferences object, or `undefined` when there is no such account
 */
export async function notificationPrefsOf(
  db: DbExecutor,
  accountId: number,
): Promise<Record<string, unknown> | undefined> {
  const [row] = await db
    .select({ prefs: s.clients.notificationPrefs })
    .from(s.clients)
    .where(eq(s.clients.id, accountId))
    .limit(1);
  return row?.prefs;
}

/** An account as billing shows and checks it: who it is, where it is billed and which rank it is in. */
export interface BillingMerchant {
  readonly id: number;
  readonly name: string;
  readonly email: string;
  /** The billing country (ISO code); empty when the account has none (a manual invoice is refused then). */
  readonly country: string;
  readonly groupId: number;
  /** `active`, `suspended`, `blocked` or `anonymized` (read it through `canAct` and `sessionStateOf` of identity, never by comparing). */
  readonly status: string;
}

/**
 * Reads accounts for the invoice and payment screens.
 *
 * Why: invoices and top-ups name the account (`client {id, name}`), the portal checks the account's rank for the payment
 * methods and the deposit limit, and a manual invoice needs the billing country (RESOLUTIONS money-7). Identity owns `clients`
 * and exports no reader for these fields yet (same deviation as the rest of this file).
 *
 * @param db the database or a transaction
 * @param ids the account ids
 * @returns the accounts that exist, by id
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

/** An account as a receipt invoice names it (a shopper is an account since decision 064). */
export interface BillingCustomer {
  readonly id: number;
  readonly name: string;
  readonly email: string;
}

/**
 * Reads accounts for the receipt invoices of the admin list.
 *
 * @param db the database or a transaction
 * @param ids the account ids
 * @returns the accounts that exist, by id
 */
export async function loadBillingCustomers(
  db: DbExecutor,
  ids: readonly number[],
): Promise<Map<number, BillingCustomer>> {
  const unique = [...new Set(ids)];
  if (unique.length === 0) return new Map();
  const rows = await db
    .select({ id: s.clients.id, name: s.clients.name, email: s.clients.email })
    .from(s.clients)
    .where(inArray(s.clients.id, unique));
  return new Map(rows.map((row) => [row.id, row]));
}

/**
 * The accounts whose name matches a search text.
 *
 * Why: the invoice and payment lists search by account name (money.md `q`); the repositories then look for rows of those accounts.
 *
 * @param db the database or a transaction
 * @param pattern a `LIKE` pattern (already escaped, with the wildcards)
 * @returns up to 200 account ids
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
 * The accounts whose name matches a search text (for the receipt invoices of the admin list).
 *
 * Why: a shopper is an account, so this reads the same table as {@link findMerchantIdsByName}; the name stays for the callers that ask
 * about shoppers.
 *
 * @param db the database or a transaction
 * @param pattern a `LIKE` pattern (already escaped, with the wildcards)
 * @returns up to 200 account ids
 */
export async function findCustomerIdsByName(db: DbExecutor, pattern: string): Promise<number[]> {
  const rows = await db
    .select({ id: s.clients.id })
    .from(s.clients)
    .where(ilike(s.clients.name, pattern))
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

/** An account as the store-balance use cases need it (feature 21, decision 064). */
export interface WalletCustomer {
  readonly id: number;
  readonly name: string;
  readonly email: string;
  /** `active`, `suspended`, `blocked` or `anonymized`. */
  readonly status: string;
  /** Whether the account has a sign-in (a guest row has none; only a login account may hold and spend a balance: O5). */
  readonly hasAccount: boolean;
}

const walletCustomerColumns = {
  id: s.clients.id,
  name: s.clients.name,
  email: s.clients.email,
  status: s.clients.status,
  hasAccount: s.clients.hasAccount,
};

/**
 * Reads one account for the store-balance use cases.
 *
 * @param db the database or a transaction
 * @param id the account id
 * @returns the account, or `undefined`
 */
export async function findWalletCustomer(db: DbExecutor, id: number): Promise<WalletCustomer | undefined> {
  const [row] = await db.select(walletCustomerColumns).from(s.clients).where(eq(s.clients.id, id)).limit(1);
  return row;
}

/**
 * Reads accounts for the store-balance list and the deposits screen (feature 21).
 *
 * @param db the database or a transaction
 * @param ids the account ids
 * @returns the accounts that exist, by id
 */
export async function loadWalletCustomers(
  db: DbExecutor,
  ids: readonly number[],
): Promise<Map<number, WalletCustomer>> {
  const unique = [...new Set(ids)];
  if (unique.length === 0) return new Map();
  const rows = await db.select(walletCustomerColumns).from(s.clients).where(inArray(s.clients.id, unique));
  return new Map(rows.map((row) => [row.id, row]));
}

/**
 * The accounts whose name, and for a caller who may read customers also email, matches a search text (the staff wallet list and the
 * deposits search, feature 21).
 *
 * Why: decision 047: the address is searched only for a caller who may read customers; the others find an account by name.
 *
 * @param db the database or a transaction
 * @param pattern a `LIKE` pattern (already escaped, with the wildcards)
 * @param matchEmail whether the address is searched too (`customerContactOf(caller) === 'full'`)
 * @returns up to 200 account ids
 */
export async function findCustomerIdsByNameOrEmail(
  db: DbExecutor,
  pattern: string,
  matchEmail: boolean,
): Promise<number[]> {
  const rows = await db
    .select({ id: s.clients.id })
    .from(s.clients)
    .where(
      matchEmail ? or(ilike(s.clients.name, pattern), ilike(s.clients.email, pattern)) : ilike(s.clients.name, pattern),
    )
    .limit(MATCH_LIMIT);
  return rows.map((row) => row.id);
}
