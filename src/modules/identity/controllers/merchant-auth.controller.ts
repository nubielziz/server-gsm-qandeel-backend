// HTTP controller of the merchant portal's sign-in routes (map domain A, /client/auth/*, stage 2). Thin: it reads the request,
// calls the use case and sets the cookies and headers; the rules live in the application services.
import { Body, Controller, Header, Req, Res } from '@nestjs/common';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { type BodyOf, type ResultOf, Route } from '../../../common/contract';
import { type MerchantMe, MerchantAccountService } from '../application/merchant-account.service';
import { MerchantPasswordService } from '../application/merchant-password.service';
import { MerchantRegistrationService } from '../application/merchant-registration.service';
import { MerchantSignInService } from '../application/merchant-sign-in.service';
import { requestMetaOf } from '../application/request-meta';
import {
  merchantForgotPassword,
  merchantLogin,
  merchantLogout,
  merchantMe,
  merchantRegister,
  merchantResetPassword,
  merchantVerifyEmail,
  merchantVerifyTwoFactor,
} from '../contracts/merchant-auth.contracts';
import { CurrentMerchant } from '../security/access-state';
import { CSRF_HEADER, CsrfService } from '../security/csrf';
import type { MerchantPrincipal } from '../security/principal';
import { SessionCookies } from '../security/session-cookies';

/**
 * Serialises a merchant for the wire.
 *
 * Why: the use cases return `Date`s; the contract's `IsoDateTime` is text.
 *
 * @param me the merchant as the account service describes it
 * @returns the body of `Me`
 */
export function wireMe(me: MerchantMe): ResultOf<typeof merchantMe> {
  return { ...me, emailVerifiedAt: me.emailVerifiedAt?.toISOString() ?? null, createdAt: me.createdAt.toISOString() };
}

/**
 * The merchant portal's sign-in routes.
 *
 * Why: the portal registers, verifies the email, signs in (with an optional authenticator code), recovers a forgotten password
 * and shows the merchant's approval status (B121 to B129). Every answer carries `Cache-Control: no-store`: these responses hold
 * cookies, tokens or personal data.
 *
 * @route POST /client/auth/register
 * @route POST /client/auth/verify-email
 * @route POST /client/auth/login
 * @route POST /client/auth/2fa
 * @route POST /client/auth/logout
 * @route POST /client/auth/password/forgot
 * @route POST /client/auth/password/reset
 * @route GET /client/auth/me
 */
@Controller()
export class MerchantAuthController {
  constructor(
    private readonly registration: MerchantRegistrationService,
    private readonly signIn: MerchantSignInService,
    private readonly passwords: MerchantPasswordService,
    private readonly account: MerchantAccountService,
    private readonly cookies: SessionCookies,
    private readonly csrf: CsrfService,
  ) {}

  /**
   * Registers a merchant.
   *
   * @param body the registration form
   * @param request the request (address for the rate limit and the link record)
   * @route POST /client/auth/register
   */
  @Route(merchantRegister)
  @Header('Cache-Control', 'no-store')
  async register(@Body() body: BodyOf<typeof merchantRegister>, @Req() request: FastifyRequest): Promise<void> {
    await this.registration.register(body, requestMetaOf(request));
  }

  /**
   * Verifies the email address with the emailed token.
   *
   * @param body the token
   * @param request the request
   * @route POST /client/auth/verify-email
   */
  @Route(merchantVerifyEmail)
  @Header('Cache-Control', 'no-store')
  async verifyEmail(@Body() body: BodyOf<typeof merchantVerifyEmail>, @Req() request: FastifyRequest): Promise<void> {
    await this.registration.verifyEmail(body.token, requestMetaOf(request));
  }

  /**
   * Signs in with email and password.
   *
   * @param body the credentials
   * @param request the request (a stale session cookie on it is ended)
   * @param reply the reply, to set the session's cookies and the CSRF header
   * @returns the next step
   * @route POST /client/auth/login
   */
  @Route(merchantLogin)
  @Header('Cache-Control', 'no-store')
  async login(
    @Body() body: BodyOf<typeof merchantLogin>,
    @Req() request: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<ResultOf<typeof merchantLogin>> {
    const { next, session } = await this.signIn.login(
      body,
      requestMetaOf(request),
      this.cookies.readToken(request, 'client'),
    );
    this.cookies.set(reply, 'client', session.token, session.session.expiresAt);
    return { next };
  }

  /**
   * Completes the sign-in with an authenticator code.
   *
   * @param merchant the pending session's merchant
   * @param body the code
   * @param request the request
   * @param reply the reply, to set the full session's cookies and the CSRF header
   * @route POST /client/auth/2fa
   */
  @Route(merchantVerifyTwoFactor)
  @Header('Cache-Control', 'no-store')
  async verifyTwoFactor(
    @CurrentMerchant() merchant: MerchantPrincipal,
    @Body() body: BodyOf<typeof merchantVerifyTwoFactor>,
    @Req() request: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<void> {
    const issued = await this.signIn.verifyTwoFactor(merchant, body.code, requestMetaOf(request));
    this.cookies.set(reply, 'client', issued.token, issued.session.expiresAt);
  }

  /**
   * Signs out.
   *
   * @param merchant the session's merchant
   * @param reply the reply, to clear both cookies
   * @route POST /client/auth/logout
   */
  @Route(merchantLogout)
  @Header('Cache-Control', 'no-store')
  async logout(
    @CurrentMerchant() merchant: MerchantPrincipal,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<void> {
    await this.signIn.logout(merchant);
    this.cookies.clear(reply, 'client');
  }

  /**
   * Sends a password reset link.
   *
   * @param body the email
   * @param request the request
   * @route POST /client/auth/password/forgot
   */
  @Route(merchantForgotPassword)
  @Header('Cache-Control', 'no-store')
  async forgotPassword(
    @Body() body: BodyOf<typeof merchantForgotPassword>,
    @Req() request: FastifyRequest,
  ): Promise<void> {
    await this.passwords.forgot(body.email, requestMetaOf(request));
  }

  /**
   * Sets a new password from a reset or invite link.
   *
   * @param body the token and the new password
   * @param request the request
   * @route POST /client/auth/password/reset
   */
  @Route(merchantResetPassword)
  @Header('Cache-Control', 'no-store')
  async resetPassword(
    @Body() body: BodyOf<typeof merchantResetPassword>,
    @Req() request: FastifyRequest,
  ): Promise<void> {
    await this.passwords.reset(body, requestMetaOf(request));
  }

  /**
   * Describes the signed-in merchant.
   *
   * @param merchant the full session's merchant
   * @param reply the reply, to repeat the CSRF token in `X-CSRF-Token`
   * @returns the merchant, its approval status and its group
   * @route GET /client/auth/me
   */
  @Route(merchantMe)
  @Header('Cache-Control', 'no-store')
  async me(
    @CurrentMerchant() merchant: MerchantPrincipal,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<ResultOf<typeof merchantMe>> {
    const me = await this.account.me(merchant);
    // After a reload a cross-site portal can only recover the token from a response header.
    void reply.header(CSRF_HEADER, this.csrf.tokenFor(merchant.session.tokenHash));
    return wireMe(me);
  }
}
