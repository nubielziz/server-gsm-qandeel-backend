// The row of the console's price grid as pure functions (decision 063): what a service costs, what each price leaves over the cost and
// what each merchant group pays. The group prices come from the price resolver's own result; nothing here prices anything.
import type { Money } from '../../../common/money';
import type { PriceResolution } from './price-resolution';

/**
 * Where a shop price comes from on the grid: a rule worked it out (`rule`), or a person typed it (`manual`). The words of the service
 * rows (decision 060) and of the retail pricing: one word for one fact on every wire.
 */
export type GridRetailSource = 'rule' | 'manual';

/** What the grid reads of a service row (the list's own figures: the same SQL, the same floor). */
export interface GridService {
  readonly id: number;
  readonly name: string;
  readonly code: string;
  readonly status: 'active' | 'disabled';
  readonly sort: number;
  readonly categoryId: number;
  /** The first active supplier link by priority, or `null`. */
  readonly supplier: { readonly id: number; readonly name: string } | null;
  /** The effective cost; zero means that nothing records a cost yet. */
  readonly effectiveCost: Money;
  /** The older cost when it rose since the base price was set, or `null`. */
  readonly costChangedFrom: Money | null;
  readonly basePrice: Money;
  readonly floorPrice: Money;
  readonly belowFloor: boolean;
}

/** The shop price of a service as the retail pricing reads it (`manual` is a typed price). */
export interface GridRetail {
  readonly price: Money | null;
  readonly source: GridRetailSource | null;
}

/** One merchant group's column of a row: its stored fixed price and what the resolver gives the group today. */
export interface GridGroupInput {
  readonly groupId: number;
  /** The stored group price, or `null` when the group pays the base price less its discount. */
  readonly fixedPrice: Money | null;
  /** The resolver's answer for this service and group (no merchant). */
  readonly resolution: PriceResolution;
}

/** The inputs of {@link gridRow}. */
export interface GridRowInput {
  readonly service: GridService;
  readonly retail: GridRetail;
  /** One entry per merchant group, in the order the grid's columns follow. */
  readonly groups: readonly GridGroupInput[];
}

/** One cell of a merchant group on the wire. */
export interface GridGroupPrice {
  readonly groupId: number;
  readonly fixedPrice: string | null;
  readonly price: string;
  readonly margin: string | null;
}

/** One row of `GET /admin/services/price-grid` as the contract describes it. */
export interface PriceGridRow {
  readonly id: number;
  readonly name: string;
  readonly code: string;
  readonly status: 'active' | 'disabled';
  readonly sort: number;
  readonly categoryId: number;
  readonly supplier: { readonly id: number; readonly name: string } | null;
  readonly cost: string | null;
  readonly costChangedFrom: string | null;
  readonly basePrice: string;
  readonly baseMargin: string | null;
  readonly floorPrice: string;
  readonly belowFloor: boolean;
  readonly retailPrice: string | null;
  readonly retailPriceSource: GridRetailSource | null;
  readonly retailMargin: string | null;
  readonly groupPrices: GridGroupPrice[];
}

/**
 * Tells whether a cost is on record.
 *
 * Why: a service starts with a cost of zero until a supplier is linked or imported (`POST /admin/services`), and the resolver then
 * says "No cost on record"; a margin over that zero would be the whole price, which is not a margin.
 *
 * @param cost the effective cost
 * @returns true when the cost is above zero
 */
export function costIsKnown(cost: Money): boolean {
  return cost.isPositive();
}

/**
 * What a price leaves over the cost.
 *
 * @param price a price
 * @param cost the effective cost
 * @returns `price - cost` (negative when the price is under the cost), or `null` when the cost is not on record
 */
export function marginOver(price: Money, cost: Money): Money | null {
  return costIsKnown(cost) ? price.sub(cost) : null;
}

/**
 * Builds the row of one service.
 *
 * Why: decision 063: the console's price grid shows, per service, the cost and what each price leaves over it. The price of a merchant
 * group is the resolver's result (`price`), never a second formula; its margin is the resolver's `price - cost`. A cost that is not on
 * record gives `cost` and every margin as `null`, and a price never gets a margin the cost cannot back.
 *
 * @param input the service, its shop price and the resolver's answer for each merchant group
 * @returns the row as it goes on the wire
 */
export function gridRow(input: GridRowInput): PriceGridRow {
  const { service, retail, groups } = input;
  const known = costIsKnown(service.effectiveCost);
  return {
    id: service.id,
    name: service.name,
    code: service.code,
    status: service.status,
    sort: service.sort,
    categoryId: service.categoryId,
    supplier: service.supplier,
    cost: known ? service.effectiveCost.toWire() : null,
    costChangedFrom: known ? (service.costChangedFrom?.toWire() ?? null) : null,
    basePrice: service.basePrice.toWire(),
    baseMargin: marginOver(service.basePrice, service.effectiveCost)?.toWire() ?? null,
    floorPrice: service.floorPrice.toWire(),
    belowFloor: service.belowFloor,
    retailPrice: retail.price?.toWire() ?? null,
    retailPriceSource: retail.price === null ? null : retail.source,
    retailMargin: retail.price === null ? null : (marginOver(retail.price, service.effectiveCost)?.toWire() ?? null),
    groupPrices: groups.map(({ groupId, fixedPrice, resolution }) => ({
      groupId,
      fixedPrice: fixedPrice?.toWire() ?? null,
      price: resolution.price.toWire(),
      margin: known ? resolution.margin.toWire() : null,
    })),
  };
}
