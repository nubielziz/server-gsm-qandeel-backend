// HTTP controller of the alert routes (map domain G, /admin/alerts*, feature 12b). Thin: the rules live in AlertsService.
import { Body, Controller, Param, Query } from '@nestjs/common';
import { type BodyOf, type ParamsOf, type QueryOf, type ResultOf, Route } from '../../../common/contract';
import { CurrentStaff, type StaffPrincipal } from '../../identity';
import { AlertsService } from '../application/alerts.service';
import { ackAlert, listAlerts, showAlert } from '../contracts/alerts.contracts';

/**
 * The alert routes.
 *
 * Why: the console's Alerts and incidents tab lists fired alerts and lets staff acknowledge a firing one.
 *
 * @route GET /admin/alerts
 * @route GET /admin/alerts/:id
 * @route POST /admin/alerts/:id/ack
 */
@Controller()
export class AlertsController {
  constructor(private readonly alerts: AlertsService) {}

  /**
   * Lists alerts.
   *
   * @param query the parsed list request
   * @returns the rows and the total
   * @route GET /admin/alerts
   */
  @Route(listAlerts)
  list(@Query() query: QueryOf<typeof listAlerts>): Promise<ResultOf<typeof listAlerts>> {
    return this.alerts.list(query);
  }

  /**
   * Shows an alert.
   *
   * @param params the alert id
   * @returns the alert
   * @route GET /admin/alerts/:id
   */
  @Route(showAlert)
  show(@Param() params: ParamsOf<typeof showAlert>): Promise<ResultOf<typeof showAlert>> {
    return this.alerts.show(params.id);
  }

  /**
   * Acknowledges an alert.
   *
   * @param staff the signed-in staff member
   * @param params the alert id
   * @param body the optional note
   * @returns the acknowledged alert
   * @route POST /admin/alerts/:id/ack
   */
  @Route(ackAlert)
  acknowledge(
    @CurrentStaff() staff: StaffPrincipal,
    @Param() params: ParamsOf<typeof ackAlert>,
    @Body() body: BodyOf<typeof ackAlert>,
  ): Promise<ResultOf<typeof ackAlert>> {
    return this.alerts.acknowledge(staff.staffId, params.id, body.note);
  }
}
