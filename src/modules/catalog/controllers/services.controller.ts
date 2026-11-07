// HTTP controller of the service routes (map domain B, /admin/services, stage 4), including the replace-all custom fields and
// option lists. Thin: the rules live in ServiceAdminService and ServicePartsService.
import { Body, Controller, Param, Query } from '@nestjs/common';
import { type BodyOf, type ParamsOf, type QueryOf, type ResultOf, Route } from '../../../common/contract';
import { ServiceAdminService } from '../application/service-admin.service';
import { ServicePartsService } from '../application/service-parts.service';
import {
  createService,
  deleteService,
  listServices,
  replaceServiceFields,
  replaceServiceOptions,
  showService,
  updateService,
} from '../contracts/services.contracts';

/**
 * The service routes.
 *
 * Why: services are the sellable catalog; the console lists, edits and prices them and replaces their custom fields and option
 * lists as whole lists.
 *
 * @route GET /admin/services
 * @route GET /admin/services/:id
 * @route POST /admin/services
 * @route PATCH /admin/services/:id
 * @route DELETE /admin/services/:id
 * @route PUT /admin/services/:id/fields
 * @route PUT /admin/services/:id/options
 */
@Controller()
export class ServicesController {
  constructor(
    private readonly services: ServiceAdminService,
    private readonly parts: ServicePartsService,
  ) {}

  /**
   * Lists services.
   *
   * @param query the parsed list request
   * @returns the rows and the total
   * @route GET /admin/services
   */
  @Route(listServices)
  list(@Query() query: QueryOf<typeof listServices>): Promise<ResultOf<typeof listServices>> {
    return this.services.list(query);
  }

  /**
   * Shows a service with its parts.
   *
   * @param params the service id
   * @returns the service
   * @route GET /admin/services/:id
   */
  @Route(showService)
  show(@Param() params: ParamsOf<typeof showService>): Promise<ResultOf<typeof showService>> {
    return this.services.show(params.id);
  }

  /**
   * Creates a service.
   *
   * @param body the service fields
   * @returns the new service
   * @route POST /admin/services
   */
  @Route(createService)
  create(@Body() body: BodyOf<typeof createService>): Promise<ResultOf<typeof createService>> {
    return this.services.create(body);
  }

  /**
   * Changes a service.
   *
   * @param params the service id
   * @param body the keys to change
   * @returns the updated service
   * @route PATCH /admin/services/:id
   */
  @Route(updateService)
  update(
    @Param() params: ParamsOf<typeof updateService>,
    @Body() body: BodyOf<typeof updateService>,
  ): Promise<ResultOf<typeof updateService>> {
    return this.services.update(params.id, body);
  }

  /**
   * Archives or deletes a service.
   *
   * @param params the service id
   * @returns nothing: the route answers 204
   * @route DELETE /admin/services/:id
   */
  @Route(deleteService)
  remove(@Param() params: ParamsOf<typeof deleteService>): Promise<void> {
    return this.services.remove(params.id);
  }

  /**
   * Replaces the custom fields of a service.
   *
   * @param params the service id
   * @param body the whole list of fields
   * @returns the saved fields
   * @route PUT /admin/services/:id/fields
   */
  @Route(replaceServiceFields)
  replaceFields(
    @Param() params: ParamsOf<typeof replaceServiceFields>,
    @Body() body: BodyOf<typeof replaceServiceFields>,
  ): Promise<ResultOf<typeof replaceServiceFields>> {
    return this.parts.replaceFields(params.id, body.fields);
  }

  /**
   * Replaces the option lists of a service.
   *
   * @param params the service id
   * @param body the whole list of options
   * @returns the saved options
   * @route PUT /admin/services/:id/options
   */
  @Route(replaceServiceOptions)
  replaceOptions(
    @Param() params: ParamsOf<typeof replaceServiceOptions>,
    @Body() body: BodyOf<typeof replaceServiceOptions>,
  ): Promise<ResultOf<typeof replaceServiceOptions>> {
    return this.parts.replaceOptions(params.id, body.options);
  }
}
