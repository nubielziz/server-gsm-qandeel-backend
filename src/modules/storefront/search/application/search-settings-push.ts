// SearchSettingsPush: the `search_settings` job of the `search-index` queue (feature 29, plan section 4.5): pushes the whole synonym
// set or curation set from Postgres to Typesense, or, for hidden terms, drops the popular cache and rebuilds the terms.
import { Inject, Injectable } from '@nestjs/common';
import { APP_CONFIG, type AppConfig } from '../../../../config';
import { CacheKeys, CacheService } from '../../../../infra/cache';
import { DbService } from '../../../../infra/db';
import { QueuesService, queueJobId } from '../../../../infra/queues';
import { TypesenseClient } from '../../../../infra/search';
import { curationItems, synonymItems } from '../domain/set-conversion';
import { enabledPins, enabledSynonyms } from '../infra/search-tables.repository';
import { SEARCH_JOBS, type SearchSettingsKind } from './search-signals';
import { SearchCollections } from './search-collections';

/** The cache version of everything the search caches (suggest answers, cards, facet labels; slice B2). */
export const SEARCH_CACHE_VERSION = 'search';

/** What one push did. */
export interface SettingsPushResult {
  readonly kind: SearchSettingsKind | 'all' | 'disabled';
  /** Items put into the set (0 for hidden terms). */
  readonly items: number;
}

/**
 * Pushes the search settings to the engine.
 *
 * Why: decision 038: synonyms and pins live in Postgres and are pushed whole (replace), nothing is edited in Typesense by hand; every
 * pin rule carries `filter_curated_hits: true` and `remove_matched_tokens: false` (step 0). After a push the cache version `search`
 * moves, so no cached suggest answer keeps the old synonyms. A hidden-term change needs no engine call: the popular list drops its
 * cache and the terms collection is rebuilt without the term.
 *
 * Side effects: `PUT /synonym_sets/<prefix>synonyms`, `PUT /curation_sets/<prefix>curations`; `CacheService.bumpVersion('search')`;
 * deletes `gsm:{env}:storefront:search-popular`; enqueues `search_terms_build` (job id `terms-hidden-<event id>`).
 */
@Injectable()
export class SearchSettingsPush {
  constructor(
    private readonly db: DbService,
    private readonly client: TypesenseClient,
    private readonly collections: SearchCollections,
    private readonly cache: CacheService,
    private readonly keys: CacheKeys,
    private readonly queues: QueuesService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  /**
   * Applies one `search.settings_changed` event.
   *
   * @param kind what changed
   * @param eventId the outbox event (the terms build's job id)
   * @returns what was pushed
   * @throws {SearchUnavailable} | {SearchRejected} when the engine refuses (retried by the queue)
   * @throws {AppError} `UNAVAILABLE` when the queue Redis cannot take the terms build
   */
  async apply(kind: SearchSettingsKind, eventId: number): Promise<SettingsPushResult> {
    if (!this.config.search.enabled) return { kind: 'disabled', items: 0 };
    if (kind === 'synonyms') return { kind, items: await this.pushSynonyms() };
    if (kind === 'pins') return { kind, items: await this.pushPins() };
    await this.cache.del(this.keys.searchPopular());
    await this.queues.add(
      'maintenance',
      SEARCH_JOBS.termsBuild,
      { reason: 'hidden_terms' },
      {
        jobId: queueJobId('terms-hidden', eventId),
      },
    );
    return { kind, items: 0 };
  }

  /**
   * Pushes both sets (the rebuild does it first, so a new collection's links point at current sets).
   *
   * @returns the items of both sets
   * @throws {SearchUnavailable} | {SearchRejected}
   */
  async pushAll(): Promise<SettingsPushResult> {
    const items = (await this.pushSynonyms()) + (await this.pushPins());
    return { kind: 'all', items };
  }

  private async pushSynonyms(): Promise<number> {
    const items = synonymItems(await enabledSynonyms(this.db.db));
    await this.client.putSynonymSet(this.collections.names.synonymSet, items);
    await this.cache.bumpVersion(SEARCH_CACHE_VERSION).catch(() => undefined);
    return items.length;
  }

  private async pushPins(): Promise<number> {
    const items = curationItems(await enabledPins(this.db.db));
    await this.client.putCurationSet(this.collections.names.curationSet, items);
    await this.cache.bumpVersion(SEARCH_CACHE_VERSION).catch(() => undefined);
    return items.length;
  }
}
