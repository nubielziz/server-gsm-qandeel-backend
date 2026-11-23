// What a caller may read of a service row beyond `catalog:read` (decision 060): the one rule the service list, show, create and
// change answers and the list's filters follow.
import type { ParsedListQuery } from '../../../common/contract';
import { type PermissionHolder, grants, missingPermission } from '../../identity';
import { ATTENTION_REASONS, type AttentionReason } from '../domain/service-attention';

/** The permission that opens the shop-page facts of a service row. */
export const LISTING_READ_PERMISSION = 'storefront:read';

/** The permission that opens the retail pricing facts of a service row. */
export const PRICING_READ_PERMISSION = 'pricing:read';

/**
 * The list filters that read shop-page facts: a caller without {@link LISTING_READ_PERMISSION} is refused when it sends one.
 *
 * Why: decision 060: a filter that is ignored would make a count disagree with the rows, and a filter that is applied would let a
 * caller probe facts it may not read.
 */
export const LISTING_FILTERS: readonly string[] = ['isListed', 'notOnShop'];

/** What a caller may read of a service row (decision 060). */
export interface ServiceReadAccess {
  /** `storefront:read`: `listingId`, `isListed`, `shopBlocked`, `publishFailure`, the reason `publish_failed` and the filters `isListed` and `notOnShop`. */
  readonly listing: boolean;
  /** `pricing:read`: `retailPriceRule`, `retailPriceWaiting` and the reason `price_proposal`. */
  readonly pricing: boolean;
  /** The attention reasons the caller may see, in the order of {@link ATTENTION_REASONS}; `needsAttention` is their union. */
  readonly reasons: readonly AttentionReason[];
}

/**
 * Decides what a caller may read of a service row.
 *
 * Why: decision 060: every `catalog:read` caller already sees the cost, the merchant price and the floor, and the shop price
 * through the detail's group prices, so `retailPrice` and `retailPriceSource` reach everyone. The shop page facts follow the
 * listing routes (`storefront:read`); the rule behind a price and a waiting proposal follow the retail price routes (`pricing:read`).
 *
 * @param caller the signed-in staff member
 * @returns the parts of the row the caller may read
 */
export function serviceReadAccess(caller: PermissionHolder): ServiceReadAccess {
  const listing = grants(caller.permissions, LISTING_READ_PERMISSION);
  const pricing = grants(caller.permissions, PRICING_READ_PERMISSION);
  const reasons = ATTENTION_REASONS.filter(
    (reason) => (reason !== 'price_proposal' || pricing) && (reason !== 'publish_failed' || listing),
  );
  return { listing, pricing, reasons };
}

/**
 * Refuses a list request whose filters the caller may not use, before any query is built.
 *
 * @param access the caller's access ({@link serviceReadAccess})
 * @param query the parsed list request
 * @throws {AppError} `FORBIDDEN` (403) naming `storefront:read` when `isListed` or `notOnShop` is sent without it
 */
export function assertListFiltersAllowed(access: ServiceReadAccess, query: Pick<ParsedListQuery, 'filters'>): void {
  if (access.listing) return;
  if (query.filters.some((filter) => LISTING_FILTERS.includes(filter.field))) {
    throw missingPermission(LISTING_READ_PERMISSION);
  }
}
