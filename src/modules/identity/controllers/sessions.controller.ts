// HTTP controller of the admin session routes (map domain A, /admin/sessions, stage 2). Thin; the rules live in
// SessionAdminService.
import { Controller, Param, Query } from '@nestjs/common';
import { type ParamsOf, type QueryOf, type ResultOf, Route } from '../../../common/contract';
import { SessionAdminService } from '../application/session-admin.service';
import { listSessions, revokeSession } from '../contracts/sessions.contracts';
import { CurrentStaff } from '../security/access-state';
import type { StaffPrincipal } from '../security/principal';

/**
 * The admin session routes.
 *
 * Why: staff see who is signed in and end sessions (scenario ip-rules, admin-team).
 *
 * @route GET /admin/sessions
 * @route DELETE /admin/sessions/:id
 */
@Controller()
export class SessionsController {
  constructor(private readonly sessions: SessionAdminService) {}

  /**
   * Lists live sessions.
   *
   * @param staff the caller
   * @param query the parsed list request
   * @returns the rows and the total
   * @route GET /admin/sessions
   */
  @Route(listSessions)
  list(
    @CurrentStaff() staff: StaffPrincipal,
    @Query() query: QueryOf<typeof listSessions>,
  ): Promise<ResultOf<typeof listSessions>> {
    return this.sessions.list(staff, query);
  }

  /**
   * Ends a session.
   *
   * @param staff the caller
   * @param params the session id
   * @returns nothing: the route answers 204
   * @route DELETE /admin/sessions/:id
   */
  @Route(revokeSession)
  remove(@CurrentStaff() staff: StaffPrincipal, @Param() params: ParamsOf<typeof revokeSession>): Promise<void> {
    return this.sessions.remove(staff, params.id);
  }
}
