// The follow pass as pure functions (decision 040, plan 31 section 3.4 and its correction 3): what a pass does about one following
// retail price, when a waiting proposal must be written again, and what staff's approval of a proposal may do. No database, no clock.
import { Money } from '../../../common/money';
import type { RetailChangeReason } from '../db/schema';
import { type RetailRulePrice, costMoved } from './retail-rule';

/** The follow row of a service: what a rule wrote last. */
export interface FollowedPrice {
  /** The rule that priced it last; `null` when the cascade of a category delete removed that rule. */
  readonly ruleId: number | null;
  readonly appliedPrice: Money;
  readonly appliedCost: Money;
  readonly appliedAt: Date;
}

/** What the table reads of the rule that prices the service now. */
export interface PricingRuleNow {
  readonly id: number;
  readonly autoFollowPercent: number;
  /** The clock's time of the rule's create and of its last edit. */
  readonly changedAt: Date;
}

/** What the table reads of the rule the follow row names, as that rule stands now (a deleted rule keeps its row). */
export interface FollowedRule {
  readonly isActive: boolean;
  readonly deletedAt: Date | null;
  readonly changedAt: Date;
}

/** Everything the table of plan 31 section 3.4 looks at, read under the service row lock. */
export interface FollowFacts {
  /** The stored retail price, or `null` when the service has none any more. */
  readonly stored: Money | null;
  /** The effective cost of now. */
  readonly cost: Money;
  readonly follow: FollowedPrice;
  /** The active rule that prices the service now, or `null`. */
  readonly rule: PricingRuleNow | null;
  /** That rule's price for the cost and the floor of now, or `null` without a rule. */
  readonly rulePrice: RetailRulePrice | null;
  /** The rule the follow row names; `null` when it names none (or the row is gone). */
  readonly followedRule: FollowedRule | null;
}

/** Why a following price is moved at once. */
export type FollowReason = Extract<RetailChangeReason, 'cost_changed' | 'rule_changed' | 'floor_changed'>;

/** Why a move waits for staff. */
export type ProposalReason = Extract<RetailChangeReason, 'cost_jump' | 'no_cost' | 'rule_changed'>;

/**
 * What the follow pass does about one following price.
 *
 * Why: one verdict per row of the table of plan 31 section 3.4, so the pass and the approval of a proposal act on the same reading.
 */
export type FollowDecision =
  /** The service has no retail row any more: the follow row goes. */
  | { readonly kind: 'drop' }
  /** Someone wrote the retail row another way: the price is a typed one from now on. */
  | { readonly kind: 'detach' }
  /** No active rule covers the service: nothing changes. */
  | { readonly kind: 'leave' }
  /** The rule gives the stored price: the follow row catches up with the cost and the rule, and a waiting proposal closes. */
  | { readonly kind: 'settle'; readonly ruleId: number }
  /** The move waits for staff; the stored price stays. `price` is `null` for `no_cost`. */
  | {
      readonly kind: 'propose';
      readonly reason: ProposalReason;
      readonly ruleId: number;
      readonly price: Money | null;
    }
  /** The rule price is written at once. */
  | { readonly kind: 'write'; readonly reason: FollowReason; readonly ruleId: number; readonly price: Money };

/** What the pass compares of a waiting proposal. */
export interface WaitingProposal {
  readonly reason: RetailChangeReason;
  readonly ruleId: number | null;
  readonly newPrice: Money | null;
  readonly newCost: Money;
}

/** True when the rule was created or edited after the follow row was last brought up to date. */
const changedSince = (rule: { readonly changedAt: Date }, follow: FollowedPrice): boolean =>
  rule.changedAt.getTime() > follow.appliedAt.getTime();

/**
 * Tells whether the service came under another rule with no staff action: its follow rule still stands as it was, and the rule of
 * now is no newer than the price. That is a service that moved (a sync adoption changes its type and category), not a rule that
 * changed; a rule staff created, edited, switched off or deleted is a decision that applies at once. A follow row that names no rule
 * (the cascade of a category delete) counts as "the rule changed".
 *
 * "No newer" holds only because the adoption moves `applied_at` to its own moment (`ServiceImporter.adoptMainInput`): a rule edited
 * after an old price but before the move was never a decision about this service, and an edit after the move still applies at once.
 */
function serviceMovedByItself(rule: PricingRuleNow, follow: FollowedPrice, followedRule: FollowedRule | null): boolean {
  if (rule.id === follow.ruleId || follow.ruleId === null || followedRule === null) return false;
  const standing = followedRule.isActive && followedRule.deletedAt === null && !changedSince(followedRule, follow);
  return standing && !changedSince(rule, follow);
}

/** The reason of a price written at once (plan 31 section 3.4): the cost, else the rule, else the floor. */
function followReason(facts: FollowFacts, rule: PricingRuleNow): FollowReason {
  if (!facts.cost.eq(facts.follow.appliedCost)) return 'cost_changed';
  if (rule.id !== facts.follow.ruleId || changedSince(rule, facts.follow)) return 'rule_changed';
  return 'floor_changed';
}

/**
 * Decides what happens to one following price: the table of plan 31 section 3.4, row by row, in its order.
 *
 * Why: decision 040: a following price moves by itself inside the rule's limit on the cost; a cost that moved more, a cost of 0, or a
 * service that came under another rule unattended (plan correction 3) waits for staff, and a price written another way stops
 * following. Only the supplier's side is unattended: a rule staff changed applies whole. An archived service is the caller's case: it
 * has no facts.
 *
 * @param facts the prices, the cost and the rules, read under the service row lock
 * @returns what to do
 * @throws {RangeError} when the rule's limit is outside 0 to 1000 (the rule's CHECK makes that impossible)
 */
export function decideFollow(facts: FollowFacts): FollowDecision {
  const { stored, cost, follow, rule, rulePrice, followedRule } = facts;
  if (stored === null) return { kind: 'drop' };
  if (!stored.eq(follow.appliedPrice)) return { kind: 'detach' };
  if (rule === null || rulePrice === null) return { kind: 'leave' };
  if (rulePrice.kind === 'no_cost') return { kind: 'propose', reason: 'no_cost', ruleId: rule.id, price: null };
  const { price } = rulePrice;
  if (price.eq(stored)) return { kind: 'settle', ruleId: rule.id };
  if (costMoved(follow.appliedCost, cost, rule.autoFollowPercent)) {
    return { kind: 'propose', reason: 'cost_jump', ruleId: rule.id, price };
  }
  if (serviceMovedByItself(rule, follow, followedRule)) {
    return { kind: 'propose', reason: 'rule_changed', ruleId: rule.id, price };
  }
  return { kind: 'write', reason: followReason(facts, rule), ruleId: rule.id, price };
}

/**
 * Tells whether a settled price still leaves something to record on the follow row.
 *
 * Why: the follow row names the rule, the cost and the time a price was last confirmed. A rule edit that leaves the price as it is must
 * still reach `applied_at`: otherwise the rule would read as "changed since" for ever, and a later unattended move of the service would
 * pass as a staff decision.
 *
 * @param decision the `settle` decision
 * @param facts the facts it was made from
 * @returns true when the follow row differs from what it should now say
 */
export function followRowIsBehind(decision: { readonly ruleId: number }, facts: FollowFacts): boolean {
  const { follow, cost, rule } = facts;
  return (
    !cost.eq(follow.appliedCost) || decision.ruleId !== follow.ruleId || (rule !== null && changedSince(rule, follow))
  );
}

/**
 * Tells whether a waiting proposal must be written again for a new proposal decision.
 *
 * Why: plan 31 section 3.4: a proposal is rewritten only when what it shows differs (`new_price`, `new_cost`, the rule, and the reason
 * printed beside them), so a pass over a proposal that did not change writes nothing.
 *
 * @param waiting the proposal that waits
 * @param decision the reason, the rule and the price it would show now
 * @param cost the effective cost of now
 * @returns true when the proposal shows something else
 */
export function proposalDiffers(
  waiting: WaitingProposal,
  decision: { readonly reason: RetailChangeReason; readonly ruleId: number; readonly price: Money | null },
  cost: Money,
): boolean {
  const samePrice =
    waiting.newPrice === null || decision.price === null
      ? waiting.newPrice === decision.price
      : waiting.newPrice.eq(decision.price);
  return (
    !samePrice || !waiting.newCost.eq(cost) || waiting.ruleId !== decision.ruleId || waiting.reason !== decision.reason
  );
}

/**
 * Tells whether a decision changes anything, so the pass can leave a service alone without locking it.
 *
 * Why: plan 31 section 6.4: one unlocked read per page finds the candidates, and a pass that changes nothing writes nothing.
 *
 * @param decision the decision
 * @param facts the facts it was made from
 * @param waiting the proposal that waits for the service, or `null`
 * @returns true when the service needs its own transaction
 */
export function followHasWork(decision: FollowDecision, facts: FollowFacts, waiting: WaitingProposal | null): boolean {
  switch (decision.kind) {
    case 'drop':
    case 'detach':
    case 'write':
      return true;
    case 'leave':
      return false;
    case 'settle':
      return waiting !== null || followRowIsBehind(decision, facts);
    case 'propose':
      return waiting === null || proposalDiffers(waiting, decision, facts.cost);
  }
}

/** What staff's approval of a waiting proposal may do. */
export type ApprovalVerdict =
  /** The rule price of now is the figure staff saw: it is written, whatever the size of the move. */
  | { readonly kind: 'apply'; readonly price: Money; readonly ruleId: number }
  /** The price no longer follows the rules (no retail row, or it was written another way). */
  | { readonly kind: 'gone' }
  /** No active rule covers the service. */
  | { readonly kind: 'no_rule' }
  /** The cost is 0, so a rule cannot price the service. */
  | { readonly kind: 'no_cost' }
  /** The rule price of now is another figure than the one staff saw: nothing is written. */
  | { readonly kind: 'moved' };

/**
 * Finds the figure staff approved: the proposal's `new_price`, when that is the figure the list showed them.
 *
 * Why: decision 040 and plan 31 section 3.4: approving writes the figure staff saw and nothing else. The follow pass rewrites a waiting
 * proposal, so the row alone cannot say what a person read; the request carries the figure of the list. Both are the wire text of one
 * column, so they are compared as text: a figure that is not exactly the row's counts as not seen, and nothing has to be parsed.
 *
 * @param proposedPrice the proposal's `new_price`, read under the service row lock
 * @param seenPrice the `newPrice` the list showed for it
 * @returns the approved figure, or `null` when staff approved none (the row has no figure, or another one than they saw)
 */
export function approvedFigure(proposedPrice: string | null, seenPrice: string | null): Money | null {
  return proposedPrice !== null && proposedPrice === seenPrice ? Money.of(proposedPrice) : null;
}

/**
 * Judges the approval of a proposal against the figures of now.
 *
 * Why: decision 040 and plan 31 section 3.4: approving writes the figure staff saw and nothing else, so a figure that moved since the
 * list was read is shown again instead of being written.
 *
 * @param decision what the pass would do now
 * @param rulePrice the rule's price of now, or `null` without a rule
 * @param approvedPrice the figure staff approved ({@link approvedFigure}), or `null` when they approved none
 * @returns the verdict
 */
export function judgeApproval(
  decision: FollowDecision,
  rulePrice: RetailRulePrice | null,
  approvedPrice: Money | null,
): ApprovalVerdict {
  if (decision.kind === 'drop' || decision.kind === 'detach') return { kind: 'gone' };
  if (decision.kind === 'leave' || rulePrice === null) return { kind: 'no_rule' };
  if (rulePrice.kind === 'no_cost') return { kind: 'no_cost' };
  if (approvedPrice === null || !rulePrice.price.eq(approvedPrice)) return { kind: 'moved' };
  return { kind: 'apply', price: rulePrice.price, ruleId: decision.ruleId };
}
