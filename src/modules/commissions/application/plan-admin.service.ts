// PlanAdminService: the use cases of `/admin/commission-plans` (stage 11): list, show, create, change and delete a plan. Rules: the rate
// is 0.5 to 15 percent, kind and the free-text labels are required, tiers is a JSON object, and a plan in use is never deleted
// (RULES commissions 5 to 7, resolutions health-commissions-1 and -2).
import { Injectable } from '@nestjs/common';
import type { JsonObject, ParsedListQuery } from '../../../common/contract';
import { AppError } from '../../../common/errors';
import { type DbExecutor, DbService, isForeignKeyViolation } from '../../../infra/db';
import { AuditService } from '../../platform';
import type { CommissionPlan, CommissionPlanKind } from '../db/schema';
import { normalisePercent, scopeOf } from '../domain/plan-input';
import { setScopeOfPlan } from '../infra/assignment.repository';
import {
  type PlanListField,
  deletePlanRow,
  findPlan,
  insertPlan,
  listPlanRows,
  lockPlan,
  planUsage,
  updatePlanRow,
} from '../infra/plan.repository';

/** A plan as the console reads it (`CommissionPlan`). */
export interface PlanView {
  readonly id: number;
  readonly name: string;
  readonly kind: CommissionPlanKind;
  readonly basis: string;
  readonly percent: string;
  readonly tiers: JsonObject;
  readonly period: string;
  readonly isActive: boolean;
  readonly createdAt: string;
  readonly updatedAt: string;
}

/** The fields of `POST /admin/commission-plans`. */
export interface CreatePlanInput {
  readonly name: string;
  readonly kind: CommissionPlanKind;
  readonly percent: string;
  readonly basis: string;
  readonly period: string;
  readonly tiers?: JsonObject | undefined;
  readonly isActive?: boolean | undefined;
}

/** The fields `PATCH /admin/commission-plans/:id` may change. */
export type UpdatePlanInput = Partial<CreatePlanInput>;

const notFound = () => new AppError('NOT_FOUND', { detail: 'No commission plan has this id.' });

/**
 * Turns a stored plan into the wire view.
 *
 * @param plan the stored plan
 * @returns the view with ISO times
 */
export function toPlanView(plan: CommissionPlan): PlanView {
  return {
    id: plan.id,
    name: plan.name,
    kind: plan.kind,
    basis: plan.basis,
    percent: plan.percent,
    // The column is a jsonb object that this service wrote from a validated JSON object.
    tiers: plan.tiers as JsonObject,
    period: plan.period,
    isActive: plan.isActive,
    createdAt: plan.createdAt.toISOString(),
    updatedAt: plan.updatedAt.toISOString(),
  };
}

/** What the audit trail keeps of a plan. */
const snapshot = (plan: CommissionPlan) => ({
  name: plan.name,
  kind: plan.kind,
  basis: plan.basis,
  percent: plan.percent,
  tiers: plan.tiers,
  period: plan.period,
  isActive: plan.isActive,
});

/**
 * Manages commission plans.
 *
 * Why: RULES commissions 5 to 7 and resolution health-commissions-1: a rate is 0.5 to 15 percent and is stored with 4 decimals;
 * `basis` and `period` are required labels (the accrual basis is always revenue); `tiers` is a JSON object stored as sent. A rate
 * change applies to orders completed after the save and never touches an accrual (the accrual keeps its own percent). A plan with a
 * current assignment is never deleted (`409 PLAN_IN_USE`, "N merchants are on this plan"), nor one that has ended assignments or
 * accruals (the history keeps it: switch it off). A change of kind gives the plan's current assignments the matching scope.
 *
 * Side effects: writes `commission_plans` (and `commission_assignments.scope` when the kind changes) and `audit_logs` (entity `plan`;
 * the console prints `<actor> <action> <entityLabel>`). `changed rate of` is the demo's phrase and its label is `<name> plan`, as in
 * the demo; the demo has no phrase for the other three, so the code's `created plan`, `edited plan` and `deleted plan` take the bare
 * plan name as the label ("created plan Gold").
 */
@Injectable()
export class PlanAdminService {
  constructor(
    private readonly db: DbService,
    private readonly audit: AuditService,
  ) {}

  /**
   * Lists plans.
   *
   * @param query the parsed list request
   * @returns the page of plans and the exact total
   */
  async list(query: ParsedListQuery<PlanListField>): Promise<{ rows: PlanView[]; total: number }> {
    const { rows, total } = await listPlanRows(this.db.db, query);
    return { rows: rows.map(toPlanView), total };
  }

  /**
   * Shows one plan.
   *
   * @param id the plan id
   * @returns the plan
   * @throws {AppError} `NOT_FOUND`
   */
  async get(id: number): Promise<PlanView> {
    const plan = await findPlan(this.db.db, id);
    if (!plan) throw notFound();
    return toPlanView(plan);
  }

  /**
   * Adds a plan.
   *
   * @param input the console's fields (the contract already checked the rate and the shapes)
   * @returns the new plan, the rate with 4 decimals
   */
  async create(input: CreatePlanInput): Promise<PlanView> {
    return this.db.runInTransaction(async ({ tx }) => {
      const plan = await insertPlan(tx, {
        name: input.name,
        kind: input.kind,
        basis: input.basis,
        percent: normalisePercent(input.percent),
        period: input.period,
        tiers: input.tiers ?? {},
        isActive: input.isActive ?? true,
      });
      await this.audit.record(tx, {
        action: 'created plan',
        entityType: 'plan',
        entityId: plan.id,
        // The phrase already says "plan": the label is the bare name ("created plan Gold").
        entityLabel: plan.name,
        after: snapshot(plan),
      });
      return toPlanView(plan);
    });
  }

  /**
   * Changes a plan.
   *
   * @param id the plan id
   * @param changes the keys to change
   * @returns the updated plan
   * @throws {AppError} `NOT_FOUND`
   */
  async update(id: number, changes: UpdatePlanInput): Promise<PlanView> {
    return this.db.runInTransaction(async ({ tx }) => {
      const before = await lockPlan(tx, id);
      if (!before) throw notFound();
      const after = await updatePlanRow(tx, id, {
        ...(changes.name === undefined ? {} : { name: changes.name }),
        ...(changes.kind === undefined ? {} : { kind: changes.kind }),
        ...(changes.basis === undefined ? {} : { basis: changes.basis }),
        ...(changes.percent === undefined ? {} : { percent: normalisePercent(changes.percent) }),
        ...(changes.period === undefined ? {} : { period: changes.period }),
        ...(changes.tiers === undefined ? {} : { tiers: changes.tiers }),
        ...(changes.isActive === undefined ? {} : { isActive: changes.isActive }),
      });
      if (!after) throw notFound();
      if (after.kind !== before.kind) await setScopeOfPlan(tx, id, scopeOf(after.kind));
      // The demo's own phrase, `changed rate of <name> plan`, keeps its label; the code's `edited plan` takes the bare name.
      const rateChanged = after.percent !== before.percent;
      await this.audit.record(tx, {
        action: rateChanged ? 'changed rate of' : 'edited plan',
        entityType: 'plan',
        entityId: id,
        entityLabel: rateChanged ? `${after.name} plan` : after.name,
        before: snapshot(before),
        after: snapshot(after),
      });
      return toPlanView(after);
    });
  }

  /**
   * Deletes a plan nothing refers to.
   *
   * @param id the plan id
   * @throws {AppError} `NOT_FOUND`; `PLAN_IN_USE` (409) while an assignment is current, or the plan has assignments or accruals
   *   in its history
   */
  async remove(id: number): Promise<void> {
    try {
      await this.db.runInTransaction(async ({ tx }) => {
        const plan = await lockPlan(tx, id);
        if (!plan) throw notFound();
        await this.assertUnused(tx, plan);
        await deletePlanRow(tx, id);
        await this.audit.record(tx, {
          action: 'deleted plan',
          entityType: 'plan',
          entityId: id,
          entityLabel: plan.name,
          before: snapshot(plan),
        });
      });
    } catch (error) {
      // A new assignment or accrual that raced in after the count: the foreign key says the same as the count would have.
      if (isForeignKeyViolation(error)) {
        throw new AppError('PLAN_IN_USE', {
          detail: 'Merchants or commissions still use this plan. Switch it off instead.',
        });
      }
      throw error;
    }
  }

  /** Refuses the delete with the most useful reason first: current assignments, then history. */
  private async assertUnused(tx: DbExecutor, plan: CommissionPlan): Promise<void> {
    const usage = await planUsage(tx, plan.id);
    if (usage.current > 0) {
      const word = usage.current === 1 ? 'merchant is' : 'merchants are';
      throw new AppError('PLAN_IN_USE', {
        detail: `${usage.current} ${word} on the ${plan.name} plan. End or move those assignments first.`,
      });
    }
    if (usage.assignments > 0 || usage.accruals > 0) {
      throw new AppError('PLAN_IN_USE', {
        detail: `The ${plan.name} plan has assignments or commissions in its history. Switch it off instead of deleting it.`,
      });
    }
  }
}
