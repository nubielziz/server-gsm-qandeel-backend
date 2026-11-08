// RetailPrices: the storefront's door into the catalog (feature 15): the retail group, the retail price and the storefront floor of
// services, a lock on a live service, and the one write of the retail price (a service_group_prices row of the b2c_retail group).
import { Injectable } from '@nestjs/common';
import { and, eq, inArray, isNull, sql } from 'drizzle-orm';
import { Money } from '../../../common/money';
import type { DbExecutor } from '../../../infra/db';
import { clientGroups, serviceGroupPrices, services } from '../db/schema';
import { storefrontFloor } from '../domain/price-resolution';
import { RETAIL_GROUP_KIND } from './client-group-directory';
import { PriceResolver } from './price-resolver';

/** A live service as the storefront needs it once it is locked. */
export interface LockedService {
  readonly id: number;
  readonly name: string;
  readonly status: string;
  readonly basePrice: Money;
}

/** What the storefront knows about the price of one live service. */
export interface RetailQuote {
  readonly serviceId: number;
  readonly name: string;
  /** The B2B base price merchants pay. */
  readonly basePrice: Money;
  /** The effective cost (RESOLUTIONS catalog-1): cost, margin and floor agree on it. */
  readonly cost: Money;
  /** The minimum profit that counts for the retail group. */
  readonly minProfit: Money;
  /** The lowest retail price accepted: `max(round(basePrice x 1.10, 2), cost + minProfit)` (catalog-12, b2c-7). */
  readonly floor: Money;
  /** The fixed retail price (net USD before VAT), or `null` when none is set. */
  readonly retailPrice: Money | null;
}

/**
 * Reads and writes the storefront retail price of services.
 *
 * Why: RESOLUTIONS catalog-12 and b2c-7: the listings admin, the storefront group-price row of the catalog and the checkout must
 * all hold the retail price to the same floor, and the catalog owns `service_group_prices`, so the storefront module reaches the
 * price only through this provider. It carries no connection: every method takes the caller's database handle or transaction.
 *
 * Side effects: `set` writes `service_group_prices`; the caller moves the catalog price version after the commit
 * (`CatalogPriceVersion.bumpAfterCommit`).
 *
 * @see docs/contract/endpoints/storefront.md (GET and PATCH /admin/service-listings)
 */
@Injectable()
export class RetailPrices {
  constructor(private readonly resolver: PriceResolver) {}

  /**
   * Finds the storefront's retail group.
   *
   * @param db the database or the caller's transaction
   * @returns the id of the single `b2c_retail` group, or `undefined` when it is gone
   */
  async retailGroupId(db: DbExecutor): Promise<number | undefined> {
    const [row] = await db
      .select({ id: clientGroups.id })
      .from(clientGroups)
      .where(eq(clientGroups.kind, RETAIL_GROUP_KIND))
      .limit(1);
    return row?.id;
  }

  /**
   * Finds a live service and locks its row for the rest of the transaction.
   *
   * Why: a retail price write, a listing switch and a listing create must not interleave with a service edit, a group-price
   * replace or a service delete (which decides between archiving and deleting from what refers to the service). `update`
   * is for writers of the price or status; `share` is for a writer that only adds a child row (a listing).
   *
   * @param db the caller's transaction
   * @param serviceId the service
   * @param mode `update` (default) or `share`
   * @returns the service, or `undefined` when it is unknown or archived
   */
  async lockLiveService(
    db: DbExecutor,
    serviceId: number,
    mode: 'update' | 'share' = 'update',
  ): Promise<LockedService | undefined> {
    const query = db
      .select({
        id: services.id,
        name: services.name,
        status: services.status,
        basePrice: services.basePrice,
      })
      .from(services)
      .where(and(eq(services.id, serviceId), isNull(services.archivedAt)))
      .limit(1);
    const [row] = await query.for(mode);
    return row ? { ...row, basePrice: Money.of(row.basePrice) } : undefined;
  }

  /**
   * Works out the cost, floor and retail price of several services with a fixed number of queries.
   *
   * @param db the database or the caller's transaction
   * @param serviceIds the services of a page
   * @param at the moment rule windows are judged at (default: the clock's now)
   * @returns one quote per live service; an unknown or archived service is absent from the map
   */
  async quotes(db: DbExecutor, serviceIds: readonly number[], at?: Date): Promise<Map<number, RetailQuote>> {
    const ids = [...new Set(serviceIds)];
    const quotes = new Map<number, RetailQuote>();
    if (ids.length === 0) return quotes;
    const context = await this.resolver.context(db, { serviceIds: ids, ...(at === undefined ? {} : { at }) });
    const groupId = (await this.retailGroupId(db)) ?? null;
    const prices = await this.retailPrices(db, ids, groupId);
    for (const id of ids) {
      const service = context.service(id);
      const floor = context.floor(id, groupId);
      if (!service || !floor) continue;
      quotes.set(id, {
        serviceId: id,
        name: service.name,
        basePrice: service.basePrice,
        cost: floor.cost,
        minProfit: floor.minProfit,
        floor: storefrontFloor(service.basePrice, floor.floor),
        retailPrice: prices.get(id) ?? null,
      });
    }
    return quotes;
  }

  /**
   * Sets the retail price of a service (the row of the `b2c_retail` group), replacing the old one.
   *
   * Why: the console's price dialog and the group-price page write the same row (ANSWERS services Q10); this is the listing
   * route's writer. The floor is the caller's check, made on a locked service.
   *
   * @param db the caller's transaction (the service row is locked)
   * @param serviceId the service
   * @param price the new retail price, above zero
   * @returns the price it replaced, or `null` when the service had none
   * @throws {Error} when the retail group is gone (it cannot be deleted through the API)
   */
  async set(db: DbExecutor, serviceId: number, price: Money): Promise<Money | null> {
    const groupId = await this.retailGroupId(db);
    if (groupId === undefined) throw new Error('The storefront retail group does not exist.');
    const before = (await this.retailPrices(db, [serviceId], groupId)).get(serviceId) ?? null;
    await db
      .insert(serviceGroupPrices)
      .values({ serviceId, groupId, price: price.toWire() })
      .onConflictDoUpdate({
        target: [serviceGroupPrices.serviceId, serviceGroupPrices.groupId],
        // updated_at is bookkeeping (decision 027), so the database's now() is fine here.
        set: { price: price.toWire(), updatedAt: sql`now()` },
      });
    return before;
  }

  private async retailPrices(
    db: DbExecutor,
    serviceIds: readonly number[],
    groupId: number | null,
  ): Promise<Map<number, Money>> {
    if (groupId === null || serviceIds.length === 0) return new Map();
    const rows = await db
      .select({ serviceId: serviceGroupPrices.serviceId, price: serviceGroupPrices.price })
      .from(serviceGroupPrices)
      .where(and(eq(serviceGroupPrices.groupId, groupId), inArray(serviceGroupPrices.serviceId, [...serviceIds])));
    return new Map(rows.map((row) => [row.serviceId, Money.of(row.price)]));
  }
}
