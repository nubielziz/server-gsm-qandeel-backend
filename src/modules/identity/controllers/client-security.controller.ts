// HTTP controller of the staff security tools on an account (feature 20, routes of /admin/clients/:id) and of "Make an account". Thin; the rules
// live in ClientSecurityAdminService and AccountGuestService.
import { Body, Controller, Header, Param } from '@nestjs/common';
import { type BodyOf, type ParamsOf, type ResultOf, Route } from '../../../common/contract';
import { AccountGuestService } from '../application/account-guest.service';
import { ClientSecurityAdminService } from '../application/client-security-admin.service';
import {
  makeClientAccount,
  resendClientVerification,
  resetClientTwoFactor,
  revokeClientSessions,
  setClientPassword,
} from '../contracts/client-security.contracts';
import { CurrentStaff } from '../security/access-state';
import type { StaffPrincipal } from '../security/principal';

/**
 * The staff security routes of an account.
 *
 * Why: staff help a person who lost the invitation, the password or the authenticator (permission `clients:security`, separate from
 * `clients:update` because these actions let a person act as the account), whatever the account's rank; and staff give a guest a login.
 *
 * @route POST /admin/clients/:id/password
 * @route POST /admin/clients/:id/reset-2fa
 * @route POST /admin/clients/:id/sessions/revoke
 * @route POST /admin/clients/:id/verify-email/resend
 * @route POST /admin/clients/:id/account
 */
@Controller()
export class ClientSecurityController {
  constructor(
    private readonly security: ClientSecurityAdminService,
    private readonly guests: AccountGuestService,
  ) {}

  /**
   * Sends a set-password link or sets a temporary password. The answer is never cached.
   *
   * @param caller the signed-in staff member
   * @param params the account id
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
   * Turns off an account's two-factor sign-in.
   *
   * @param params the account id
   * @returns nothing: the route answers 204
   * @route POST /admin/clients/:id/reset-2fa
   */
  @Route(resetClientTwoFactor)
  resetTwoFactor(@Param() params: ParamsOf<typeof resetClientTwoFactor>): Promise<void> {
    return this.security.resetTwoFactor(params.id);
  }

  /**
   * Ends every session of an account.
   *
   * @param params the account id
   * @returns nothing: the route answers 204
   * @route POST /admin/clients/:id/sessions/revoke
   */
  @Route(revokeClientSessions)
  revokeSessions(@Param() params: ParamsOf<typeof revokeClientSessions>): Promise<void> {
    return this.security.revokeSessions(params.id);
  }

  /**
   * Sends the account a new verification email.
   *
   * @param caller the signed-in staff member
   * @param params the account id
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

  /**
   * Makes an account of a guest. The answer is never cached (it may carry a temporary password).
   *
   * @param caller the signed-in staff member
   * @param params the guest row's id
   * @param body how the account gets a password
   * @returns `{ link: 'invite' }` or `{ temporaryPassword }`
   * @route POST /admin/clients/:id/account
   */
  @Route(makeClientAccount)
  @Header('Cache-Control', 'no-store')
  makeAccount(
    @CurrentStaff() caller: StaffPrincipal,
    @Param() params: ParamsOf<typeof makeClientAccount>,
    @Body() body: BodyOf<typeof makeClientAccount>,
  ): Promise<ResultOf<typeof makeClientAccount>> {
    return this.guests.makeAccount(caller, params.id, body.mode);
  }
}
