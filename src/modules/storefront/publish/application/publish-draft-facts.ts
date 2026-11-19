// PublishDraftFacts: what a draft row is judged on, read for a page of services (feature 31, plan 31 sections 3.2 and 6.1): the live
// service with its category, whether it has a listing, whether a supplier can take an order, and its cost, floor, stored price and rule.
import { Injectable } from '@nestjs/common';
import type { DbExecutor } from '../../../../infra/db';
import { RetailPricing, supplyStates } from '../../../catalog';
import { type PublishServiceFacts, publishFactsOf } from '../../infra/foreign-reads.repository';
import { servicesWithListing } from '../../infra/listing.repository';
import type { PriceNow, PublishFacts } from '../domain/publish-item';

/** Everything a draft row is judged on for one live service. */
export interface DraftFacts {
  /** The service and its category: the name and type the naming reads, and the category's switch. */
  readonly service: PublishServiceFacts;
  /** The facts `evaluateItem` judges. */
  readonly facts: PublishFacts;
  /** The cost, floor, stored retail price and rule of now, which `decidePrice` judges. */
  readonly price: PriceNow;
}

/**
 * Reads, for a page of services, what the draft evaluation needs.
 *
 * Why: plan 31 sections 3.2 and 6.1 step 5: one fixed set of queries per page (the quote and rules, the supply states, the lock facts
 * with the category's `is_active`, the listings), whatever the page holds. The preparer uses it for a whole run, and the edit of a row
 * (slice B4b) for one service, inside its transaction.
 *
 * Side effects: none (reads only, no lock: a draft decides nothing; apply decides again under the service lock).
 */
@Injectable()
export class PublishDraftFacts {
  constructor(private readonly pricing: RetailPricing) {}

  /**
   * Reads the facts of a page of services.
   *
   * @param db the database or a transaction
   * @param serviceIds the services of the page
   * @returns the facts per live service; an unknown or archived service is absent
   */
  async read(db: DbExecutor, serviceIds: readonly number[]): Promise<Map<number, DraftFacts>> {
    const ids = [...new Set(serviceIds)];
    const out = new Map<number, DraftFacts>();
    if (ids.length === 0) return out;
    // One after the other: `db` may be a transaction (the row edit), which runs one query at a time.
    const services = await publishFactsOf(db, ids);
    const supply = await supplyStates(db, ids);
    const listed = await servicesWithListing(db, ids);
    const targets = await this.pricing.targets(db, ids);
    for (const id of ids) {
      const service = services.get(id);
      const target = targets.get(id);
      if (service === undefined || target === undefined) continue;
      out.set(id, {
        service,
        facts: {
          listed: listed.has(id),
          serviceStatus: service.status,
          serviceType: service.type,
          fulfillment: service.fulfillment,
          categoryActive: service.categoryActive,
          categoryName: service.categoryName,
          categoryAllowedGroupIds: service.allowedGroupIds,
          retailGroupId: service.retailGroupId,
          supply: supply.get(id) ?? 'no_link',
        },
        price: {
          cost: target.quote.cost,
          floor: target.quote.floor,
          stored: { price: target.quote.retailPrice, following: target.source === 'rule' },
          rule: target.rule === null ? null : { id: target.rule.id, autoFollowPercent: target.rule.autoFollowPercent },
          rulePrice: target.rulePrice,
        },
      });
    }
    return out;
  }
}
