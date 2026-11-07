// HTTP controller of the public storefront catalog (map domain H, stage 14): configuration, the service list and one service page.
// Thin: the rules live in StorefrontCatalogService. The answers carry a short Cache-Control for the browser.
import { Controller, Param, Query, Res } from '@nestjs/common';
import type { FastifyReply } from 'fastify';
import { type ParamsOf, type QueryOf, type ResultOf, Route } from '../../../common/contract';
import { StorefrontCatalogService } from '../application/storefront-catalog.service';
import { getStoreConfig, listStoreServices, showStoreService } from '../contracts/storefront-public.contracts';

/** What a browser or a CDN may keep a public catalog answer for. */
const PUBLIC_CACHE_CONTROL = 'public, max-age=30';

/**
 * The public storefront catalog routes.
 *
 * Why: the shop's start-up configuration, its service list and its service pages are public and read only (map stage 14); the
 * Turnstile and per-IP limit of ALIGNMENT § 7 apply to the writes and to the whole store surface respectively.
 *
 * @route GET /store/v1/config
 * @route GET /store/v1/services
 * @route GET /store/v1/services/:slug
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
   * @param reply the reply, for the cache header
   * @returns the page of services and the exact total
   * @route GET /store/v1/services
   */
  @Route(listStoreServices)
  list(
    @Query() query: QueryOf<typeof listStoreServices>,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<ResultOf<typeof listStoreServices>> {
    reply.header('cache-control', PUBLIC_CACHE_CONTROL);
    return this.catalog.list(query);
  }

  /**
   * Reads one service page.
   *
   * @param params the slug
   * @param query the language, buyer country, region and currency
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
    return this.catalog.page(params.slug, query.locale, {
      country: query.buyerCountry ?? null,
      region: query.region,
      currency: query.currency,
    });
  }
}
