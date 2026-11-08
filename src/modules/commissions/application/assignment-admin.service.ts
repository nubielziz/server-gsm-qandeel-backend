// AssignmentAdminService: the use cases of `/admin/commission-assignments` (stage 11): list, show, assign a plan to a merchant, change the
// plan, end the assignment. Rules: one current plan per merchant, changing the plan ends the current assignment and starts a new one,
// ending never refuses (RULES commissions 8 and 9, resolutions health-commissions-2 and -12, ANSWERS commissions Q6, MISMATCHES B42).
import { Inject, Injectable } from '@nestjs/common';
import { CLOCK, type Clock } from '../../../common/clock';
import type { ParsedListQuery } from '../../../common/contract';
import { AppError } from '../../../common/errors';
import { DbService, type DbExecutor, isUniqueViolation } from '../../../infra/db';
import { AuditService } from '../../platform';
import type { CommissionAssignment, CommissionPlan } from '../db/schema';
import { scopeOf } from '../domain/plan-input';
import {
  type AssignmentListField,
  type AssignmentRow,
  accrualTotalsOf,
  currentAssignmentOf,
  endAssignmentRow,
  findAssignmentRow,
  insertAssignment,
  listAssignmentRows,
  lockAssignment,
} from '../infra/assignment.repository';
import { findMerchants, referredCounts, referredRevenueSince } from '../infra/foreign-reads.repository';
import { lockPlan } from '../infra/plan.repository';

const DAY_MS = 86_400_000;
/** The window of the agents table's revenue figure (the demo's "Their revenue, 30 d"). */
const FIGURE_DAYS = 30;

/** An assignment as the console reads it (`CommissionAssignment`), with the per-agent figures of M155 as extra fields. */
export interface AssignmentView {
  readonly id: number;
  readonly planId: number;
  readonly beneficiaryId: number;
  readonly scope: string;
  readonly startsAt: string | null;
  readonly endsAt: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly beneficiary: { readonly id: number; readonly name: string; readonly country: string } | null;
  readonly plan: { readonly id: number; readonly name: string; readonly percent: string };
  /** Merchants the agent referred. */
  readonly referredCount: number;
  /** Revenue of the referred merchants' orders completed in the last 30 days. */
  readonly revenue30d: string;
  /** Commission waiting for approval. */
  readonly readyAmount: string;
  /** Commission approved, all time, and not paid back. */
  readonly approvedAmount: string;
}

const ZERO = '0.0000';

function invalid(field: string, message: string, code = 'invalid'): AppError {
  return new AppError('VALIDATION_FAILED', { errors: [{ field, code, message }] });
}

const notFound = () => new AppError('NOT_FOUND', { detail: 'No commission assignment has this id.' });
const ended = () =>
  new AppError('NOT_FOUND', { detail: 'This assignment has already ended. Assign the merchant a plan again.' });
const alreadyAssigned = (merchant: string, plan: string) =>
  new AppError('ALREADY_ASSIGNED', { detail: `${merchant} is already on the ${plan} plan` });

/** What the audit trail keeps of an assignment. */
const snapshot = (assignment: CommissionAssignment, plan: CommissionPlan) => ({
  plan: plan.name,
  percent: plan.percent,
  scope: assignment.scope,
  startsAt: assignment.startsAt.toISOString(),
  endsAt: assignment.endsAt?.toISOString() ?? null,
});

/**
 * Manages the plans merchants are on.
 *
 * Why: RULES commissions 8 and 9: a merchant has one current plan (unique index on `beneficiary_id` where `ends_at` is null; a race
 * answers `409 ALREADY_ASSIGNED` like the pre-check); the server sets the scope from the plan's kind and `starts_at` from the clock; a
 * plan must exist and be switched on (`422` on `planId`), a merchant must exist (`422` on `beneficiaryId`). Changing the plan ends the
 * current row and inserts the new one in one transaction (the answer is the new row, so its id differs); the same plan again is
 * `ALREADY_ASSIGNED`. Ending sets `ends_at` and never refuses: ready accruals stay approvable. The list shows current assignments
 * unless `includeEnded=true` (B42) and carries the per-agent figures of M155.
 *
 * Side effects: writes `commission_assignments` and `audit_logs` (entity `merchant`, the agent: `assigned plan to`, `changed commission plan of`,
 * `ended plan of`).
 */
@Injectable()
export class AssignmentAdminService {
  constructor(
    private readonly db: DbService,
    private readonly audit: AuditService,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  /**
   * Lists assignments.
   *
   * @param query the parsed list request
   * @param includeEnded true to list ended assignments too
   * @returns the page of assignments with their joins and figures, and the exact total
   */
  async list(
    query: ParsedListQuery<AssignmentListField, unknown>,
    includeEnded: boolean,
  ): Promise<{ rows: AssignmentView[]; total: number }> {
    const { rows, total } = await listAssignmentRows(this.db.db, query, includeEnded);
    return { rows: await this.views(this.db.db, rows), total };
  }

  /**
   * Shows one assignment (an ended one too).
   *
   * @param id the assignment id
   * @returns the assignment
   * @throws {AppError} `NOT_FOUND`
   */
  async get(id: number): Promise<AssignmentView> {
    const row = await findAssignmentRow(this.db.db, id);
    if (!row) throw notFound();
    return (await this.views(this.db.db, [row]))[0]!;
  }

  /**
   * Puts a merchant on a plan.
   *
   * @param input the merchant and the plan
   * @returns the new assignment
   * @throws {AppError} `VALIDATION_FAILED` (`beneficiaryId` unknown, `planId` unknown or switched off); `ALREADY_ASSIGNED` (409)
   */
  async create(input: { beneficiaryId: number; planId: number }): Promise<AssignmentView> {
    try {
      return await this.db.runInTransaction(async ({ tx }) => {
        const merchant = (await findMerchants(tx, [input.beneficiaryId])).get(input.beneficiaryId);
        if (!merchant) throw invalid('beneficiaryId', 'No merchant has this id.', 'unknown');
        const plan = await this.activePlan(tx, input.planId);
        const current = await currentAssignmentOf(tx, merchant.id);
        if (current) throw alreadyAssigned(merchant.name, current.plan.name);
        const now = this.clock.now();
        const assignment = await insertAssignment(tx, {
          planId: plan.id,
          beneficiaryId: merchant.id,
          scope: scopeOf(plan.kind),
          startsAt: now,
          createdAt: now,
        });
        await this.audit.record(tx, {
          action: 'assigned plan to',
          entityType: 'merchant',
          entityId: merchant.id,
          entityLabel: `${merchant.name}, ${plan.name} plan`,
          after: snapshot(assignment, plan),
        });
        return (await this.views(tx, [{ assignment, plan }]))[0]!;
      });
    } catch (error) {
      if (isUniqueViolation(error, 'commission_assignments_current_uq')) {
        // Another request put the merchant on a plan between our check and our insert: say which one, like the pre-check.
        const current = await currentAssignmentOf(this.db.db, input.beneficiaryId);
        const name =
          (await findMerchants(this.db.db, [input.beneficiaryId])).get(input.beneficiaryId)?.name ?? 'This merchant';
        throw alreadyAssigned(name, current?.plan.name ?? 'another');
      }
      throw error;
    }
  }

  /**
   * Moves a merchant to another plan: the current assignment ends and a new one starts, in one transaction.
   *
   * @param id the current assignment
   * @param input the new plan
   * @returns the new assignment (the answer's id is the new row's)
   * @throws {AppError} `NOT_FOUND` (unknown, or already ended); `VALIDATION_FAILED` (`planId` unknown or switched off);
   *   `ALREADY_ASSIGNED` (the merchant is already on that plan)
   */
  async update(id: number, input: { planId: number }): Promise<AssignmentView> {
    return this.db.runInTransaction(async ({ tx }) => {
      const before = await lockAssignment(tx, id);
      if (!before) throw notFound();
      if (before.endsAt !== null) throw ended();
      const plan = await this.activePlan(tx, input.planId);
      const old = (await findAssignmentRow(tx, id))!.plan;
      const merchant = (await findMerchants(tx, [before.beneficiaryId])).get(before.beneficiaryId);
      if (before.planId === plan.id) throw alreadyAssigned(merchant?.name ?? 'This merchant', plan.name);
      const now = this.clock.now();
      await endAssignmentRow(tx, id, now);
      const assignment = await insertAssignment(tx, {
        planId: plan.id,
        beneficiaryId: before.beneficiaryId,
        scope: scopeOf(plan.kind),
        startsAt: now,
        createdAt: now,
      });
      await this.audit.record(tx, {
        // The demo's own phrase: it reads "<actor> changed commission plan of <merchant>"; the plan diff is in before/after.
        action: 'changed commission plan of',
        entityType: 'merchant',
        entityId: before.beneficiaryId,
        entityLabel: merchant?.name ?? `Merchant ${before.beneficiaryId}`,
        before: snapshot(before, old),
        after: snapshot(assignment, plan),
      });
      return (await this.views(tx, [{ assignment, plan }]))[0]!;
    });
  }

  /**
   * Ends an assignment: no commission accrues on orders completed afterwards; accruals already earned stay approvable.
   *
   * @param id the assignment id
   * @throws {AppError} `NOT_FOUND` (unknown, or already ended)
   */
  async end(id: number): Promise<void> {
    await this.db.runInTransaction(async ({ tx }) => {
      const before = await lockAssignment(tx, id);
      if (!before) throw notFound();
      if (before.endsAt !== null) throw ended();
      const plan = (await findAssignmentRow(tx, id))!.plan;
      const merchant = (await findMerchants(tx, [before.beneficiaryId])).get(before.beneficiaryId);
      const now = this.clock.now();
      await endAssignmentRow(tx, id, now);
      await this.audit.record(tx, {
        action: 'ended plan of',
        entityType: 'merchant',
        entityId: before.beneficiaryId,
        entityLabel: `${merchant?.name ?? `Merchant ${before.beneficiaryId}`}, ${plan.name} plan`,
        before: snapshot(before, plan),
        after: snapshot({ ...before, endsAt: now }, plan),
      });
    });
  }

  /** Reads a plan under a lock and refuses one that is unknown or switched off (`422` on `planId`). */
  private async activePlan(tx: DbExecutor, planId: number): Promise<CommissionPlan> {
    const plan = await lockPlan(tx, planId);
    if (!plan) throw invalid('planId', 'No plan has this id.', 'unknown');
    if (!plan.isActive)
      throw invalid('planId', 'This plan is switched off. Switch it on or choose another plan.', 'inactive');
    return plan;
  }

  /** Adds the merchants' names and the per-agent figures to assignment rows with four batched queries (no N+1). */
  private async views(db: DbExecutor, rows: readonly AssignmentRow[]): Promise<AssignmentView[]> {
    if (rows.length === 0) return [];
    const agentIds = [...new Set(rows.map((row) => row.assignment.beneficiaryId))];
    const since = new Date(this.clock.nowMs() - FIGURE_DAYS * DAY_MS);
    // One after the other: `db` may be a transaction, which runs one query at a time.
    const merchants = await findMerchants(db, agentIds);
    const referred = await referredCounts(db, agentIds);
    const revenue = await referredRevenueSince(db, agentIds, since);
    const totals = await accrualTotalsOf(db, agentIds);
    return rows.map(({ assignment, plan }) => {
      const merchant = merchants.get(assignment.beneficiaryId);
      const money = totals.get(assignment.beneficiaryId);
      return {
        id: assignment.id,
        planId: assignment.planId,
        beneficiaryId: assignment.beneficiaryId,
        scope: assignment.scope,
        startsAt: assignment.startsAt.toISOString(),
        endsAt: assignment.endsAt?.toISOString() ?? null,
        createdAt: assignment.createdAt.toISOString(),
        updatedAt: assignment.updatedAt.toISOString(),
        beneficiary: merchant ? { id: merchant.id, name: merchant.name, country: merchant.country } : null,
        plan: { id: plan.id, name: plan.name, percent: plan.percent },
        referredCount: referred.get(assignment.beneficiaryId) ?? 0,
        revenue30d: revenue.get(assignment.beneficiaryId) ?? ZERO,
        readyAmount: money?.ready ?? ZERO,
        approvedAmount: money?.approved ?? ZERO,
      };
    });
  }
}
