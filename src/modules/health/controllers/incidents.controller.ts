// HTTP controller of the incident routes (map domain G, /admin/incidents*, feature 12b). Thin: the rules live in IncidentsService.
import { Body, Controller, Param, Query } from '@nestjs/common';
import { type BodyOf, type ParamsOf, type QueryOf, type ResultOf, Route } from '../../../common/contract';
import { CurrentStaff, type StaffPrincipal } from '../../identity';
import { IncidentsService } from '../application/incidents.service';
import { createIncident, listIncidents, showIncident, updateIncident } from '../contracts/incidents.contracts';

/**
 * The incident routes.
 *
 * Why: the console's Alerts and incidents tab declares incidents, adds timeline updates and closes them with the root cause.
 *
 * @route GET /admin/incidents
 * @route GET /admin/incidents/:id
 * @route POST /admin/incidents
 * @route PATCH /admin/incidents/:id
 */
@Controller()
export class IncidentsController {
  constructor(private readonly incidents: IncidentsService) {}

  /**
   * Lists incidents.
   *
   * @param query the parsed list request
   * @returns the rows and the total
   * @route GET /admin/incidents
   */
  @Route(listIncidents)
  list(@Query() query: QueryOf<typeof listIncidents>): Promise<ResultOf<typeof listIncidents>> {
    return this.incidents.list(query);
  }

  /**
   * Shows an incident.
   *
   * @param params the incident id
   * @returns the incident with its timeline
   * @route GET /admin/incidents/:id
   */
  @Route(showIncident)
  show(@Param() params: ParamsOf<typeof showIncident>): Promise<ResultOf<typeof showIncident>> {
    return this.incidents.show(params.id);
  }

  /**
   * Declares an incident.
   *
   * @param staff the signed-in staff member
   * @param body the incident's fields
   * @returns the new incident
   * @route POST /admin/incidents
   */
  @Route(createIncident)
  declare(
    @CurrentStaff() staff: StaffPrincipal,
    @Body() body: BodyOf<typeof createIncident>,
  ): Promise<ResultOf<typeof createIncident>> {
    return this.incidents.declare(staff.staffId, body);
  }

  /**
   * Updates or closes an incident.
   *
   * @param staff the signed-in staff member
   * @param params the incident id
   * @param body the fields to change
   * @returns the updated incident
   * @route PATCH /admin/incidents/:id
   */
  @Route(updateIncident)
  update(
    @CurrentStaff() staff: StaffPrincipal,
    @Param() params: ParamsOf<typeof updateIncident>,
    @Body() body: BodyOf<typeof updateIncident>,
  ): Promise<ResultOf<typeof updateIncident>> {
    return this.incidents.update(staff.staffId, params.id, body);
  }
}
