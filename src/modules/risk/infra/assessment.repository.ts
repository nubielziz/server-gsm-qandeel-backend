// Drizzle queries on `risk_assessments` (risk module): the new assessment of a payment and the staff decision on a held order.
import { and, eq, isNull } from 'drizzle-orm';
import type { DbExecutor } from '../../../infra/db';
import { type NewRiskAssessment, type RiskAssessment, type RiskOutcome, riskAssessments } from '../db/schema';

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
