// Drizzle queries on `refunds` (map routes /admin/refunds*, feature 16): the storefront refund list with sort, filter, search and exact
// count, find with a row lock, insert, guarded updates and the sums the refundable amount needs. Only the money module touches this table.
import { type SQL, and, eq, inArray, isNotNull, isNull, lte, ne, sql } from 'drizzle-orm';
import type { ParsedListQuery } from '../../../common/contract';
import { type DbExecutor, schema as s } from '../../../infra/db';
import { listOrderBy, listWhere } from '../../../infra/db/list-sql';
import { type NewRefund, type Refund, type RefundStatus, refunds } from '../db/schema';

/** The sort fields of the refund list. */
export type RefundSortField = 'id' | 'amount' | 'status' | 'createdAt';

// The wire keys stay `customer.*` (the console's Refunds page names the buyer so); the value is the buyer account (decision 064).
const COLUMNS = {
  id: refunds.id,
  refundId: sql`${refunds.id}::text`,
  amount: refunds.amount,
  status: refunds.status,
  createdAt: refunds.createdAt,
  reason: refunds.reason,
  'customer.name': s.clients.name,
  'customer.email': s.clients.email,
};

/**
 * The refunds the Refunds page and its routes show: the ones of a storefront order, which name a payment and an order.
 *
 * Why: ANSWERS refunds Q1 and RESOLUTIONS money-12: a merchant refund goes through its order, and decision 048's return of a held payment
 * has no order, so the page and the reports leave it out. Since decision 064 every refund with a payment carries its payment's account
 * (`refunds_account_refs_check`), so the account says nothing about the kind of refund: the payment and the order do.
 */
const STOREFRONT_REFUND = and(isNotNull(refunds.paymentId), isNotNull(refunds.orderId));

/**
 * Lists storefront refunds.
 *
 * Why: ANSWERS refunds Q1 and RESOLUTIONS money-12: only refunds of a storefront order are listed ({@link STOREFRONT_REFUND}), whatever rank
 * the buyer's account has now.
 *
 * @param db the database or a transaction
 * @param query the parsed list request (`q` searches the id, the reason and the account's name)
 * @returns the page of refunds and the number matching the filters
 */
export async function listRefundRows(
  db: DbExecutor,
  query: ParsedListQuery<RefundSortField>,
): Promise<{ rows: Refund[]; total: number }> {
  const where = listWhere(query, COLUMNS, STOREFRONT_REFUND);
  const [rows, [counted]] = await Promise.all([
    db
      .select({ refund: refunds })
      .from(refunds)
      .leftJoin(s.clients, eq(s.clients.id, refunds.accountId))
      .where(where)
      .orderBy(...listOrderBy(query.sort, COLUMNS, refunds.id))
      .limit(query.range.limit)
      .offset(query.range.start),
    db
      .select({ total: sql<number>`count(*)::int` })
      .from(refunds)
      .leftJoin(s.clients, eq(s.clients.id, refunds.accountId))
      .where(where),
  ]);
  return { rows: rows.map((row) => row.refund), total: counted?.total ?? 0 };
}

/**
 * Finds a storefront refund by id.
 *
 * @param db the database or a transaction
 * @param id the refund id
 * @returns the refund, or `undefined` for an unknown id, a merchant refund or a return without an order
 */
export async function findStorefrontRefund(db: DbExecutor, id: number): Promise<Refund | undefined> {
  const [row] = await db
    .select()
    .from(refunds)
    .where(and(eq(refunds.id, id), STOREFRONT_REFUND))
    .limit(1);
  return row;
}

/**
 * Finds a refund and locks it until the transaction ends.
 *
 * Why: approve, decline, retry and the gateway's answer all lock the refund and re-check its status under the lock, so the loser of a
 * race changes nothing.
 *
 * @param db the caller's transaction
 * @param id the refund id
 * @returns the refund, or `undefined`
 */
export async function lockRefund(db: DbExecutor, id: number): Promise<Refund | undefined> {
  const [row] = await db.select().from(refunds).where(eq(refunds.id, id)).limit(1).for('update');
  return row;
}

/**
 * Inserts a refund.
 *
 * Side effects: inserts a `refunds` row.
 *
 * @param db the caller's transaction
 * @param row the new refund
 * @returns the stored row
 */
export async function insertRefund(db: DbExecutor, row: NewRefund): Promise<Refund> {
  const [created] = await db.insert(refunds).values(row).returning();
  return created!;
}

/**
 * Updates a refund.
 *
 * Side effects: updates the `refunds` row.
 *
 * @param db the caller's transaction
 * @param id the refund id
 * @param changes the columns to set
 * @returns the stored row
 */
export async function updateRefund(db: DbExecutor, id: number, changes: Partial<NewRefund>): Promise<Refund> {
  const [updated] = await db.update(refunds).set(changes).where(eq(refunds.id, id)).returning();
  return updated!;
}

/**
 * Updates a refund only while it is in one of the given statuses (a guarded change).
 *
 * @param db the caller's transaction
 * @param id the refund id
 * @param statuses the statuses it must be in
 * @param changes the columns to set
 * @returns the stored row, or `undefined` when another request changed it first
 */
export async function updateRefundIn(
  db: DbExecutor,
  id: number,
  statuses: readonly RefundStatus[],
  changes: Partial<NewRefund>,
): Promise<Refund | undefined> {
  const [updated] = await db
    .update(refunds)
    .set(changes)
    .where(and(eq(refunds.id, id), inArray(refunds.status, [...statuses])))
    .returning();
  return updated;
}

/**
 * Moves a `processing` refund to `failed`, and moves its idempotency key on when the gateway refused it for good.
 *
 * Why: the next send of a refund the gateway refused (a 4xx, a failed refund object) must use a new key, or the gateway only replays the
 * refusal; after a failure whose outcome is unknown (a timeout, a 5xx) the key stays, so a refund the gateway may have made is not made twice.
 * A new key was never sent, so a definite failure clears `unanswered_send_at`; a failure of a send that got no answer records the start of
 * that send there (the current `updated_at`, read before this update changes it), unless an earlier send under the key already did.
 *
 * @param db the caller's transaction
 * @param id the refund id
 * @param changes the failure text, the gateway's id and the time
 * @param definite true when the gateway refused the refund for good: `send_attempt` grows by one in the same update
 * @param unanswered true when the failed send got no answer (the gateway may have made the refund)
 * @returns the stored row, or `undefined` when the refund was not `processing`
 */
export async function failProcessingRefund(
  db: DbExecutor,
  id: number,
  changes: Pick<NewRefund, 'note' | 'updatedAt'> & Partial<Pick<NewRefund, 'gatewayRefundId'>>,
  definite: boolean,
  unanswered = false,
): Promise<Refund | undefined> {
  const [updated] = await db
    .update(refunds)
    .set({
      ...changes,
      status: 'failed',
      ...(definite
        ? { sendAttempt: sql`${refunds.sendAttempt} + 1`, unansweredSendAt: null }
        : unanswered
          ? { unansweredSendAt: sql`coalesce(${refunds.unansweredSendAt}, ${refunds.updatedAt})` }
          : {}),
    })
    .where(and(eq(refunds.id, id), eq(refunds.status, 'processing')))
    .returning();
  return updated;
}

/**
 * Records the gateway's refusal for good of the current send of a `failed` refund.
 *
 * Why: a send that got no answer fails the refund but keeps its idempotency key, since the gateway may have made the refund. The gateway's
 * own refusal of that send (`refund.failed`) says that gateway refund is dead: the key moves on (`send_attempt` + 1) and
 * `unanswered_send_at` is cleared, as for any refusal for good, so a later success of that send (delivered out of order or again) is stale
 * and the staff retry sends under a new key. The gateway's refund id is stored, so a success that names no attempt but that gateway refund
 * is stale too. Guarded by the status and the send attempt the refusal belongs to, so a repeated delivery changes nothing.
 *
 * Side effects: updates the `refunds` row (the gateway's text is appended to `note`).
 *
 * @param db the caller's transaction
 * @param id the refund id
 * @param sendAttempt the send attempt the refusal belongs to
 * @param gatewayRefundId the gateway's id of the refused refund, when it gave one (kept as it is otherwise)
 * @param text the line to append to the note
 * @param at the clock's time
 * @returns the stored row, or `undefined` when the refund is not `failed` on that send attempt
 */
export async function recordRefusalOfFailedRefund(
  db: DbExecutor,
  id: number,
  sendAttempt: number,
  gatewayRefundId: string | null,
  text: string,
  at: Date,
): Promise<Refund | undefined> {
  const [updated] = await db
    .update(refunds)
    .set({
      sendAttempt: sql`${refunds.sendAttempt} + 1`,
      unansweredSendAt: null,
      ...(gatewayRefundId === null ? {} : { gatewayRefundId }),
      note: sql`case when ${refunds.note} = '' then ${text} else ${refunds.note} || chr(10) || ${text} end`,
      updatedAt: at,
    })
    .where(and(eq(refunds.id, id), eq(refunds.status, 'failed'), eq(refunds.sendAttempt, sendAttempt)))
    .returning();
  return updated;
}

/**
 * Records that a send of a `processing` refund got no answer, while the queue retries it under the same key.
 *
 * Why: the gateway may have made the refund on that send and remembers its key only 24 hours, so a later send under the key must know when
 * the first unanswered one started (`unanswered_send_at`, from the current `updated_at`, the start of the send). An earlier record is kept;
 * `updated_at` is left as it is (the lost-work reconcile reads it as the start of the send). Guarded by the status and the send attempt, so
 * a refund that moved on in the meantime is not touched.
 *
 * Side effects: updates the `refunds` row.
 *
 * @param db the database or a transaction
 * @param id the refund id
 * @param sendAttempt the send attempt the unanswered call used
 * @returns true when the row was updated
 */
export async function markSendUnanswered(db: DbExecutor, id: number, sendAttempt: number): Promise<boolean> {
  const updated = await db
    .update(refunds)
    .set({ unansweredSendAt: sql`${refunds.updatedAt}`, updatedAt: sql`${refunds.updatedAt}` })
    .where(
      and(
        eq(refunds.id, id),
        eq(refunds.status, 'processing'),
        eq(refunds.sendAttempt, sendAttempt),
        isNull(refunds.unansweredSendAt),
      ),
    )
    .returning({ id: refunds.id });
  return updated.length > 0;
}

/**
 * Lists the storefront refunds that wait for their gateway call: `processing`, paid back to the original payment, with no gateway
 * reference yet, unchanged since `before`.
 *
 * Why: decision 055: the lost-work reconcile asks again for the send of a refund whose `refund.process` job was lost. `updated_at` is
 * the start of the current send (approval and retry write it from the clock); the index `refunds_status_created_idx` narrows by status.
 *
 * @param db the database or a transaction
 * @param before only refunds whose `updated_at` is at or before this time
 * @param limit the most refunds returned
 * @returns id, `updated_at` and send attempt, by id
 */
export async function refundsAwaitingSend(
  db: DbExecutor,
  before: Date,
  limit: number,
): Promise<Array<{ id: number; updatedAt: Date; sendAttempt: number }>> {
  return db
    .select({ id: refunds.id, updatedAt: refunds.updatedAt, sendAttempt: refunds.sendAttempt })
    .from(refunds)
    .where(
      and(
        eq(refunds.status, 'processing'),
        eq(refunds.method, 'original'),
        isNotNull(refunds.paymentId),
        isNull(refunds.gatewayRefundId),
        lte(refunds.updatedAt, before),
      ),
    )
    .orderBy(refunds.id)
    .limit(limit);
}

/**
 * Appends the gateway's late failure of a completed refund to its note, once per gateway refund.
 *
 * Why: plan 24C § 2.3: Stripe can report a refund `succeeded` and fail it later (`refund.failed`). The refund stays `completed` (its journal
 * is not undone automatically); the note is the durable trace staff act on. The update is guarded by the status, the gateway refund id
 * and the absence of the same marker, so a repeated delivery adds nothing.
 *
 * @param db the database or a transaction
 * @param id the refund id
 * @param gatewayRefundId the gateway's id of the refund that failed: it must be the one the refund completed with
 * @param marker text that identifies this failure inside the note (it is part of `text`)
 * @param text the sentence to append
 * @param at the time of the change
 * @returns the stored row, or `undefined` when the refund is not `completed` with that gateway refund, or the note already has it
 */
export async function appendLateRefundFailure(
  db: DbExecutor,
  id: number,
  gatewayRefundId: string,
  marker: string,
  text: string,
  at: Date,
): Promise<Refund | undefined> {
  const [updated] = await db
    .update(refunds)
    .set({
      note: sql`case when ${refunds.note} = '' then ${text} else ${refunds.note} || chr(10) || ${text} end`,
      updatedAt: at,
    })
    .where(
      and(
        eq(refunds.id, id),
        eq(refunds.status, 'completed'),
        eq(refunds.gatewayRefundId, gatewayRefundId),
        sql`strpos(${refunds.note}, ${marker}) = 0`,
      ),
    )
    .returning();
  return updated;
}

/**
 * Marks a completed return without an order failed again when the gateway reports its refund failed after it had completed.
 *
 * Why: decision 048: a held storefront payment counts for the money integrity check until a refund of it is `processing` or `completed`;
 * a return the gateway failed later is money that did not go back, so the refund is `failed` again (`completed_at` cleared) with the
 * failure on its note, and the payment is listed again. That gateway refund is dead, a failure for good, so `send_attempt` moves on (and
 * `unanswered_send_at` is cleared) as for any definite failure: a later success of that send (delivered out of order or again) is stale and
 * cannot complete the return, and a new send uses a new key. The update is guarded like {@link appendLateRefundFailure}: the status, no
 * order, the gateway refund id and the absence of the same marker, so a repeated delivery changes nothing.
 *
 * @param db the database or a transaction
 * @param id the refund id
 * @param gatewayRefundId the gateway's id of the refund that failed
 * @param marker the text that identifies this failure on the note
 * @param text the line to append
 * @param at the clock's time
 * @returns the updated row, or `undefined` when nothing matched
 */
export async function failLateReturn(
  db: DbExecutor,
  id: number,
  gatewayRefundId: string,
  marker: string,
  text: string,
  at: Date,
): Promise<Refund | undefined> {
  const [updated] = await db
    .update(refunds)
    .set({
      status: 'failed',
      completedAt: null,
      note: sql`case when ${refunds.note} = '' then ${text} else ${refunds.note} || chr(10) || ${text} end`,
      // The gateway refused that refund for good: the key moves on, as for any definite failure.
      sendAttempt: sql`${refunds.sendAttempt} + 1`,
      unansweredSendAt: null,
      updatedAt: at,
    })
    .where(
      and(
        eq(refunds.id, id),
        eq(refunds.status, 'completed'),
        isNull(refunds.orderId),
        eq(refunds.gatewayRefundId, gatewayRefundId),
        sql`strpos(${refunds.note}, ${marker}) = 0`,
      ),
    )
    .returning();
  return updated;
}

/**
 * The refunds of a payment that count against what can still go back.
 *
 * Why: ANSWERS refunds Q3: the limit is the paid amount minus the other refunds that are `completed` or `processing` (an approved
 * refund is money already promised). A `failed` refund counts too: its reversal stays posted in the ledger and a retry still sends
 * the money, so a second approval must not post (and pay) the same money again.
 *
 * @param db the database or a transaction
 * @param paymentId the payment
 * @param exceptId a refund to leave out (the one being decided)
 * @returns the refunds, oldest first
 */
export async function takenRefundsOfPayment(db: DbExecutor, paymentId: number, exceptId?: number): Promise<Refund[]> {
  const conditions: SQL[] = [
    eq(refunds.paymentId, paymentId),
    inArray(refunds.status, ['processing', 'completed', 'failed']),
  ];
  if (exceptId !== undefined) conditions.push(ne(refunds.id, exceptId));
  return db
    .select()
    .from(refunds)
    .where(and(...conditions))
    .orderBy(refunds.id);
}

/**
 * Every refund of a payment, whatever its status.
 *
 * Why: decision 048: a payment that is not captured has refunds only from a return (a held confirmation sent back, or paid back by hand),
 * and such a payment never pays its checkout once one exists.
 *
 * @param db the database or a transaction
 * @param paymentId the payment
 * @returns the refunds, oldest first
 */
export async function refundsOfPayment(db: DbExecutor, paymentId: number): Promise<Refund[]> {
  return db.select().from(refunds).where(eq(refunds.paymentId, paymentId)).orderBy(refunds.id);
}

/**
 * Finds a refund by the gateway's own id.
 *
 * @param db the database or a transaction
 * @param paymentId the payment the refund belongs to
 * @param gatewayRefundId the gateway's id
 * @returns the refund, or `undefined`
 */
export async function findRefundByGatewayId(
  db: DbExecutor,
  paymentId: number,
  gatewayRefundId: string,
): Promise<Refund | undefined> {
  const [row] = await db
    .select()
    .from(refunds)
    .where(and(eq(refunds.paymentId, paymentId), eq(refunds.gatewayRefundId, gatewayRefundId)))
    .limit(1);
  return row;
}

/**
 * Finds a refund by id (any refund, storefront or not).
 *
 * @param db the database or a transaction
 * @param id the refund id
 * @returns the refund, or `undefined`
 */
export async function findRefund(db: DbExecutor, id: number): Promise<Refund | undefined> {
  const [row] = await db.select().from(refunds).where(eq(refunds.id, id)).limit(1);
  return row;
}

/**
 * Finds the refund a gateway's event is about, among the refunds of payments of that gateway.
 *
 * Why: a refund result event names our refund id (echoed metadata) or the gateway's own refund id; either way the refund must belong
 * to a payment of the gateway that signed the event, so one gateway can never settle another's refunds.
 *
 * @param db the database or a transaction
 * @param gatewayId the gateway that signed the event
 * @param ref our refund id and/or the gateway's refund id from the event
 * @returns the refund, or `undefined`
 */
export async function findRefundForGateway(
  db: DbExecutor,
  gatewayId: number,
  ref: { readonly refundId: number | null; readonly gatewayRefundId: string },
): Promise<Refund | undefined> {
  const [row] = await db
    .select({ refund: refunds })
    .from(refunds)
    .innerJoin(s.payments, eq(s.payments.id, refunds.paymentId))
    .where(
      and(
        eq(s.payments.gatewayId, gatewayId),
        ref.refundId === null ? eq(refunds.gatewayRefundId, ref.gatewayRefundId) : eq(refunds.id, ref.refundId),
      ),
    )
    .limit(1);
  return row?.refund;
}

/**
 * Moves the refunds of a guest row to the account that proved the mailbox (the money participant of the guest-order claim).
 *
 * Why: decision 064: every refund with a payment names its payment's account, so when the payments of a guest row move
 * to the account that claims them, their refunds move with them. The rows are taken `FOR UPDATE NOWAIT`: a refund another request
 * holds (a staff approval, the refund job's answer) makes the lock error (SQLSTATE 55P03) that the claim catches and answers as `busy`.
 * `updated_at` is kept as it is: it is the start of the current send of a refund (see {@link refundsAwaitingSend}), and a change of owner
 * is not a new send.
 *
 * Side effects: updates `refunds.account_id` of the guest row's refunds.
 *
 * @param tx the claim's transaction, inside the savepoint the claim opened
 * @param guestId the guest row that holds the refunds now
 * @param accountId the account that takes them
 * @returns how many refunds moved
 * @throws the lock error (55P03) when another transaction holds one of the rows
 */
export async function moveGuestRefunds(tx: DbExecutor, guestId: number, accountId: number): Promise<number> {
  const mine = eq(refunds.accountId, guestId);
  const locked = await tx
    .select({ id: refunds.id })
    .from(refunds)
    .where(mine)
    .orderBy(refunds.id)
    .for('update', { noWait: true });
  if (locked.length === 0) return 0;
  const moved = await tx
    .update(refunds)
    .set({ accountId, updatedAt: sql`${refunds.updatedAt}` })
    .where(mine)
    .returning({ id: refunds.id });
  return moved.length;
}
