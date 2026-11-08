// HTTP controller of the content page routes (map domain H, /admin/content-pages, stage 15). Thin: the rules live in
// ContentPageAdminService.
import { Body, Controller, Param, Query } from '@nestjs/common';
import { type BodyOf, type ParamsOf, type QueryOf, type ResultOf, Route } from '../../../common/contract';
import { CurrentStaff, type StaffPrincipal } from '../../identity';
import { ContentPageAdminService } from '../application/content-page-admin.service';
import {
  createContentPage,
  listContentPages,
  publishContentPage,
  showContentPage,
  updateContentPage,
} from '../contracts/content-pages.contracts';

/**
 * The content page routes.
 *
 * Why: staff write landing pages, static pages and the blog, then publish them to the public storefront.
 *
 * @route GET /admin/content-pages
 * @route GET /admin/content-pages/:id
 * @route POST /admin/content-pages
 * @route PATCH /admin/content-pages/:id
 * @route POST /admin/content-pages/:id/publish
 */
@Controller()
export class ContentPagesController {
  constructor(private readonly pages: ContentPageAdminService) {}

  /**
   * Lists pages.
   *
   * @param query the parsed list request
   * @returns the rows and the total
   * @route GET /admin/content-pages
   */
  @Route(listContentPages)
  list(@Query() query: QueryOf<typeof listContentPages>): Promise<ResultOf<typeof listContentPages>> {
    return this.pages.list(query);
  }

  /**
   * Shows a page.
   *
   * @param params the page id
   * @returns the page
   * @route GET /admin/content-pages/:id
   */
  @Route(showContentPage)
  show(@Param() params: ParamsOf<typeof showContentPage>): Promise<ResultOf<typeof showContentPage>> {
    return this.pages.show(params.id);
  }

  /**
   * Creates a draft page.
   *
   * @param staff the signed-in staff member (`author_id`)
   * @param body the page fields
   * @returns the new draft
   * @route POST /admin/content-pages
   */
  @Route(createContentPage)
  create(
    @CurrentStaff() staff: StaffPrincipal,
    @Body() body: BodyOf<typeof createContentPage>,
  ): Promise<ResultOf<typeof createContentPage>> {
    return this.pages.create(body, staff.staffId);
  }

  /**
   * Changes a page.
   *
   * @param params the page id
   * @param body the keys to change
   * @returns the updated page
   * @route PATCH /admin/content-pages/:id
   */
  @Route(updateContentPage)
  update(
    @Param() params: ParamsOf<typeof updateContentPage>,
    @Body() body: BodyOf<typeof updateContentPage>,
  ): Promise<ResultOf<typeof updateContentPage>> {
    return this.pages.update(params.id, body);
  }

  /**
   * Publishes a page or hides it.
   *
   * @param params the page id
   * @param body `published`
   * @returns the updated page
   * @route POST /admin/content-pages/:id/publish
   */
  @Route(publishContentPage)
  publish(
    @Param() params: ParamsOf<typeof publishContentPage>,
    @Body() body: BodyOf<typeof publishContentPage>,
  ): Promise<ResultOf<typeof publishContentPage>> {
    return this.pages.publish(params.id, body.published);
  }
}
