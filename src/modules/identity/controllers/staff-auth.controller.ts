// HTTP controller of the staff sign-in routes (map domain A, /admin/auth/*, stage 2). Thin: it reads the request, calls the
// use case and sets the cookies and headers; the rules live in the application services.
import { Body, Controller, Header, Req, Res } from '@nestjs/common';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { type BodyOf, type ResultOf, Route } from '../../../common/contract';
import { requestMetaOf } from '../application/request-meta';
import { StaffPasswordService } from '../application/staff-password.service';
import { StaffSignInService } from '../application/staff-sign-in.service';
import {
  staffLogin,
  staffLogout,
  staffMe,
  staffSetPassword,
  staffSetupTwoFactor,
  staffVerifyTwoFactor,
} from '../contracts/auth.contracts';
import { CurrentStaff } from '../security/access-state';
import { CSRF_HEADER, CsrfService } from '../security/csrf';
import type { StaffPrincipal } from '../security/principal';
import { SessionCookies } from '../security/session-cookies';

/**
 * The staff sign-in routes.
 *
 * Why: the console signs in with email and password, then an authenticator code (ALIGNMENT § 3). Every answer carries
 * `Cache-Control: no-store`: these responses hold cookies, tokens or secrets.
 *
 * @route POST /admin/auth/login
 * @route POST /admin/auth/2fa
 * @route POST /admin/auth/2fa/setup
 * @route POST /admin/auth/logout
 * @route POST /admin/auth/password/set
 * @route GET /admin/auth/me
 */
@Controller()
export class StaffAuthController {
  constructor(
    private readonly signIn: StaffSignInService,
    private readonly passwords: StaffPasswordService,
    private readonly cookies: SessionCookies,
    private readonly csrf: CsrfService,
  ) {}

  /**
   * Signs in with email and password.
   *
   * @param body the credentials
   * @param request the request (a stale session cookie on it is ended)
   * @param reply the reply, to set the pending session's cookies and the CSRF header
   * @returns the next step
   * @route POST /admin/auth/login
   */
  @Route(staffLogin)
  @Header('Cache-Control', 'no-store')
  async login(
    @Body() body: BodyOf<typeof staffLogin>,
    @Req() request: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<ResultOf<typeof staffLogin>> {
    const { next, session } = await this.signIn.login(
      body,
      requestMetaOf(request),
      this.cookies.readToken(request, 'staff'),
    );
    this.cookies.set(reply, 'staff', session.token, session.session.expiresAt);
    return { next };
  }

  /**
   * Completes the sign-in with an authenticator code.
   *
   * @param staff the pending session's staff member
   * @param body the code
   * @param request the request
   * @param reply the reply, to set the full session's cookies and the CSRF header
   * @route POST /admin/auth/2fa
   */
  @Route(staffVerifyTwoFactor)
  @Header('Cache-Control', 'no-store')
  async verifyTwoFactor(
    @CurrentStaff() staff: StaffPrincipal,
    @Body() body: BodyOf<typeof staffVerifyTwoFactor>,
    @Req() request: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<void> {
    const issued = await this.signIn.verifyTwoFactor(staff, body.code, requestMetaOf(request));
    this.cookies.set(reply, 'staff', issued.token, issued.session.expiresAt);
  }

  /**
   * Starts the authenticator setup.
   *
   * @param staff the pending session's staff member
   * @returns the secret, the `otpauth://` link and the QR code
   * @route POST /admin/auth/2fa/setup
   */
  @Route(staffSetupTwoFactor)
  @Header('Cache-Control', 'no-store')
  setupTwoFactor(@CurrentStaff() staff: StaffPrincipal): Promise<ResultOf<typeof staffSetupTwoFactor>> {
    return this.signIn.setupTwoFactor(staff);
  }

  /**
   * Signs out.
   *
   * @param staff the session's staff member
   * @param reply the reply, to clear both cookies
   * @route POST /admin/auth/logout
   */
  @Route(staffLogout)
  @Header('Cache-Control', 'no-store')
  async logout(@CurrentStaff() staff: StaffPrincipal, @Res({ passthrough: true }) reply: FastifyReply): Promise<void> {
    await this.signIn.logout(staff);
    this.cookies.clear(reply, 'staff');
  }

  /**
   * Describes the signed-in member.
   *
   * @param staff the full session's staff member
   * @param reply the reply, to repeat the CSRF token in `X-CSRF-Token`
   * @returns the member
   * @route GET /admin/auth/me
   */
  @Route(staffMe)
  @Header('Cache-Control', 'no-store')
  async me(
    @CurrentStaff() staff: StaffPrincipal,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<ResultOf<typeof staffMe>> {
    const me = await this.signIn.me(staff);
    // After a reload a cross-site console can only recover the token from a response header.
    void reply.header(CSRF_HEADER, this.csrf.tokenFor(staff.session.tokenHash));
    return { ...me, lastLoginAt: me.lastLoginAt?.toISOString() ?? null, permissions: [...me.permissions] };
  }

  /**
   * Sets a new password from a link or after a temporary password.
   *
   * @param body the password and, for a link, its token
   * @param request the request (the pending-session mode reads its cookie and CSRF header)
   * @route POST /admin/auth/password/set
   */
  @Route(staffSetPassword)
  @Header('Cache-Control', 'no-store')
  async setPassword(@Body() body: BodyOf<typeof staffSetPassword>, @Req() request: FastifyRequest): Promise<void> {
    await this.passwords.setPassword(body, request, requestMetaOf(request));
  }
}
