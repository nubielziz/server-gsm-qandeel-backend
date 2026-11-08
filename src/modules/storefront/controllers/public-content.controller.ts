// HTTP controller of the public content routes (map domain H, /store/v1/pages and /store/v1/help, stage 15). Thin: the reads live
// in PublicContentService.
import { Controller, Param, Query } from '@nestjs/common';
import { type ParamsOf, type QueryOf, type ResultOf, Route } from '../../../common/contract';
import { PublicContentService } from '../application/public-content.service';
import { getPublicHelp, getPublicPage, listPublicHelp } from '../contracts/public-content.contracts';

/**
 * The public content routes.
 *
 * Why: the storefront renders pages and the help centre from them; they serve only what staff published.
 *
 * @route GET /store/v1/pages/:slug
 * @route GET /store/v1/help
 * @route GET /store/v1/help/:slug
 */
@Controller()
export class PublicContentController {
  constructor(private readonly content: PublicContentService) {}

  /**
   * Gets a page.
   *
   * @param params the slug
   * @param query the language
   * @returns the live content page or the legal document in force
   * @route GET /store/v1/pages/:slug
   */
  @Route(getPublicPage)
  page(
    @Param() params: ParamsOf<typeof getPublicPage>,
    @Query() query: QueryOf<typeof getPublicPage>,
  ): Promise<ResultOf<typeof getPublicPage>> {
    return this.content.page(params.slug, query.locale);
  }

  /**
   * Lists published help articles.
   *
   * @param query the parsed list request (its `extra.locale` is the language)
   * @returns the rows and the total
   * @route GET /store/v1/help
   */
  @Route(listPublicHelp)
  helpList(@Query() query: QueryOf<typeof listPublicHelp>): Promise<ResultOf<typeof listPublicHelp>> {
    return this.content.helpList(query, query.extra.locale);
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
}
