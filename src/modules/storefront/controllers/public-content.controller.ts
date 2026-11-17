// HTTP controller of the public content routes (map domain H, /store/v1/pages and /store/v1/help, stage 15). Thin: the reads live
// in PublicContentService.
import { Body, Controller, Param, Query, Req } from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import { type BodyOf, type ParamsOf, type QueryOf, type ResultOf, Route } from '../../../common/contract';
import { PublicContentService } from '../application/public-content.service';
import {
  getPublicHelp,
  getPublicPage,
  listPublicHelp,
  listPublicPages,
  voteHelpArticle,
} from '../contracts/public-content.contracts';

/**
 * The public content routes.
 *
 * Why: the storefront renders pages and the help centre from them; they serve only what staff published.
 *
 * @route GET /store/v1/pages/:slug
 * @route GET /store/v1/help
 * @route GET /store/v1/help/:slug
 * @route GET /store/v1/pages
 * @route POST /store/v1/help/:slug/vote
 */
@Controller()
export class PublicContentController {
  constructor(private readonly content: PublicContentService) {}

  /**
   * Gets a page.
   *
   * @param params the slug
   * @returns the live content page or the legal document in force
   * @route GET /store/v1/pages/:slug
   */
  @Route(getPublicPage)
  page(@Param() params: ParamsOf<typeof getPublicPage>): Promise<ResultOf<typeof getPublicPage>> {
    return this.content.page(params.slug);
  }

  /**
   * Lists published help articles.
   *
   * @param query the parsed list request
   * @returns the rows and the total
   * @route GET /store/v1/help
   */
  @Route(listPublicHelp)
  helpList(@Query() query: QueryOf<typeof listPublicHelp>): Promise<ResultOf<typeof listPublicHelp>> {
    return this.content.helpList(query);
  }

  /**
   * Gets one published help article.
   *
   * @param params the slug
   * @returns the article
   * @route GET /store/v1/help/:slug
   */
  @Route(getPublicHelp)
  help(@Param() params: ParamsOf<typeof getPublicHelp>): Promise<ResultOf<typeof getPublicHelp>> {
    return this.content.help(params.slug);
  }

  /**
   * Lists the live pages.
   *
   * @param query the parsed list request
   * @returns the rows and the total
   * @route GET /store/v1/pages
   */
  @Route(listPublicPages)
  pageList(@Query() query: QueryOf<typeof listPublicPages>): Promise<ResultOf<typeof listPublicPages>> {
    return this.content.pageList(query);
  }

  /**
   * Counts a "was this helpful?" vote.
   *
   * @param params the article slug
   * @param body the vote
   * @param request the request, for the visitor's address
   * @returns nothing: the route answers 204
   * @route POST /store/v1/help/:slug/vote
   */
  @Route(voteHelpArticle)
  vote(
    @Param() params: ParamsOf<typeof voteHelpArticle>,
    @Body() body: BodyOf<typeof voteHelpArticle>,
    @Req() request: FastifyRequest,
  ): Promise<void> {
    return this.content.vote(params.slug, body.helpful, request.ip);
  }
}
