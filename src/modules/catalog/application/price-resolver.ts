// PriceResolver: the one public price resolver of the catalog (user rule 8, RESOLUTIONS catalog-4). It loads what a resolution
// needs and runs the pure rules of domain/price-resolution.ts. Used by GET /admin/pricing/resolve, the client and group price
// checks, the merchant catalog and price export, and (later) orders, the Dhru and REST v1 lists and the storefront listings.
import { Inject, Injectable } from '@nestjs/common';
import { CLOCK, type Clock } from '../../../common/clock';
import type { DbExecutor } from '../../../infra/db';
import {
  type PriceResolution,
  type PricedGroup,
  type PricedService,
  floorFor,
  resolveServicePrice,
} from '../domain/price-resolution';
import { type LoadedPricing, type PricedGroupRow, loadPricing } from '../infra/pricing-data.repository';
import type { Money } from '../../../common/money';

/** What to resolve: a service for a merchant group, optionally for one merchant (its client price wins). */
export interface PriceRequest {
  readonly serviceId: number;
  /** The merchant's group; `null` prices without a merchant (no group price, no discount, rules for every group only). */
  readonly groupId: number | null;
  /** The merchant whose fixed price counts; `null` or left out ignores client prices. */
  readonly clientId?: number | null;
}

/** What to load into a {@link PricingContext}. */
export interface ContextOptions {
  readonly serviceIds: readonly number[];
  /** Merchants whose client prices may be asked for. */
  readonly clientIds?: readonly number[];
  /** The moment rule windows are judged at; the injected clock's now by default. */
  readonly at?: Date;
}

/** The floor of a service for a group. */
export interface FloorQuote {
  readonly cost: Money;
  readonly minProfit: Money;
  readonly floor: Money;
}

/**
 * Loaded pricing data with the resolution functions on top, so one load answers many questions (the price for a merchant and
 * for every other group; the floors of the rows of a group-price save).
 *
 * Why: the admin resolve page, the client price list and the catalog lists ask several questions about the same services;
 * loading once keeps them to a fixed number of queries.
 */
export class PricingContext {
  constructor(
    private readonly data: LoadedPricing,
    readonly at: Date,
  ) {}

  /**
   * The service as the resolver reads it.
   *
   * @param serviceId the service
   * @returns the service, or `undefined` when it is unknown or archived
   */
  service(serviceId: number): PricedService | undefined {
    return this.data.services.get(serviceId);
  }

  /**
   * A merchant group.
   *
   * @param groupId the group
   * @returns the group, or `undefined` when it does not exist
   */
  group(groupId: number): PricedGroup | undefined {
    return this.data.groups.get(groupId);
  }

  /**
   * The merchant groups (`kind` `b2b`), by id: what the "other groups" table lists.
   *
   * @returns the groups in id order
   */
  merchantGroups(): PricedGroupRow[] {
    return [...this.data.groups.values()].filter((group) => group.kind === 'b2b').sort((a, b) => a.id - b.id);
  }

  /**
   * Resolves one request.
   *
   * @param request the service, the merchant group and optionally the merchant
   * @returns the resolution, or `undefined` when the service is unknown or archived
   */
  resolve(request: PriceRequest): PriceResolution | undefined {
    const service = this.data.services.get(request.serviceId);
    if (!service) return undefined;
    const group = request.groupId === null ? null : (this.data.groups.get(request.groupId) ?? null);
    const clientPrice =
      request.clientId == null ? null : (this.data.clientPrices.get(`${service.id}|${request.clientId}`) ?? null);
    const groupPrice = group === null ? null : (this.data.groupPrices.get(`${service.id}|${group.id}`) ?? null);
    return resolveServicePrice({ service, group, clientPrice, groupPrice, rules: this.data.rules, at: this.at });
  }

  /**
   * The floor of a service for a group: effective cost plus the minimum profit that counts for that group.
   *
   * @param serviceId the service
   * @param groupId the merchant group, or `null` without a merchant
   * @param ownMinProfit the service's own minimum profit to use instead of the stored one (`null` = none, so rules and the
   *   default policy decide); leave it out to use the stored one. A service edit that changes `minProfit` asks with the new value.
   * @returns the cost, minimum profit and floor, or `undefined` when the service is unknown or archived
   */
  floor(serviceId: number, groupId: number | null, ownMinProfit?: Money | null): FloorQuote | undefined {
    const service = this.data.services.get(serviceId);
    if (!service) return undefined;
    const subject = ownMinProfit === undefined ? service : { ...service, minProfit: ownMinProfit };
    return { cost: service.effectiveCost, ...floorFor(subject, groupId, this.data.rules, this.at) };
  }
}

/**
 * Resolves prices.
 *
 * Why: RESOLUTIONS catalog-4 makes one resolver the authority for every price the system shows or charges, so the console, the
 * merchant lists, the group and client price checks and the order path never disagree. A price list is never the truth for a
 * charge: the order path resolves again inside its own transaction.
 *
 * Side effects: none (reads only).
 *
 * @see docs/contract/RULES.md (services 3)
 */
@Injectable()
export class PriceResolver {
  constructor(@Inject(CLOCK) private readonly clock: Clock) {}

  /**
   * Loads the pricing data of some services into a context.
   *
   * @param db the database or the caller's transaction
   * @param options the services, the merchants whose client prices matter, and the moment
   * @returns the context to resolve and floor with
   */
  async context(db: DbExecutor, options: ContextOptions): Promise<PricingContext> {
    const data = await loadPricing(db, {
      serviceIds: options.serviceIds,
      ...(options.clientIds === undefined ? {} : { clientIds: options.clientIds }),
    });
    return new PricingContext(data, options.at ?? this.clock.now());
  }

  /**
   * Resolves several prices with one load.
   *
   * @param db the database or the caller's transaction
   * @param requests what to resolve
   * @param at the moment rule windows are judged at (default: the clock's now)
   * @returns one resolution per request, in order; `undefined` for an unknown or archived service
   */
  async resolveMany(
    db: DbExecutor,
    requests: readonly PriceRequest[],
    at?: Date,
  ): Promise<Array<PriceResolution | undefined>> {
    const context = await this.context(db, {
      serviceIds: requests.map((request) => request.serviceId),
      clientIds: requests.flatMap((request) => (request.clientId == null ? [] : [request.clientId])),
      ...(at === undefined ? {} : { at }),
    });
    return requests.map((request) => context.resolve(request));
  }

  /**
   * Resolves one price.
   *
   * @param db the database or the caller's transaction
   * @param request the service, the merchant group and optionally the merchant
   * @param at the moment rule windows are judged at (default: the clock's now)
   * @returns the resolution, or `undefined` when the service is unknown or archived
   */
  async resolve(db: DbExecutor, request: PriceRequest, at?: Date): Promise<PriceResolution | undefined> {
    return (await this.resolveMany(db, [request], at))[0];
  }

  /**
   * The floor of a service for a group (and the storefront's b2c_retail group), the same function checkout and the listing
   * edits use.
   *
   * @param db the database or the caller's transaction
   * @param serviceId the service
   * @param groupId the merchant group, or `null` without a merchant
   * @param at the moment rule windows are judged at (default: the clock's now)
   * @returns the cost, minimum profit and floor, or `undefined` when the service is unknown or archived
   */
  async floor(db: DbExecutor, serviceId: number, groupId: number | null, at?: Date): Promise<FloorQuote | undefined> {
    return (await this.context(db, { serviceIds: [serviceId], ...(at === undefined ? {} : { at }) })).floor(
      serviceId,
      groupId,
    );
  }
}
