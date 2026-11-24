// SearchCards: the display part of a search card (feature 29, plan section 5.2): slug, title, brand, network and picture of a service's
// English listing, cached 30 seconds per service. Prices, availability and the searchable rule are never here: they are read on every request.
import { Injectable } from '@nestjs/common';
import { CacheKeys, CacheService } from '../../../../infra/cache';
import type { DbExecutor } from '../../../../infra/db';
import { PublicImages } from '../../../platform';
import { englishListingRows } from '../infra/search-read.repository';
import { SEARCH_CACHE_VERSION } from './search-synonym-push';

const TTL_SECONDS = 30;

/** What a card shows of a listing and nothing that decides. */
export interface CardFacts {
  readonly slug: string;
  readonly title: string;
  readonly brand: string;
  readonly network: string;
  readonly imageUrl: string | null;
}

/**
 * Reads the display facts of services' English listings, through a short cache.
 *
 * Why: a typing visitor sends a request every 150 ms; the same few services are on screen, so their titles and pictures are read once
 * per 30 seconds. The cache holds display text only: whether a service may be shown, its price and its stock are read on every request
 * (a cached card must never decide, decision 038 "every hit is re-checked").
 *
 * Side effects: `gsm:{env}:storefront:search-card:{serviceId}:v{search}` (30 s, +-15 %); on a miss one listing query and one picture query
 * for all the missing services of the call.
 */
@Injectable()
export class SearchCards {
  constructor(
    private readonly cache: CacheService,
    private readonly keys: CacheKeys,
    private readonly images: PublicImages,
  ) {}

  /**
   * Reads the card facts of some services.
   *
   * @param db the database or a transaction
   * @param serviceIds the services
   * @returns the facts by service id; a service without a switched-on English listing is absent
   */
  async facts(db: DbExecutor, serviceIds: readonly number[]): Promise<Map<number, CardFacts>> {
    const ids = [...new Set(serviceIds)];
    let batch: Promise<Map<number, CardFacts>> | undefined;
    // One read for every service the cache misses, however many loaders ask.
    const read = () => (batch ??= this.read(db, ids));
    const found = await Promise.all(
      ids.map(async (id) => {
        const key = await this.cache.versioned(SEARCH_CACHE_VERSION, this.keys.searchCard(id));
        const facts = await this.cache.getOrLoad<CardFacts | null>(
          key,
          TTL_SECONDS,
          async () => (await read()).get(id) ?? null,
        );
        return [id, facts] as const;
      }),
    );
    return new Map(found.flatMap(([id, facts]) => (facts === null ? [] : [[id, facts] as const])));
  }

  private async read(db: DbExecutor, ids: readonly number[]): Promise<Map<number, CardFacts>> {
    const rows = await englishListingRows(db, ids);
    const urls = await this.images.urlsOf(
      db,
      [...rows.values()].map((row) => row.imageFileId),
    );
    return new Map(
      [...rows].map(([id, row]) => [
        id,
        {
          slug: row.slug,
          title: row.publicTitle,
          brand: row.brand,
          network: row.carrier,
          imageUrl: row.imageFileId === null ? null : (urls.get(row.imageFileId) ?? null),
        },
      ]),
    );
  }
}
