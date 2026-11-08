// HTTP controller of the notification templates (map domain G, stage 12, routes /admin/notification-templates).
import { Body, Controller, Param, Query } from '@nestjs/common';
import { type BodyOf, type ParamsOf, type QueryOf, type ResultOf, Route } from '../../../common/contract';
import { NotificationTemplateAdminService } from './notification-template-admin.service';
import {
  createNotificationTemplate,
  deleteNotificationTemplate,
  listNotificationTemplates,
  previewNotificationTemplate,
  showNotificationTemplate,
  updateNotificationTemplate,
} from './notification-templates.contracts';

/**
 * Routes of the notification templates.
 *
 * Why: thin layer over {@link NotificationTemplateAdminService}: the contracts check access, CSRF and shapes; the service applies the rules.
 */
@Controller()
export class NotificationTemplatesController {
  constructor(private readonly templates: NotificationTemplateAdminService) {}

  /**
   * Lists the templates.
   *
   * @param query range, sort, filters and search
   * @returns the page of rows
   * @route GET /admin/notification-templates
   */
  @Route(listNotificationTemplates)
  list(@Query() query: QueryOf<typeof listNotificationTemplates>): Promise<ResultOf<typeof listNotificationTemplates>> {
    return this.templates.list(query);
  }

  /**
   * Reads one template.
   *
   * @param params the template id
   * @returns the template
   * @route GET /admin/notification-templates/:id
   */
  @Route(showNotificationTemplate)
  show(@Param() params: ParamsOf<typeof showNotificationTemplate>): Promise<ResultOf<typeof showNotificationTemplate>> {
    return this.templates.get(params.id);
  }

  /**
   * Adds a template.
   *
   * @param body the new template
   * @returns the stored template
   * @route POST /admin/notification-templates
   */
  @Route(createNotificationTemplate)
  create(
    @Body() body: BodyOf<typeof createNotificationTemplate>,
  ): Promise<ResultOf<typeof createNotificationTemplate>> {
    return this.templates.create(body);
  }

  /**
   * Changes a template.
   *
   * @param params the template id
   * @param body the fields to change
   * @returns the stored template
   * @route PATCH /admin/notification-templates/:id
   */
  @Route(updateNotificationTemplate)
  update(
    @Param() params: ParamsOf<typeof updateNotificationTemplate>,
    @Body() body: BodyOf<typeof updateNotificationTemplate>,
  ): Promise<ResultOf<typeof updateNotificationTemplate>> {
    return this.templates.update(params.id, body);
  }

  /**
   * Deletes a template.
   *
   * @param params the template id
   * @returns nothing: the route answers 204
   * @route DELETE /admin/notification-templates/:id
   */
  @Route(deleteNotificationTemplate)
  remove(@Param() params: ParamsOf<typeof deleteNotificationTemplate>): Promise<void> {
    return this.templates.remove(params.id);
  }

  /**
   * Renders a template with sample data.
   *
   * @param params the template id
   * @param body unsaved text to preview, or empty
   * @returns the preview
   * @route POST /admin/notification-templates/:id/preview
   */
  @Route(previewNotificationTemplate)
  preview(
    @Param() params: ParamsOf<typeof previewNotificationTemplate>,
    @Body() body: BodyOf<typeof previewNotificationTemplate>,
  ): Promise<ResultOf<typeof previewNotificationTemplate>> {
    return this.templates.preview(params.id, body);
  }
}
