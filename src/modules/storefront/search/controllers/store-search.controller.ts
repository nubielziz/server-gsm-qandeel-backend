// HTTP controller of the public storefront search (feature 29, plan sections 5.1-5.3): the search-as-you-type route and the results page.
// Thin: the rules live in SuggestService and ResultsService. Both answers are cacheable for 30 seconds and say which engine answered.
import { Controller, Query, Req, Res } from '@nestjs/common';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { type QueryOf, type ResultOf, Route } from '../../../../common/contract';
import { ResultsService } from '../application/results.service';
import { SuggestService } from '../application/suggest.service';
import { searchStore, suggestStoreSearch } from '../contracts/store-search.contracts';
import { visitorOf } from './visitor';

/** What a browser or a CDN may keep a search answer for. */
const PUBLIC_CACHE_CONTROL = 'public, max-age=30';

/**
 * The public search routes.
 *
 * Why: the shop header completes words and suggests services while the visitor types, and the results page lists the matches; both are
 * English only and degrade to the database search when the engine is off or down (decision 038).
 *
 * @route GET /store/v1/search/suggest
 * @route GET /store/v1/search
 */
@Controller()
export class StoreSearchController {
  constructor(
    private readonly suggestions: SuggestService,
    private readonly results: ResultsService,
  ) {}

  /**
   * Suggests while the visitor types.
   *
   * @param query the typed text and the currency
   * @param reply the reply, for the cache and engine headers
   * @returns the ghost, completions, services, filters, did-you-mean and popular searches
   * @route GET /store/v1/search/suggest
   */
  @Route(suggestStoreSearch)
  async suggest(
    @Query() query: QueryOf<typeof suggestStoreSearch>,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<ResultOf<typeof suggestStoreSearch>> {
    const body = await this.suggestions.suggest(query);
    reply.header('cache-control', PUBLIC_CACHE_CONTROL);
    reply.header('x-search-engine', body.engine);
    return body;
  }

  /**
   * Lists the matches of a query.
   *
   * @param query the validated query
   * @param request the request, for the statistics (address hash, User-Agent, prefetch)
   * @param reply the reply, for the cache and engine headers
   * @returns the page with its facet counts and price span
   * @route GET /store/v1/search
   */
  @Route(searchStore)
  async search(
    @Query() query: QueryOf<typeof searchStore>,
    @Req() request: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<ResultOf<typeof searchStore>> {
    const page = await this.results.search(query, visitorOf(request));
    reply.header('cache-control', PUBLIC_CACHE_CONTROL);
    reply.header('x-search-engine', page.engine);
    return page;
  }
}
