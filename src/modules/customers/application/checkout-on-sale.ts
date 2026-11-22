// The sale check of the pay step of a storefront checkout (card page and store balance). The checkout locked its price when it opened; this
// only asks whether the shop still offers the service at all.
import { AppError } from '../../../common/errors';
import type { DbExecutor } from '../../../infra/db';
import type { StorefrontQuotes } from '../../storefront';

/**
 * Refuses the pay step of a checkout whose service is no longer on sale.
 *
 * Why: scenario b2c-paid steps 4 and 5: a checkout opened while the service was sellable, listed and priced keeps its locked price for
 * its whole life, but staff who switched the service off, took its listing down or removed its retail price must be able to stop new
 * money from being taken for it. A changed price is not a reason (the lock holds); the retail price only has to exist. Money that already
 * arrived is not judged here: the gateway's confirmation still places the order. A replay of an earlier pay call answers before this
 * check runs.
 *
 * @param quotes the storefront's quote rules (the one rule that decides what is on sale)
 * @param db the database or the pay step's transaction
 * @param serviceId the service of the checkout
 * @throws {AppError} `INVALID_TRANSITION` (409) when the shop has no retail group, or the service is not sellable, not listed or has no
 *   retail price
 *
 * Side effects: none (reads only).
 */
export async function assertServiceOnSale(quotes: StorefrontQuotes, db: DbExecutor, serviceId: number): Promise<void> {
  const retailGroupId = await quotes.retailGroupId(db);
  if (retailGroupId === undefined || !(await quotes.onSale(db, [serviceId], retailGroupId)).has(serviceId)) {
    throw new AppError('INVALID_TRANSITION', { detail: 'This service is no longer available. Start again.' });
  }
}
