// Choosing the supplier service an order goes to (resolutions orders-suppliers-11 and -12, user rule 9 / B117 (6)), and the reason a
// waiting order stops for when none can take it (decision 069 for a service delivered from code stock). Pure.
import { Money } from '../../../common/money';

/** A supplier service a service is linked to, with what the choice needs to know. */
export interface RoutingLink {
  readonly linkId: number;
  readonly priority: number;
  readonly supplierId: number;
  readonly supplierName: string;
  readonly supplierStatus: 'active' | 'disabled' | 'paused';
  readonly supplierServiceId: number;
  /** False once a sync no longer sees the service at the supplier. */
  readonly available: boolean;
  /** The price in supplier credits (4 decimals). */
  readonly credit: string;
  /** The base-currency value of one supplier credit (8 decimals). */
  readonly creditRate: string;
}

/**
 * What one unit costs through a link, in USD.
 *
 * Why: orders-suppliers-12 and -13: `credit x credit_rate`, rounded to four decimals (the same formula as the effective cost).
 *
 * @param link the link
 * @returns the unit cost
 */
export function linkUnitCost(link: Pick<RoutingLink, 'credit' | 'creditRate'>): Money {
  return Money.of(link.credit).mul(link.creditRate);
}

/** Why no link could take an order. */
export type NoLinkReason = 'no_link' | 'supplier_unavailable' | 'costs_more';

/** The answer of {@link pickLink}. */
export type LinkChoice =
  | { readonly ok: true; readonly link: RoutingLink; readonly unitCost: Money }
  | { readonly ok: false; readonly reason: NoLinkReason; readonly message: string };

/**
 * Picks the first eligible link by priority for an automatic dispatch.
 *
 * Why: orders-suppliers-11 and user rule 9 (B117 (6)): the dispatch job takes the first active link whose supplier is `active`
 * (not paused, not disabled), whose service the supplier still lists, and whose unit cost is not above the price the merchant was
 * charged for one unit; it never fails over to a costlier link, the order goes to `needs_attention` with the reason instead.
 *
 * @param links the service's active links, ordered by priority then id
 * @param unitPrice the price charged for one unit of the order
 * @returns the chosen link and its unit cost, or why none fits
 */
export function pickLink(links: readonly RoutingLink[], unitPrice: Money): LinkChoice {
  if (links.length === 0) {
    return { ok: false, reason: 'no_link', message: 'No active supplier is linked to this service.' };
  }
  const usable = links.filter((link) => link.supplierStatus === 'active' && link.available);
  if (usable.length === 0) {
    return {
      ok: false,
      reason: 'supplier_unavailable',
      message: 'Every supplier linked to this service is paused or disabled, or no longer offers it.',
    };
  }
  for (const link of usable) {
    const unitCost = linkUnitCost(link);
    if (unitCost.cmp(unitPrice) <= 0) return { ok: true, link, unitCost };
  }
  const cheapest = usable.map(linkUnitCost).reduce((low, cost) => (cost.cmp(low) < 0 ? cost : low));
  return {
    ok: false,
    reason: 'costs_more',
    message: `Every available supplier costs more than the price charged (cheapest ${cheapest.toWire()}, charged ${unitPrice.toWire()}).`,
  };
}

/** The reason of an order of a service delivered from code stock that no supplier can take (decision 069). */
export const NO_STOCK_NO_SUPPLIER_MESSAGE = 'No codes in stock and no supplier: deliver it by hand.';

/**
 * The reason an automatic order stops in `needs_attention` for when no link could take it.
 *
 * Why: decision 069: an order of a service delivered from code stock reaches the dispatch only when its stock was short at placement;
 * with no usable supplier (`no_link`, `supplier_unavailable`) staff deliver it by hand, so the reason says that rather than naming a
 * missing supplier. A usable supplier that costs more than the price charged (`costs_more`) keeps its own reason, and so does every
 * order of any other service.
 *
 * @param choice why {@link pickLink} found no link, and its message
 * @param stockDelivery the order's service is delivered from code stock
 * @returns the reason the order's `needs_attention` line carries
 */
export function noLinkReason(
  choice: { readonly reason: NoLinkReason; readonly message: string },
  stockDelivery: boolean,
): string {
  return stockDelivery && choice.reason !== 'costs_more' ? NO_STOCK_NO_SUPPLIER_MESSAGE : choice.message;
}
