// The reads the price resolver needs, in a handful of queries for any number of services: the services with their category
// names, the merchant groups, the group and client prices, and the active pricing rules with the name of their target.
import { and, eq, inArray, isNull } from 'drizzle-orm';
import { Money } from '../../../common/money';
import type { DbExecutor } from '../../../infra/db';
import type { PricedGroup, PricedService, PricingRuleInput } from '../domain/price-resolution';
import {
  clientGroups,
  pricingRules,
  serviceCategories,
  serviceClientPrices,
  serviceGroupPrices,
  services,
} from '../db/schema';

/** A merchant group as the resolver reads it, with its kind (the storefront retail group is `b2c_retail`). */
export interface PricedGroupRow extends PricedGroup {
  readonly kind: string;
}

/** What one load brings back. */
export interface LoadedPricing {
  /** Live services only: an archived service is gone for the resolver (RESOLUTIONS catalog-3). */
  readonly services: ReadonlyMap<number, PricedService>;
  readonly groups: ReadonlyMap<number, PricedGroupRow>;
  /** Fixed group prices by `${serviceId}|${groupId}`. */
  readonly groupPrices: ReadonlyMap<string, Money>;
  /** Fixed client prices by `${serviceId}|${clientId}`. */
  readonly clientPrices: ReadonlyMap<string, Money>;
  /** Every active rule; the resolver judges windows, groups and targets. */
  readonly rules: readonly PricingRuleInput[];
}

/** What to load. */
export interface PricingQuery {
  readonly serviceIds: readonly number[];
  /** Merchants whose fixed prices matter; leave empty to ignore client prices. */
  readonly clientIds?: readonly number[];
}

/**
 * Loads everything the resolver needs for some services.
 *
 * Why: price lists and admin pages resolve many services at once; one query per table keeps them off the N+1 path.
 *
 * @param db the database or a transaction
 * @param query the services and the merchants to load fixed prices for
 * @returns the services, groups, fixed prices and active rules
 */
export async function loadPricing(db: DbExecutor, query: PricingQuery): Promise<LoadedPricing> {
  const serviceIds = [...new Set(query.serviceIds)];
  const clientIds = [...new Set(query.clientIds ?? [])];

  // One query after the other: `db` may be a transaction, whose single connection runs one statement at a time.
  const serviceRows =
    serviceIds.length === 0
      ? []
      : await db
          .select({ service: services, categoryName: serviceCategories.name })
          .from(services)
          .innerJoin(serviceCategories, eq(serviceCategories.id, services.categoryId))
          .where(and(inArray(services.id, serviceIds), isNull(services.archivedAt)));
  const groupRows = await db.select().from(clientGroups);
  const groupPriceRows =
    serviceIds.length === 0
      ? []
      : await db.select().from(serviceGroupPrices).where(inArray(serviceGroupPrices.serviceId, serviceIds));
  const clientPriceRows =
    serviceIds.length === 0 || clientIds.length === 0
      ? []
      : await db
          .select()
          .from(serviceClientPrices)
          .where(
            and(inArray(serviceClientPrices.serviceId, serviceIds), inArray(serviceClientPrices.clientId, clientIds)),
          );
  const ruleRows = await db
    .select({ rule: pricingRules, categoryName: serviceCategories.name, serviceName: services.name })
    .from(pricingRules)
    .leftJoin(
      serviceCategories,
      and(eq(pricingRules.scope, 'category'), eq(serviceCategories.id, pricingRules.targetId)),
    )
    .leftJoin(services, and(eq(pricingRules.scope, 'service'), eq(services.id, pricingRules.targetId)))
    .where(eq(pricingRules.isActive, true));

  return {
    services: new Map(
      serviceRows.map(({ service, categoryName }) => [
        service.id,
        {
          id: service.id,
          name: service.name,
          categoryId: service.categoryId,
          categoryName,
          basePrice: Money.of(service.basePrice),
          effectiveCost: Money.of(service.effectiveCost),
          minProfit: service.minProfit === null ? null : Money.of(service.minProfit),
        },
      ]),
    ),
    groups: new Map(
      groupRows.map((group) => [
        group.id,
        { id: group.id, name: group.name, discountPercent: group.discountPercent, kind: group.kind },
      ]),
    ),
    groupPrices: new Map(groupPriceRows.map((row) => [`${row.serviceId}|${row.groupId}`, Money.of(row.price)])),
    clientPrices: new Map(clientPriceRows.map((row) => [`${row.serviceId}|${row.clientId}`, Money.of(row.price)])),
    rules: ruleRows.map(({ rule, categoryName, serviceName }) => ({
      id: rule.id,
      scope: rule.scope,
      targetId: rule.targetId,
      targetName: rule.scope === 'category' ? (categoryName ?? '') : (serviceName ?? ''),
      groupId: rule.groupId,
      kind: rule.kind,
      percent: rule.percent,
      fixed: rule.fixed,
      rounding: rule.rounding,
      minProfit: rule.minProfit,
      priority: rule.priority,
      isActive: rule.isActive,
      startsAt: rule.startsAt,
      endsAt: rule.endsAt,
    })),
  };
}
