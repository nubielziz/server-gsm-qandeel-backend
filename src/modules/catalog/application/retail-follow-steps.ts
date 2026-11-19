// RetailFollowSteps: what happens to one following retail price under its service lock (decision 040, plan 31 sections 3.4 and 6.4):
// the locks and the fresh reading, and the writes of each verdict of the table. The follow pass and the resolve route share them.
import { Inject, Injectable } from '@nestjs/common';
import { CLOCK, type Clock } from '../../../common/clock';
import { Money } from '../../../common/money';
import type { DbExecutor } from '../../../infra/db';
import { AuditService } from '../../platform';
import type { RetailChangeReason, RetailPriceChange, RetailPriceFollow } from '../db/schema';
import {
  type FollowDecision,
  type FollowFacts,
  type FollowedRule,
  type WaitingProposal,
  decideFollow,
  followRowIsBehind,
  proposalDiffers,
} from '../domain/retail-follow';
import {
  closeProposal,
  insertRetailChange,
  lockWaitingProposal,
  rewriteProposal,
} from '../infra/retail-price-change.repository';
import {
  confirmRetailFollow,
  deleteRetailFollow,
  lockRetailFollow,
  ruleRowsOf,
} from '../infra/retail-price-rule.repository';
import { type LockedService, RetailPrices } from './retail-prices';
import { type RetailFollowState, type RetailTarget, RetailPricing } from './retail-pricing';
import { retailRuleOf } from './retail-rules';

/** The audit actions of the price changes (plan 31 section 6.6; the proposal and the detach are this slice's words). */
export const RETAIL_CHANGE_AUDIT = {
  followed: 'changed retail price of',
  proposed: 'proposed retail price of',
  detached: 'detached retail price of',
  approved: 'approved retail price of',
  kept: 'kept retail price of',
} as const;

/** What one step did to a following price. */
export type FollowStep = 'none' | 'removed' | 'detached' | 'settled' | 'proposed' | 'rewritten' | 'followed';

/** The rows of one service, locked in the order of plan 31 section 6.5. */
export interface LockedFollow {
  readonly serviceId: number;
  /** The live service, or `undefined` when it is archived. */
  readonly service: LockedService | undefined;
  /** The follow row, or `undefined` when the price no longer follows a rule. */
  readonly follow: RetailPriceFollow | undefined;
  /** The proposal that waits, or `undefined`. */
  readonly waiting: RetailPriceChange | undefined;
}

/** A following price as it stands under its locks. */
export interface FollowState {
  readonly serviceId: number;
  readonly serviceName: string;
  readonly target: RetailTarget;
  readonly facts: FollowFacts;
  readonly waiting: RetailPriceChange | undefined;
}

/**
 * Builds what the table of plan 31 section 3.4 reads from a target and the rule its follow row names.
 *
 * @param target the quote, the rule of now and its price
 * @param follow the follow row of the target
 * @param followedRule the rule that row names, or `undefined`
 * @returns the facts
 */
export function followFactsOf(
  target: RetailTarget,
  follow: RetailFollowState,
  followedRule: FollowedRule | undefined,
): FollowFacts {
  return {
    stored: target.quote.retailPrice,
    cost: target.quote.cost,
    follow,
    rule: target.rule,
    rulePrice: target.rulePrice,
    followedRule: followedRule ?? null,
  };
}

/**
 * The part of a proposal the table compares.
 *
 * @param row the proposal
 * @returns its reason, rule and new figures
 */
export function waitingProposalOf(row: RetailPriceChange): WaitingProposal {
  return {
    reason: row.reason,
    ruleId: row.ruleId,
    newPrice: row.newPrice === null ? null : Money.of(row.newPrice),
    newCost: Money.of(row.newCost),
  };
}

const wireOrNull = (value: Money | null): string | null => value?.toWire() ?? null;

/**
 * Carries out the table of plan 31 section 3.4 for one service.
 *
 * Why: decision 040: the follow pass and the approval of a proposal judge a price by the same reading, taken under the service row
 * lock, and every write of the retail price goes through `RetailPrices.set`. Nothing here takes a lock on a retail price rule: reading
 * a rule takes none, and the foreign key checks of the follow and change rows take `FOR KEY SHARE`, which never meets the
 * `FOR NO KEY UPDATE` of a rule edit or a soft delete (plan 31 section 4.1).
 *
 * Side effects: writes `service_group_prices` (through `RetailPrices.set`), `retail_price_follows`, `retail_price_changes` and
 * `audit_logs`, all in the caller's transaction. The caller moves the catalog price version after its commit.
 *
 * @see docs/decisions/040-retail-price-rules.md
 */
@Injectable()
export class RetailFollowSteps {
  constructor(
    private readonly retail: RetailPrices,
    private readonly pricing: RetailPricing,
    private readonly audit: AuditService,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  /**
   * Locks one following service: the service row first (every writer of a retail price does), then the follow row, then the proposal.
   *
   * @param tx the caller's transaction
   * @param serviceId the service
   * @returns what it found
   */
  async lock(tx: DbExecutor, serviceId: number): Promise<LockedFollow> {
    const service = await this.retail.lockLiveService(tx, serviceId);
    const follow = await lockRetailFollow(tx, serviceId);
    const waiting = await lockWaitingProposal(tx, serviceId);
    return { serviceId, service, follow, waiting };
  }

  /**
   * Reads the quote, the rules and the follow rule of a locked service.
   *
   * @param tx the caller's transaction
   * @param locked what {@link lock} found
   * @returns the state, or `undefined` when the service is archived or its price no longer follows a rule
   * @throws {RangeError} when a rule's price does not fit `numeric(18,4)` (a supplier's absurd cost)
   * @throws {Error} when a live, locked service has no quote: the follow row must not be taken for gone
   */
  async read(tx: DbExecutor, locked: LockedFollow): Promise<FollowState | undefined> {
    const { serviceId, service, follow, waiting } = locked;
    if (!service || !follow) return undefined;
    const target = (await this.pricing.targets(tx, [serviceId])).get(serviceId);
    if (!target?.follow) throw new Error(`The live service ${serviceId} has no retail quote.`);
    const rules = await ruleRowsOf(tx, follow.ruleId === null ? [] : [follow.ruleId]);
    const row = follow.ruleId === null ? undefined : rules.get(follow.ruleId);
    const facts = followFactsOf(target, target.follow, row ? retailRuleOf(row) : undefined);
    return { serviceId, serviceName: service.name, target, facts, waiting };
  }

  /**
   * Ends following for a service that has no live state to judge: the follow row goes and a waiting proposal closes.
   *
   * @param tx the caller's transaction
   * @param found the service and the proposal that waits for it
   * @returns `removed`, or `none` when there was no follow row to remove
   */
  async drop(tx: DbExecutor, found: Pick<LockedFollow, 'serviceId' | 'waiting'>): Promise<FollowStep> {
    await this.supersede(tx, found.waiting);
    return (await deleteRetailFollow(tx, found.serviceId)) ? 'removed' : 'none';
  }

  /**
   * Carries out one decision of the table.
   *
   * @param tx the caller's transaction (it holds the locks of {@link lock})
   * @param state the state the decision was made from
   * @param decision the decision (by default the one `decideFollow` makes)
   * @returns what was done (`none` when nothing had to change)
   * @throws {RetailFloorError} never in practice: a rule price is at or above the floor of the same quote
   */
  async carryOut(
    tx: DbExecutor,
    state: FollowState,
    decision: FollowDecision = decideFollow(state.facts),
  ): Promise<FollowStep> {
    switch (decision.kind) {
      case 'drop':
        return this.drop(tx, state);
      case 'detach':
        return this.detach(tx, state);
      case 'leave':
        return 'none';
      case 'settle':
        return this.settle(tx, state, decision);
      case 'propose':
        return this.propose(tx, state, decision);
      case 'write':
        return this.write(tx, state, decision);
    }
  }

  /**
   * Writes new figures on the waiting proposal of a price when what it shows differs, with an audit row; its `notified_at` stays.
   *
   * @param tx the caller's transaction
   * @param state the state, with a proposal waiting
   * @param figures the reason, the rule and the price it should show
   * @returns `rewritten`, or `none` when it already shows them
   */
  async rewrite(
    tx: DbExecutor,
    state: FollowState,
    figures: { readonly reason: RetailChangeReason; readonly ruleId: number; readonly price: Money | null },
  ): Promise<FollowStep> {
    const proposal = state.waiting!;
    const { facts } = state;
    if (!proposalDiffers(waitingProposalOf(proposal), figures, facts.cost)) return 'none';
    await rewriteProposal(tx, proposal.id, {
      ruleId: figures.ruleId,
      reason: figures.reason,
      oldPrice: facts.stored!.toWire(),
      newPrice: wireOrNull(figures.price),
      oldCost: facts.follow.appliedCost.toWire(),
      newCost: facts.cost.toWire(),
    });
    await this.auditProposal(tx, state, figures, proposal.id);
    return 'rewritten';
  }

  /** The follow row stops, the row says why, and the price is a typed one from now on (plan 31 section 3.4). */
  private async detach(tx: DbExecutor, state: FollowState): Promise<FollowStep> {
    const { facts, serviceId } = state;
    await deleteRetailFollow(tx, serviceId);
    await this.supersede(tx, state.waiting);
    const reason = 'changed_elsewhere';
    await insertRetailChange(tx, {
      serviceId,
      ruleId: facts.follow.ruleId,
      kind: 'detached',
      reason,
      oldPrice: facts.follow.appliedPrice.toWire(),
      newPrice: null,
      oldCost: facts.follow.appliedCost.toWire(),
      newCost: facts.cost.toWire(),
      createdAt: this.clock.now(),
    });
    await this.audit.record(tx, {
      action: RETAIL_CHANGE_AUDIT.detached,
      entityType: 'service',
      entityId: serviceId,
      entityLabel: state.serviceName,
      before: { retailPrice: facts.follow.appliedPrice.toWire(), cost: facts.follow.appliedCost.toWire() },
      after: {
        retailPrice: wireOrNull(facts.stored),
        cost: facts.cost.toWire(),
        reason,
        ruleId: facts.follow.ruleId,
      },
    });
    return 'detached';
  }

  /** The rule gives the stored price: the follow row catches up, and a proposal has nothing left to ask. */
  private async settle(
    tx: DbExecutor,
    state: FollowState,
    decision: Extract<FollowDecision, { kind: 'settle' }>,
  ): Promise<FollowStep> {
    const behind = followRowIsBehind(decision, state.facts);
    if (behind) {
      await confirmRetailFollow(tx, state.serviceId, {
        ruleId: decision.ruleId,
        appliedCost: state.facts.cost.toWire(),
        appliedAt: this.clock.now(),
      });
    }
    await this.supersede(tx, state.waiting);
    return behind || state.waiting ? 'settled' : 'none';
  }

  /** Opens a proposal, or rewrites the one that waits when what it shows differs; the stored price stays. */
  private async propose(
    tx: DbExecutor,
    state: FollowState,
    decision: Extract<FollowDecision, { kind: 'propose' }>,
  ): Promise<FollowStep> {
    const { facts, serviceId, waiting } = state;
    if (waiting) return this.rewrite(tx, state, decision);
    const row = await insertRetailChange(tx, {
      serviceId,
      ruleId: decision.ruleId,
      kind: 'proposed',
      reason: decision.reason,
      oldPrice: facts.stored!.toWire(),
      newPrice: wireOrNull(decision.price),
      oldCost: facts.follow.appliedCost.toWire(),
      newCost: facts.cost.toWire(),
      createdAt: this.clock.now(),
    });
    await this.auditProposal(tx, state, decision, row.id);
    return 'proposed';
  }

  /** Writes the rule price at once (`RetailPrices.set` closes a proposal that waited), with its change row and audit row. */
  private async write(
    tx: DbExecutor,
    state: FollowState,
    decision: Extract<FollowDecision, { kind: 'write' }>,
  ): Promise<FollowStep> {
    const { facts, serviceId, target } = state;
    await this.retail.set(tx, serviceId, decision.price, {
      origin: { kind: 'rule', ruleId: decision.ruleId, cost: facts.cost },
      quote: target.quote,
    });
    await insertRetailChange(tx, {
      serviceId,
      ruleId: decision.ruleId,
      kind: 'followed',
      reason: decision.reason,
      oldPrice: facts.stored!.toWire(),
      newPrice: decision.price.toWire(),
      oldCost: facts.follow.appliedCost.toWire(),
      newCost: facts.cost.toWire(),
      createdAt: this.clock.now(),
    });
    await this.audit.record(tx, {
      action: RETAIL_CHANGE_AUDIT.followed,
      entityType: 'service',
      entityId: serviceId,
      entityLabel: state.serviceName,
      before: { retailPrice: facts.stored!.toWire(), cost: facts.follow.appliedCost.toWire() },
      after: {
        retailPrice: decision.price.toWire(),
        cost: facts.cost.toWire(),
        reason: decision.reason,
        ruleId: decision.ruleId,
      },
    });
    return 'followed';
  }

  /** The audit row of a proposal opened or rewritten (the price it shows; the stored price has not moved). */
  private async auditProposal(
    tx: DbExecutor,
    state: FollowState,
    figures: { readonly reason: RetailChangeReason; readonly ruleId: number; readonly price: Money | null },
    proposalId: number,
  ): Promise<void> {
    const { facts } = state;
    await this.audit.record(tx, {
      action: RETAIL_CHANGE_AUDIT.proposed,
      entityType: 'service',
      entityId: state.serviceId,
      entityLabel: state.serviceName,
      before: { retailPrice: facts.stored!.toWire(), cost: facts.follow.appliedCost.toWire() },
      after: {
        retailPrice: wireOrNull(figures.price),
        cost: facts.cost.toWire(),
        reason: figures.reason,
        ruleId: figures.ruleId,
        proposalId,
      },
    });
  }

  /** Closes a proposal the system no longer needs. */
  private async supersede(tx: DbExecutor, waiting: RetailPriceChange | undefined): Promise<void> {
    if (!waiting) return;
    await closeProposal(tx, waiting.id, { resolution: 'superseded', resolvedAt: this.clock.now(), resolvedBy: null });
  }
}
