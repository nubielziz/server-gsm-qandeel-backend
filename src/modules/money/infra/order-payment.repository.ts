// Drizzle queries on the storefront (order) payments of `payments` (feature 16): the pending payment of a pay call, the payment of an
// order, locks and the guarded updates of capture, failure and refund status. Top-ups have their own file (`payment.repository.ts`).
import { and, asc, eq, inArray, sql } from 'drizzle-orm';
import type { DbExecutor } from '../../../infra/db';
import { type NewPayment, type Payment, disputes, invoices, ledgerAccounts, payments } from '../db/schema';

/** The statuses of an order payment that was captured (money received), whatever happened to it since. */
export const CAPTURED_STATUSES = ['captured', 'partial_refund', 'refunded', 'disputed', 'chargeback'] as const;

/**
 * Takes the lock of a pay call without waiting.
 *
 * Why: two `/pay` calls with the same checkout and `Idempotency-Key` must not both open a gateway checkout; the loser learns at once
 * that the key is in use (`409 IDEMPOTENCY_IN_PROGRESS`), as the portal's order placement does.
 *
 * @param db the transaction
 * @param sessionId the checkout session
 * @param key the `Idempotency-Key`
 * @returns true when this transaction now holds the lock
 */
export async function tryLockPayKey(db: DbExecutor, sessionId: number, key: string): Promise<boolean> {
  const result = await db.execute(
    sql`select pg_try_advisory_xact_lock(hashtextextended(${`pay:${sessionId}:${key}`}, 0)) as locked`,
  );
  return result.rows[0]?.locked === true;
}

/**
 * Takes the lock of a checkout's pay calls, waiting for it.
 *
 * Why: decision 048: a checkout keeps at most a few live payment pages; the count and the insert of a new page run under this lock, so
 * calls with different keys at once cannot all pass the count. Lock order of a pay call: the key's try-lock, then this lock.
 *
 * @param db the transaction
 * @param sessionId the checkout session
 */
export async function lockPaySession(db: DbExecutor, sessionId: number): Promise<void> {
  await db.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`pay-session:${sessionId}`}, 0))`);
}

/**
 * Counts the live payment pages of a checkout: storefront payments that are pending and not held for staff.
 *
 * @param db the transaction (under {@link lockPaySession})
 * @param sessionId the checkout session
 * @returns the number of live pages, a page still being opened included
 */
export async function countLivePayments(db: DbExecutor, sessionId: number): Promise<number> {
  const [row] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(payments)
    .where(
      and(
        eq(payments.checkoutSessionId, sessionId),
        eq(payments.purpose, 'order'),
        eq(payments.status, 'pending'),
        eq(payments.reviewRequired, false),
      ),
    );
  return row?.n ?? 0;
}

/**
 * Finds the payment a pay call opened under a key.
 *
 * @param db the database or a transaction
 * @param sessionId the checkout session
 * @param key the `Idempotency-Key`
 * @returns the payment, or `undefined`
 */
export async function findPaymentByKey(db: DbExecutor, sessionId: number, key: string): Promise<Payment | undefined> {
  const [row] = await db
    .select()
    .from(payments)
    .where(and(eq(payments.checkoutSessionId, sessionId), eq(payments.idempotencyKey, key)))
    .limit(1);
  return row;
}

/**
 * Reserves the next payment id.
 *
 * Why: the gateway's reference of a storefront checkout is `PAY-<id>` and the gateway is asked before anything is written.
 *
 * @param db the database or a transaction
 * @returns the id
 */
export async function reservePaymentId(db: DbExecutor): Promise<number> {
  const result = await db.execute<{ id: string }>(
    sql`select nextval(pg_get_serial_sequence('public.payments', 'id')) as id`,
  );
  return Number(result.rows[0]!.id);
}

/**
 * Inserts an order payment under an id reserved with {@link reservePaymentId}.
 *
 * Side effects: inserts a `payments` row.
 *
 * @param db the transaction
 * @param row the new row with its id
 * @returns the stored row
 */
export async function insertOrderPayment(db: DbExecutor, row: NewPayment & { id: number }): Promise<Payment> {
  const [created] = await db.insert(payments).overridingSystemValue().values(row).returning();
  return created!;
}

/**
 * Finds an order payment by id (any status).
 *
 * @param db the database or a transaction
 * @param id the payment id
 * @returns the payment, or `undefined` for an unknown id or a top-up
 */
export async function findOrderPayment(db: DbExecutor, id: number): Promise<Payment | undefined> {
  const [row] = await db
    .select()
    .from(payments)
    .where(and(eq(payments.id, id), eq(payments.purpose, 'order')))
    .limit(1);
  return row;
}

/**
 * Finds an order payment and locks it until the transaction ends.
 *
 * Why: capture, refund approval and the dispute webhook all lock the payment first and re-check its status under the lock. Lock order
 * everywhere: the order (an existing one: a rejection's guarded update and an approval's `lockOrderForRefund` take it first), the checkout
 * session, the payment, the refund, the ledger accounts.
 *
 * @param db the caller's transaction
 * @param id the payment id
 * @returns the payment, or `undefined`
 */
export async function lockOrderPayment(db: DbExecutor, id: number): Promise<Payment | undefined> {
  const [row] = await db
    .select()
    .from(payments)
    .where(and(eq(payments.id, id), eq(payments.purpose, 'order')))
    .limit(1)
    .for('update');
  return row;
}

/**
 * Finds the captured payment that paid an order.
 *
 * Why: an order can have more than one captured payment (a duplicate payment for a paid checkout is booked and refunded at once). The
 * payment that paid the order is the one linked to the order's first receipt invoice, whatever its id; the duplicate's own receipt comes
 * later. Taking the lowest payment id instead would pick an already refunded duplicate whenever it was opened first and confirmed second,
 * and a rejection would then refund nothing.
 *
 * @param db the database or a transaction
 * @param orderId the order
 * @returns the payment of the order's first receipt (when no payment is linked to a receipt, the oldest captured one), or `undefined`
 */
export async function findPaymentOfOrder(db: DbExecutor, orderId: number): Promise<Payment | undefined> {
  const [row] = await db
    .select({ payment: payments })
    .from(payments)
    .leftJoin(
      invoices,
      and(eq(invoices.id, payments.invoiceId), eq(invoices.kind, 'receipt'), eq(invoices.orderId, orderId)),
    )
    .where(
      and(
        eq(payments.purpose, 'order'),
        eq(payments.orderId, orderId),
        inArray(payments.status, [...CAPTURED_STATUSES]),
      ),
    )
    .orderBy(sql`${invoices.id} asc nulls last`, asc(payments.id))
    .limit(1);
  return row?.payment;
}

/**
 * Finds a payment by the gateway's reference (the event's id of the payment).
 *
 * @param db the database or a transaction
 * @param gatewayId the gateway
 * @param reference the gateway's reference
 * @returns the order payment, or `undefined`
 */
export async function findOrderPaymentByReference(
  db: DbExecutor,
  gatewayId: number,
  reference: string,
): Promise<Payment | undefined> {
  const [row] = await db
    .select()
    .from(payments)
    .where(and(eq(payments.purpose, 'order'), eq(payments.gatewayId, gatewayId), eq(payments.gatewayTxnId, reference)))
    .limit(1);
  return row;
}

/**
 * Updates an order payment.
 *
 * Side effects: updates the `payments` row.
 *
 * @param db the caller's transaction
 * @param id the payment id
 * @param changes the columns to set
 * @returns the stored row
 */
export async function updateOrderPayment(db: DbExecutor, id: number, changes: Partial<NewPayment>): Promise<Payment> {
  const [updated] = await db.update(payments).set(changes).where(eq(payments.id, id)).returning();
  return updated!;
}

/**
 * Updates an order payment only while it still has a status (a guarded change).
 *
 * @param db the caller's transaction
 * @param id the payment id
 * @param statuses the statuses it must be in
 * @param changes the columns to set
 * @returns the stored row, or `undefined` when another request changed it first
 */
export async function updateOrderPaymentIn(
  db: DbExecutor,
  id: number,
  statuses: readonly Payment['status'][],
  changes: Partial<NewPayment>,
): Promise<Payment | undefined> {
  const [updated] = await db
    .update(payments)
    .set(changes)
    .where(and(eq(payments.id, id), inArray(payments.status, [...statuses])))
    .returning();
  return updated;
}

/**
 * Reads order payments by id.
 *
 * @param db the database or a transaction
 * @param ids the payment ids
 * @returns the payments that exist (top-ups excluded), by id
 */
export async function loadOrderPayments(db: DbExecutor, ids: readonly number[]): Promise<Map<number, Payment>> {
  const unique = [...new Set(ids)];
  if (unique.length === 0) return new Map();
  const rows = await db
    .select()
    .from(payments)
    .where(and(eq(payments.purpose, 'order'), inArray(payments.id, unique)));
  return new Map(rows.map((row) => [row.id, row]));
}

/**
 * Tells whether a ledger account is owned by an account (a wallet or a hold that was ever opened for it).
 *
 * Why: the guest-order claim refuses a guest row that holds any ledger account (decision 064): money that sits on the row would have to move
 * with it, and the claim moves records, not balances.
 *
 * @param db the transaction
 * @param accountId the account (a guest row for the claim)
 * @returns true when a ledger account names the account as its owner
 */
export async function hasLedgerAccount(db: DbExecutor, accountId: number): Promise<boolean> {
  const [row] = await db
    .select({ id: ledgerAccounts.id })
    .from(ledgerAccounts)
    .where(and(eq(ledgerAccounts.ownerType, 'account'), eq(ledgerAccounts.ownerId, accountId)))
    .limit(1);
  return row !== undefined;
}

/**
 * Takes the payments of an account `FOR UPDATE NOWAIT` and says whether any of them is still pending.
 *
 * Why: the first step of the money participant of the guest-order claim: a pending payment (a page still open, a confirmation held
 * for staff) is mid-flight, so the claim gives up with `busy` instead of moving it; any other payment is only re-pointed. A row another
 * request holds (a confirmation being captured, a dispute webhook) makes the lock error (SQLSTATE 55P03) that the claim answers as `busy`.
 *
 * Side effects: row locks until the transaction ends.
 *
 * @param tx the claim's transaction, inside the savepoint the claim opened
 * @param accountId the guest row
 * @returns how many payments it has and whether one is pending
 * @throws the lock error (55P03) when another transaction holds one of the rows
 */
export async function lockGuestPayments(
  tx: DbExecutor,
  accountId: number,
): Promise<{ readonly count: number; readonly pending: boolean }> {
  const rows = await tx
    .select({ id: payments.id, status: payments.status })
    .from(payments)
    .where(eq(payments.accountId, accountId))
    .orderBy(payments.id)
    .for('update', { noWait: true });
  return { count: rows.length, pending: rows.some((row) => row.status === 'pending') };
}

/**
 * Moves the payments, the invoices (the receipts) and the disputes of a guest row to the account that proved the mailbox.
 *
 * Why: decision 064: the money participant of the guest-order claim. Every record that hangs on a guest checkout names
 * its owner by `account_id`, and the account that claims the orders owns what was paid for them. The rows are taken `FOR UPDATE NOWAIT`
 * (the payments were taken by {@link lockGuestPayments} already): a dispute another request is writing makes the lock error that the claim
 * answers as `busy`. `updated_at` is kept as it is: a change of owner is not a change of the record's state.
 *
 * Side effects: updates `payments.account_id`, `invoices.account_id` and `disputes.account_id`.
 *
 * @param tx the claim's transaction, inside the savepoint the claim opened (the payments of the guest row are locked)
 * @param guestId the guest row that holds the records now
 * @param accountId the account that takes them
 * @returns how many payments, invoices and disputes moved
 * @throws the lock error (55P03) when another transaction holds one of the rows
 */
export async function moveGuestPaymentRecords(
  tx: DbExecutor,
  guestId: number,
  accountId: number,
): Promise<{ readonly payments: number; readonly invoices: number; readonly disputes: number }> {
  const movedPayments = await tx
    .update(payments)
    .set({ accountId, updatedAt: sql`${payments.updatedAt}` })
    .where(eq(payments.accountId, guestId))
    .returning({ id: payments.id });
  const mineInvoices = eq(invoices.accountId, guestId);
  const invoiceRows = await tx
    .select({ id: invoices.id })
    .from(invoices)
    .where(mineInvoices)
    .orderBy(invoices.id)
    .for('update', { noWait: true });
  const movedInvoices =
    invoiceRows.length === 0
      ? []
      : await tx
          .update(invoices)
          .set({ accountId, updatedAt: sql`${invoices.updatedAt}` })
          .where(mineInvoices)
          .returning({ id: invoices.id });
  const mineDisputes = eq(disputes.accountId, guestId);
  const disputeRows = await tx
    .select({ id: disputes.id })
    .from(disputes)
    .where(mineDisputes)
    .orderBy(disputes.id)
    .for('update', { noWait: true });
  const movedDisputes =
    disputeRows.length === 0
      ? []
      : await tx
          .update(disputes)
          .set({ accountId, updatedAt: sql`${disputes.updatedAt}` })
          .where(mineDisputes)
          .returning({ id: disputes.id });
  return { payments: movedPayments.length, invoices: movedInvoices.length, disputes: movedDisputes.length };
}
