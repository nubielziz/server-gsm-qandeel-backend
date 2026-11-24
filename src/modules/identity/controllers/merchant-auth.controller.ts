// HTTP controller of the sign-in routes `/client/auth/*` (map domain A, stage 2; decision 064). Thin: it reads the request, calls the use
// case through its port and sets the cookies and headers; the rules live in the application services behind the ports.
import { Body, Controller, Header, Req, Res } from '@nestjs/common';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { type BodyOf, type ResultOf, Route } from '../../../common/contract';
import { MerchantAccountService } from '../application/merchant-account.service';
import { requestMetaOf } from '../application/request-meta';
import {
  merchantForgotPassword,
  merchantChangeTemporaryPassword,
  merchantLogin,
  merchantLogout,
  merchantMe,
  merchantResendVerification,
  merchantResetPassword,
  merchantVerifyEmail,
  merchantVerifyTwoFactor,
} from '../contracts/merchant-auth.contracts';
import { AccountEmailVerification, AccountSignIn } from '../ports/account-auth';
import { CurrentAccount, type AccountPrincipal } from '../ports/account-principal';
import { CSRF_HEADER, CsrfService } from '../security/csrf';

/**
 * The sign-in routes of the `/client/auth` family.
 *
 * Why: one sign-in, one code step, one sign-out, one forced password change and one set of password links serve every account (decision
 * 064); the portal and the shop call these routes. The controller calls the ports (`AccountSignIn`, `AccountEmailVerification`), never the
 * services behind them. Every answer carries `Cache-Control: no-store`: these responses hold cookies, tokens or personal data.
 *
 * @route POST /client/auth/verify-email
 * @route POST /client/auth/login
 * @route POST /client/auth/2fa
 * @route POST /client/auth/logout
 * @route POST /client/auth/password/change
 * @route POST /client/auth/verify-email/resend
 * @route POST /client/auth/password/forgot
 * @route POST /client/auth/password/reset
 * @route GET /client/auth/me
 */
@Controller()
export class MerchantAuthController {
  constructor(
    private readonly emailVerification: AccountEmailVerification,
    private readonly signIn: AccountSignIn,
    private readonly account: MerchantAccountService,
    private readonly csrf: CsrfService,
  ) {}

  /**
   * Verifies the email address with the emailed token.
   *
   * @param body the token
   * @param request the request (a session cookie on it is read)
   * @route POST /client/auth/verify-email
   */
  @Route(merchantVerifyEmail)
  @Header('Cache-Control', 'no-store')
  async verifyEmail(@Body() body: BodyOf<typeof merchantVerifyEmail>, @Req() request: FastifyRequest): Promise<void> {
    await this.emailVerification.verify(body.token, request, requestMetaOf(request));
  }

  /**
   * Signs in with email and password (the alias of `POST /client/auth/sign-in` that answers the next step only).
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
    const { next } = await this.signIn.signIn(body, request, reply);
    return { next };
  }

  /**
   * Completes the sign-in with an authenticator code.
   *
   * @param account the pending session's account
   * @param body the code
   * @param request the request
   * @param reply the reply, to set the full session's cookies and the CSRF header
   * @route POST /client/auth/2fa
   */
  @Route(merchantVerifyTwoFactor)
  @Header('Cache-Control', 'no-store')
  async verifyTwoFactor(
    @CurrentAccount() account: AccountPrincipal,
    @Body() body: BodyOf<typeof merchantVerifyTwoFactor>,
    @Req() request: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<void> {
    await this.signIn.finishCodeStep(account, body.code, request, reply);
  }

  /**
   * Signs out.
   *
   * @param account the session's account
   * @param reply the reply, to clear the cookies
   * @route POST /client/auth/logout
   */
  @Route(merchantLogout)
  @Header('Cache-Control', 'no-store')
  async logout(
    @CurrentAccount() account: AccountPrincipal,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<void> {
    await this.signIn.signOut(account, reply);
  }

  /**
   * Replaces a temporary password during the sign-in and continues it.
   *
   * @param account the `pending_password` session's account
   * @param body the new password
   * @param request the request
   * @param reply the reply, to set the rotated session's cookies and the CSRF header
   * @returns the next step (`totp` or `done`)
   * @route POST /client/auth/password/change
   */
  @Route(merchantChangeTemporaryPassword)
  @Header('Cache-Control', 'no-store')
  async changeTemporaryPassword(
    @CurrentAccount() account: AccountPrincipal,
    @Body() body: BodyOf<typeof merchantChangeTemporaryPassword>,
    @Req() request: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<ResultOf<typeof merchantChangeTemporaryPassword>> {
    const { next } = await this.signIn.changeForcedPassword(account, body.password, request, reply);
    return { next };
  }

  /**
   * Sends the signed-in account a new verification email.
   *
   * @param account the session's account
   * @param request the request
   * @route POST /client/auth/verify-email/resend
   */
  @Route(merchantResendVerification)
  @Header('Cache-Control', 'no-store')
  async resendVerification(@CurrentAccount() account: AccountPrincipal, @Req() request: FastifyRequest): Promise<void> {
    await this.emailVerification.resend(account, requestMetaOf(request));
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
    await this.signIn.forgotPassword(body.email, requestMetaOf(request));
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
    await this.signIn.resetPassword(body, requestMetaOf(request));
  }

  /**
   * Describes the signed-in account.
   *
   * @param account the full session's account
   * @param reply the reply, to repeat the CSRF token in `X-CSRF-Token`
   * @returns the account and its rank (`AccountMe`)
   * @route GET /client/auth/me
   */
  @Route(merchantMe)
  @Header('Cache-Control', 'no-store')
  async me(
    @CurrentAccount() account: AccountPrincipal,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<ResultOf<typeof merchantMe>> {
    const me = await this.account.me(account);
    // After a reload a cross-site portal can only recover the token from a response header.
    void reply.header(CSRF_HEADER, this.csrf.tokenFor(account.session.tokenHash));
    return me;
  }
}
