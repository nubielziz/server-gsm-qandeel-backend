// Drizzle queries on `disputes` (map routes /admin/disputes*, the dispute webhook, feature 16): the list with the deadline order the console
// wants, find with a row lock, insert-once and guarded updates. Only the money module touches this table.
import { type SQL, and, eq, inArray, sql } from 'drizzle-orm';
import type { ParsedListQuery } from '../../../common/contract';
import { type DbExecutor, schema as s } from '../../../infra/db';
import { listOrderBy, listWhere } from '../../../infra/db/list-sql';
import { type Dispute, type DisputeStatus, type NewDispute, disputes } from '../db/schema';

/** The sort fields of the dispute list. */
export type DisputeSortField = 'id' | 'amount' | 'evidenceDueAt' | 'status';

const COLUMNS = {
  id: disputes.id,
  disputeId: sql`${disputes.id}::text`,
  amount: disputes.amount,
  evidenceDueAt: disputes.evidenceDueAt,
  status: disputes.status,
  reasonCode: disputes.reasonCode,
  'customer.name': s.customers.name,
  'customer.email': s.customers.email,
};

/**
 * Lists disputes.
 *
 * Why: ANSWERS refunds Q7: sorted by `evidenceDueAt` ascending the disputes that still need an answer come first (soonest deadline
 * first), then the others by deadline; any other sort stays plain.
 *
 * @param db the database or a transaction
 * @param query the parsed list request (`q` searches the id, the reason code and the customer name)
 * @returns the page of disputes and the number matching the filters
 */
export async function listDisputeRows(
  db: DbExecutor,
  query: ParsedListQuery<DisputeSortField>,
): Promise<{ rows: Dispute[]; total: number }> {
  const where = listWhere(query, COLUMNS);
  const first = query.sort[0];
  const open: SQL[] =
    first?.field === 'evidenceDueAt' && first.order === 'asc'
      ? [sql`case when ${disputes.status} = 'needs_response' then 0 else 1 end asc`]
      : [];
  const [rows, [counted]] = await Promise.all([
    db
      .select({ dispute: disputes })
      .from(disputes)
      .leftJoin(s.customers, eq(s.customers.id, disputes.customerId))
      .where(where)
      .orderBy(...open, ...listOrderBy(query.sort, COLUMNS, disputes.id))
      .limit(query.range.limit)
      .offset(query.range.start),
    db
      .select({ total: sql<number>`count(*)::int` })
      .from(disputes)
      .leftJoin(s.customers, eq(s.customers.id, disputes.customerId))
      .where(where),
  ]);
  return { rows: rows.map((row) => row.dispute), total: counted?.total ?? 0 };
}

/**
 * Finds a dispute by id.
 *
 * @param db the database or a transaction
 * @param id the dispute id
 * @returns the dispute, or `undefined`
 */
export async function findDispute(db: DbExecutor, id: number): Promise<Dispute | undefined> {
  const [row] = await db.select().from(disputes).where(eq(disputes.id, id)).limit(1);
  return row;
}

/**
 * Finds a dispute and locks it until the transaction ends.
 *
 * Why: submit, accept and the gateway's webhook all lock the dispute and re-check its status under the lock; lock order: the payment,
 * then the dispute, then the ledger accounts.
 *
 * @param db the caller's transaction
 * @param id the dispute id
 * @returns the dispute, or `undefined`
 */
export async function lockDispute(db: DbExecutor, id: number): Promise<Dispute | undefined> {
  const [row] = await db.select().from(disputes).where(eq(disputes.id, id)).limit(1).for('update');
  return row;
}

/**
 * Finds the dispute a gateway reported for a payment.
 *
 * @param db the database or a transaction
 * @param paymentId the payment
 * @param gatewayDisputeId the gateway's id of the dispute
 * @returns the dispute, or `undefined`
 */
export async function findDisputeByGatewayId(
  db: DbExecutor,
  paymentId: number,
  gatewayDisputeId: string,
): Promise<Dispute | undefined> {
  const [row] = await db
    .select()
    .from(disputes)
    .where(and(eq(disputes.paymentId, paymentId), eq(disputes.gatewayDisputeId, gatewayDisputeId)))
    .limit(1);
  return row;
}

/**
 * Inserts a dispute, or does nothing when the gateway already reported it for the payment.
 *
 * Why: the unique `(payment_id, gateway_dispute_id)` is what makes a repeated `dispute.created` create one dispute.
 *
 * Side effects: inserts a `disputes` row.
 *
 * @param db the caller's transaction
 * @param row the new dispute
 * @returns the stored row, or `undefined` when it existed
 */
export async function insertDisputeOnce(db: DbExecutor, row: NewDispute): Promise<Dispute | undefined> {
  const [created] = await db.insert(disputes).values(row).onConflictDoNothing().returning();
  return created;
}

/**
 * Updates a dispute only while it is in one of the given statuses (a guarded change).
 *
 * @param db the caller's transaction
 * @param id the dispute id
 * @param statuses the statuses it must be in
 * @param changes the columns to set
 * @returns the stored row, or `undefined` when another request changed it first
 */
export async function updateDisputeIn(
  db: DbExecutor,
  id: number,
  statuses: readonly DisputeStatus[],
  changes: Partial<NewDispute>,
): Promise<Dispute | undefined> {
  const [updated] = await db
    .update(disputes)
    .set(changes)
    .where(and(eq(disputes.id, id), inArray(disputes.status, [...statuses])))
    .returning();
  return updated;
}

/**
 * Updates a dispute.
 *
 * Side effects: updates the `disputes` row.
 *
 * @param db the caller's transaction
 * @param id the dispute id
 * @param changes the columns to set
 * @returns the stored row
 */
export async function updateDispute(db: DbExecutor, id: number, changes: Partial<NewDispute>): Promise<Dispute> {
  const [updated] = await db.update(disputes).set(changes).where(eq(disputes.id, id)).returning();
  return updated!;
}
