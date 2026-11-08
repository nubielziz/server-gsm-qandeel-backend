// Drizzle query of the landing-page generator on this module's own `service_listings`: the networks (carriers) the site sells.

import { asc, ne } from 'drizzle-orm';
import type { DbExecutor } from '../../../infra/db';
import { serviceListings } from '../db/schema';

/**
 * Lists the distinct carriers of the service listings.
 *
 * Why: `POST /admin/content-pages/generate` with no networks means every network on the site: the distinct, non-empty
 * `service_listings.carrier` (the endpoint doc).
 *
 * @param db the database or a transaction
 * @returns the carrier names, alphabetical
 */
export async function listCarriers(db: DbExecutor): Promise<string[]> {
  const rows = await db
    .selectDistinct({ carrier: serviceListings.carrier })
    .from(serviceListings)
    .where(ne(serviceListings.carrier, ''))
    .orderBy(asc(serviceListings.carrier));
  return rows.map((row) => row.carrier);
}
