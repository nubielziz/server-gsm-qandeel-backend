// The rules of services sold as codes (decision 069): whether a service can be supplied now (a usable supplier, or, for a service
// delivered from code stock, an available code), the words of the two refusals that guard the stock, and the largest own cost. Pure.

/**
 * Whether a service can be fulfilled now: `ok` (a usable supplier, or a code in stock for a service delivered from code stock),
 * `no_link` (no active supplier link), `supplier_unavailable` (every active link's supplier is paused or disabled, or no longer lists
 * the service), `out_of_stock` (a service delivered from code stock with neither a usable supplier nor an available code).
 *
 * Why: plan 31 section 3.2 (`supplier_unavailable`) and decision 069 (`out_of_stock`): the shop never lists an automatic service whose
 * paid order would only wait for staff.
 */
export type SupplyState = 'ok' | 'no_link' | 'supplier_unavailable' | 'out_of_stock';

/** What {@link supplyStateOf} judges about one service. */
export interface SupplyFacts {
  /** The service has at least one active supplier link. */
  readonly activeLink: boolean;
  /** At least one active link's supplier is `active` and still lists the service (the rule of `pickLink` without its price test). */
  readonly usableLink: boolean;
  /** The service is delivered from code stock (`services.stock_delivery`). */
  readonly stockDelivery: boolean;
  /** How many of its codes are `available` now. */
  readonly availableCodes: number;
}

/**
 * Tells whether a service can be fulfilled now.
 *
 * Why: decision 069: the owner sells codes they own, with no supplier. A service delivered from code stock that has at least one
 * available code is supplied, whatever its links; with no usable supplier and no code it is `out_of_stock` (never
 * `supplier_unavailable`: the fix is to import codes, or link a supplier). Codes of any other service never count (it does not hold
 * any, and its orders never take one).
 *
 * @param facts the links and the stock of the service
 * @returns the supply state
 */
export function supplyStateOf(facts: SupplyFacts): SupplyState {
  if (facts.usableLink) return 'ok';
  if (facts.stockDelivery) return facts.availableCodes > 0 ? 'ok' : 'out_of_stock';
  return facts.activeLink ? 'supplier_unavailable' : 'no_link';
}

/**
 * The largest own cost staff may type (`ownCost`, `services.cost`): one billion, the largest supplier price used (decision 051).
 *
 * Why: decision 069: the floor (cost plus minimum profit) and the shop's price rules (cost x (1 + percent) + fixed) are worked out
 * from the cost in `numeric(18,4)`; a cost near the column's limit would overflow them and fail the request (a 500 in place of a 422).
 */
export const MAX_OWN_COST = '1000000000';

/** The refusal code of `PATCH /admin/services/:id` with `stockDelivery: false` while codes are available (field `stockDelivery`). */
export const CODES_IN_STOCK = 'codes_in_stock';

/** The refusal code of an import of codes into a service that is not delivered from code stock (field `codes`). */
export const NOT_STOCK_SERVICE = 'not_stock_service';

/** What staff read when they import codes into a service that is not delivered from code stock. */
export const NOT_STOCK_SERVICE_MESSAGE = 'Turn on Delivered from code stock for this service first.';

/**
 * What staff read when they turn "Delivered from code stock" off while codes are available.
 *
 * Why: decision 069: available codes of a service that no longer delivers from its stock would never be sold nor voided by anyone who
 * looks at the service, so they are voided first.
 *
 * @param count how many codes are available (1 or more)
 * @returns the sentence (`Void the 3 codes in stock first.`; one code is `Void the 1 code in stock first.`)
 */
export function codesInStockMessage(count: number): string {
  return `Void the ${String(count)} ${count === 1 ? 'code' : 'codes'} in stock first.`;
}
