// Drizzle queries of the commission plan routes on `commission_plans` (stage 11): list, find, lock, insert, change, delete, and the
// counts that decide whether a plan may be deleted.
import { and, eq, isNull, sql } from 'drizzle-orm';
import type { ParsedListQuery } from '../../../common/contract';
import { type DbExecutor, type ListColumns, listOrderBy, listWhere } from '../../../infra/db';
import {
  type CommissionPlan,
  type NewCommissionPlan,
  commissionAccruals,
  commissionAssignments,
  commissionPlans,
} from '../db/schema';

/** The list fields `GET /admin/commission-plans` can sort and filter on. */
export type PlanListField = 'id' | 'name' | 'percent' | 'createdAt';

const COLUMNS: ListColumns = {
  id: commissionPlans.id,
  name: commissionPlans.name,
  percent: commissionPlans.percent,
  createdAt: commissionPlans.createdAt,
  kind: commissionPlans.kind,
  isActive: commissionPlans.isActive,
};

/**
 * Lists plans.
 *
 * @param db the database or a transaction
 * @param query the parsed list request
 * @returns the page of plans and the exact total
 */
export async function listPlanRows(
  db: DbExecutor,
  query: ParsedListQuery<PlanListField>,
): Promise<{ rows: CommissionPlan[]; total: number }> {
  const where = listWhere(query, COLUMNS);
  const [rows, [count]] = await Promise.all([
    db
      .select()
      .from(commissionPlans)
      .where(where)
      .orderBy(...listOrderBy(query.sort, COLUMNS, commissionPlans.id))
      .limit(query.range.limit)
      .offset(query.range.start),
    db
      .select({ total: sql<number>`count(*)::int` })
      .from(commissionPlans)
      .where(where),
  ]);
  return { rows, total: count?.total ?? 0 };
}

/**
 * Finds a plan.
 *
 * @param db the database or a transaction
 * @param id the plan id
 * @returns the row, or `undefined`
 */
export async function findPlan(db: DbExecutor, id: number): Promise<CommissionPlan | undefined> {
  const [row] = await db.select().from(commissionPlans).where(eq(commissionPlans.id, id)).limit(1);
  return row;
}

/**
 * Finds a plan and locks it for the rest of the transaction.
 *
 * Why: a rate change, a delete and a new assignment of the same plan must not interleave (the delete counts the assignments, the
 * assignment reads the rate).
 *
 * @param db the transaction
 * @param id the plan id
 * @returns the locked row, or `undefined`
 */
export async function lockPlan(db: DbExecutor, id: number): Promise<CommissionPlan | undefined> {
  const [row] = await db.select().from(commissionPlans).where(eq(commissionPlans.id, id)).limit(1).for('update');
  return row;
}

/**
 * Inserts a plan.
 *
 * @param db the transaction
 * @param row the new plan
 * @returns the stored row
 */
export async function insertPlan(db: DbExecutor, row: NewCommissionPlan): Promise<CommissionPlan> {
  const [created] = await db.insert(commissionPlans).values(row).returning();
  return created!;
}

/**
 * Changes a plan.
 *
 * @param db the transaction
 * @param id the plan id
 * @param changes the columns that change
 * @returns the updated row, or `undefined` when it is gone
 */
export async function updatePlanRow(
  db: DbExecutor,
  id: number,
  changes: Partial<NewCommissionPlan>,
): Promise<CommissionPlan | undefined> {
  const [row] = await db.update(commissionPlans).set(changes).where(eq(commissionPlans.id, id)).returning();
  return row;
}

/**
 * Deletes a plan row.
 *
 * @param db the transaction (the row is locked and its blockers were counted)
 * @param id the plan id
 */
export async function deletePlanRow(db: DbExecutor, id: number): Promise<void> {
  await db.delete(commissionPlans).where(eq(commissionPlans.id, id));
}

/** What still refers to a plan. */
export interface PlanUsage {
  /** Assignments that have not ended. */
  readonly current: number;
  /** Assignments of any age. */
  readonly assignments: number;
  readonly accruals: number;
}

/**
 * Counts what refers to a plan.
 *
 * Why: RULES commissions 7: a plan is deleted only when no assignment is current; the foreign keys also keep a plan that has
 * ended assignments or accruals, so those answer `PLAN_IN_USE` too (with the advice to switch the plan off instead).
 *
 * @param db the transaction
 * @param planId the plan
 * @returns the three counts
 */
export async function planUsage(db: DbExecutor, planId: number): Promise<PlanUsage> {
  const [assignments] = await db
    .select({
      all: sql<number>`count(*)::int`,
      current: sql<number>`count(*) filter (where ${isNull(commissionAssignments.endsAt)})::int`,
    })
    .from(commissionAssignments)
    .where(eq(commissionAssignments.planId, planId));
  const [accruals] = await db
    .select({ total: sql<number>`count(*)::int` })
    .from(commissionAccruals)
    .where(and(eq(commissionAccruals.planId, planId)));
  return {
    current: assignments?.current ?? 0,
    assignments: assignments?.all ?? 0,
    accruals: accruals?.total ?? 0,
  };
}
