// FacetLabels: the display names of brands, networks and categories for the filter chips and the facet counts (feature 29, plan section
// 5.3). Brand and carrier are free text whose case varies; the engine counts their lower-cased keys, and the wire shows the most frequent
// spelling of each. Cached 10 minutes (display only, never a decision).
import { Injectable } from '@nestjs/common';
import { CacheKeys, CacheService } from '../../../../infra/cache';
import { DbService } from '../../../../infra/db';
import { StorefrontServices } from '../../../catalog';
import { enabledSynonyms } from '../infra/search-tables.repository';
import { brandAndCarrierSpellings } from '../infra/search-read.repository';
import { fold } from '../domain/did-you-mean';
import { normaliseText } from '../domain/normalise';
import { listedServiceIds } from '../../infra/listing.repository';
import type { FacetLabels } from '../domain/suggest-assembly';
import { SearchableIds } from './searchable-ids';
import { SEARCH_CACHE_VERSION } from './search-synonym-push';

const TTL_SECONDS = 600;

/** The cacheable form of {@link FacetLabels}: lists of pairs, because a Map is not JSON. */
interface StoredLabels {
  readonly brands: ReadonlyArray<readonly [string, string]>;
  readonly networks: ReadonlyArray<readonly [string, string]>;
  readonly categories: ReadonlyArray<readonly [number, string]>;
  /** Every folded word of every enabled synonym term (the did-you-mean never flags them). */
  readonly synonymWords: readonly string[];
  /** The folded words of each multi-word enabled synonym term. */
  readonly synonymPhrases: ReadonlyArray<readonly string[]>;
}

/** What the search routes read besides the engine: display names and the enabled synonyms' words. */
export interface SearchLabels extends FacetLabels {
  readonly synonymWords: ReadonlySet<string>;
  readonly synonymPhrases: ReadonlyArray<readonly string[]>;
}

/**
 * Reads and caches the facet labels.
 *
 * Why: plan section 5.3: "the most frequent spelling per `lower(value)` among English listed listings, from one cached Postgres read" so
 * `Samsung` and `SAMSUNG` are one entry with the summed count; categories come from the same list the menu shows. The enabled synonyms'
 * words ride along (they change with the same `search` version bump), for the did-you-mean.
 *
 * Side effects: one cached key, `gsm:{env}:storefront:search-facet-labels:v{search}` (10 minutes, +-15 %).
 */
@Injectable()
export class SearchFacetLabels {
  constructor(
    private readonly db: DbService,
    private readonly cache: CacheService,
    private readonly keys: CacheKeys,
    private readonly searchable: SearchableIds,
    private readonly services: StorefrontServices,
  ) {}

  /**
   * Reads the labels.
   *
   * @returns brand, network and category labels by lower-cased key (category by id)
   */
  async read(): Promise<SearchLabels> {
    const key = await this.cache.versioned(SEARCH_CACHE_VERSION, this.keys.searchFacetLabels());
    const stored = await this.cache.getOrLoad<StoredLabels>(key, TTL_SECONDS, () => this.load());
    return {
      brands: new Map(stored.brands),
      networks: new Map(stored.networks),
      categories: new Map(stored.categories),
      synonymWords: new Set(stored.synonymWords),
      synonymPhrases: stored.synonymPhrases,
    };
  }

  private async load(): Promise<StoredLabels> {
    const db = this.db.db;
    const spellings = await brandAndCarrierSpellings(db);
    const best = (field: 'brand' | 'carrier') => {
      const byKey = new Map<string, { spelling: string; uses: number }>();
      for (const row of spellings.filter((entry) => entry.field === field)) {
        const key = row.spelling.trim().replace(/\s+/g, ' ').toLowerCase();
        const current = byKey.get(key);
        // The most used spelling wins; a tie goes to the one that sorts first, so two workers agree.
        if (!current || row.uses > current.uses || (row.uses === current.uses && row.spelling < current.spelling)) {
          byKey.set(key, { spelling: row.spelling.trim().replace(/\s+/g, ' '), uses: row.uses });
        }
      }
      return [...byKey].map(([key, value]) => [key, value.spelling] as const);
    };
    const groupId = await this.searchable.retailGroupId(db);
    let categories: Array<readonly [number, string]> = [];
    if (groupId !== undefined) {
      const ids = await this.services.priced(db, groupId);
      const listed = await listedServiceIds(db, ids);
      categories = (await this.services.categoriesOf(db, [...listed])).map((row) => [row.id, row.name] as const);
    }
    const terms = (await enabledSynonyms(db)).flatMap((row) => [...row.terms, ...(row.root ? [row.root] : [])]);
    const phrases = terms.map((term) =>
      normaliseText(term)
        .split(' ')
        .map(fold)
        .filter((word) => word !== ''),
    );
    return {
      brands: best('brand'),
      networks: best('carrier'),
      categories,
      synonymWords: [...new Set(phrases.flat())],
      synonymPhrases: phrases.filter((words) => words.length > 1),
    };
  }
}
