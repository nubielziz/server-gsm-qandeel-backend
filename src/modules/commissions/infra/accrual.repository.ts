// Drizzle queries of the accrual routes on `commission_accruals` (stage 11): the staff and merchant lists, the locks the approval and
// the reversal take, and the writes of an accrual's life (born, approved, reversed, paid back).
import { and, asc, eq, inArray, isNull, sql } from 'drizzle-orm';
import type { ParsedListQuery } from '../../../common/contract';
import { Money } from '../../../common/money';
import { type DbExecutor, type ListColumns, listOrderBy, listWhere } from '../../../infra/db';
import { type CommissionAccrual, type NewCommissionAccrual, commissionAccruals } from '../db/schema';

/** The list fields `GET /admin/commission-accruals` can sort on. */
export type AccrualListField = 'id' | 'createdAt' | 'approvedAt' | 'basisAmount' | 'percent' | 'amount' | 'status';

/** The list fields `GET /client/commissions` can sort on. */
export type ClientAccrualListField = 'createdAt' | 'period' | 'amount';

const COLUMNS: ListColumns = {
  id: commissionAccruals.id,
  createdAt: commissionAccruals.createdAt,
  approvedAt: commissionAccruals.approvedAt,
  basisAmount: commissionAccruals.basisAmount,
  percent: commissionAccruals.percent,
  amount: commissionAccruals.amount,
  status: commissionAccruals.status,
  period: commissionAccruals.period,
  beneficiaryId: commissionAccruals.beneficiaryId,
  orderId: commissionAccruals.orderId,
};

/**
 * Lists accruals.
 *
 * @param db the database or a transaction
 * @param query the parsed list request (the sort fields of either list: both are columns of this table)
 * @param onlyBeneficiary a merchant: the merchant portal's list shows only its own accruals
 * @returns the page of accruals and the exact total
 */
export async function listAccrualRows(
  db: DbExecutor,
  query: ParsedListQuery<AccrualListField | ClientAccrualListField>,
  onlyBeneficiary?: number,
): Promise<{ rows: CommissionAccrual[]; total: number }> {
  const scope = onlyBeneficiary === undefined ? undefined : eq(commissionAccruals.beneficiaryId, onlyBeneficiary);
  const where = listWhere(query, COLUMNS, scope);
  const [rows, [count]] = await Promise.all([
    db
      .select()
      .from(commissionAccruals)
      .where(where)
      .orderBy(...listOrderBy(query.sort, COLUMNS, commissionAccruals.id))
      .limit(query.range.limit)
      .offset(query.range.start),
    db
      .select({ total: sql<number>`count(*)::int` })
      .from(commissionAccruals)
      .where(where),
  ]);
  return { rows, total: count?.total ?? 0 };
}

/**
 * Finds an accrual.
 *
 * @param db the database or a transaction
 * @param id the accrual id
 * @returns the row, or `undefined`
 */
export async function findAccrual(db: DbExecutor, id: number): Promise<CommissionAccrual | undefined> {
  const [row] = await db.select().from(commissionAccruals).where(eq(commissionAccruals.id, id)).limit(1);
  return row;
}

/**
 * Finds accruals by id and locks them for the rest of the transaction, in id order.
 *
 * Why: two approvals of overlapping ids, or an approval and a reversal of the same accrual, must not both act on it: whoever locks
 * second sees the first one's status. Ascending id order keeps two such requests from waiting on each other.
 *
 * @param db the transaction
 * @param ids the accrual ids
 * @returns the locked rows by id; an unknown id has no entry
 */
export async function lockAccruals(db: DbExecutor, ids: readonly number[]): Promise<Map<number, CommissionAccrual>> {
  if (ids.length === 0) return new Map();
  const rows = await db
    .select()
    .from(commissionAccruals)
    .where(inArray(commissionAccruals.id, [...ids]))
    .orderBy(asc(commissionAccruals.id))
    .for('update');
  return new Map(rows.map((row) => [row.id, row]));
}

/**
 * Finds the accruals of an order that still count (not reversed) and locks them, in id order.
 *
 * @param db the transaction of the reversal
 * @param orderId the order that was reopened or refunded
 * @returns the locked rows
 */
export async function lockLiveAccrualsOfOrder(db: DbExecutor, orderId: number): Promise<CommissionAccrual[]> {
  return db
    .select()
    .from(commissionAccruals)
    .where(
      and(
        eq(commissionAccruals.orderId, orderId),
        inArray(commissionAccruals.status, ['accrued', 'approved']),
        isNull(commissionAccruals.reversedAt),
      ),
    )
    .orderBy(asc(commissionAccruals.id))
    .for('update');
}

/**
 * Inserts an accrual unless the order already has a live one for that beneficiary.
 *
 * Why: RULES commissions 1: an order accrues once per beneficiary. The partial unique index decides, so two completions that race
 * (or a replay) write one row; `ON CONFLICT DO NOTHING` skips the loser without failing the completion's transaction. An amount
 * of 0 (or less) is never written: the ledger cannot post it, so such a row could only get in the way of an approval.
 *
 * @param db the completion's transaction
 * @param row the accrual
 * @returns the stored row, or `undefined` when the amount is not above 0 or the order already accrued for this beneficiary
 */
export async function insertAccrualOnce(
  db: DbExecutor,
  row: NewCommissionAccrual,
): Promise<CommissionAccrual | undefined> {
  if (!Money.of(row.amount).isPositive()) return undefined;
  const [created] = await db.insert(commissionAccruals).values(row).onConflictDoNothing().returning();
  return created;
}

/**
 * Marks accruals approved and ties them to the commission posting.
 *
 * @param db the approval's transaction (the rows are locked and `accrued`)
 * @param ids the accruals of one agent's batch
 * @param ledgerTxId the posting that paid them
 * @param approvedAt the approval time, from the injected clock
 */
export async function markApproved(
  db: DbExecutor,
  ids: readonly number[],
  ledgerTxId: number,
  approvedAt: Date,
): Promise<void> {
  await db
    .update(commissionAccruals)
    .set({ status: 'approved', ledgerTxId, approvedAt })
    .where(and(inArray(commissionAccruals.id, [...ids]), eq(commissionAccruals.status, 'accrued')));
}

/**
 * Reverses an accrual that was not approved yet.
 *
 * @param db the reversal's transaction (the row is locked)
 * @param id the accrual
 * @param reversedAt the time of the reopen or refund, from the injected clock
 */
export async function markReversed(db: DbExecutor, id: number, reversedAt: Date): Promise<void> {
  await db
    .update(commissionAccruals)
    .set({ status: 'reversed', reversedAt })
    .where(and(eq(commissionAccruals.id, id), eq(commissionAccruals.status, 'accrued')));
}

/**
 * Records that an approved accrual was paid back (its status stays `approved`, user rule 5).
 *
 * @param db the reversal's transaction (the row is locked)
 * @param id the accrual
 * @param reversedAt the time of the reopen or refund, from the injected clock
 * @returns true when this call marked it (false: it was already paid back)
 */
export async function markPaidBack(db: DbExecutor, id: number, reversedAt: Date): Promise<boolean> {
  const rows = await db
    .update(commissionAccruals)
    .set({ reversedAt })
    .where(
      and(
        eq(commissionAccruals.id, id),
        eq(commissionAccruals.status, 'approved'),
        isNull(commissionAccruals.reversedAt),
      ),
    )
    .returning({ id: commissionAccruals.id });
  return rows.length > 0;
}
