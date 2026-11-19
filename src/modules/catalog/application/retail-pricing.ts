// RetailPricing: what the retail price rules say about services (decision 040, feature 31): for each service its cost and
// floor, its stored retail price and whether that is typed or following, the rule that prices it now and that rule's price.
// It reads only; the writer is RetailPrices.set.
import { Injectable } from '@nestjs/common';
import { Money } from '../../../common/money';
import type { DbExecutor } from '../../../infra/db';
import type { ServiceType } from '../db/schema';
import { type RetailRulePrice, evaluateRetailRule, pickRetailRule } from '../domain/retail-rule';
import {
  activeRetailRules,
  anyActiveRetailRule,
  followsOf,
  serviceRuleTargets,
} from '../infra/retail-price-rule.repository';
import { type RetailQuote, RetailPrices } from './retail-prices';
import { type RetailRule, retailRuleOf } from './retail-rules';

/** The follow row of a service: what a rule wrote last. */
export interface RetailFollowState {
  /** The rule that priced it last; `null` when that rule was removed by the cascade of a category delete. */
  readonly ruleId: number | null;
  readonly appliedPrice: Money;
  readonly appliedCost: Money;
  readonly appliedAt: Date;
}

/** What is known about the retail price of one live service before any rule is applied. */
export interface RetailFacts {
  readonly serviceId: number;
  readonly type: ServiceType;
  readonly categoryId: number;
  /** The cost, the floor and the stored retail price (`RetailPrices.quotes`). */
  readonly quote: RetailQuote;
  /** The follow row, or `null` when the price is typed (or absent). */
  readonly follow: RetailFollowState | null;
}

/** The retail price of one live service and what the rules say about it. */
export interface RetailTarget extends RetailFacts {
  /** `rule` (following), `manual` (typed), `null` (no retail price). */
  readonly source: 'rule' | 'manual' | null;
  /** The active rule that prices the service now (category, then type, then global), or `null`. */
  readonly rule: RetailRule | null;
  /** That rule's price for the cost and floor of now (`no_cost` for a cost of 0), or `null` without a rule. */
  readonly rulePrice: RetailRulePrice | null;
}

/**
 * Applies a set of rules to the facts of a service.
 *
 * Why: the same evaluation serves the rules of now (`RetailPricing.targets`) and a rule set changed in memory (the preview of
 * `POST /admin/retail-price-rules/preview`), so both agree to the cent.
 *
 * @param facts the service's cost, floor, stored price and follow row
 * @param rules the active rules to choose from
 * @returns the target
 */
export function priceWithRules(facts: RetailFacts, rules: readonly RetailRule[]): RetailTarget {
  const rule = pickRetailRule(rules, facts) ?? null;
  const source = facts.quote.retailPrice === null ? null : facts.follow ? 'rule' : 'manual';
  return {
    ...facts,
    source,
    rule,
    rulePrice: rule ? evaluateRetailRule(rule, facts.quote) : null,
  };
}

/**
 * Reads what the retail price rules say about services.
 *
 * Why: decision 040: the listing route (`retailPricing: 'rule'`), the publisher's preview and apply, the follow pass and the
 * rule preview all need the same facts with a fixed number of queries per page: the quote (`RetailPrices.quotes`), the type and
 * category, the follow row and the active rules that are not deleted. A caller that writes reads it inside its transaction,
 * after locking the service row.
 *
 * Side effects: none (reads only).
 *
 * @see docs/decisions/040-retail-price-rules.md
 */
@Injectable()
export class RetailPricing {
  constructor(private readonly retail: RetailPrices) {}

  /**
   * Reads, for several services, the quote, the follow row, the rule that prices each one now and that rule's price.
   *
   * @param db the database or the caller's transaction
   * @param serviceIds the services of a page
   * @param at the moment B2B rule windows are judged at for the floor (default: the clock's now)
   * @returns one target per live service; an unknown or archived service is absent
   */
  async targets(db: DbExecutor, serviceIds: readonly number[], at?: Date): Promise<Map<number, RetailTarget>> {
    const facts = await this.facts(db, serviceIds, at);
    const rules = await this.activeRules(db, [...facts.values()]);
    return new Map([...facts].map(([id, fact]) => [id, priceWithRules(fact, rules)]));
  }

  /**
   * Reads, for several services, the quote, the type and category and the follow row, without applying any rule.
   *
   * @param db the database or the caller's transaction
   * @param serviceIds the services
   * @param at the moment B2B rule windows are judged at for the floor (default: the clock's now)
   * @returns the facts per live service; an unknown or archived service is absent
   */
  async facts(db: DbExecutor, serviceIds: readonly number[], at?: Date): Promise<Map<number, RetailFacts>> {
    const ids = [...new Set(serviceIds)];
    const out = new Map<number, RetailFacts>();
    if (ids.length === 0) return out;
    const quotes = await this.retail.quotes(db, ids, at);
    const targets = await serviceRuleTargets(db, ids);
    const follows = await followsOf(db, ids);
    for (const id of ids) {
      const quote = quotes.get(id);
      const target = targets.get(id);
      if (!quote || !target) continue;
      const follow = follows.get(id);
      out.set(id, {
        serviceId: id,
        type: target.type,
        categoryId: target.categoryId,
        quote,
        follow: follow
          ? {
              ruleId: follow.ruleId,
              appliedPrice: Money.of(follow.appliedPrice),
              appliedCost: Money.of(follow.appliedCost),
              appliedAt: follow.appliedAt,
            }
          : null,
      });
    }
    return out;
  }

  /**
   * Reads the active rules (not deleted) that could price these services.
   *
   * @param db the database or the caller's transaction
   * @param services the types and categories of the services
   * @returns the rules
   */
  async activeRules(
    db: DbExecutor,
    services: readonly { readonly type: ServiceType; readonly categoryId: number }[],
  ): Promise<RetailRule[]> {
    const rows = await activeRetailRules(db, {
      types: services.map((service) => service.type),
      categoryIds: services.map((service) => service.categoryId),
    });
    return rows.map(retailRuleOf);
  }

  /**
   * Tells whether any retail price rule is active.
   *
   * Why: plan 31 sections 5.5 and 7.2: Quick add refuses to publish without a rule, and the console says so before a preview.
   *
   * @param db the database or the caller's transaction
   * @returns true when at least one active rule exists
   */
  anyActiveRule(db: DbExecutor): Promise<boolean> {
    return anyActiveRetailRule(db);
  }
}
