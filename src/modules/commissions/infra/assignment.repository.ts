// Drizzle queries of the commission assignment routes on `commission_assignments` (stage 11), with the plan of each row, and the
// lookup the accrual rule makes for the current plans of two merchants. Merchants (names) come from the foreign reads file.
import { and, eq, inArray, isNull, sql } from 'drizzle-orm';
import type { ParsedListQuery } from '../../../common/contract';
import { type DbExecutor, type ListColumns, listOrderBy, listWhere } from '../../../infra/db';
import {
  type CommissionAssignment,
  type CommissionPlan,
  type NewCommissionAssignment,
  commissionAccruals,
  commissionAssignments,
  commissionPlans,
} from '../db/schema';
import type { CurrentPlan } from '../domain/accrual-rules';

/** The list fields `GET /admin/commission-assignments` can sort on. */
export type AssignmentListField = 'id' | 'createdAt' | 'startsAt';

/** An assignment with its plan. */
export interface AssignmentRow {
  readonly assignment: CommissionAssignment;
  readonly plan: CommissionPlan;
}

const COLUMNS: ListColumns = {
  id: commissionAssignments.id,
  createdAt: commissionAssignments.createdAt,
  startsAt: commissionAssignments.startsAt,
  planId: commissionAssignments.planId,
  beneficiaryId: commissionAssignments.beneficiaryId,
};

function selectRows(db: DbExecutor) {
  return db
    .select({ assignment: commissionAssignments, plan: commissionPlans })
    .from(commissionAssignments)
    .innerJoin(commissionPlans, eq(commissionPlans.id, commissionAssignments.planId));
}

/**
 * Lists assignments with their plans.
 *
 * @param db the database or a transaction
 * @param query the parsed list request
 * @param includeEnded false (the default of the route) leaves out the assignments that ended
 * @returns the page of assignments and the exact total
 */
export async function listAssignmentRows(
  db: DbExecutor,
  query: ParsedListQuery<AssignmentListField, unknown>,
  includeEnded: boolean,
): Promise<{ rows: AssignmentRow[]; total: number }> {
  const where = listWhere(query, COLUMNS, includeEnded ? undefined : sql`${commissionAssignments.endsAt} is null`);
  const [rows, [count]] = await Promise.all([
    selectRows(db)
      .where(where)
      .orderBy(...listOrderBy(query.sort, COLUMNS, commissionAssignments.id))
      .limit(query.range.limit)
      .offset(query.range.start),
    db
      .select({ total: sql<number>`count(*)::int` })
      .from(commissionAssignments)
      .where(where),
  ]);
  return { rows, total: count?.total ?? 0 };
}

/**
 * Finds an assignment with its plan.
 *
 * @param db the database or a transaction
 * @param id the assignment id
 * @returns the row, or `undefined`
 */
export async function findAssignmentRow(db: DbExecutor, id: number): Promise<AssignmentRow | undefined> {
  const [row] = await selectRows(db).where(eq(commissionAssignments.id, id)).limit(1);
  return row;
}

/**
 * Finds an assignment and locks it for the rest of the transaction.
 *
 * Why: changing a plan and ending an assignment of the same row must not interleave.
 *
 * @param db the transaction
 * @param id the assignment id
 * @returns the locked row, or `undefined`
 */
export async function lockAssignment(db: DbExecutor, id: number): Promise<CommissionAssignment | undefined> {
  const [row] = await db
    .select()
    .from(commissionAssignments)
    .where(eq(commissionAssignments.id, id))
    .limit(1)
    .for('update');
  return row;
}

/**
 * Finds the current assignment of a merchant with its plan.
 *
 * @param db the database or a transaction
 * @param beneficiaryId the merchant
 * @returns the current assignment (`ends_at` null), or `undefined`
 */
export async function currentAssignmentOf(db: DbExecutor, beneficiaryId: number): Promise<AssignmentRow | undefined> {
  const [row] = await selectRows(db)
    .where(and(eq(commissionAssignments.beneficiaryId, beneficiaryId), isNull(commissionAssignments.endsAt)))
    .limit(1);
  return row;
}

/**
 * Inserts an assignment.
 *
 * @param db the transaction
 * @param row the new assignment
 * @returns the stored row
 * @throws the database's unique violation `commission_assignments_current_uq` when the merchant already has a current plan
 */
export async function insertAssignment(db: DbExecutor, row: NewCommissionAssignment): Promise<CommissionAssignment> {
  const [created] = await db.insert(commissionAssignments).values(row).returning();
  return created!;
}

/**
 * Ends an assignment.
 *
 * @param db the transaction
 * @param id the assignment id
 * @param endsAt the end time, from the injected clock
 */
export async function endAssignmentRow(db: DbExecutor, id: number, endsAt: Date): Promise<void> {
  await db.update(commissionAssignments).set({ endsAt }).where(eq(commissionAssignments.id, id));
}

/**
 * Gives the current assignments of a plan the scope that matches its (changed) kind.
 *
 * @param db the transaction
 * @param planId the plan
 * @param scope `referrals` or `own`
 */
export async function setScopeOfPlan(db: DbExecutor, planId: number, scope: string): Promise<void> {
  await db
    .update(commissionAssignments)
    .set({ scope })
    .where(and(eq(commissionAssignments.planId, planId), isNull(commissionAssignments.endsAt)));
}

/**
 * Reads the current plans of some merchants, for the accrual rule.
 *
 * @param db the transaction of the completion
 * @param beneficiaryIds the order's merchant and the merchant that referred it
 * @returns one entry per merchant that has a current assignment
 */
export async function currentPlansOf(db: DbExecutor, beneficiaryIds: readonly number[]): Promise<CurrentPlan[]> {
  if (beneficiaryIds.length === 0) return [];
  const rows = await db
    .select({
      beneficiaryId: commissionAssignments.beneficiaryId,
      planId: commissionPlans.id,
      kind: commissionPlans.kind,
      percent: commissionPlans.percent,
      isActive: commissionPlans.isActive,
    })
    .from(commissionAssignments)
    .innerJoin(commissionPlans, eq(commissionPlans.id, commissionAssignments.planId))
    .where(
      and(inArray(commissionAssignments.beneficiaryId, [...beneficiaryIds]), isNull(commissionAssignments.endsAt)),
    );
  return rows;
}

/** An agent's money figures on the accruals. */
export interface AgentAccrualTotals {
  /** The sum of the accruals waiting for approval. */
  readonly ready: string;
  /** The sum of the approved accruals that were not paid back. */
  readonly approved: string;
}

/**
 * Adds up the accruals of some agents: what waits for approval and what was approved.
 *
 * Why: M155 and the demo's agents table: "Ready to approve" and "Approved, all time".
 *
 * @param db the database or a transaction
 * @param agentIds the agents
 * @returns the totals by agent id; an agent with no accrual has no entry
 */
export async function accrualTotalsOf(
  db: DbExecutor,
  agentIds: readonly number[],
): Promise<Map<number, AgentAccrualTotals>> {
  if (agentIds.length === 0) return new Map();
  const rows = await db
    .select({
      agentId: commissionAccruals.beneficiaryId,
      ready: sql<string>`coalesce(sum(${commissionAccruals.amount}) filter (where ${commissionAccruals.status} = 'accrued'), 0)::numeric(18,4)::text`,
      approved: sql<string>`coalesce(sum(${commissionAccruals.amount}) filter (where ${commissionAccruals.status} = 'approved' and ${commissionAccruals.reversedAt} is null), 0)::numeric(18,4)::text`,
    })
    .from(commissionAccruals)
    .where(inArray(commissionAccruals.beneficiaryId, [...agentIds]))
    .groupBy(commissionAccruals.beneficiaryId);
  return new Map(rows.map((row) => [row.agentId, { ready: row.ready, approved: row.approved }]));
}
