// Reads of the storefront's own tables that the public search routes need (feature 29, plan sections 5.2-5.3): the English listing rows of
// some services (the cards), the spellings of the brand and carrier names (the facet labels) and the services of a page's hits.
import { and, eq, inArray, sql } from 'drizzle-orm';
import type { DbExecutor } from '../../../../infra/db';
import { type ServiceListing, serviceListings } from '../../db/schema';

/**
 * Reads the switched-on English listing rows of some services.
 *
 * Why: cards are built only from English listing rows (plan section 4.1); a service whose English listing is off has no card even if the
 * engine still holds its document (the re-check drops it first, this read is the second guard).
 *
 * @param db the database or a transaction
 * @param serviceIds the services
 * @returns the rows by service id
 */
export async function englishListingRows(
  db: DbExecutor,
  serviceIds: readonly number[],
): Promise<Map<number, ServiceListing>> {
  if (serviceIds.length === 0) return new Map();
  const rows = await db
    .select()
    .from(serviceListings)
    .where(
      and(
        eq(serviceListings.locale, 'en'),
        eq(serviceListings.isListed, true),
        inArray(serviceListings.serviceId, [...new Set(serviceIds)]),
      ),
    );
  return new Map(rows.map((row) => [row.serviceId, row]));
}

/** One spelling of a brand or carrier name with how many English listed listings use it. */
export interface SpellingRow {
  readonly field: 'brand' | 'carrier';
  readonly spelling: string;
  readonly uses: number;
}

/**
 * Counts the spellings of the brand and carrier names of the English listed listings.
 *
 * Why: plan section 5.3: brand and carrier are free text whose case varies; the facets count `lower(value)`, and the wire shows the most
 * frequent spelling of each.
 *
 * @param db the database or a transaction
 * @returns each non-empty spelling with its use count
 */
export async function brandAndCarrierSpellings(db: DbExecutor): Promise<SpellingRow[]> {
  const brands = await db
    .select({ spelling: serviceListings.brand, uses: sql<number>`count(*)::int` })
    .from(serviceListings)
    .where(
      and(eq(serviceListings.locale, 'en'), eq(serviceListings.isListed, true), sql`${serviceListings.brand} <> ''`),
    )
    .groupBy(serviceListings.brand);
  const carriers = await db
    .select({ spelling: serviceListings.carrier, uses: sql<number>`count(*)::int` })
    .from(serviceListings)
    .where(
      and(eq(serviceListings.locale, 'en'), eq(serviceListings.isListed, true), sql`${serviceListings.carrier} <> ''`),
    )
    .groupBy(serviceListings.carrier);
  return [
    ...brands.map((row) => ({ field: 'brand' as const, ...row })),
    ...carriers.map((row) => ({ field: 'carrier' as const, ...row })),
  ];
}
