// SuggestService: the use case of `GET /store/v1/search/suggest` (feature 29, plan section 5.2): what the shop header shows while a
// visitor types. One engine part (cached 30 s per typed text), then the Postgres re-check, the cards and the prices of the survivors.
import { createHash } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import { CLOCK, type Clock } from '../../../../common/clock';
import type { z } from 'zod';
import { CacheKeys, CacheService } from '../../../../infra/cache';
import { DbService } from '../../../../infra/db';
import { SearchMetrics } from '../../../../infra/search';
import type { FallbackReason } from '../../../../infra/search';
import { StorefrontServices } from '../../../catalog';
import { StorefrontQuotes } from '../../application/storefront-quotes';
import type { suggestStoreSearch } from '../contracts/store-search.contracts';
import { imeiIntent } from '../domain/imei-intent';
import { normaliseQuery, normaliseText } from '../domain/normalise';
import { nearbyServicesSearch, suggestServicesSearch, termsSearch, termsTypoSearch } from '../domain/ranking';
import {
  type EnginePart,
  type TermHitDocument,
  assembleEnginePart,
  highlightTitle,
  typedPrefix,
} from '../domain/suggest-assembly';
import { hiddenTermSet, popularCandidates } from '../infra/search-tables.repository';
import { quoteFilterValue } from '../domain/filters';
import { dayOf, isPopularQuery } from '../domain/terms';
import { POPULAR_WINDOW_DAYS } from './search-terms-build';
import { SearchFacetLabels } from './facet-labels';
import { SearchCards } from './search-cards';
import { SearchCollections } from './search-collections';
import { SearchEngine } from './search-engine';
import { SEARCH_CACHE_VERSION } from './search-settings-push';
import { SearchableIds } from './searchable-ids';
import type { SearchResult } from '../../../../infra/search';

type SuggestBody = z.output<(typeof suggestStoreSearch)['success']['schema']>;

const ENGINE_PART_TTL_SECONDS = 30;
const POPULAR_TTL_SECONDS = 600;
const MAX_POPULAR = 8;
const MAX_SERVICES = 6;
const POPULAR_CANDIDATES = 40;
const DAY_MS = 86_400_000;

/** Thrown out of the cached loader so a fallback is never cached: the caller turns it into the fallback answer. */
class FellBack extends Error {
  constructor(readonly reason: FallbackReason) {
    super('The search engine did not answer.');
  }
}

/** Thrown out of the popular loader when only a peek was wanted (the fallback never reads Postgres or the engine). */
class NothingCached extends Error {}

/**
 * Serves the search-as-you-type route.
 *
 * Why: decision 038: the engine suggests (completions, the ghost, nearby services, filter chips), Postgres decides: every service of the
 * answer is re-checked with `SearchableIds`, priced by `StorefrontQuotes` (never from the engine) and dropped if it fails either. On any
 * engine failure the answer is the fallback (popular phrases that start with the typed text), 200, with no service query.
 *
 * Side effects: cache keys `suggest:{sha1(p)}:v{search}`, `search-card:*`, `search-popular`; engine calls; `search_*` metrics; reads only
 * in Postgres.
 *
 * @see GET /store/v1/search/suggest
 */
@Injectable()
export class SuggestService {
  constructor(
    private readonly db: DbService,
    private readonly engine: SearchEngine,
    private readonly collections: SearchCollections,
    private readonly labels: SearchFacetLabels,
    private readonly cache: CacheService,
    private readonly keys: CacheKeys,
    private readonly searchable: SearchableIds,
    private readonly quotes: StorefrontQuotes,
    private readonly cards: SearchCards,
    private readonly services: StorefrontServices,
    private readonly metrics: SearchMetrics,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  /**
   * Answers one suggest request.
   *
   * @param input what the visitor typed and the currency to show prices in
   * @returns the answer; `engine: 'fallback'` when the engine did not answer
   * @throws {AppError} `VALIDATION_FAILED` on `currency` when it is not offered
   */
  async suggest(input: { readonly q: string; readonly currency?: string | undefined }): Promise<SuggestBody> {
    const query = normaliseQuery(input.q);
    const empty = {
      ghost: null,
      completions: [],
      services: [],
      filters: [],
      didYouMean: null,
      popular: [],
      intent: null,
    };
    if (query === '') {
      return { q: '', engine: this.engine.enabled ? 'typesense' : 'fallback', ...empty, popular: await this.popular() };
    }
    if (imeiIntent(input.q) !== null) {
      // An IMEI is a personal identifier of a phone: no search, no count, no cache key (plan section 5.2).
      return { q: query, engine: this.engine.enabled ? 'typesense' : 'fallback', ...empty, intent: 'imei' };
    }
    const p = typedPrefix(input.q);
    const outcome = await this.enginePart(input.q, p, query);
    if (outcome === null) return this.fallback(query, p);
    const body = await this.decorate(query, outcome, input.currency);
    if (body.services.length === 0 && body.completions.length === 0) this.metrics.zeroResults.inc({ route: 'suggest' });
    return body;
  }

  /**
   * The popular searches of the empty box: the searched terms with at least 5 visitors on each of 3 days that the catalog knows and staff
   * did not hide (`isPopularQuery`), else the first four category names.
   *
   * @returns at most eight phrases
   */
  async popular(): Promise<string[]> {
    const key = this.keys.searchPopular();
    try {
      return await this.cache.getOrLoad(key, POPULAR_TTL_SECONDS, () => this.loadPopular());
    } catch (error) {
      // The cache shares one in-flight load per key: a fallback's peek (`cachedPopular`) that is running now is the load this call
      // joined, and it rejects with `NothingCached`. That is not this call's failure: load for real, once.
      if (error instanceof NothingCached) {
        return this.cache.getOrLoad(key, POPULAR_TTL_SECONDS, () => this.loadPopular());
      }
      throw error;
    }
  }

  /** The cached popular phrases, or none: never loads (the fallback must not read the engine or Postgres). */
  private async cachedPopular(): Promise<string[]> {
    try {
      return await this.cache.getOrLoad(this.keys.searchPopular(), POPULAR_TTL_SECONDS, () =>
        Promise.reject(new NothingCached()),
      );
    } catch (error) {
      if (error instanceof NothingCached) return [];
      return [];
    }
  }

  private async loadPopular(): Promise<string[]> {
    const db = this.db.db;
    const since = dayOf(new Date(this.clock.nowMs() - (POPULAR_WINDOW_DAYS - 1) * DAY_MS));
    const [candidates, hidden] = await Promise.all([popularCandidates(db, since), hiddenTermSet(db)]);
    const alias = this.collections.names.alias('terms');
    const top = candidates.slice(0, POPULAR_CANDIDATES);
    // The catalog's vocabulary is what the terms collection holds: a candidate is popular only when its phrase is one of its documents
    // (the terms build kept only queries whose words the catalog knows, and a title phrase or a facet value is catalog words by itself).
    const outcome = await this.engine.run(
      'suggest',
      async (client, timeoutMs) => {
        if (top.length === 0) return [] as string[];
        const result = await client.search<{ q: string }>(
          alias,
          {
            q: '*',
            query_by: 'q',
            filter_by: `q:=[${top.map((candidate) => quoteFilterValue(normaliseText(candidate.term))).join(',')}]`,
            per_page: POPULAR_CANDIDATES,
            include_fields: 'q',
          },
          { timeoutMs },
        );
        return result.hits.map((hit) => hit.document.q);
      },
      () => Promise.resolve([] as string[]),
    );
    const known = new Set(outcome.value);
    const vocabulary = new Set([...known].flatMap((phrase) => phrase.split(' ')));
    const phrases = top
      .filter((candidate) => known.has(normaliseText(candidate.term)) && isPopularQuery(candidate, vocabulary, hidden))
      .map((candidate) => normaliseText(candidate.term))
      .slice(0, MAX_POPULAR);
    if (phrases.length > 0) return phrases;
    const labels = await this.labels.read();
    return [...labels.categories.values()].slice(0, 4);
  }

  /**
   * The engine's part of the answer, from the cache or the engine; `null` for the fallback.
   *
   * Side effects: the cache key `suggest:{sha1(p)}:v{search}`; a fallback is never cached.
   */
  private async enginePart(raw: string, p: string, query: string): Promise<EnginePart | null> {
    const fetch = async (): Promise<EnginePart> => {
      const labels = await this.labels.read();
      const outcome = await this.engine.run(
        'suggest',
        async (client, timeoutMs) => {
          const services = this.collections.names.alias('services');
          const terms = this.collections.names.alias('terms');
          const [termsAnswer, servicesAnswer, nearbyAnswer] = await client.multiSearch<never>(
            [
              termsSearch(terms, p.trim()),
              suggestServicesSearch(services, query),
              nearbyServicesSearch(services, query),
            ],
            { timeoutMs },
          );
          const part = assembleEnginePart({
            raw,
            answer: {
              terms: termsAnswer as unknown as SearchResult<TermHitDocument>,
              services: servicesAnswer as unknown as SearchResult<{ id: string }>,
              nearby: nearbyAnswer as unknown as SearchResult<{ id: string }>,
            },
            labels,
            synonymWords: labels.synonymWords,
            synonymPhrases: labels.synonymPhrases,
          });
          if (servicesAnswer!.found > 0 || part.didYouMean !== null) return part;
          // Nothing matched: one more request, to the terms collection, for the nearest phrase.
          const [typo] = await client.multiSearch<{ q: string }>([termsTypoSearch(terms, query)], { timeoutMs });
          const best = typo?.hits[0]?.document.q;
          return { ...part, didYouMean: best !== undefined && best !== query ? best : null };
        },
        () => Promise.resolve(null),
      );
      if (outcome.engine === 'fallback') throw new FellBack(outcome.reason);
      return outcome.value;
    };
    if (!this.engine.enabled) {
      // Switched off: counted as a fallback without touching the cache or the engine.
      await this.engine.run(
        'suggest',
        () => Promise.reject(new Error('unreachable')),
        () => Promise.resolve(null),
      );
      return null;
    }
    let loaded = false;
    try {
      const key = await this.cache.versioned(
        SEARCH_CACHE_VERSION,
        this.keys.searchSuggest(createHash('sha1').update(p).digest('hex')),
      );
      const part = await this.cache.getOrLoad(key, ENGINE_PART_TTL_SECONDS, async () => {
        loaded = true;
        return fetch();
      });
      if (!loaded) this.metrics.requests.inc({ route: 'suggest', engine: 'typesense' });
      return part;
    } catch (error) {
      if (error instanceof FellBack) return null;
      throw error;
    }
  }

  /** Re-checks the candidates against Postgres, then prices them and builds the answer. */
  private async decorate(query: string, part: EnginePart, currency: string | undefined): Promise<SuggestBody> {
    const base = {
      q: query,
      engine: 'typesense' as const,
      ghost: part.ghost,
      completions: part.completions,
      filters: part.filters,
      didYouMean: part.didYouMean,
      popular: [] as string[],
      intent: null,
    };
    if (part.candidates.length === 0) return { ...base, services: [] };
    const db = this.db.db;
    const groupId = await this.searchable.retailGroupId(db);
    if (groupId === undefined) return { ...base, services: [] };
    const [context, { services: searchable }] = await Promise.all([
      this.quotes.context(db, groupId, { currency }),
      this.searchable.of(
        db,
        part.candidates.map((candidate) => candidate.id),
        groupId,
      ),
    ]);
    const priced = await this.quotes.pricedSellable(db, context, searchable);
    const shown = part.candidates.filter((candidate) => priced.has(candidate.id));
    const ids = shown.map((candidate) => candidate.id);
    const [facts, inStock] = await Promise.all([this.cards.facts(db, ids), this.services.inStockIds(db, ids)]);
    const services: SuggestBody['services'] = [];
    let examined = 0;
    for (const candidate of part.candidates) {
      if (services.length === MAX_SERVICES) break;
      examined += 1;
      const found = priced.get(candidate.id);
      const card = facts.get(candidate.id);
      if (found === undefined || card === undefined) continue;
      const { display } = this.quotes.amounts(context, found.unitNet, 1);
      services.push({
        id: candidate.id,
        slug: card.slug,
        title: card.title,
        titleHighlight: highlightTitle(card.title, candidate.tokens),
        brand: card.brand,
        network: card.network,
        type: found.service.type,
        category: { id: found.service.categoryId, name: found.service.categoryName },
        imageUrl: card.imageUrl,
        availability: inStock.has(candidate.id) ? 'in_stock' : 'on_request',
        price: { currency: context.currency.code, net: display.net.toWire(), gross: display.gross.toWire() },
      });
    }
    // A hit the engine still lists but Postgres no longer lets the shop show is dropped and counted.
    const dropped = part.candidates.slice(0, examined).length - services.length;
    if (dropped > 0) this.metrics.staleHits.inc(dropped);
    return { ...base, services };
  }

  /** The fallback: no service query, popular phrases that start with the typed text. */
  private async fallback(query: string, p: string): Promise<SuggestBody> {
    const popular = await this.cachedPopular();
    const typed = p.trim();
    const completions = popular
      .filter((phrase) => phrase.startsWith(typed) && phrase !== typed)
      .slice(0, 6)
      .map((text) => ({ text, kind: 'query' as const }));
    return {
      q: query,
      engine: 'fallback',
      ghost: null,
      completions,
      services: [],
      filters: [],
      didYouMean: null,
      popular: [],
      intent: null,
    };
  }
}
