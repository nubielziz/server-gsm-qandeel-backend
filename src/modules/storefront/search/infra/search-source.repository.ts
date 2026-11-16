// Reads of the storefront's own tables that the search documents are built from (feature 29, plan section 4.1): the English listing
// rows of some services. Catalog facts come through catalog's public StorefrontServices.
import { and, eq, inArray } from 'drizzle-orm';
import type { DbExecutor } from '../../../../infra/db';
import { serviceListings } from '../../db/schema';

/** The English listing facts a search document needs. */
export interface EnglishListingRow {
  readonly serviceId: number;
  readonly publicTitle: string;
  readonly summary: string;
  readonly brand: string;
  readonly carrier: string;
  readonly country: string;
  readonly isListed: boolean;
  readonly isFeatured: boolean;
  readonly sort: number;
  readonly sales30d: number;
  readonly listedAt: Date | null;
  readonly createdAt: Date;
}

/**
 * Reads the English listings of some services.
 *
 * Why: plan section 4.1: cards and documents are built only from English listing rows (the facts are equal on every language row,
 * the texts are not).
 *
 * @param db the database or a transaction
 * @param serviceIds the services
 * @returns the English listing of each service that has one, by service id
 */
export async function englishListingsOf(
  db: DbExecutor,
  serviceIds: readonly number[],
): Promise<Map<number, EnglishListingRow>> {
  if (serviceIds.length === 0) return new Map();
  const rows = await db
    .select({
      serviceId: serviceListings.serviceId,
      publicTitle: serviceListings.publicTitle,
      summary: serviceListings.summary,
      brand: serviceListings.brand,
      carrier: serviceListings.carrier,
      country: serviceListings.country,
      isListed: serviceListings.isListed,
      isFeatured: serviceListings.isFeatured,
      sort: serviceListings.sort,
      sales30d: serviceListings.sales30d,
      listedAt: serviceListings.listedAt,
      createdAt: serviceListings.createdAt,
    })
    .from(serviceListings)
    .where(and(eq(serviceListings.locale, 'en'), inArray(serviceListings.serviceId, [...new Set(serviceIds)])));
  return new Map(rows.map((row) => [row.serviceId, row]));
}
