// HTTP controller of the service routes (map domain B, /admin/services, stage 4), including the replace-all custom fields and
// option lists. Thin: the rules live in ServiceAdminService and ServicePartsService.
import { Body, Controller, Param, Query } from '@nestjs/common';
import { type BodyOf, type ParamsOf, type QueryOf, type ResultOf, Route } from '../../../common/contract';
import { CurrentStaff, type StaffPrincipal } from '../../identity';
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
   * @param staff the signed-in staff member (decision 060: the shop facts and filters follow the caller's permissions)
   * @param query the parsed list request
   * @returns the rows and the total
   * @route GET /admin/services
   */
  @Route(listServices)
  list(
    @CurrentStaff() staff: StaffPrincipal,
    @Query() query: QueryOf<typeof listServices>,
  ): Promise<ResultOf<typeof listServices>> {
    return this.services.list(staff, query);
  }

  /**
   * Shows a service with its parts.
   *
   * @param staff the signed-in staff member (decision 060: the shop facts follow the caller's permissions)
   * @param params the service id
   * @returns the service
   * @route GET /admin/services/:id
   */
  @Route(showService)
  show(
    @CurrentStaff() staff: StaffPrincipal,
    @Param() params: ParamsOf<typeof showService>,
  ): Promise<ResultOf<typeof showService>> {
    return this.services.show(staff, params.id);
  }

  /**
   * Creates a service.
   *
   * @param staff the signed-in staff member (decision 060: the shop facts of the answer follow the caller's permissions)
   * @param body the service fields
   * @returns the new service
   * @route POST /admin/services
   */
  @Route(createService)
  create(
    @CurrentStaff() staff: StaffPrincipal,
    @Body() body: BodyOf<typeof createService>,
  ): Promise<ResultOf<typeof createService>> {
    return this.services.create(staff, body);
  }

  /**
   * Changes a service.
   *
   * @param staff the signed-in staff member (decisions 046 and 069: `basePrice`, `minProfit` and `ownCost` also need `pricing:update`)
   * @param params the service id
   * @param body the keys to change
   * @returns the updated service
   * @route PATCH /admin/services/:id
   */
  @Route(updateService)
  update(
    @CurrentStaff() staff: StaffPrincipal,
    @Param() params: ParamsOf<typeof updateService>,
    @Body() body: BodyOf<typeof updateService>,
  ): Promise<ResultOf<typeof updateService>> {
    return this.services.update(staff, params.id, body);
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
