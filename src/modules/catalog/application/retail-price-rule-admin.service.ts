// RetailPriceRuleAdminService: the use cases of the retail price rule routes (feature 31, decision 040, spec B229): list,
// create, change, soft delete, and the preview of what the follow pass would do once a change is saved.
import { Inject, Injectable } from '@nestjs/common';
import { Decimal } from 'decimal.js';
import { CLOCK, type Clock } from '../../../common/clock';
import type { ParsedListQuery } from '../../../common/contract';
import { AppError, type FieldError } from '../../../common/errors';
import { Money } from '../../../common/money';
import { type DbExecutor, DbService, isUniqueViolation } from '../../../infra/db';
import { AuditService } from '../../platform';
import type { RetailPriceRule, RetailRounding, RetailRuleScope, ServiceType } from '../db/schema';
import {
  DEFAULT_AUTO_FOLLOW_PERCENT,
  DEFAULT_ROUND_FROM,
  RULE_PREVIEW_LIMIT,
  RULE_PREVIEW_LINES,
  type RetailRuleTargetProblem,
  retailRuleTargetProblems,
  ruleLabel,
} from '../domain/retail-rule';
import { lockCategoryRow } from '../infra/category.repository';
import {
  type RetailRuleSort,
  findRetailRuleForTarget,
  findRetailRuleRow,
  followersInReach,
  insertRetailRule,
  listRetailRuleRows,
  lockRetailRule,
  serviceNamesOf,
  updateRetailRuleRow,
} from '../infra/retail-price-rule.repository';
import { CatalogPriceVersion } from './catalog-price-version';
import { RetailPricing, priceWithRules } from './retail-pricing';
import { type RetailRule, retailRuleOf } from './retail-rules';

/** The three unique indexes of one rule per target. */
const TARGET_INDEXES = ['retail_price_rules_global_uq', 'retail_price_rules_type_uq', 'retail_price_rules_category_uq'];

/** A rule as the console reads it. */
export interface RetailRuleView {
  readonly id: number;
  readonly scope: RetailRuleScope;
  readonly serviceType: ServiceType | null;
  readonly categoryId: number | null;
  readonly categoryName: string | null;
  readonly percent: string;
  readonly fixed: string;
  readonly rounding: RetailRounding;
  readonly roundFrom: string;
  readonly autoFollowPercent: number;
  readonly isActive: boolean;
  readonly label: string;
  readonly following: number;
  readonly updatedAt: string;
}

/** The fields of `POST /admin/retail-price-rules`. */
export interface CreateRetailRuleInput {
  readonly scope: RetailRuleScope;
  readonly serviceType?: ServiceType | null | undefined;
  readonly categoryId?: number | null | undefined;
  readonly percent: string;
  readonly fixed?: string | undefined;
  readonly rounding: RetailRounding;
  readonly roundFrom?: string | undefined;
  readonly autoFollowPercent?: number | undefined;
  readonly isActive?: boolean | undefined;
}

/** The fields `PATCH /admin/retail-price-rules/:id` may change (never the scope or the target). */
export interface UpdateRetailRuleInput {
  readonly percent?: string | undefined;
  readonly fixed?: string | undefined;
  readonly rounding?: RetailRounding | undefined;
  readonly roundFrom?: string | undefined;
  readonly autoFollowPercent?: number | undefined;
  readonly isActive?: boolean | undefined;
}

/** The change a preview works out. */
export type RetailRuleChange =
  | { readonly kind: 'create'; readonly rule: CreateRetailRuleInput }
  | { readonly kind: 'update'; readonly id: number; readonly rule: UpdateRetailRuleInput }
  | { readonly kind: 'delete'; readonly id: number };

/** One service of a preview. */
export interface RetailRulePreviewLine {
  readonly serviceId: number;
  readonly name: string;
  readonly code: string;
  readonly cost: string;
  readonly floorPrice: string;
  readonly currentPrice: string;
  readonly newPrice: string | null;
  readonly atFloor: boolean;
}

/** What a preview answers. */
export interface RetailRulePreview {
  readonly following: number;
  readonly changes: number;
  readonly raised: number;
  readonly lowered: number;
  readonly atFloor: number;
  readonly noRule: number;
  readonly lines: RetailRulePreviewLine[];
  readonly truncated: boolean;
}

/** The figures of a rule a create or an update leaves (the target and scope come from the rule or the create). */
interface RuleFigures {
  readonly percent: string;
  readonly fixed: Money;
  readonly rounding: RetailRounding;
  readonly roundFrom: Money;
  readonly autoFollowPercent: number;
  readonly isActive: boolean;
}

const notFound = () => new AppError('NOT_FOUND', { detail: 'No retail price rule has this id.' });

const duplicate = (prefix: string) =>
  new AppError('VALIDATION_FAILED', {
    errors: [
      { field: `${prefix}scope`, code: 'duplicate', message: 'A rule for this already exists. Edit it instead.' },
    ],
  });

const percentText = (percent: string): string => new Decimal(percent).toFixed(4);

const toView = (rule: RetailRule): RetailRuleView => ({
  id: rule.id,
  scope: rule.scope,
  serviceType: rule.serviceType,
  categoryId: rule.categoryId,
  categoryName: rule.categoryName,
  percent: rule.percent,
  fixed: rule.fixed.toWire(),
  rounding: rule.rounding,
  roundFrom: rule.roundFrom.toWire(),
  autoFollowPercent: rule.autoFollowPercent,
  isActive: rule.isActive,
  label: rule.label,
  following: rule.following,
  updatedAt: rule.updatedAt.toISOString(),
});

/** What the audit log keeps of a rule. */
const snapshot = (rule: RetailPriceRule) => ({
  scope: rule.scope,
  serviceType: rule.serviceType,
  categoryId: rule.categoryId,
  percent: rule.percent,
  fixed: rule.fixed,
  rounding: rule.rounding,
  roundFrom: rule.roundFrom,
  autoFollowPercent: rule.autoFollowPercent,
  isActive: rule.isActive,
});

/** The figures of a create, with the defaults of plan 31 section 3.3. */
const createFigures = (input: CreateRetailRuleInput): RuleFigures => ({
  percent: percentText(input.percent),
  fixed: Money.of(input.fixed ?? '0'),
  rounding: input.rounding,
  roundFrom: Money.of(input.roundFrom ?? DEFAULT_ROUND_FROM),
  autoFollowPercent: input.autoFollowPercent ?? DEFAULT_AUTO_FOLLOW_PERCENT,
  isActive: input.isActive ?? true,
});

/** The figures of a rule after an update. */
const mergedFigures = (rule: RetailRule, changes: UpdateRetailRuleInput): RuleFigures => ({
  percent: changes.percent === undefined ? rule.percent : percentText(changes.percent),
  fixed: changes.fixed === undefined ? rule.fixed : Money.of(changes.fixed),
  rounding: changes.rounding ?? rule.rounding,
  roundFrom: changes.roundFrom === undefined ? rule.roundFrom : Money.of(changes.roundFrom),
  autoFollowPercent: changes.autoFollowPercent ?? rule.autoFollowPercent,
  isActive: changes.isActive ?? rule.isActive,
});

/** A rule as the preview pictures it: an existing rule with new figures, or a rule not saved yet. */
function pictured(
  base: Pick<RetailRule, 'id' | 'scope' | 'serviceType' | 'categoryId' | 'categoryName'>,
  figures: RuleFigures,
  at: Date,
): RetailRule {
  return {
    ...base,
    ...figures,
    deletedAt: null,
    changedAt: at,
    updatedAt: at,
    label: ruleLabel({ ...base, ...figures }),
    following: 0,
  };
}

/**
 * Manages the retail price rules.
 *
 * Why: decision 040: staff price the shop by rules that follow the supplier's cost: a general rule, one per service type, one
 * per category. One rule per target among the rules that are not deleted (checked before the write, the partial unique indexes
 * are the backstop of a race). A delete is soft so the history keeps the rule's name and no transaction pricing by the rule
 * waits on the delete. Every write moves the catalog price version, which starts the follow pass.
 *
 * Side effects: writes `retail_price_rules` and `audit_logs` (entity `retail_price_rule`); moves the catalog price version after
 * the commit. The preview writes nothing.
 *
 * @see docs/decisions/040-retail-price-rules.md
 * @see docs/contract/endpoints/catalog.md (the `/admin/retail-price-rules` sections)
 */
@Injectable()
export class RetailPriceRuleAdminService {
  constructor(
    private readonly db: DbService,
    private readonly audit: AuditService,
    private readonly priceVersion: CatalogPriceVersion,
    private readonly pricing: RetailPricing,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  /**
   * Lists the rules that are not deleted.
   *
   * @param query the parsed list request
   * @returns the page of rules and the exact total
   */
  async list(query: ParsedListQuery<RetailRuleSort>): Promise<{ rows: RetailRuleView[]; total: number }> {
    const { rows, total } = await listRetailRuleRows(this.db.db, query);
    return { rows: rows.map((row) => toView(retailRuleOf(row))), total };
  }

  /**
   * Creates a rule.
   *
   * @param staffId the staff member who saves it
   * @param input the rule
   * @returns the new rule
   * @throws {AppError} `VALIDATION_FAILED` (422 on `serviceType` / `categoryId` with the code `invalid` for a target that does not
   *   fit the scope or an unknown category; on `scope` with the code `duplicate` for a second rule of the same target)
   */
  async create(staffId: number, input: CreateRetailRuleInput): Promise<RetailRuleView> {
    return this.db.runInTransaction(async (work) => {
      const { tx } = work;
      const { target } = await this.checkedTarget(tx, input, '');
      const figures = createFigures(input);
      let created: RetailPriceRule;
      try {
        created = await insertRetailRule(tx, {
          ...target,
          ...figures,
          fixed: figures.fixed.toWire(),
          roundFrom: figures.roundFrom.toWire(),
          updatedBy: staffId,
          changedAt: this.clock.now(),
        });
      } catch (error) {
        // Two creates for one target that race past the check meet here.
        if (TARGET_INDEXES.some((name) => isUniqueViolation(error, name))) throw duplicate('');
        throw error;
      }
      const view = (await findRetailRuleRow(tx, created.id))!;
      this.priceVersion.bumpAfterCommit(work);
      await this.audit.record(tx, {
        action: 'created retail price rule',
        entityType: 'retail_price_rule',
        entityId: created.id,
        entityLabel: retailRuleOf(view).label,
        before: null,
        after: snapshot(created),
      });
      return toView(retailRuleOf(view));
    });
  }

  /**
   * Changes the figures of a rule, or switches it off and on.
   *
   * @param staffId the staff member who saves it
   * @param id the rule id
   * @param changes the figures to change
   * @returns the updated rule
   * @throws {AppError} `NOT_FOUND` (404: unknown or deleted)
   */
  async update(staffId: number, id: number, changes: UpdateRetailRuleInput): Promise<RetailRuleView> {
    return this.db.runInTransaction(async (work) => {
      const { tx } = work;
      const before = await lockRetailRule(tx, id);
      if (!before) throw notFound();
      const current = retailRuleOf((await findRetailRuleRow(tx, id))!);
      const figures = mergedFigures(current, changes);
      const after = await updateRetailRuleRow(tx, id, {
        ...figures,
        fixed: figures.fixed.toWire(),
        roundFrom: figures.roundFrom.toWire(),
        updatedBy: staffId,
        changedAt: this.clock.now(),
      });
      const view = retailRuleOf((await findRetailRuleRow(tx, id))!);
      this.priceVersion.bumpAfterCommit(work);
      await this.audit.record(tx, {
        action: 'changed retail price rule',
        entityType: 'retail_price_rule',
        entityId: id,
        entityLabel: view.label,
        before: snapshot(before),
        after: snapshot(after),
      });
      return toView(view);
    });
  }

  /**
   * Deletes a rule softly: it is switched off and marked deleted, and its row stays for the history.
   *
   * Why: plan 31 section 4.1: a hard delete would wait on, or deadlock with, the follow pass and the publisher (their foreign key
   * checks read the rule row while they hold a service row); an update of `deleted_at` takes no lock those checks wait for. The
   * follow rows keep their `rule_id`; the next pass moves them to the next rule by precedence.
   *
   * @param staffId the staff member who deletes it
   * @param id the rule id
   * @throws {AppError} `NOT_FOUND` (404: unknown or already deleted)
   */
  async remove(staffId: number, id: number): Promise<void> {
    await this.db.runInTransaction(async (work) => {
      const { tx } = work;
      const before = await lockRetailRule(tx, id);
      if (!before) throw notFound();
      const label = retailRuleOf((await findRetailRuleRow(tx, id))!).label;
      const now = this.clock.now();
      await updateRetailRuleRow(tx, id, { isActive: false, deletedAt: now, changedAt: now, updatedBy: staffId });
      this.priceVersion.bumpAfterCommit(work);
      await this.audit.record(tx, {
        action: 'deleted retail price rule',
        entityType: 'retail_price_rule',
        entityId: id,
        entityLabel: label,
        before: snapshot(before),
        // The rule's fields as the row now stands (plan section 6.6): the same figures, switched off and marked deleted.
        after: { ...snapshot(before), isActive: false, deletedAt: now.toISOString() },
      });
    });
  }

  /**
   * Works out what the follow pass would do to following prices once a change is saved; stores nothing.
   *
   * Why: plan 31 section 5.3: staff see how many following prices move, up or down, and the largest moves before they save. Only
   * services with a follow row that the change's target reaches are worked out (a typed price is never touched), at most
   * {@link RULE_PREVIEW_LIMIT} by id; the new price is the rule price of the cost and floor of now, by the same function as the pass.
   *
   * @param change the create, update or delete to preview
   * @returns the counts and the largest changes
   * @throws {AppError} `NOT_FOUND` (404: the rule of an update or delete is unknown or deleted); `VALIDATION_FAILED` (422, as the
   *   write it previews, with the fields under `change.rule.`)
   */
  async preview(change: RetailRuleChange): Promise<RetailRulePreview> {
    const db = this.db.db;
    const now = this.clock.now();
    let target: { scope: RetailRuleScope; serviceType: ServiceType | null; categoryId: number | null };
    /** The rule set after the change, given the active rules of now that the services can match. */
    let after: (rules: RetailRule[]) => RetailRule[];
    if (change.kind === 'create') {
      const checked = await this.checkedTarget(db, change.rule, 'change.rule.');
      target = checked.target;
      const categoryName = checked.categoryName;
      const rule = pictured({ id: 0, ...target, categoryName }, createFigures(change.rule), now);
      after = (rules) => (rule.isActive ? [...rules, rule] : rules);
    } else {
      const row = await findRetailRuleRow(db, change.id);
      if (!row) throw notFound();
      const existing = retailRuleOf(row);
      target = { scope: existing.scope, serviceType: existing.serviceType, categoryId: existing.categoryId };
      if (change.kind === 'update') {
        const rule = pictured(existing, mergedFigures(existing, change.rule), now);
        after = (rules) => [...rules.filter((one) => one.id !== existing.id), ...(rule.isActive ? [rule] : [])];
      } else {
        after = (rules) => rules.filter((one) => one.id !== existing.id);
      }
    }

    const reached = await followersInReach(db, target, RULE_PREVIEW_LIMIT + 1);
    const ids = reached.slice(0, RULE_PREVIEW_LIMIT);
    const facts = [...(await this.pricing.facts(db, ids)).values()];
    const rulesAfter = after(await this.pricing.activeRules(db, facts));

    let changes = 0;
    let raised = 0;
    let lowered = 0;
    let atFloor = 0;
    let noRule = 0;
    const moved: { line: Omit<RetailRulePreviewLine, 'name' | 'code'>; size: Money }[] = [];
    for (const fact of facts) {
      const current = fact.quote.retailPrice;
      // A follow row whose price was changed another way is detached by the pass, not repriced: it is in `following` and in
      // no other figure, so `atFloor` and `noRule` count only what the pass would price.
      if (current === null || fact.follow === null || !current.eq(fact.follow.appliedPrice)) continue;
      const priced = priceWithRules(fact, rulesAfter).rulePrice;
      if (priced === null) {
        noRule += 1;
        continue;
      }
      if (priced.kind !== 'price') continue;
      if (priced.atFloor) atFloor += 1;
      const direction = priced.price.cmp(current);
      if (direction === 0) continue;
      changes += 1;
      if (direction > 0) raised += 1;
      else lowered += 1;
      moved.push({
        size: priced.price.sub(current).abs(),
        line: {
          serviceId: fact.serviceId,
          cost: fact.quote.cost.toWire(),
          floorPrice: fact.quote.floor.toWire(),
          currentPrice: current.toWire(),
          newPrice: priced.price.toWire(),
          atFloor: priced.atFloor,
        },
      });
    }
    moved.sort((a, b) => b.size.cmp(a.size) || a.line.serviceId - b.line.serviceId);
    const top = moved.slice(0, RULE_PREVIEW_LINES);
    const names = await serviceNamesOf(
      db,
      top.map((entry) => entry.line.serviceId),
    );
    return {
      following: facts.length,
      changes,
      raised,
      lowered,
      atFloor,
      noRule,
      lines: top.map((entry) => ({
        ...entry.line,
        name: names.get(entry.line.serviceId)?.name ?? '',
        code: names.get(entry.line.serviceId)?.code ?? '',
      })),
      truncated: reached.length > RULE_PREVIEW_LIMIT,
    };
  }

  /**
   * Judges the target of a new rule, before anything is written: the fields against the scope, the category (held `FOR SHARE`
   * in a transaction, so a category delete cannot slip in), then one rule per target. Returns the target and the category's name.
   */
  private async checkedTarget(
    db: DbExecutor,
    input: CreateRetailRuleInput,
    prefix: string,
  ): Promise<{
    target: { scope: RetailRuleScope; serviceType: ServiceType | null; categoryId: number | null };
    categoryName: string | null;
  }> {
    const target = { scope: input.scope, serviceType: input.serviceType ?? null, categoryId: input.categoryId ?? null };
    let categoryName: string | null = null;
    const problems: RetailRuleTargetProblem[] = retailRuleTargetProblems(
      target.scope,
      target.serviceType,
      target.categoryId,
    );
    if (problems.length === 0 && target.scope === 'category' && target.categoryId !== null) {
      const category = await lockCategoryRow(db, target.categoryId, 'share');
      if (category) categoryName = category.name;
      else problems.push({ field: 'categoryId', message: 'Choose a category that exists.' });
    }
    if (problems.length > 0) {
      const errors: FieldError[] = problems.map((problem) => ({
        field: `${prefix}${problem.field}`,
        code: 'invalid',
        message: problem.message,
      }));
      throw new AppError('VALIDATION_FAILED', { errors });
    }
    if ((await findRetailRuleForTarget(db, target)) !== undefined) throw duplicate(prefix);
    return { target, categoryName };
  }
}
