// RetailPrices: the storefront's door into the catalog (feature 15): the retail group, the retail price and the storefront floor of
// services, a lock on a live service, and the one writer of the retail price (a service_group_prices row of the b2c_retail group)
// with its origin, typed or following a rule (decision 040, feature 31).
import { Inject, Injectable } from '@nestjs/common';
import { and, eq, inArray, isNull, sql } from 'drizzle-orm';
import { CLOCK, type Clock } from '../../../common/clock';
import { Money } from '../../../common/money';
import type { DbExecutor } from '../../../infra/db';
import { clientGroups, serviceGroupPrices, services } from '../db/schema';
import { storefrontFloor } from '../domain/price-resolution';
import { supersedeWaitingProposal, waitingProposalsOf } from '../infra/retail-price-change.repository';
import { deleteRetailFollow, followsOf, ruleRowsOf, upsertRetailFollow } from '../infra/retail-price-rule.repository';
import { RETAIL_GROUP_KIND } from './client-group-directory';
import { PriceResolver } from './price-resolver';
import { retailRuleOf } from './retail-rules';

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
 * Where a retail price comes from: a person typed it, or a rule worked it out from a cost.
 *
 * Why: decision 040: a rule never overwrites a typed price unless staff ask for it, so every write says which it is, and the
 * writer keeps `retail_price_follows` in step.
 */
export type RetailOrigin =
  | { readonly kind: 'manual' }
  | {
      readonly kind: 'rule';
      /** The rule that priced it. */
      readonly ruleId: number;
      /** The effective cost the price was worked out from (the follow pass and the publish limit compare with it). */
      readonly cost: Money;
    };

/** The origin and the quote of a retail price write. */
export interface RetailWrite {
  readonly origin: RetailOrigin;
  /** The quote of the service, read by the caller in the same transaction after locking the service row. */
  readonly quote: RetailQuote;
}

/** Whether a service's retail price is typed or follows a rule, and which rule. */
export interface RetailPriceSource {
  /** `rule` when the price follows a rule, `manual` when a person typed it, `null` when the service has no retail price. */
  readonly source: 'rule' | 'manual' | null;
  /** The rule a following price came from (also a rule deleted since: its name stays), or `null`. */
  readonly rule: { readonly id: number; readonly label: string } | null;
  /** True when a proposal for the price waits for staff (a row of `retail_price_changes` nobody resolved). */
  readonly waiting: boolean;
}

/**
 * A retail price under the storefront floor reached the writer.
 *
 * Why: decision 040: `RetailPrices.set` refuses a price under the floor itself, so no new writer can skip the invariant. The
 * callers' own `422` checks answer first; this error means a caller forgot one, so it is a server error, never a user's.
 */
export class RetailFloorError extends Error {
  /**
   * @param serviceId the service
   * @param price the refused price
   * @param floor the storefront floor of the quote
   */
  constructor(
    readonly serviceId: number,
    readonly price: Money,
    readonly floor: Money,
  ) {
    super(
      `The retail price ${price.toWire()} of service ${serviceId} is under the storefront floor ${floor.toWire()}.`,
    );
    this.name = 'RetailFloorError';
  }
}

/**
 * Reads and writes the storefront retail price of services.
 *
 * Why: RESOLUTIONS catalog-12 and b2c-7: the listings admin, the storefront group-price row of the catalog and the checkout must
 * all hold the retail price to the same floor, and the catalog owns `service_group_prices`, so the storefront module reaches the
 * price only through this provider. It carries no connection: every method takes the caller's database handle or transaction.
 *
 * Decision 040: the retail row has two writers and no third: `set` (the listing route, the publisher, the follow pass, the
 * approval of a proposal) and the group price page's replace-all, which keeps its own floor check and calls `afterGroupReplace`.
 *
 * Side effects: `set` writes `service_group_prices` and `retail_price_follows` and closes a waiting proposal of the service
 * (`retail_price_changes`); `afterGroupReplace` deletes from `retail_price_follows` and closes that proposal when following stops.
 * The caller moves the catalog price version after the commit (`CatalogPriceVersion.bumpAfterCommit`).
 *
 * @see docs/contract/endpoints/storefront.md (GET and PATCH /admin/service-listings)
 * @see docs/decisions/040-retail-price-rules.md
 */
@Injectable()
export class RetailPrices {
  constructor(
    private readonly resolver: PriceResolver,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

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
   * Reads the stored retail price of one service, with no cost or floor worked out.
   *
   * Why: plan 31 section 3.4: keeping a price needs only the figure that stays, so staff can keep it even when the service's cost is one
   * no quote can hold (a supplier's absurd cost).
   *
   * @param db the database or the caller's transaction
   * @param serviceId the service
   * @returns the price, or `null` when it has none
   */
  async storedPrice(db: DbExecutor, serviceId: number): Promise<Money | null> {
    const groupId = (await this.retailGroupId(db)) ?? null;
    return (await this.retailPrices(db, [serviceId], groupId)).get(serviceId) ?? null;
  }

  /**
   * Sets the retail price of a service (the row of the `b2c_retail` group), replacing the old one, and records whether it is
   * typed or follows a rule.
   *
   * Why: decision 040: every writer of the retail row but the group price page goes through here (the listing route, the
   * publisher, the follow pass, the approval of a proposal). It refuses a price under the floor of the caller's quote itself,
   * so no writer can skip the invariant (the callers' `422` checks answer first). A typed price deletes the follow row; a rule
   * price upserts it with the price, the cost it came from and the clock's time. Either way a new price answers what a waiting
   * proposal asked, so that proposal closes as `superseded` (a caller that resolves it otherwise closes it first). Lock order: the
   * caller holds the service row; this takes the price row, then the follow row, then the proposal.
   *
   * @param db the caller's transaction (the service row is locked)
   * @param serviceId the service
   * @param price the new retail price, above zero
   * @param write the origin of the price and the quote the caller read after locking the service
   * @returns the price it replaced, or `null` when the service had none
   * @throws {RetailFloorError} when the price is under `write.quote.floor`
   * @throws {RangeError} when the price is not above zero
   * @throws {Error} when the quote is of another service, or the retail group is gone (it cannot be deleted through the API)
   */
  async set(db: DbExecutor, serviceId: number, price: Money, write: RetailWrite): Promise<Money | null> {
    const { origin, quote } = write;
    if (quote.serviceId !== serviceId)
      throw new Error(`The quote of service ${quote.serviceId} cannot price ${serviceId}.`);
    if (!price.isPositive()) throw new RangeError('A retail price is above zero.');
    // Every refusal before the first write.
    if (price.cmp(quote.floor) < 0) throw new RetailFloorError(serviceId, price, quote.floor);
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
    if (origin.kind === 'manual') {
      await deleteRetailFollow(db, serviceId);
    } else {
      await upsertRetailFollow(db, {
        serviceId,
        ruleId: origin.ruleId,
        appliedPrice: price.toWire(),
        appliedCost: origin.cost.toWire(),
        appliedAt: this.clock.now(),
      });
    }
    await supersedeWaitingProposal(db, serviceId, this.clock.now());
    return before;
  }

  /**
   * Keeps the follow row in step after the group price page replaced the prices of a service.
   *
   * Why: decision 040, plan 31 section 3.3: the page writes the retail row itself (replace-all) with its own floor check. A
   * changed or removed retail price is a person's choice, so following stops, and a proposal that waited for the price closes with
   * it; the same price (the page re-sends every group) keeps both.
   *
   * @param db the caller's transaction (the service row is locked)
   * @param serviceId the service
   * @param before the retail price before the replace, or `null`
   * @param after the retail price after it, or `null` when the row is gone
   * @returns true when following stopped (a follow row was deleted)
   */
  async afterGroupReplace(
    db: DbExecutor,
    serviceId: number,
    before: Money | null,
    after: Money | null,
  ): Promise<boolean> {
    const same = before !== null && after !== null && before.eq(after);
    if (same) return false;
    const stopped = await deleteRetailFollow(db, serviceId);
    if (stopped) await supersedeWaitingProposal(db, serviceId, this.clock.now());
    return stopped;
  }

  /**
   * Tells, for several services, whether their retail price is typed or follows a rule, and which rule.
   *
   * Why: plan 31 section 5.5: the listing rows carry `retailPriceSource`, `retailPriceRule` and `retailPriceWaiting`, read with
   * a fixed number of queries for a page. A follow row without a retail row (it cannot last: every remover of the row deletes
   * it) reads as no price. `waiting` says a proposal for the price waits for staff.
   *
   * @param db the database or the caller's transaction
   * @param serviceIds the services of a page
   * @returns one entry per service id asked
   */
  async sources(db: DbExecutor, serviceIds: readonly number[]): Promise<Map<number, RetailPriceSource>> {
    const ids = [...new Set(serviceIds)];
    const out = new Map<number, RetailPriceSource>();
    if (ids.length === 0) return out;
    const groupId = (await this.retailGroupId(db)) ?? null;
    const prices = await this.retailPrices(db, ids, groupId);
    const follows = await followsOf(db, ids);
    const rules = await ruleRowsOf(
      db,
      [...follows.values()].flatMap((follow) => (follow.ruleId === null ? [] : [follow.ruleId])),
    );
    const waiting = await waitingProposalsOf(db, ids);
    for (const id of ids) {
      const follow = follows.get(id);
      if (!prices.has(id)) {
        out.set(id, { source: null, rule: null, waiting: false });
        continue;
      }
      const row = follow?.ruleId == null ? undefined : rules.get(follow.ruleId);
      out.set(id, {
        source: follow ? 'rule' : 'manual',
        rule: row ? { id: row.rule.id, label: retailRuleOf(row).label } : null,
        waiting: waiting.has(id),
      });
    }
    return out;
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
