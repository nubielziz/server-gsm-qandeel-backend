// Checks of a whole set of group prices (PUT /admin/services/:id/group-prices): unknown and repeated groups, and every price
// against the floor of its group. Pure: the use case hands it the groups and floors it loaded.
import type { Money } from '../../../common/money';
import { belowFloorMessage, storefrontFloor } from './price-resolution';
import type { ListProblem } from './service-parts';
import { dollars } from './service-figures';

/** One row of the set as the console sends it. */
export interface GroupPriceInput {
  readonly groupId: number;
  readonly price: Money;
}

/** What the check needs to know about a group. */
export interface GroupInfo {
  /** True for the storefront's single retail group (`b2c_retail`), which has its own floor. */
  readonly isRetail: boolean;
}

/** The floor of the service for one group. */
export interface GroupFloor {
  readonly cost: Money;
  readonly minProfit: Money;
  readonly floor: Money;
}

/**
 * Finds every problem of a set of group prices.
 *
 * Why: RESOLUTIONS catalog-11 and catalog-12: a group listed twice is `422` on the later row's `groupId` ("Listed twice"); an
 * unknown group is `422` on its `groupId`; each merchant group row must be at or above the floor of that group (effective cost
 * plus the minimum profit that counts for it); the storefront row (`b2c_retail`) at or above `max(round(base price x 1.10, 2),
 * floor)`. The whole set is judged, unchanged rows included, and all problems are reported together.
 *
 * @param rows the set, in the order the console sent it
 * @param groups the groups that exist, by id
 * @param floors the floor of the service for each existing group, by id
 * @param basePrice the service's base price (the storefront floor starts from it)
 * @returns the problems with their dotted paths, empty when the set can be saved
 */
export function groupPriceProblems(
  rows: readonly GroupPriceInput[],
  groups: ReadonlyMap<number, GroupInfo>,
  floors: ReadonlyMap<number, GroupFloor>,
  basePrice: Money,
): ListProblem[] {
  const problems: ListProblem[] = [];
  const seen = new Set<number>();
  rows.forEach((row, index) => {
    const group = groups.get(row.groupId);
    if (!group) {
      problems.push({ field: `prices.${index}.groupId`, message: 'This group does not exist.' });
      return;
    }
    if (seen.has(row.groupId)) problems.push({ field: `prices.${index}.groupId`, message: 'Listed twice' });
    seen.add(row.groupId);
    const floor = floors.get(row.groupId);
    if (!floor) return;
    if (group.isRetail) {
      const storefront = storefrontFloor(basePrice, floor.floor);
      if (row.price.cmp(storefront) < 0) {
        problems.push({
          field: `prices.${index}.price`,
          message: `Below the storefront floor of ${dollars(storefront)}.`,
        });
      }
    } else if (row.price.cmp(floor.floor) < 0) {
      problems.push({ field: `prices.${index}.price`, message: belowFloorMessage(floor.cost, floor.minProfit) });
    }
  });
  return problems;
}
