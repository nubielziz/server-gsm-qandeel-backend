// Drizzle queries on invoices (map routes /admin/invoices, /client/invoices, stage 8): lists for staff and for one merchant with
// sort, search and exact count, find, id allocation, insert and update. Only the money module touches this table.
import { type SQL, and, asc, eq, gt, inArray, or, sql } from 'drizzle-orm';
import type { ParsedListQuery } from '../../../common/contract';
import type { DbExecutor } from '../../../infra/db';
import { escapeLike, listOrderBy, listWhere } from '../../../infra/db/list-sql';
import { type Invoice, type InvoiceKind, type NewInvoice, invoices, payments } from '../db/schema';
import { findCustomerIdsByName, findMerchantIdsByName } from './foreign-directory.repository';

/** The sort fields of the invoice lists (staff: createdAt, total, status; merchant: also number and dueAt). */
export type InvoiceSortField = 'createdAt' | 'total' | 'status' | 'number' | 'dueAt';

const COLUMNS = {
  createdAt: invoices.createdAt,
  total: invoices.total,
  status: invoices.status,
  number: invoices.number,
  dueAt: invoices.dueAt,
  kind: invoices.kind,
  clientId: invoices.clientId,
};

/** What narrows an invoice list before the request's own filters. */
export interface InvoiceScope {
  /** Only this merchant's invoices (the portal). */
  readonly clientId?: number;
  /** Only these kinds (the portal never shows receipts). */
  readonly kinds?: readonly InvoiceKind[];
  /** Let `q` also match merchant and customer names (the staff list). */
  readonly searchNames?: boolean;
}

/**
 * Lists invoices.
 *
 * @param db the database or a transaction
 * @param query the parsed list request (`q` searches the number, and for staff the merchant and customer names)
 * @param scope the merchant and kinds the list is limited to
 * @returns the page of rows and the number matching the filters
 */
export async function listInvoiceRows(
  db: DbExecutor,
  query: ParsedListQuery<InvoiceSortField>,
  scope: InvoiceScope,
): Promise<{ rows: Invoice[]; total: number }> {
  const search = query.search;
  const alternatives: SQL[] = [];
  if (search) {
    const pattern = `%${escapeLike(search.text)}%`;
    alternatives.push(sql`${invoices.number} ilike ${pattern}`);
    if (scope.searchNames) {
      const [clientIds, customerIds] = await Promise.all([
        findMerchantIdsByName(db, pattern),
        findCustomerIdsByName(db, pattern),
      ]);
      if (clientIds.length > 0) alternatives.push(inArray(invoices.clientId, clientIds));
      if (customerIds.length > 0) alternatives.push(inArray(invoices.customerId, customerIds));
    }
  }
  const where = listWhere(
    { filters: query.filters, search: undefined },
    COLUMNS,
    scope.clientId === undefined ? undefined : eq(invoices.clientId, scope.clientId),
    scope.kinds === undefined ? undefined : inArray(invoices.kind, [...scope.kinds]),
    search ? or(...alternatives) : undefined,
  );
  const [rows, [counted]] = await Promise.all([
    db
      .select()
      .from(invoices)
      .where(where)
      .orderBy(...listOrderBy(query.sort, COLUMNS, invoices.id))
      .limit(query.range.limit)
      .offset(query.range.start),
    db
      .select({ total: sql<number>`count(*)::int` })
      .from(invoices)
      .where(where),
  ]);
  return { rows, total: counted?.total ?? 0 };
}

/**
 * Finds an invoice by id.
 *
 * @param db the database or a transaction
 * @param id the invoice id
 * @param lock lock the row `FOR UPDATE` until the transaction ends
 * @returns the row, or `undefined`
 */
export async function findInvoice(db: DbExecutor, id: number, lock = false): Promise<Invoice | undefined> {
  const query = db.select().from(invoices).where(eq(invoices.id, id)).limit(1);
  const [row] = await (lock ? query.for('update') : query);
  return row;
}

/**
 * Finds an invoice of one merchant (never a neighbour's).
 *
 * @param db the database or a transaction
 * @param id the invoice id
 * @param clientId the merchant
 * @param lock lock the row `FOR UPDATE` until the transaction ends
 * @returns the row, or `undefined` when it does not exist or belongs to someone else
 */
export async function findInvoiceOfClient(
  db: DbExecutor,
  id: number,
  clientId: number,
  lock = false,
): Promise<Invoice | undefined> {
  const query = db
    .select()
    .from(invoices)
    .where(and(eq(invoices.id, id), eq(invoices.clientId, clientId)))
    .limit(1);
  const [row] = await (lock ? query.for('update') : query);
  return row;
}

/**
 * Finds an invoice by its number.
 *
 * @param db the database or a transaction
 * @param number the invoice number
 * @param lock lock the row `FOR UPDATE` until the transaction ends
 * @returns the row, or `undefined`
 */
export async function findInvoiceByNumber(db: DbExecutor, number: string, lock = false): Promise<Invoice | undefined> {
  const query = db.select().from(invoices).where(eq(invoices.number, number)).limit(1);
  const [row] = await (lock ? query.for('update') : query);
  return row;
}

/**
 * Reserves the next invoice id.
 *
 * Why: the number `INV-<year>-<id>` and the payment gateway's reference are needed before the row is written (a checkout is
 * opened first, so a failing gateway leaves nothing behind); a reserved id that is never used is only a gap in the numbers.
 *
 * Side effects: advances the id sequence of `invoices`.
 *
 * @param db the database or a transaction
 * @returns the id
 */
export async function reserveInvoiceId(db: DbExecutor): Promise<number> {
  const result = await db.execute<{ id: string }>(
    sql`select nextval(pg_get_serial_sequence('public.invoices', 'id')) as id`,
  );
  return Number(result.rows[0]!.id);
}

/**
 * Inserts an invoice under an id reserved with {@link reserveInvoiceId}.
 *
 * Side effects: inserts an `invoices` row.
 *
 * @param db the caller's transaction
 * @param row the new row, with its id
 * @returns the stored row
 */
export async function insertInvoice(db: DbExecutor, row: NewInvoice & { id: number }): Promise<Invoice> {
  const [created] = await db.insert(invoices).overridingSystemValue().values(row).returning();
  return created!;
}

/**
 * Updates an invoice.
 *
 * Side effects: updates the `invoices` row.
 *
 * @param db the caller's transaction
 * @param id the invoice id
 * @param changes the columns to set
 * @returns the stored row
 */
export async function updateInvoice(db: DbExecutor, id: number, changes: Partial<NewInvoice>): Promise<Invoice> {
  const [updated] = await db.update(invoices).set(changes).where(eq(invoices.id, id)).returning();
  return updated!;
}

/**
 * Finds the tax receipt of a storefront order.
 *
 * Why: scenario b2c-paid step 16: the receipt invoice (kind `receipt`) is issued when the payment is captured; the order's tracking page
 * downloads its PDF.
 *
 * @param db the database or a transaction
 * @param orderId the order
 * @returns the receipt, or `undefined` when the order was never paid through the storefront
 */
export async function findReceiptOfOrder(db: DbExecutor, orderId: number): Promise<Invoice | undefined> {
  const [row] = await db
    .select()
    .from(invoices)
    .where(and(eq(invoices.orderId, orderId), eq(invoices.kind, 'receipt')))
    .orderBy(asc(invoices.id))
    .limit(1);
  return row;
}

/**
 * Serialises the top-up invoices of one merchant until the transaction ends.
 *
 * Why: decision 049: the count of live unpaid top-ups and the insert that extends it run one request at a time per merchant.
 *
 * Side effects: takes `pg_advisory_xact_lock(hashtextextended('merchant-topup:<clientId>', 0))`, released at commit or rollback.
 *
 * @param tx the transaction that inserts the invoice or the receipt
 * @param clientId the merchant
 */
export async function lockMerchantTopUps(tx: DbExecutor, clientId: number): Promise<void> {
  await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`merchant-topup:${clientId}`}, 0))`);
}

/**
 * Counts a merchant's live unpaid top-up invoices: open, and created after `since` or with a payment waiting for review.
 *
 * Why: decision 049 (at most five; `MERCHANT_OPEN_TOPUPS`). The window takes the clock's time (decision 031).
 *
 * @param db the database or a transaction
 * @param clientId the merchant
 * @param since the start of the window (the clock's time minus 24 hours)
 * @returns the count
 */
export async function countLiveMerchantTopUps(db: DbExecutor, clientId: number, since: Date): Promise<number> {
  const [row] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(invoices)
    .where(
      and(
        eq(invoices.clientId, clientId),
        eq(invoices.kind, 'topup'),
        eq(invoices.status, 'open'),
        or(
          gt(invoices.createdAt, since),
          sql`exists (select 1 from ${payments} p where p.invoice_id = ${invoices.id} and p.status = 'pending')`,
        ),
      ),
    );
  return row?.n ?? 0;
}
