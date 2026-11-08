// Drizzle queries on `customers` (customers module): the list with its filters, sorts and order aggregates, one customer, and
// the writes of the admin routes and the store account. The currency join and the order counts come through the foreign reads.
import { and, asc, eq, sql } from 'drizzle-orm';
import type { ParsedListQuery } from '../../../common/contract';
import { type DbExecutor, type ListColumns, listOrderBy, listWhere } from '../../../infra/db';
import { type Customer, type NewCustomer, customers } from '../db/schema';
import { foreignTables } from './foreign-reads.repository';

const { currencies, orders } = foreignTables;

/** The sort fields of the customer list. */
export type CustomerSortField =
  'name' | 'country' | 'hasAccount' | 'ordersCount' | 'totalSpent' | 'lastOrderAt' | 'riskLevel' | 'status';

/** A customer with the currency's id and the figures the list adds. */
export interface CustomerRow {
  readonly customer: Customer;
  /** `currencies.id` of the customer's currency code; `null` when the customer has none. */
  readonly currencyId: number | null;
  readonly ordersCount: number;
  readonly lastOrderAt: Date | null;
}

// Scalar subqueries: Postgres evaluates them only for the rows of the page unless the sort needs them.
const ordersCountSql = sql<number>`(select count(*)::int from ${orders} where ${orders.customerId} = ${customers.id})`;
const lastOrderAtSql = sql<Date | null>`(select max(${orders.createdAt}) from ${orders} where ${orders.customerId} = ${customers.id})`;
// low < medium < high, as the console sorts the risk column.
const riskRankSql = sql`case ${customers.riskLevel} when 'low' then 1 when 'medium' then 2 else 3 end`;

const COLUMNS: ListColumns = {
  name: customers.name,
  email: customers.email,
  country: customers.country,
  hasAccount: customers.hasAccount,
  status: customers.status,
  riskLevel: riskRankSql,
  totalSpent: customers.totalSpent,
  ordersCount: ordersCountSql,
  lastOrderAt: lastOrderAtSql,
};

// The filter columns are plain columns: the rank above is for sorting only.
const FILTER_COLUMNS: ListColumns = { ...COLUMNS, riskLevel: customers.riskLevel };

function selectRows(db: DbExecutor) {
  return db
    .select({
      customer: customers,
      currencyId: currencies.id,
      ordersCount: ordersCountSql,
      lastOrderAt: lastOrderAtSql.mapWith(customers.createdAt),
    })
    .from(customers)
    .leftJoin(currencies, eq(currencies.code, customers.currency));
}

/**
 * Lists customers for `GET /admin/customers`.
 *
 * @param db the database or a transaction
 * @param query the parsed list request (`q` searches name and email)
 * @returns the page of customers and the exact total
 */
export async function listCustomerRows(
  db: DbExecutor,
  query: ParsedListQuery<CustomerSortField>,
): Promise<{ rows: CustomerRow[]; total: number }> {
  const where = listWhere(query, FILTER_COLUMNS);
  // The sort needs the order aggregates and the risk rank, so it maps its own fields.
  const [rows, [count]] = await Promise.all([
    selectRows(db)
      .where(where)
      .orderBy(...listOrderBy(query.sort, COLUMNS, customers.id))
      .limit(query.range.limit)
      .offset(query.range.start),
    db
      .select({ total: sql<number>`count(*)::int` })
      .from(customers)
      .where(where),
  ]);
  return { rows, total: count?.total ?? 0 };
}

/**
 * Finds one customer with its currency id and order figures.
 *
 * @param db the database or a transaction
 * @param id the customer id
 * @returns the customer row, or `undefined`
 */
export async function findCustomerRow(db: DbExecutor, id: number): Promise<CustomerRow | undefined> {
  const [row] = await selectRows(db).where(eq(customers.id, id)).limit(1);
  return row;
}

/**
 * Finds a customer by id, optionally locking the row for the rest of the transaction.
 *
 * Why: status changes read the status, check the transition and write; the lock keeps two staff members from suspending and
 * editing the same customer at once.
 *
 * @param db the database or a transaction
 * @param id the customer id
 * @param lock lock the row `FOR UPDATE`
 * @returns the customer, or `undefined`
 */
export async function findCustomerById(db: DbExecutor, id: number, lock = false): Promise<Customer | undefined> {
  const query = db.select().from(customers).where(eq(customers.id, id)).limit(1);
  const [row] = await (lock ? query.for('update') : query);
  return row;
}

/**
 * Finds a customer by email, ignoring case.
 *
 * @param db the database or a transaction
 * @param email the normalised (trimmed, lower-case) email
 * @param exceptId a customer to leave out (the one being edited)
 * @returns the customer, or `undefined`
 */
export async function findCustomerByEmail(
  db: DbExecutor,
  email: string,
  exceptId?: number,
): Promise<Customer | undefined> {
  const [row] = await db
    .select()
    .from(customers)
    .where(
      and(
        sql`lower(${customers.email}) = ${email.toLowerCase()}`,
        exceptId === undefined ? undefined : sql`${customers.id} <> ${exceptId}`,
      ),
    )
    .orderBy(asc(customers.id))
    .limit(1);
  return row;
}

/**
 * Inserts a customer.
 *
 * Side effects: inserts a `customers` row.
 *
 * @param db the transaction
 * @param values the new row
 * @returns the stored row
 * @throws a unique violation of `customers_email_uq` when the email is taken (a race the pre-check could not see)
 */
export async function insertCustomer(db: DbExecutor, values: NewCustomer): Promise<Customer> {
  const [row] = await db.insert(customers).values(values).returning();
  if (!row) throw new Error('Inserting a customer returned no row.');
  return row;
}

/**
 * Inserts a customer unless another row already has the email.
 *
 * Why: two parallel sign-in link requests for a new email must not fail on the unique index: the loser reads the winner's row.
 *
 * Side effects: inserts a `customers` row, or nothing.
 *
 * @param db the transaction
 * @param values the new row
 * @returns the stored row, or `undefined` when the email already belongs to a customer
 */
export async function insertCustomerIfAbsent(db: DbExecutor, values: NewCustomer): Promise<Customer | undefined> {
  const [row] = await db.insert(customers).values(values).onConflictDoNothing().returning();
  return row;
}

/**
 * Updates a customer.
 *
 * Side effects: updates the `customers` row.
 *
 * @param db the transaction
 * @param id the customer id
 * @param values the changed columns
 * @returns the stored row
 */
export async function updateCustomerRow(db: DbExecutor, id: number, values: Partial<NewCustomer>): Promise<Customer> {
  const [row] = await db.update(customers).set(values).where(eq(customers.id, id)).returning();
  if (!row) throw new Error(`Customer ${id} vanished during its update.`);
  return row;
}

/**
 * Sets a customer's marketing choice.
 *
 * Why: a signed-in account holder who answers the marketing consent at checkout is choosing for their own account, so the column
 * the console shows follows the answer, as `PATCH /store/v1/me` does. (A guest's checkout answer goes through
 * `setGuestMarketingOptIn`, which never touches an account holder.)
 *
 * Side effects: updates the `customers` row.
 *
 * @param db the caller's transaction
 * @param id the customer id
 * @param granted the recorded answer
 * @param now the injected clock's time for `updated_at`
 */
export async function setMarketingOptIn(db: DbExecutor, id: number, granted: boolean, now: Date): Promise<void> {
  await db.update(customers).set({ marketingOptIn: granted, updatedAt: now }).where(eq(customers.id, id));
}
