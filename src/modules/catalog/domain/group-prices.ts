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
 * Tells whether a saved set leaves the retail row as the dialog loaded it.
 *
 * Why: decision 040 and the final review of feature 31: the dialog sends every box back, so a retail figure that a follow pass or a
 * publish changed after the dialog opened would read as a price staff typed. What the dialog loaded (`retailPriceSeen` of the route) tells
 * the two apart: the same figure, or no row when none was loaded, means nobody touched the retail box.
 *
 * @param rows the set as sent
 * @param retailGroupId the storefront's retail group
 * @param seen the retail price the dialog loaded, or `null` when it loaded none
 * @returns true when the retail row of the set is what the dialog loaded
 */
export function retailRowUntouched(
  rows: readonly GroupPriceInput[],
  retailGroupId: number,
  seen: Money | null,
): boolean {
  const sent = rows.find((row) => row.groupId === retailGroupId)?.price ?? null;
  return sent === null || seen === null ? sent === seen : sent.eq(seen);
}

/**
 * Puts the stored retail row in place of the one a set carries.
 *
 * Why: see {@link retailRowUntouched}: a retail box nobody touched changes nothing, whatever the stored row became since the dialog
 * opened: a price the follow pass moved stays and keeps following, and a price a publish set is not deleted. No row stored, no row kept.
 *
 * @param rows the set as sent
 * @param retailGroupId the storefront's retail group
 * @param stored the retail row the service has now, or `undefined`
 * @returns the rows to write: the other groups' as sent, then the stored retail row
 */
export function keepStoredRetailRow<T extends { readonly groupId: number }>(
  rows: readonly T[],
  retailGroupId: number,
  stored: T | undefined,
): T[] {
  return [...rows.filter((row) => row.groupId !== retailGroupId), ...(stored === undefined ? [] : [stored])];
}

/**
 * Finds every problem of a set of group prices.
 *
 * Why: RESOLUTIONS catalog-11 and catalog-12: a group listed twice is `422` on the later row's `groupId` ("Listed twice"); an
 * unknown group is `422` on its `groupId`; each merchant group row must be at or above the floor of that group (effective cost
 * plus the minimum profit that counts for it); the storefront row (`b2c_retail`) at or above `max(round(base price x 1.10, 2),
 * floor)`. The whole set is judged, unchanged rows included, and all problems are reported together. The one exception is the
 * group named by `keptGroupId`: its row is not written (the stored one stays, {@link keepStoredRetailRow}), so its figure is not judged.
 *
 * @param rows the set, in the order the console sent it
 * @param groups the groups that exist, by id
 * @param floors the floor of the service for each existing group, by id
 * @param basePrice the service's base price (the storefront floor starts from it)
 * @param keptGroupId the group whose stored price stays, if any
 * @returns the problems with their dotted paths, empty when the set can be saved
 */
export function groupPriceProblems(
  rows: readonly GroupPriceInput[],
  groups: ReadonlyMap<number, GroupInfo>,
  floors: ReadonlyMap<number, GroupFloor>,
  basePrice: Money,
  keptGroupId?: number,
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
    if (row.groupId === keptGroupId) return;
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
