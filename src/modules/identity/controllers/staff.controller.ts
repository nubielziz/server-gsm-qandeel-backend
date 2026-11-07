// HTTP controller of the staff management routes (map domain A, /admin/staff, stage 2). Thin: it maps the request to the
// use case; the rules live in StaffAdminService.
import { Body, Controller, Header, Param, Query } from '@nestjs/common';
import { type BodyOf, type ParamsOf, type QueryOf, type ResultOf, Route } from '../../../common/contract';
import { StaffAdminService } from '../application/staff-admin.service';
import {
  createStaff,
  listStaff,
  reactivateStaff,
  resetStaffTwoFactor,
  revokeStaffSessions,
  setStaffPassword,
  showStaff,
  suspendStaff,
  updateStaff,
} from '../contracts/staff.contracts';
import { CurrentStaff } from '../security/access-state';
import type { StaffPrincipal } from '../security/principal';

/**
 * The staff management routes.
 *
 * Why: scenario admin-team: an Owner adds, edits, suspends and reactivates staff and resets their password and 2FA.
 *
 * @route GET /admin/staff
 * @route GET /admin/staff/:id
 * @route POST /admin/staff
 * @route PATCH /admin/staff/:id
 * @route POST /admin/staff/:id/password
 * @route POST /admin/staff/:id/sessions/revoke
 * @route POST /admin/staff/:id/suspend
 * @route POST /admin/staff/:id/reactivate
 * @route POST /admin/staff/:id/reset-2fa
 */
@Controller()
export class StaffController {
  constructor(private readonly staff: StaffAdminService) {}

  /**
   * Lists staff members.
   *
   * @param query the parsed list request
   * @returns the rows and the total
   * @route GET /admin/staff
   */
  @Route(listStaff)
  list(@Query() query: QueryOf<typeof listStaff>): Promise<ResultOf<typeof listStaff>> {
    return this.staff.list(query);
  }

  /**
   * Shows a staff member.
   *
   * @param params the member id
   * @returns the member
   * @route GET /admin/staff/:id
   */
  @Route(showStaff)
  show(@Param() params: ParamsOf<typeof showStaff>): Promise<ResultOf<typeof showStaff>> {
    return this.staff.show(params.id);
  }

  /**
   * Adds a staff member. The answer may carry a temporary password, so it is never cached.
   *
   * @param caller the signed-in staff member
   * @param body the new member
   * @returns the member
   * @route POST /admin/staff
   */
  @Route(createStaff)
  @Header('Cache-Control', 'no-store')
  create(
    @CurrentStaff() caller: StaffPrincipal,
    @Body() body: BodyOf<typeof createStaff>,
  ): Promise<ResultOf<typeof createStaff>> {
    return this.staff.create(caller, body);
  }

  /**
   * Edits a staff member.
   *
   * @param caller the signed-in staff member
   * @param params the member id
   * @param body the keys to change
   * @returns the updated member
   * @route PATCH /admin/staff/:id
   */
  @Route(updateStaff)
  update(
    @CurrentStaff() caller: StaffPrincipal,
    @Param() params: ParamsOf<typeof updateStaff>,
    @Body() body: BodyOf<typeof updateStaff>,
  ): Promise<ResultOf<typeof updateStaff>> {
    return this.staff.update(caller, params.id, body);
  }

  /**
   * Sends a set-password link or sets a temporary password. The answer is never cached.
   *
   * @param caller the signed-in staff member
   * @param params the member id
   * @param body the mode and whether to end the sessions
   * @returns `{}` or `{ temporaryPassword }`
   * @route POST /admin/staff/:id/password
   */
  @Route(setStaffPassword)
  @Header('Cache-Control', 'no-store')
  setPassword(
    @CurrentStaff() caller: StaffPrincipal,
    @Param() params: ParamsOf<typeof setStaffPassword>,
    @Body() body: BodyOf<typeof setStaffPassword>,
  ): Promise<ResultOf<typeof setStaffPassword>> {
    return this.staff.setPassword(caller, params.id, body);
  }

  /**
   * Ends every session of a member.
   *
   * @param caller the signed-in staff member
   * @param params the member id
   * @returns nothing: the route answers 204
   * @route POST /admin/staff/:id/sessions/revoke
   */
  @Route(revokeStaffSessions)
  revokeSessions(
    @CurrentStaff() caller: StaffPrincipal,
    @Param() params: ParamsOf<typeof revokeStaffSessions>,
  ): Promise<void> {
    return this.staff.revokeSessions(caller, params.id);
  }

  /**
   * Suspends a member.
   *
   * @param caller the signed-in staff member
   * @param params the member id
   * @param body the reason
   * @returns nothing: the route answers 204
   * @route POST /admin/staff/:id/suspend
   */
  @Route(suspendStaff)
  suspend(
    @CurrentStaff() caller: StaffPrincipal,
    @Param() params: ParamsOf<typeof suspendStaff>,
    @Body() body: BodyOf<typeof suspendStaff>,
  ): Promise<void> {
    return this.staff.suspend(caller, params.id, body.reason);
  }

  /**
   * Reactivates a suspended member.
   *
   * @param caller the signed-in staff member
   * @param params the member id
   * @returns nothing: the route answers 204
   * @route POST /admin/staff/:id/reactivate
   */
  @Route(reactivateStaff)
  reactivate(@CurrentStaff() caller: StaffPrincipal, @Param() params: ParamsOf<typeof reactivateStaff>): Promise<void> {
    return this.staff.reactivate(caller, params.id);
  }

  /**
   * Clears a member's authenticator.
   *
   * @param caller the signed-in staff member
   * @param params the member id
   * @returns nothing: the route answers 204
   * @route POST /admin/staff/:id/reset-2fa
   */
  @Route(resetStaffTwoFactor)
  resetTwoFactor(
    @CurrentStaff() caller: StaffPrincipal,
    @Param() params: ParamsOf<typeof resetStaffTwoFactor>,
  ): Promise<void> {
    return this.staff.resetTwoFactor(caller, params.id);
  }
}
