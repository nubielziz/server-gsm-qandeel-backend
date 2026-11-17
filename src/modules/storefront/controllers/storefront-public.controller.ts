// HTTP controller of the public storefront catalog (map domain H, stage 14): configuration, the service list, one service page, the
// category menu and the old addresses of feature 30. Thin: the rules live in StorefrontCatalogService. The catalog answers carry a
// short Cache-Control for the browser.
import { Controller, Param, Query, Req, Res } from '@nestjs/common';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { type ParamsOf, type QueryOf, type ResultOf, Route } from '../../../common/contract';
import { StorefrontCatalogService } from '../application/storefront-catalog.service';
import { getLegacySlug } from '../contracts/legacy-slugs.contracts';
import { visitorOf } from '../search/controllers/visitor';
import {
  getStoreConfig,
  listStoreCategories,
  listStoreServices,
  showStoreService,
} from '../contracts/storefront-public.contracts';

/** What a browser or a CDN may keep a public catalog answer for. */
const PUBLIC_CACHE_CONTROL = 'public, max-age=30';

/**
 * The public storefront catalog routes.
 *
 * Why: the shop's start-up configuration, its service list and its service pages are public and read only (map stage 14); the
 * Turnstile and per-IP limit of ALIGNMENT § 7 apply to the writes and to the whole store surface respectively (the old-address
 * route counts against the same `ip` limiter as every public store read).
 *
 * @route GET /store/v1/config
 * @route GET /store/v1/services
 * @route GET /store/v1/services/:slug
 * @route GET /store/v1/categories
 * @route GET /store/v1/legacy-slugs/:kind/:slug
 */
@Controller()
export class StorefrontPublicController {
  constructor(private readonly catalog: StorefrontCatalogService) {}

  /**
   * Reads the storefront configuration.
   *
   * @param reply the reply, for the cache header
   * @returns currencies, tax windows, payment methods, policy switches and legal documents
   * @route GET /store/v1/config
   */
  @Route(getStoreConfig)
  config(@Res({ passthrough: true }) reply: FastifyReply): Promise<ResultOf<typeof getStoreConfig>> {
    reply.header('cache-control', PUBLIC_CACHE_CONTROL);
    return this.catalog.config();
  }

  /**
   * Lists the service pages on sale.
   *
   * @param query the parsed list request
   * @param request the request, for the search statistics when `q` is set (address hash, User-Agent, prefetch)
   * @param reply the reply, for the cache header and, with `q`, which engine answered
   * @returns the page of services and the exact total
   * @route GET /store/v1/services
   */
  @Route(listStoreServices)
  async list(
    @Query() query: QueryOf<typeof listStoreServices>,
    @Req() request: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<ResultOf<typeof listStoreServices>> {
    reply.header('cache-control', PUBLIC_CACHE_CONTROL);
    const page = await this.catalog.list(query, visitorOf(request));
    if (page.engine !== undefined) reply.header('x-search-engine', page.engine);
    if (page.truncated === true) reply.header('x-search-truncated', 'true');
    return page;
  }

  /**
   * Reads one service page.
   *
   * @param params the slug
   * @param query the buyer country, region and currency
   * @param reply the reply, for the cache header
   * @returns the page
   * @route GET /store/v1/services/:slug
   */
  @Route(showStoreService)
  show(
    @Param() params: ParamsOf<typeof showStoreService>,
    @Query() query: QueryOf<typeof showStoreService>,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<ResultOf<typeof showStoreService>> {
    reply.header('cache-control', PUBLIC_CACHE_CONTROL);
    return this.catalog.page(params.slug, {
      country: query.buyerCountry ?? null,
      region: query.region,
      currency: query.currency,
    });
  }

  /**
   * Lists the storefront categories with their service counts.
   *
   * @param reply the reply, for the cache header
   * @returns the categories of the menu
   * @route GET /store/v1/categories
   */
  @Route(listStoreCategories)
  categories(@Res({ passthrough: true }) reply: FastifyReply): Promise<ResultOf<typeof listStoreCategories>> {
    reply.header('cache-control', PUBLIC_CACHE_CONTROL);
    return this.catalog.categories();
  }

  /**
   * Tells where an old address in another language leads now (English only, decision 039).
   *
   * Why: the cache headers are those of `GET /store/v1/pages/:slug` (none set here): the website keeps the answer in its own
   * content cache.
   *
   * @param params the kind and the old slug
   * @returns the path to send the reader on to, and the service page's slug when there is one
   * @route GET /store/v1/legacy-slugs/:kind/:slug
   */
  @Route(getLegacySlug)
  legacy(@Param() params: ParamsOf<typeof getLegacySlug>): Promise<ResultOf<typeof getLegacySlug>> {
    return this.catalog.legacyAddress(params.kind, params.slug);
  }
}
