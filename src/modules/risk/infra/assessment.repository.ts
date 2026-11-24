// Drizzle queries on `risk_assessments` (risk module): the new assessment of a payment and the staff decision on a held order.
import { and, eq, inArray, isNull, sql } from 'drizzle-orm';
import type { DbExecutor } from '../../../infra/db';
import { type NewRiskAssessment, type RiskAssessment, type RiskOutcome, riskAssessments } from '../db/schema';

/**
 * Serialises the screenings of one buyer until the transaction ends.
 *
 * Why: decision 050: two payments of one email screened at the same moment run one after the other, so the second counts the first one's
 * order. Lock order: the payment and checkout-session rows the caller holds, then this lock, then the order, stock and ledger rows of the
 * placement; no caller takes it in another order, and no network call happens while it is held.
 *
 * Side effects: takes `pg_advisory_xact_lock`, released at commit or rollback.
 *
 * @param db the caller's transaction
 * @param email the buyer's email, trimmed and lower case
 */
export async function lockBuyer(db: DbExecutor, email: string): Promise<void> {
  await db.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`risk-buyer:${email}`}, 0))`);
}

/**
 * Inserts an assessment.
 *
 * @param db the database or a transaction
 * @param values the row (`createdAt` and `updatedAt` come from the clock, decision 031)
 * @returns the stored row
 */
export async function insertAssessment(db: DbExecutor, values: NewRiskAssessment): Promise<RiskAssessment> {
  const [row] = await db.insert(riskAssessments).values(values).returning();
  return row!;
}

/**
 * Points an assessment made before the order existed at the order.
 *
 * Why: the payment is scored before the order is placed (the placement needs the verdict to start `held`), so the assessment is
 * written without an order and linked right after.
 *
 * @param db the database or a transaction
 * @param assessmentId the assessment
 * @param orderId the placed order
 * @param now the clock's time
 * @returns false when no such undecided-link assessment exists or it already points at an order
 */
export async function linkAssessmentToOrder(
  db: DbExecutor,
  assessmentId: number,
  orderId: number,
  now: Date,
): Promise<boolean> {
  const rows = await db
    .update(riskAssessments)
    .set({ orderId, updatedAt: now })
    .where(and(eq(riskAssessments.id, assessmentId), isNull(riskAssessments.orderId)))
    .returning({ id: riskAssessments.id });
  return rows.length > 0;
}

/**
 * Records the decision on an assessment.
 *
 * @param db the caller's transaction (the assessment row is locked by the caller)
 * @param assessmentId the assessment
 * @param decision who decided (`null` for the system: a payment the rules blocked), when and how
 * @returns the number of rows changed (0 when it was decided meanwhile)
 */
export async function markDecided(
  db: DbExecutor,
  assessmentId: number,
  decision: { readonly reviewedBy: number | null; readonly reviewedAt: Date; readonly outcome: RiskOutcome },
): Promise<number> {
  const rows = await db
    .update(riskAssessments)
    .set({
      reviewedBy: decision.reviewedBy,
      reviewedAt: decision.reviewedAt,
      outcome: decision.outcome,
      updatedAt: decision.reviewedAt,
    })
    .where(and(eq(riskAssessments.id, assessmentId), isNull(riskAssessments.reviewedAt)))
    .returning({ id: riskAssessments.id });
  return rows.length;
}

/**
 * Locks the assessments of one account row without waiting.
 *
 * Why: the guest-order claim (decision 064) never waits: an assessment a decision (a staff approve or refund) or a payment
 * holds makes the lock fail at once with SQLSTATE 55P03, the claim catches it and answers `busy`, and the sign-in still succeeds.
 *
 * Side effects: row locks until the claim's transaction ends.
 *
 * @param db the claim's transaction
 * @param accountId the guest row
 * @returns the ids of the locked assessments, oldest first
 * @throws the lock error (SQLSTATE 55P03) when another transaction holds one of the rows
 */
export async function lockAssessmentsOfAccountNoWait(db: DbExecutor, accountId: number): Promise<number[]> {
  const rows = await db
    .select({ id: riskAssessments.id })
    .from(riskAssessments)
    .where(eq(riskAssessments.accountId, accountId))
    .orderBy(riskAssessments.id)
    .for('update', { noWait: true });
  return rows.map((row) => row.id);
}

/**
 * Moves locked assessments to another account row.
 *
 * Why: the guest-order claim re-points the assessments of the guest row's checkouts and orders at the account that proved the mailbox, so
 * the account's risk panel and the queue's history include them. Only the pointer changes: score, signals, decision and outcome stay.
 *
 * @param db the claim's transaction (the rows are locked by {@link lockAssessmentsOfAccountNoWait})
 * @param ids the locked assessments
 * @param accountId the account that claims them
 * @param now the clock's time
 * @returns how many rows moved
 */
export async function moveAssessmentsToAccount(
  db: DbExecutor,
  ids: readonly number[],
  accountId: number,
  now: Date,
): Promise<number> {
  if (ids.length === 0) return 0;
  const rows = await db
    .update(riskAssessments)
    .set({ accountId, updatedAt: now })
    .where(inArray(riskAssessments.id, [...ids]))
    .returning({ id: riskAssessments.id });
  return rows.length;
}
