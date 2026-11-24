// How many points of an API key's per-minute limit a call costs (decision 053): one, except a bulk placement, which costs one per item.
import { DHRU_MAX_BULK_ITEMS, bulkPlacementItems } from '../../../../../common/dhru';

/**
 * The cost of an API-key call in points of the key's per-minute limit.
 *
 * Why: decision 053. A call used to cost one point whatever it carried, and a bulk placement takes up to 100 orders (Dhru
 * `placeimeiorderbulk`), so one point could start a hundred orders. A bulk costs one point per item; the authenticator caps the charge at
 * the key's own limit, so the documented 100-item bulk still passes under the default 60 a minute. `getimeiorderbulk` only reads and stays
 * one point.
 *
 * @param routeKey the contract key (`POST /api/index.php`)
 * @param body the parsed request body
 * @returns the points, from 1 to {@link DHRU_MAX_BULK_ITEMS} (the item limit of a bulk)
 */
export function requestPoints(routeKey: string, body: unknown): number {
  const items = routeKey === 'POST /api/index.php' ? bulkPlacementItems(body) : 1;
  return Math.min(DHRU_MAX_BULK_ITEMS, Math.max(1, items));
}
