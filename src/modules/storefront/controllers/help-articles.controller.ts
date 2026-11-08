// HTTP controller of the help article routes (map domain H, /admin/help-articles, stage 15). Thin: the rules live in
// HelpArticleAdminService.
import { Body, Controller, Param, Query } from '@nestjs/common';
import { type BodyOf, type ParamsOf, type QueryOf, type ResultOf, Route } from '../../../common/contract';
import { HelpArticleAdminService } from '../application/help-article-admin.service';
import {
  createHelpArticle,
  listHelpArticles,
  showHelpArticle,
  updateHelpArticle,
} from '../contracts/help-articles.contracts';

/**
 * The help article routes.
 *
 * Why: staff write the help centre articles the public storefront shows.
 *
 * @route GET /admin/help-articles
 * @route GET /admin/help-articles/:id
 * @route POST /admin/help-articles
 * @route PATCH /admin/help-articles/:id
 */
@Controller()
export class HelpArticlesController {
  constructor(private readonly articles: HelpArticleAdminService) {}

  /**
   * Lists articles.
   *
   * @param query the parsed list request
   * @returns the rows and the total
   * @route GET /admin/help-articles
   */
  @Route(listHelpArticles)
  list(@Query() query: QueryOf<typeof listHelpArticles>): Promise<ResultOf<typeof listHelpArticles>> {
    return this.articles.list(query);
  }

  /**
   * Shows an article.
   *
   * @param params the article id
   * @returns the article
   * @route GET /admin/help-articles/:id
   */
  @Route(showHelpArticle)
  show(@Param() params: ParamsOf<typeof showHelpArticle>): Promise<ResultOf<typeof showHelpArticle>> {
    return this.articles.show(params.id);
  }

  /**
   * Creates an article.
   *
   * @param body the article fields
   * @returns the new article
   * @route POST /admin/help-articles
   */
  @Route(createHelpArticle)
  create(@Body() body: BodyOf<typeof createHelpArticle>): Promise<ResultOf<typeof createHelpArticle>> {
    return this.articles.create(body);
  }

  /**
   * Changes an article or its publish switch.
   *
   * @param params the article id
   * @param body the keys to change
   * @returns the updated article
   * @route PATCH /admin/help-articles/:id
   */
  @Route(updateHelpArticle)
  update(
    @Param() params: ParamsOf<typeof updateHelpArticle>,
    @Body() body: BodyOf<typeof updateHelpArticle>,
  ): Promise<ResultOf<typeof updateHelpArticle>> {
    return this.articles.update(params.id, body);
  }
}
