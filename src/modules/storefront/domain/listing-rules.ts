// The rules of the storefront listings (feature 15, B53, b2c-7): which services can never be public, and the retail price against
// its floor. Pure functions; the SQL twin of `lockOf` is in infra/foreign-reads.repository.ts and a test keeps them equal.
import { Money } from '../../../common/money';
import { dollars } from '../../catalog';

/** What the lock rule needs to know about a service and its category. */
export interface LockInput {
  readonly serviceStatus: string;
  readonly categoryName: string;
  /** The merchant groups that can see the category; an empty list means every group. */
  readonly categoryAllowedGroupIds: readonly number[];
  /** The storefront retail group, or `undefined` when it does not exist. */
  readonly retailGroupId: number | undefined;
}

/** The outcome of {@link lockOf}. */
export interface Lock {
  readonly locked: boolean;
  readonly reason: string | null;
}

/**
 * Tells whether a service can never go on the public storefront, and why.
 *
 * Why: MISMATCHES B53 (accepted): no column marks a service that is never public, so it is locked when its category's
 * `allowed_group_ids` excludes the retail group ("B2B only") or when the service is disabled ("Service disabled"), following
 * the demo's unlisted reasons. A category visible to every group (an empty list) is open to the storefront.
 *
 * @param input the service status and its category's group list
 * @returns whether it is locked and the words for staff (without a final full stop)
 */
export function lockOf(input: LockInput): Lock {
  const excluded =
    input.categoryAllowedGroupIds.length > 0 &&
    (input.retailGroupId === undefined || !input.categoryAllowedGroupIds.includes(input.retailGroupId));
  if (excluded) {
    return {
      locked: true,
      reason: `B2B only: the category ${input.categoryName} is not offered to storefront customers`,
    };
  }
  if (input.serviceStatus !== 'active') return { locked: true, reason: 'Service disabled' };
  return { locked: false, reason: null };
}

/**
 * Writes the detail of a 409 `LISTING_LOCKED` answer.
 *
 * @param reason the lock reason from {@link lockOf}
 * @returns the sentence staff read in the dialog
 */
export function lockedDetail(reason: string): string {
  return `${reason}. This service cannot be listed publicly.`;
}

/**
 * Writes the sentence a retail price under its floor is refused with.
 *
 * Why: RESOLUTIONS catalog-12 uses `Below the storefront floor of $X.` for the retail row of the group prices; the listing
 * route answers with the same words so the two routes never disagree.
 *
 * @param floor the storefront floor
 * @returns the message for the `retailPrice` field
 */
export function belowStorefrontFloorMessage(floor: Money): string {
  return `Below the storefront floor of ${dollars(floor)}.`;
}

/**
 * Judges a retail price against the floor.
 *
 * @param price the price staff sent
 * @param floor the storefront floor of the service
 * @returns `null` when the price can be saved, else the message for the `retailPrice` field
 */
export function retailPriceProblem(price: Money, floor: Money): string | null {
  if (!price.isPositive()) return 'Enter a price greater than zero.';
  return price.cmp(floor) < 0 ? belowStorefrontFloorMessage(floor) : null;
}
