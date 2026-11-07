// PricingRuleAdminService: the use cases of the pricing rule routes (map domain B, stage 4): list, show, create, change and
// delete margin, discount and promo rules. The resolver (application/price-resolver.ts) is what reads them.
import { Injectable } from '@nestjs/common';
import { Decimal } from 'decimal.js';
import type { ParsedListQuery } from '../../../common/contract';
import { AppError, type FieldError } from '../../../common/errors';
import { type DbExecutor, DbService } from '../../../infra/db';
import { AuditService } from '../../platform';
import type { PricingRounding, PricingRule, PricingRuleKind, PricingScope } from '../db/schema';
import { type RuleDraft, type RuleProblem, ruleNumberProblems } from '../domain/pricing-rule-input';
import { lockCategoryRow } from '../infra/category.repository';
import {
  type PricingRuleRow,
  deletePricingRuleRow,
  findPricingRuleRow,
  insertPricingRule,
  listPricingRuleRows,
  lockPricingRule,
  updatePricingRuleRow,
} from '../infra/pricing-rule.repository';
import { lockGroupsShared, lockLiveService } from '../infra/service.repository';
import { CatalogPriceVersion } from './catalog-price-version';

/** A rule as the console reads it. */
export interface PricingRuleView {
  readonly id: number;
  readonly scope: PricingScope;
  readonly targetId: number | null;
  readonly target: { id: number; name: string } | null;
  readonly groupId: number | null;
  readonly group: { id: number; name: string } | null;
  readonly kind: PricingRuleKind;
  readonly percent: string;
  readonly fixed: string;
  readonly rounding: PricingRounding;
  readonly minProfit: string;
  readonly priority: number;
  readonly isActive: boolean;
  readonly startsAt: string | null;
  readonly endsAt: string | null;
}

/** The fields of `POST /admin/pricing-rules`. */
export interface CreatePricingRuleInput {
  readonly scope: PricingScope;
  readonly targetId: number | null;
  readonly groupId: number | null;
  readonly kind: PricingRuleKind;
  readonly percent: string;
  readonly fixed: string;
  readonly rounding: PricingRounding;
  readonly minProfit: string;
  readonly priority: number;
  readonly startsAt: string | null;
  readonly endsAt: string | null;
}

/** The fields `PATCH /admin/pricing-rules/:id` may change. */
export type UpdatePricingRuleInput = { [K in keyof CreatePricingRuleInput]?: CreatePricingRuleInput[K] | undefined } & {
  readonly isActive?: boolean | undefined;
};

const notFound = () => new AppError('NOT_FOUND', { detail: 'No pricing rule has this id.' });

const percentText = (percent: string): string => new Decimal(percent).toFixed(4);

const toView = ({ rule, targetName, groupName }: PricingRuleRow): PricingRuleView => ({
  id: rule.id,
  scope: rule.scope,
  targetId: rule.targetId,
  target: rule.targetId !== null && targetName !== null ? { id: rule.targetId, name: targetName } : null,
  groupId: rule.groupId,
  group: rule.groupId !== null && groupName !== null ? { id: rule.groupId, name: groupName } : null,
  kind: rule.kind,
  percent: rule.percent,
  fixed: rule.fixed,
  rounding: rule.rounding,
  minProfit: rule.minProfit,
  priority: rule.priority,
  isActive: rule.isActive,
  startsAt: rule.startsAt?.toISOString() ?? null,
  endsAt: rule.endsAt?.toISOString() ?? null,
});

const snapshot = (rule: PricingRule) => ({
  scope: rule.scope,
  targetId: rule.targetId,
  groupId: rule.groupId,
  kind: rule.kind,
  percent: rule.percent,
  fixed: rule.fixed,
  rounding: rule.rounding,
  minProfit: rule.minProfit,
  priority: rule.priority,
  isActive: rule.isActive,
  startsAt: rule.startsAt?.toISOString() ?? null,
  endsAt: rule.endsAt?.toISOString() ?? null,
});

/**
 * Manages pricing rules.
 *
 * Why: staff add margins, discounts and promos for a service, a category or everything, optionally for one merchant group and
 * inside a window (user rule 8, RESOLUTIONS catalog-4). The resolver applies at most one rule per price and takes the minimum profit
 * from the first rule that sets one, so a rule must be well formed before it is saved: a target that exists, a group that exists,
 * amounts that are never negative with at least one above zero, and a window that runs forwards. Rules change the price of new
 * orders only; orders keep their snapshot.
 *
 * Side effects: writes `pricing_rules` and `audit_logs` (entity `pricing_rule`); moves the catalog price version after the commit.
 *
 * @see docs/contract/endpoints/catalog.md (the `/admin/pricing-rules` sections)
 */
@Injectable()
export class PricingRuleAdminService {
  constructor(
    private readonly db: DbService,
    private readonly audit: AuditService,
    private readonly priceVersion: CatalogPriceVersion,
  ) {}

  /**
   * Lists rules with the names of their targets and groups.
   *
   * @param query the parsed list request
   * @returns the page of rules and the exact total
   */
  async list(
    query: ParsedListQuery<'priority' | 'id' | 'scope' | 'kind'>,
  ): Promise<{ rows: PricingRuleView[]; total: number }> {
    const { rows, total } = await listPricingRuleRows(this.db.db, query);
    return { rows: rows.map(toView), total };
  }

  /**
   * Shows one rule.
   *
   * @param id the rule id
   * @returns the rule
   * @throws {AppError} `NOT_FOUND` (404)
   */
  async show(id: number): Promise<PricingRuleView> {
    const row = await findPricingRuleRow(this.db.db, id);
    if (!row) throw notFound();
    return toView(row);
  }

  /**
   * Creates a rule.
   *
   * @param input the whole rule
   * @returns the new rule
   * @throws {AppError} `VALIDATION_FAILED` (422 on `targetId`, `groupId`, `percent`, `endsAt`)
   */
  async create(input: CreatePricingRuleInput): Promise<PricingRuleView> {
    return this.db.runInTransaction(async (work) => {
      const { tx } = work;
      const draft = this.draftOf(input);
      const label = await this.validate(tx, draft, { target: true, group: true });
      const created = await insertPricingRule(tx, {
        ...draft,
        percent: percentText(draft.percent),
        rounding: input.rounding,
        isActive: true,
      });
      this.priceVersion.bumpAfterCommit(work);
      await this.audit.record(tx, {
        action: 'added pricing rule for',
        entityType: 'pricing_rule',
        entityId: created.id,
        entityLabel: label,
        before: null,
        after: snapshot(created),
      });
      return this.viewOf(tx, created.id);
    });
  }

  /**
   * Changes a rule (or turns it off and on with `isActive`).
   *
   * @param id the rule id
   * @param changes the keys to change
   * @returns the updated rule
   * @throws {AppError} `NOT_FOUND` (404); `VALIDATION_FAILED` (422, as on create, judged on the merged rule)
   */
  async update(id: number, changes: UpdatePricingRuleInput): Promise<PricingRuleView> {
    return this.db.runInTransaction(async (work) => {
      const { tx } = work;
      const before = await lockPricingRule(tx, id);
      if (!before) throw notFound();
      const merged = this.draftOf({
        scope: changes.scope ?? before.scope,
        // The old target id belongs to the old scope's table: moving to another scope needs a target of its own.
        targetId:
          changes.targetId !== undefined
            ? changes.targetId
            : changes.scope !== undefined && changes.scope !== before.scope
              ? null
              : before.targetId,
        groupId: changes.groupId === undefined ? before.groupId : changes.groupId,
        kind: changes.kind ?? before.kind,
        percent: changes.percent ?? before.percent,
        fixed: changes.fixed ?? before.fixed,
        rounding: changes.rounding ?? before.rounding,
        minProfit: changes.minProfit ?? before.minProfit,
        priority: changes.priority ?? before.priority,
        startsAt: changes.startsAt === undefined ? (before.startsAt?.toISOString() ?? null) : changes.startsAt,
        endsAt: changes.endsAt === undefined ? (before.endsAt?.toISOString() ?? null) : changes.endsAt,
      });
      const isActive = changes.isActive ?? before.isActive;
      // A rule being turned off is never refused for its target (an archived service switches its rules off); one that stays
      // on or comes on needs a target that exists.
      const retarget = changes.scope !== undefined || changes.targetId !== undefined || (isActive && !before.isActive);
      const label = await this.validate(tx, merged, { target: retarget, group: changes.groupId !== undefined });
      const after = await updatePricingRuleRow(tx, id, {
        ...merged,
        percent: percentText(merged.percent),
        rounding: changes.rounding ?? before.rounding,
        isActive,
      });
      this.priceVersion.bumpAfterCommit(work);
      await this.audit.record(tx, {
        action: 'edited pricing rule for',
        entityType: 'pricing_rule',
        entityId: id,
        entityLabel: label,
        before: snapshot(before),
        after: snapshot(after!),
      });
      return this.viewOf(tx, id);
    });
  }

  /**
   * Deletes a rule.
   *
   * @param id the rule id
   * @throws {AppError} `NOT_FOUND` (404)
   */
  async remove(id: number): Promise<void> {
    await this.db.runInTransaction(async (work) => {
      const { tx } = work;
      const rule = await lockPricingRule(tx, id);
      if (!rule) throw notFound();
      const row = (await findPricingRuleRow(tx, id))!;
      await deletePricingRuleRow(tx, id);
      this.priceVersion.bumpAfterCommit(work);
      await this.audit.record(tx, {
        action: 'removed pricing rule for',
        entityType: 'pricing_rule',
        entityId: id,
        entityLabel: this.labelOf(rule.scope, row.targetName),
        before: snapshot(rule),
        after: null,
      });
    });
  }

  /** The numbers and dates of a rule as the domain check reads them (a global rule has no target). */
  private draftOf(input: CreatePricingRuleInput): RuleDraft & { readonly rounding: PricingRounding } {
    return {
      scope: input.scope,
      targetId: input.scope === 'global' ? null : input.targetId,
      groupId: input.groupId,
      kind: input.kind,
      percent: input.percent,
      fixed: input.fixed,
      minProfit: input.minProfit,
      priority: input.priority,
      rounding: input.rounding,
      startsAt: input.startsAt === null ? null : new Date(input.startsAt),
      endsAt: input.endsAt === null ? null : new Date(input.endsAt),
    };
  }

  /**
   * Judges a rule: the numbers and dates, then (under share locks, so a concurrent delete cannot slip in) that its target and
   * group exist. Returns the audit label of the rule.
   */
  private async validate(
    tx: DbExecutor,
    draft: RuleDraft,
    check: { readonly target: boolean; readonly group: boolean },
  ): Promise<string> {
    const problems: RuleProblem[] = ruleNumberProblems(draft);
    let targetName: string | null = null;
    if (draft.scope === 'category') {
      if (draft.targetId === null) {
        problems.push({ field: 'targetId', message: 'Choose the category.' });
      } else {
        const category = await lockCategoryRow(tx, draft.targetId, 'share');
        targetName = category?.name ?? null;
        if (!category && check.target) problems.push({ field: 'targetId', message: 'Choose the category.' });
      }
    } else if (draft.scope === 'service') {
      if (draft.targetId === null) {
        problems.push({ field: 'targetId', message: 'Choose the service.' });
      } else {
        const service = await lockLiveService(tx, draft.targetId, 'share');
        targetName = service?.name ?? null;
        if (!service && check.target) problems.push({ field: 'targetId', message: 'Choose the service.' });
      }
    }
    if (check.group && draft.groupId !== null) {
      const groups = await lockGroupsShared(tx, [draft.groupId]);
      if (!groups.has(draft.groupId)) problems.push({ field: 'groupId', message: 'Choose a merchant group.' });
    }
    if (problems.length > 0) {
      const errors: FieldError[] = problems.map((problem) => ({
        field: problem.field,
        code: 'invalid',
        message: problem.message,
      }));
      throw new AppError('VALIDATION_FAILED', { errors });
    }
    return this.labelOf(draft.scope, targetName);
  }

  /** The audit label: the target's name, or `all services` for a global rule. */
  private labelOf(scope: PricingScope, targetName: string | null): string {
    return scope === 'global' ? 'all services' : (targetName ?? `${scope} (deleted)`);
  }

  private async viewOf(db: DbExecutor, id: number): Promise<PricingRuleView> {
    return toView((await findPricingRuleRow(db, id))!);
  }
}
