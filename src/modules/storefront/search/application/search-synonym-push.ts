// SearchSynonymPush: the synonym set push of the storefront search (feature 29, plan section 4.5): the rebuild pushes the whole synonym
// set from Postgres to Typesense before it creates a services collection that links it. Decision 068: the synonyms are shipped data
// (migration 0033), read only; nobody edits them, so the rebuild is the only push.
import { Injectable } from '@nestjs/common';
import { CacheService } from '../../../../infra/cache';
import { DbService } from '../../../../infra/db';
import { TypesenseClient } from '../../../../infra/search';
import { synonymItems } from '../domain/set-conversion';
import { enabledSynonyms } from '../infra/search-tables.repository';
import { SearchCollections } from './search-collections';

/** The cache version of everything the search caches (suggest answers, cards, facet labels; slice B2). */
export const SEARCH_CACHE_VERSION = 'search';

/**
 * Pushes the synonym set to the engine.
 *
 * Why: decision 038: synonyms live in Postgres and are pushed whole (replace), nothing is edited in Typesense by hand; the shop's search
 * applies the five shipped synonyms exactly as before decision 068. After a push the cache version `search` moves, so no cached suggest
 * answer keeps an older set.
 *
 * Side effects: `PUT /synonym_sets/<prefix>synonyms`; `CacheService.bumpVersion('search')`.
 */
@Injectable()
export class SearchSynonymPush {
  constructor(
    private readonly db: DbService,
    private readonly client: TypesenseClient,
    private readonly collections: SearchCollections,
    private readonly cache: CacheService,
  ) {}

  /**
   * Pushes every enabled synonym (the rebuild does it first, so a new collection's link points at the current set).
   *
   * @returns the items of the set
   * @throws {SearchUnavailable} | {SearchRejected} when the engine refuses (the rebuild is retried)
   */
  async push(): Promise<number> {
    const items = synonymItems(await enabledSynonyms(this.db.db));
    await this.client.putSynonymSet(this.collections.names.synonymSet, items);
    await this.cache.bumpVersion(SEARCH_CACHE_VERSION).catch(() => undefined);
    return items.length;
  }
}
