// RetailPriceChangesService: the use cases of the price changes routes (feature 31, decision 040, spec B230): the list of what the
// follow pass did or proposes, and staff's answer to a proposal: approve the figure they saw, or keep the current price.
import { Inject, Injectable } from '@nestjs/common';
import { CLOCK, type Clock } from '../../../common/clock';
import type { ParsedListQuery } from '../../../common/contract';
import type { Money } from '../../../common/money';
import { type DbExecutor, DbService, type TransactionContext } from '../../../infra/db';
import { AuditService } from '../../platform';
import type { RetailChangeKind, RetailChangeReason, RetailChangeResolution, RetailPriceChange } from '../db/schema';
import { approvedFigure, decideFollow, judgeApproval } from '../domain/retail-follow';
import {
  type RetailChangeRow,
  type RetailChangeSort,
  closeProposal,
  findRetailChange,
  listRetailChangeRows,
} from '../infra/retail-price-change.repository';
import { deleteRetailFollow, ruleRowsOf, serviceNamesOf } from '../infra/retail-price-rule.repository';
import { CatalogPriceVersion } from './catalog-price-version';
import { type FollowState, type LockedFollow, RETAIL_CHANGE_AUDIT, RetailFollowSteps } from './retail-follow-steps';
import { RetailPrices } from './retail-prices';
import { type RetailRule, retailRuleOf } from './retail-rules';

/** What the list showed of one proposal when staff approved it. */
export interface SeenRetailChange {
  readonly id: number;
  /** The `newPrice` of the row, as the list sent it. */
  readonly newPrice: string | null;
}

/** Staff's answer to proposals: approve the figures they saw, or keep the current prices. */
export type RetailChangeAnswer =
  | { readonly action: 'apply'; readonly ids: readonly number[]; readonly seen: readonly SeenRetailChange[] }
  | { readonly action: 'keep'; readonly ids: readonly number[] };

/** Why a proposal was not resolved. */
export type RetailChangeSkipReason = 'no_rule' | 'no_cost' | 'not_waiting' | 'changed';

/** A price change as the console reads it. */
export interface RetailChangeView {
  readonly id: number;
  readonly service: { readonly id: number; readonly name: string; readonly code: string };
  readonly kind: RetailChangeKind;
  readonly reason: RetailChangeReason;
  readonly oldPrice: string;
  readonly newPrice: string | null;
  readonly oldCost: string;
  readonly newCost: string;
  readonly rule: { readonly id: number; readonly label: string } | null;
  readonly waiting: boolean;
  readonly resolution: RetailChangeResolution | null;
  readonly resolvedAt: string | null;
  readonly resolvedBy: number | null;
  readonly createdAt: string;
}

/** What `POST /admin/retail-price-changes/resolve` answers. */
export interface RetailChangesResolved {
  readonly applied: number;
  readonly kept: number;
  readonly skipped: { readonly id: number; readonly reason: RetailChangeSkipReason }[];
}

/** The answer for one id. */
type Resolution = 'applied' | 'kept' | RetailChangeSkipReason;

const toView = (row: RetailChangeRow, rules: ReadonlyMap<number, RetailRule>): RetailChangeView => {
  const { change } = row;
  const rule = change.ruleId === null ? undefined : rules.get(change.ruleId);
  return {
    id: change.id,
    service: { id: change.serviceId, name: row.serviceName, code: row.serviceCode },
    kind: change.kind,
    reason: change.reason,
    oldPrice: change.oldPrice,
    newPrice: change.newPrice,
    oldCost: change.oldCost,
    newCost: change.newCost,
    rule: rule ? { id: rule.id, label: rule.label } : null,
    waiting: change.kind === 'proposed' && change.resolvedAt === null,
    resolution: change.resolution,
    resolvedAt: change.resolvedAt?.toISOString() ?? null,
    resolvedBy: change.resolvedBy,
    createdAt: change.createdAt.toISOString(),
  };
};

/**
 * Lists the price changes and resolves proposals.
 *
 * Why: decision 040 and plan 31 sections 3.4 and 5.4: a move over the rule's limit waits for a person, who approves the figure shown or
 * keeps the current price, which then is a typed one. An approval writes only the figure staff saw, which the request names because the
 * follow pass rewrites a waiting proposal: when the proposal or the rule gives another figure now, no price is written and the proposal
 * shows the figure of now, so staff read it and approve again. Each id is its own transaction under the service row lock, so one refused
 * id never undoes the others.
 *
 * Side effects: `resolve` writes `service_group_prices` (through `RetailPrices.set`), `retail_price_follows`, `retail_price_changes` and
 * `audit_logs` (entity `service`), and moves the catalog price version after a price was written.
 *
 * @see docs/decisions/040-retail-price-rules.md
 * @see docs/contract/endpoints/catalog.md (the `/admin/retail-price-changes` sections)
 */
@Injectable()
export class RetailPriceChangesService {
  constructor(
    private readonly db: DbService,
    private readonly steps: RetailFollowSteps,
    private readonly retail: RetailPrices,
    private readonly audit: AuditService,
    private readonly priceVersion: CatalogPriceVersion,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  /**
   * Lists the price changes.
   *
   * @param query the parsed list request
   * @returns the page and the exact total
   */
  async list(query: ParsedListQuery<RetailChangeSort>): Promise<{ rows: RetailChangeView[]; total: number }> {
    const { db } = this.db;
    const { rows, total } = await listRetailChangeRows(db, query);
    // A deleted rule keeps its row, so the history still names it.
    const found = await ruleRowsOf(
      db,
      rows.flatMap(({ change }) => (change.ruleId === null ? [] : [change.ruleId])),
    );
    const rules = new Map([...found].map(([id, row]) => [id, retailRuleOf(row)]));
    return { rows: rows.map((row) => toView(row, rules)), total };
  }

  /**
   * Answers several proposals, one transaction each.
   *
   * @param staffId the staff member who answers
   * @param answer the proposals (an id that is no waiting proposal is `skipped` with `not_waiting`), `apply` with the figures the list
   *   showed, or `keep`
   * @returns how many were applied and kept, and the ids skipped with the reason (`no_rule`, `no_cost`, `not_waiting`, `changed`)
   */
  async resolve(staffId: number, answer: RetailChangeAnswer): Promise<RetailChangesResolved> {
    const ids = new Set(answer.ids);
    const seen = new Map(answer.action === 'apply' ? answer.seen.map((row) => [row.id, row.newPrice]) : []);
    let applied = 0;
    let kept = 0;
    const skipped: { id: number; reason: RetailChangeSkipReason }[] = [];
    for (const id of ids) {
      // The route requires a figure per id to approve; without one nothing counts as seen, so nothing can be written.
      const outcome = await this.resolveOne(staffId, id, answer.action, seen.get(id) ?? null);
      if (outcome === 'applied') applied += 1;
      else if (outcome === 'kept') kept += 1;
      else skipped.push({ id, reason: outcome });
    }
    if (applied + kept === 0) {
      // Every staff write leaves an audit row, also one that resolved nothing (the rule of the bulk reply).
      await this.db.runInTransaction(({ tx }) =>
        this.audit.record(tx, {
          action: 'resolved no retail price change',
          entityType: 'service',
          entityLabel: `0 of ${ids.size} price changes`,
          after: { action: answer.action, skipped: skipped.length },
        }),
      );
    }
    return { applied, kept, skipped };
  }

  /** Answers one proposal in its own transaction: the service row first, then the proposal read again under it. */
  private async resolveOne(
    staffId: number,
    id: number,
    action: RetailChangeAnswer['action'],
    seenPrice: string | null,
  ): Promise<Resolution> {
    const change = await findRetailChange(this.db.db, id);
    if (!change || change.kind !== 'proposed' || change.resolvedAt !== null) return 'not_waiting';
    return this.db.runInTransaction(async (work) => {
      const locked = await this.steps.lock(work.tx, change.serviceId);
      const proposal = locked.waiting;
      if (proposal?.id !== id) return 'not_waiting';
      return action === 'keep'
        ? this.keep(work.tx, staffId, locked, proposal)
        : this.apply(work, staffId, locked, proposal, seenPrice);
    });
  }

  /**
   * Keeps the current price: following ends, so it is a typed price from now on (plan 31 section 3.4). It works nothing out from the
   * cost or the rules, so it also ends a proposal for a service no rule can price.
   */
  private async keep(
    tx: DbExecutor,
    staffId: number,
    locked: LockedFollow,
    proposal: RetailPriceChange,
  ): Promise<Resolution> {
    const { serviceId } = locked;
    const stored = await this.retail.storedPrice(tx, serviceId);
    await deleteRetailFollow(tx, serviceId);
    await closeProposal(tx, proposal.id, {
      resolution: 'kept',
      resolvedAt: this.clock.now(),
      resolvedBy: staffId,
    });
    const name = locked.service?.name ?? (await serviceNamesOf(tx, [serviceId])).get(serviceId)?.name ?? '';
    const retailPrice = stored?.toWire() ?? proposal.oldPrice;
    await this.audit.record(tx, {
      action: RETAIL_CHANGE_AUDIT.kept,
      entityType: 'service',
      entityId: serviceId,
      entityLabel: name,
      before: { retailPrice, cost: proposal.oldCost, proposedPrice: proposal.newPrice },
      after: { retailPrice, cost: proposal.newCost, proposalId: proposal.id },
    });
    return 'kept';
  }

  /**
   * Writes the rule price of now when it is the figure staff saw; anything else writes no price. A cost no rule can price (over
   * `numeric(18,4)`) answers `no_cost`: there is no figure to approve, and the other ids of the request go on.
   */
  private async apply(
    work: TransactionContext,
    staffId: number,
    locked: LockedFollow,
    proposal: RetailPriceChange,
    seenPrice: string | null,
  ): Promise<Resolution> {
    const { tx } = work;
    let state: FollowState | undefined;
    try {
      state = await this.steps.read(tx, locked);
    } catch (error) {
      if (error instanceof RangeError) return 'no_cost';
      throw error;
    }
    if (!state) {
      // An archived service, or a price that stopped following: the proposal has nothing left to approve.
      await this.steps.drop(tx, locked);
      return 'not_waiting';
    }
    const decision = decideFollow(state.facts);
    const verdict = judgeApproval(decision, state.target.rulePrice, approvedFigure(proposal.newPrice, seenPrice));
    switch (verdict.kind) {
      case 'apply':
        await this.approve(work, staffId, state, proposal, verdict);
        return 'applied';
      case 'gone':
        await this.steps.carryOut(tx, state, decision);
        return 'not_waiting';
      case 'no_rule':
        return 'no_rule';
      case 'no_cost':
        // The proposal now says what stands in the way.
        await this.steps.carryOut(tx, state, decision);
        return 'no_cost';
      case 'moved':
        return this.showMoved(tx, state, decision);
    }
  }

  /** Writes the approved figure, closes the proposal as `applied` first (the writer closes only what still waits) and audits it. */
  private async approve(
    work: TransactionContext,
    staffId: number,
    state: FollowState,
    proposal: RetailPriceChange,
    verdict: { readonly price: Money; readonly ruleId: number },
  ): Promise<void> {
    const { tx } = work;
    const { facts, target, serviceId } = state;
    await closeProposal(tx, proposal.id, {
      resolution: 'applied',
      resolvedAt: this.clock.now(),
      resolvedBy: staffId,
    });
    await this.retail.set(tx, serviceId, verdict.price, {
      origin: { kind: 'rule', ruleId: verdict.ruleId, cost: facts.cost },
      quote: target.quote,
    });
    this.priceVersion.bumpAfterCommit(work);
    await this.audit.record(tx, {
      action: RETAIL_CHANGE_AUDIT.approved,
      entityType: 'service',
      entityId: serviceId,
      entityLabel: state.serviceName,
      before: { retailPrice: facts.stored?.toWire() ?? null, cost: facts.follow.appliedCost.toWire() },
      after: {
        retailPrice: verdict.price.toWire(),
        cost: facts.cost.toWire(),
        ruleId: verdict.ruleId,
        proposalId: proposal.id,
      },
    });
  }

  /**
   * The figure is not the one staff saw: no price is written, and the proposal shows the figure of now (it may already: the pass rewrites
   * it too) so staff approve again. When the rule now gives the stored price there is nothing left to approve, and when the pass would
   * move the price by itself the proposal only shows the new figure, with the reason of that move, until the next pass does.
   */
  private async showMoved(
    tx: DbExecutor,
    state: FollowState,
    decision: ReturnType<typeof decideFollow>,
  ): Promise<Resolution> {
    if (decision.kind === 'settle') {
      await this.steps.carryOut(tx, state, decision);
      return 'not_waiting';
    }
    if (decision.kind === 'propose') await this.steps.carryOut(tx, state, decision);
    else if (decision.kind === 'write') await this.steps.rewrite(tx, state, decision);
    return 'changed';
  }
}
