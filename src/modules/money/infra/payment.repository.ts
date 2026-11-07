// Drizzle queries on payments (map routes /admin/payments*, /client/invoices/:id/receipt, the payment webhook and the automatic
// credit job, stage 8): the top-up list with sort, search and exact count, find with a row lock, insert, guarded update, the due
// payments of the job and the lookups the wire needs. Only the money module touches this table.
import { type SQL, and, asc, eq, inArray, lte, or, sql } from 'drizzle-orm';
import type { ParsedListQuery } from '../../../common/contract';
import type { DbExecutor } from '../../../infra/db';
import { escapeLike, listOrderBy, listWhere } from '../../../infra/db/list-sql';
import { type NewPayment, type Payment, invoices, payments } from '../db/schema';
import { findMerchantIdsByName } from './foreign-directory.repository';

/** The sort fields of the top-up payment list. */
export type PaymentSortField = 'createdAt' | 'id' | 'amount' | 'status';

/** A payment with the merchant of its invoice. */
export interface PaymentRow {
  readonly payment: Payment;
  /** `invoices.client_id` of the linked invoice (the merchant is reached through the invoice); `null` without an invoice. */
  readonly clientId: number | null;
}

const COLUMNS = {
  createdAt: payments.createdAt,
  id: payments.id,
  amount: payments.amount,
  status: payments.status,
  purpose: payments.purpose,
  clientId: invoices.clientId,
};

const ROW = { payment: payments, clientId: invoices.clientId };

/**
 * Lists top-up payments.
 *
 * Why: RESOLUTIONS money-2: `/admin/payments` serves top-ups only, so the list always adds `purpose = 'topup'` (a `purpose=order`
 * filter then matches nothing).
 *
 * @param db the database or a transaction
 * @param query the parsed list request (`q` searches the gateway reference and the merchant name)
 * @returns the page of rows and the number matching the filters
 */
export async function listPaymentRows(
  db: DbExecutor,
  query: ParsedListQuery<PaymentSortField>,
): Promise<{ rows: PaymentRow[]; total: number }> {
  const alternatives: SQL[] = [];
  if (query.search) {
    const pattern = `%${escapeLike(query.search.text)}%`;
    alternatives.push(sql`${payments.gatewayTxnId} ilike ${pattern}`);
    const clientIds = await findMerchantIdsByName(db, pattern);
    if (clientIds.length > 0) alternatives.push(inArray(invoices.clientId, clientIds));
  }
  const where = listWhere(
    { filters: query.filters, search: undefined },
    COLUMNS,
    eq(payments.purpose, 'topup'),
    query.search ? or(...alternatives) : undefined,
  );
  const [rows, [counted]] = await Promise.all([
    db
      .select(ROW)
      .from(payments)
      .leftJoin(invoices, eq(invoices.id, payments.invoiceId))
      .where(where)
      .orderBy(...listOrderBy(query.sort, COLUMNS, payments.id))
      .limit(query.range.limit)
      .offset(query.range.start),
    db
      .select({ total: sql<number>`count(*)::int` })
      .from(payments)
      .leftJoin(invoices, eq(invoices.id, payments.invoiceId))
      .where(where),
  ]);
  return { rows, total: counted?.total ?? 0 };
}

/**
 * Finds a top-up payment by id with its merchant.
 *
 * @param db the database or a transaction
 * @param id the payment id
 * @returns the row, or `undefined` when there is no top-up payment with the id (an order payment is not served here)
 */
export async function findTopupPayment(db: DbExecutor, id: number): Promise<PaymentRow | undefined> {
  const [row] = await db
    .select(ROW)
    .from(payments)
    .leftJoin(invoices, eq(invoices.id, payments.invoiceId))
    .where(and(eq(payments.id, id), eq(payments.purpose, 'topup')))
    .limit(1);
  return row;
}

/**
 * Finds a top-up payment and locks it `FOR UPDATE` until the transaction ends.
 *
 * Why: approve, reject and the automatic credit all lock the payment first and re-check its status under the lock, so the loser of
 * a race changes nothing (RESOLUTIONS money-3). Lock order everywhere: the payment, then its invoice, then the ledger accounts.
 *
 * @param db the caller's transaction
 * @param id the payment id
 * @returns the payment, or `undefined` for an unknown id or an order payment
 */
export async function lockTopupPayment(db: DbExecutor, id: number): Promise<Payment | undefined> {
  const [row] = await db
    .select()
    .from(payments)
    .where(and(eq(payments.id, id), eq(payments.purpose, 'topup')))
    .limit(1)
    .for('update');
  return row;
}

/**
 * Finds the payment a gateway reference already created.
 *
 * @param db the database or a transaction
 * @param gatewayId the gateway
 * @param reference the gateway's id of the payment
 * @returns the payment, or `undefined`
 */
export async function findPaymentByReference(
  db: DbExecutor,
  gatewayId: number,
  reference: string,
): Promise<Payment | undefined> {
  const [row] = await db
    .select()
    .from(payments)
    .where(and(eq(payments.gatewayId, gatewayId), eq(payments.gatewayTxnId, reference)))
    .limit(1);
  return row;
}

/**
 * Inserts a payment, or does nothing when the gateway reference is already there.
 *
 * Why: the unique index on `(gateway_id, gateway_txn_id)` is what makes a repeated webhook create one payment, even when two
 * deliveries race.
 *
 * Side effects: inserts a `payments` row.
 *
 * @param db the caller's transaction
 * @param row the new row
 * @returns the stored row, or `undefined` when the reference already existed
 */
export async function insertPaymentOnce(db: DbExecutor, row: NewPayment): Promise<Payment | undefined> {
  const [created] = await db.insert(payments).values(row).onConflictDoNothing().returning();
  return created;
}

/**
 * Inserts a payment.
 *
 * Side effects: inserts a `payments` row.
 *
 * @param db the caller's transaction
 * @param row the new row
 * @returns the stored row
 */
export async function insertPayment(db: DbExecutor, row: NewPayment): Promise<Payment> {
  const [created] = await db.insert(payments).values(row).returning();
  return created!;
}

/**
 * Updates a payment.
 *
 * Side effects: updates the `payments` row.
 *
 * @param db the caller's transaction
 * @param id the payment id
 * @param changes the columns to set
 * @returns the stored row
 */
export async function updatePayment(db: DbExecutor, id: number, changes: Partial<NewPayment>): Promise<Payment> {
  const [updated] = await db.update(payments).set(changes).where(eq(payments.id, id)).returning();
  return updated!;
}

/**
 * Lists the top-up payments of an invoice, oldest first.
 *
 * @param db the database or a transaction
 * @param invoiceId the invoice
 * @returns its payments
 */
export async function listPaymentsOfInvoice(db: DbExecutor, invoiceId: number): Promise<Payment[]> {
  return db.select().from(payments).where(eq(payments.invoiceId, invoiceId)).orderBy(asc(payments.id));
}

/**
 * Finds the top-up payments of an invoice that wait for a decision.
 *
 * @param db the database or a transaction
 * @param invoiceId the invoice
 * @returns its pending payments
 */
export async function pendingPaymentsOfInvoice(db: DbExecutor, invoiceId: number): Promise<Payment[]> {
  return db
    .select()
    .from(payments)
    .where(and(eq(payments.invoiceId, invoiceId), eq(payments.status, 'pending')));
}

/**
 * The ids of the automatic top-ups that are due to credit themselves.
 *
 * Why: the job's sweep: pending top-ups whose time has come and that risk has not sent to staff (the partial index
 * `payments_auto_credit_idx` covers the filter). The job re-reads each one under a lock, so this list is only a to-do.
 *
 * @param db the database or a transaction
 * @param now the clock's time
 * @param limit the most ids to return
 * @returns the payment ids, oldest due first
 */
export async function dueAutoCreditIds(db: DbExecutor, now: Date, limit: number): Promise<number[]> {
  const rows = await db
    .select({ id: payments.id })
    .from(payments)
    .where(
      and(
        eq(payments.purpose, 'topup'),
        eq(payments.status, 'pending'),
        eq(payments.reviewRequired, false),
        lte(payments.autoCreditAt, now),
      ),
    )
    .orderBy(asc(payments.autoCreditAt), asc(payments.id))
    .limit(limit);
  return rows.map((row) => row.id);
}

/**
 * Tells which of some merchants already have an approved top-up.
 *
 * Why: a pending top-up of a merchant with none is a first deposit, which the reviewer is told (the note hint of money.md).
 *
 * @param db the database or a transaction
 * @param clientIds the merchants
 * @returns the ids that have at least one approved top-up
 */
export async function clientsWithApprovedTopup(db: DbExecutor, clientIds: readonly number[]): Promise<Set<number>> {
  if (clientIds.length === 0) return new Set();
  const rows = await db
    .selectDistinct({ clientId: invoices.clientId })
    .from(payments)
    .innerJoin(invoices, eq(invoices.id, payments.invoiceId))
    .where(
      and(eq(payments.purpose, 'topup'), eq(payments.status, 'approved'), inArray(invoices.clientId, [...clientIds])),
    );
  return new Set(rows.flatMap((row) => (row.clientId === null ? [] : [row.clientId])));
}
