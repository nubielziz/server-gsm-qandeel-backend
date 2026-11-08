// HTTP controller of the reply templates (map domain J, /admin/reply-templates, stage 17). Thin: the rules live in ReplyTemplateAdminService.
import { Body, Controller, Param, Query } from '@nestjs/common';
import { type BodyOf, type ParamsOf, type QueryOf, type ResultOf, Route } from '../../../common/contract';
import { CurrentStaff, type StaffPrincipal } from '../../identity';
import { ReplyTemplateAdminService } from '../application/reply-template-admin.service';
import {
  createReplyTemplate,
  deleteReplyTemplate,
  listReplyTemplates,
  showReplyTemplate,
  updateReplyTemplate,
} from '../contracts/reply-templates.contracts';

/**
 * The reply template routes.
 *
 * Why: the console's Templates view manages the canned replies the composer inserts.
 *
 * @route GET /admin/reply-templates
 * @route GET /admin/reply-templates/:id
 * @route POST /admin/reply-templates
 * @route PATCH /admin/reply-templates/:id
 * @route DELETE /admin/reply-templates/:id
 */
@Controller()
export class ReplyTemplatesController {
  constructor(private readonly templates: ReplyTemplateAdminService) {}

  /**
   * Lists templates.
   *
   * @param query the parsed list request
   * @returns the rows and the total
   * @route GET /admin/reply-templates
   */
  @Route(listReplyTemplates)
  list(@Query() query: QueryOf<typeof listReplyTemplates>): Promise<ResultOf<typeof listReplyTemplates>> {
    return this.templates.list(query);
  }

  /**
   * Shows a template.
   *
   * @param params the template id
   * @returns the template
   * @route GET /admin/reply-templates/:id
   */
  @Route(showReplyTemplate)
  show(@Param() params: ParamsOf<typeof showReplyTemplate>): Promise<ResultOf<typeof showReplyTemplate>> {
    return this.templates.show(params.id);
  }

  /**
   * Creates a template.
   *
   * @param body the five fields
   * @param staff the signed-in staff member (the author)
   * @returns the new template
   * @route POST /admin/reply-templates
   */
  @Route(createReplyTemplate)
  create(
    @Body() body: BodyOf<typeof createReplyTemplate>,
    @CurrentStaff() staff: StaffPrincipal,
  ): Promise<ResultOf<typeof createReplyTemplate>> {
    return this.templates.create(body, staff.staffId);
  }

  /**
   * Changes a template.
   *
   * @param params the template id
   * @param body the keys to change
   * @returns the updated template
   * @route PATCH /admin/reply-templates/:id
   */
  @Route(updateReplyTemplate)
  update(
    @Param() params: ParamsOf<typeof updateReplyTemplate>,
    @Body() body: BodyOf<typeof updateReplyTemplate>,
  ): Promise<ResultOf<typeof updateReplyTemplate>> {
    return this.templates.update(params.id, body);
  }

  /**
   * Deletes a template.
   *
   * @param params the template id
   * @returns nothing: the route answers 204
   * @route DELETE /admin/reply-templates/:id
   */
  @Route(deleteReplyTemplate)
  remove(@Param() params: ParamsOf<typeof deleteReplyTemplate>): Promise<void> {
    return this.templates.remove(params.id);
  }
}
