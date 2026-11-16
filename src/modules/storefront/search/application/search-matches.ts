// SearchMatches: the engine half of a results request (feature 29, plan sections 5.3-5.4): one multi-search for the page, the facet counts,
// the ids of all matches and the "did you mean", through the circuit and the fallback. It returns ids and counts, never prices or cards.
import { Injectable } from '@nestjs/common';
import { APP_CONFIG, type AppConfig } from '../../../../config';
import type { SearchResult } from '../../../../infra/search';
import { didYouMean } from '../domain/did-you-mean';
import {
  FACET_FIELD,
  type FacetGroup,
  type FacetValue,
  FACET_GROUPS,
  RESULT_FACETS,
  type ResultFilters,
  facetValues,
  filterBy,
  selectedGroups,
} from '../domain/filters';
import { normaliseQuery, normaliseText } from '../domain/normalise';
import { type EngineSort, RANKING, facetsOnlySearch, resultsSearch, sortBy, termsTypoSearch } from '../domain/ranking';
import { Inject } from '@nestjs/common';
import { SearchCollections } from './search-collections';
import { type EngineOutcome, SearchEngine } from './search-engine';
import { SearchFacetLabels } from './facet-labels';

/** What the engine is asked for. */
export interface MatchRequest {
  readonly route: 'results' | 'services';
  /** What the visitor typed. */
  readonly q: string;
  readonly filters: ResultFilters;
  readonly sort: ReadonlyArray<{ readonly field: EngineSort; readonly order: 'asc' | 'desc' }>;
  readonly offset: number;
  readonly limit: number;
  /** Read up to 1000 matching ids instead of a page (a price sort or price bounds). */
  readonly readAll: boolean;
  /** Page 1 of the results page: facet counts, the did-you-mean and the ids for the price span. */
  readonly extras: boolean;
}

/** What the engine answered. */
export interface Matches {
  /** How many documents matched in all. */
  readonly found: number;
  /** The page's ids in order (all of them, up to 1000, when `readAll`). */
  readonly ids: number[];
  /** The ids of every match when at most 1000 matched (for the price span); `null` otherwise or without `extras`. */
  readonly allIds: number[] | null;
  /** The counts per group, each ignoring its own group's selection; `null` without `extras`. */
  readonly facets: Record<FacetGroup, FacetValue[]> | null;
  readonly didYouMean: string | null;
  /** The ids a pin put first. */
  readonly pinned: ReadonlySet<number>;
}

const idsOf = (result: SearchResult<{ id: string }>): number[] =>
  result.hits.map((hit) => Number(hit.document.id)).filter((id) => Number.isSafeInteger(id));

/**
 * Asks the engine which services match a query.
 *
 * Why: plan section 5.3: one `multi_search` holds the main search, the facet counts of each group that has a selected value (counts of a
 * group ignore that group's own selection), and (a price sort, price bounds or the price span) four pages of 250 ids; the "did you mean"
 * reads the main hits' matched tokens, and the terms collection answers when nothing matched.
 *
 * Side effects: engine calls only (through {@link SearchEngine}, which counts them and falls back).
 */
@Injectable()
export class SearchMatches {
  constructor(
    private readonly engine: SearchEngine,
    private readonly collections: SearchCollections,
    private readonly labels: SearchFacetLabels,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  /** Whether the engine may be tried at all (search on). */
  get enabled(): boolean {
    return this.engine.enabled;
  }

  /**
   * Finds the matches.
   *
   * @param request the query, filters, sort and window
   * @returns the matches, or `null` for the fallback (engine off, down, not ready or a query with no searchable word)
   */
  async find(request: MatchRequest): Promise<EngineOutcome<Matches, null>> {
    const query = normaliseQuery(request.q);
    const route = request.route;
    if (query === '') {
      // Nothing to search for (only symbols): the database search keeps its own reading of the text.
      return { engine: 'fallback', value: null, reason: 'error' };
    }
    const services = this.collections.names.alias('services');
    const terms = this.collections.names.alias('terms');
    return this.engine.run(
      route === 'results' ? 'results' : 'services',
      async (client, timeoutMs) => {
        // The enabled synonyms' words (for the did-you-mean) are read only when the engine is really asked, never on a fallback.
        const labels = request.extras ? await this.labels.read() : undefined;
        const filter = filterBy(request.filters);
        const sort = sortBy(request.sort);
        const searches = [];
        const ids = request.readAll
          ? Array.from({ length: RANKING.priceReadLimit / RANKING.priceReadPage }, (_, page) =>
              resultsSearch(services, query, {
                filterBy: filter,
                sortBy: sort,
                offset: page * RANKING.priceReadPage,
                limit: RANKING.priceReadPage,
                highlight: page === 0,
              }),
            )
          : [
              resultsSearch(services, query, {
                filterBy: filter,
                sortBy: sort,
                offset: request.offset,
                limit: request.limit,
              }),
            ];
        searches.push(...ids);
        // The facet counts: the page's own search gives them when it can; groups with a selection are counted without that selection.
        const selected = request.extras ? selectedGroups(request.filters) : [];
        const withFacets = request.extras && !request.readAll;
        if (withFacets) searches[0] = { ...searches[0]!, facet_by: RESULT_FACETS, max_facet_values: 20 };
        if (request.extras && request.readAll) searches.push(facetsOnlySearch(services, query, filter, RESULT_FACETS));
        const extraStart = searches.length;
        for (const group of selected) {
          searches.push(facetsOnlySearch(services, query, filterBy(request.filters, group), FACET_FIELD[group]));
        }
        // The ids of every match, for the price span (page 1, a page search that is not already a read of all ids).
        const spanStart = searches.length;
        if (request.extras && !request.readAll) {
          for (let page = 0; page < RANKING.priceReadLimit / RANKING.priceReadPage; page += 1) {
            searches.push(
              resultsSearch(services, query, {
                filterBy: filter,
                sortBy: sort,
                offset: page * RANKING.priceReadPage,
                limit: RANKING.priceReadPage,
                highlight: false,
              }),
            );
          }
        }
        const answers = await client.multiSearch<{ id: string }>(searches, { timeoutMs });
        const main = answers[0]!;
        const pageIds = request.readAll ? answers.slice(0, ids.length).flatMap((answer) => idsOf(answer)) : idsOf(main);
        const facets = request.extras ? this.facetsOf(answers, request, selected, extraStart, withFacets) : null;
        let allIds: number[] | null = null;
        if (request.extras) {
          allIds =
            main.found <= RANKING.priceReadLimit
              ? request.readAll
                ? pageIds
                : answers.slice(spanStart, spanStart + RANKING.priceReadLimit / RANKING.priceReadPage).flatMap(idsOf)
              : null;
        }
        let suggestion: string | null = null;
        if (request.extras) {
          suggestion = didYouMean({
            query,
            hits: main.hits,
            found: main.found,
            synonymWords: labels?.synonymWords ?? new Set<string>(),
            synonymPhrases: labels?.synonymPhrases ?? [],
            lastWordComplete: true,
          });
          if (main.found === 0) {
            const [typo] = await client.multiSearch<{ q: string }>([termsTypoSearch(terms, query)], { timeoutMs });
            const best = typo?.hits[0]?.document.q;
            suggestion = best !== undefined && best !== normaliseText(query) ? best : null;
          }
        }
        return {
          found: main.found,
          ids: pageIds,
          allIds,
          facets,
          didYouMean: suggestion,
          pinned: new Set(main.hits.filter((hit) => hit.curated === true).map((hit) => Number(hit.document.id))),
        } satisfies Matches;
      },
      () => Promise.resolve(null),
    );
  }

  private facetsOf(
    answers: ReadonlyArray<SearchResult<{ id: string }>>,
    request: MatchRequest,
    selected: readonly FacetGroup[],
    extraStart: number,
    withFacets: boolean,
  ): Record<FacetGroup, FacetValue[]> {
    const source = withFacets ? answers[0]! : answers[extraStart - 1]!;
    const out = {} as Record<FacetGroup, FacetValue[]>;
    for (const group of FACET_GROUPS) out[group] = facetValues(source.facet_counts, FACET_FIELD[group]);
    selected.forEach((group, index) => {
      const answer = answers[extraStart + index]!;
      out[group] = facetValues(answer.facet_counts, FACET_FIELD[group]);
    });
    void request;
    return out;
  }
}
