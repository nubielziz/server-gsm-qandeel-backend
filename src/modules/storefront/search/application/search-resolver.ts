// SearchResolver: turns the engine's ids into services the shop may show now (feature 29, decision 038 "every hit is re-checked"): the
// searchable rule against Postgres, the English listing row and the retail price. A hit that fails any of them is dropped and counted.
import { Injectable } from '@nestjs/common';
import type { DbExecutor } from '../../../../infra/db';
import { SearchMetrics } from '../../../../infra/search';
import type { ServiceListing } from '../../db/schema';
import { type PricedService, type QuoteContext, StorefrontQuotes } from '../../application/storefront-quotes';
import { englishListingRows } from '../infra/search-read.repository';
import { SearchableIds } from './searchable-ids';

/** One hit that passed the re-check: its English listing and its retail price. */
export interface ResolvedHit {
  readonly listing: ServiceListing;
  readonly priced: PricedService;
}

/**
 * Re-checks hits against Postgres and prices the survivors.
 *
 * Why: the index is derived and can be a few seconds behind (a listing switched off, a price row removed): the API never shows or prices
 * from a document. The one rule is `SearchableIds` (sellable for the retail group, a retail price row, an English listing switched on);
 * the price is `StorefrontQuotes`' (so the checkout charges what the card showed), computed with `pricedSellable` so the sellable and
 * listing reads are not repeated.
 *
 * Side effects: reads only; `search_stale_hits_total` grows by the number of dropped hits.
 */
@Injectable()
export class SearchResolver {
  constructor(
    private readonly searchable: SearchableIds,
    private readonly quotes: StorefrontQuotes,
    private readonly metrics: SearchMetrics,
  ) {}

  /**
   * Resolves hits.
   *
   * @param db the database or a transaction
   * @param context the buyer's pricing context
   * @param ids the engine's ids, best first
   * @returns the hits that may be shown, in the engine's order
   */
  async resolve(db: DbExecutor, context: QuoteContext, ids: readonly number[]): Promise<ResolvedHit[]> {
    if (ids.length === 0) return [];
    const { services } = await this.searchable.of(db, ids, context.retailGroupId);
    const listings = await englishListingRows(db, [...services.keys()]);
    const priced = await this.quotes.pricedSellable(
      db,
      context,
      new Map([...services].filter(([id]) => listings.has(id))),
    );
    const out: ResolvedHit[] = [];
    for (const id of new Set(ids)) {
      const listing = listings.get(id);
      const price = priced.get(id);
      if (listing !== undefined && price !== undefined) out.push({ listing, priced: price });
    }
    const dropped = new Set(ids).size - out.length;
    if (dropped > 0) this.metrics.staleHits.inc(dropped);
    return out;
  }
}
