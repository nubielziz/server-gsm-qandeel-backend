// HTTP controller of the staff security tools on a merchant (feature 20, routes R1-R4 of /admin/clients/:id). Thin; the rules live in
// ClientSecurityAdminService.
import { Body, Controller, Header, Param } from '@nestjs/common';
import { type BodyOf, type ParamsOf, type ResultOf, Route } from '../../../common/contract';
import { ClientSecurityAdminService } from '../application/client-security-admin.service';
import {
  resendClientVerification,
  resetClientTwoFactor,
  revokeClientSessions,
  setClientPassword,
} from '../contracts/client-security.contracts';
import { CurrentStaff } from '../security/access-state';
import type { StaffPrincipal } from '../security/principal';

/**
 * The staff security routes of a merchant.
 *
 * Why: staff help a merchant who lost the invitation, the password or the authenticator (permission `clients:security`, separate from
 * `clients:update` because these actions let a person act as the merchant).
 *
 * @route POST /admin/clients/:id/password
 * @route POST /admin/clients/:id/reset-2fa
 * @route POST /admin/clients/:id/sessions/revoke
 * @route POST /admin/clients/:id/verify-email/resend
 */
@Controller()
export class ClientSecurityController {
  constructor(private readonly security: ClientSecurityAdminService) {}

  /**
   * Sends a set-password link or sets a temporary password. The answer is never cached.
   *
   * @param caller the signed-in staff member
   * @param params the merchant id
   * @param body the mode and whether to end the sessions
   * @returns `{ link }` or `{ temporaryPassword }`
   * @route POST /admin/clients/:id/password
   */
  @Route(setClientPassword)
  @Header('Cache-Control', 'no-store')
  setPassword(
    @CurrentStaff() caller: StaffPrincipal,
    @Param() params: ParamsOf<typeof setClientPassword>,
    @Body() body: BodyOf<typeof setClientPassword>,
  ): Promise<ResultOf<typeof setClientPassword>> {
    return this.security.setPassword(caller, params.id, body);
  }

  /**
   * Turns off a merchant's two-factor sign-in.
   *
   * @param params the merchant id
   * @returns nothing: the route answers 204
   * @route POST /admin/clients/:id/reset-2fa
   */
  @Route(resetClientTwoFactor)
  resetTwoFactor(@Param() params: ParamsOf<typeof resetClientTwoFactor>): Promise<void> {
    return this.security.resetTwoFactor(params.id);
  }

  /**
   * Ends every session of a merchant.
   *
   * @param params the merchant id
   * @returns nothing: the route answers 204
   * @route POST /admin/clients/:id/sessions/revoke
   */
  @Route(revokeClientSessions)
  revokeSessions(@Param() params: ParamsOf<typeof revokeClientSessions>): Promise<void> {
    return this.security.revokeSessions(params.id);
  }

  /**
   * Sends the merchant a new verification email.
   *
   * @param caller the signed-in staff member
   * @param params the merchant id
   * @returns nothing: the route answers 204
   * @route POST /admin/clients/:id/verify-email/resend
   */
  @Route(resendClientVerification)
  resendVerification(
    @CurrentStaff() caller: StaffPrincipal,
    @Param() params: ParamsOf<typeof resendClientVerification>,
  ): Promise<void> {
    return this.security.resendVerification(caller, params.id);
  }
}
