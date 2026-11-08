// HTTP controller of the storefront customer's sign-in routes (map domain I, /store/v1/auth/* and /store/v1/me/password, stage 14).
// Thin: it reads the request, calls the use case and sets the cookies and headers; the rules live in the application services.
import { Body, Controller, Header, Req, Res } from '@nestjs/common';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { type BodyOf, type ResultOf, Route } from '../../../common/contract';
import { type CustomerPrincipal, requestMetaOf, SessionCookies } from '../../identity';
import { CustomerPasswordService } from '../application/customer-password.service';
import { CustomerSignInService } from '../application/customer-sign-in.service';
import {
  changeMyPassword,
  forgotCustomerPassword,
  loginCustomer,
  logoutCustomer,
  requestMagicLink,
  setCustomerPasswordByLink,
  verifyMagicLink,
} from '../contracts/store-auth.contracts';
import { CurrentCustomer, CurrentLink } from './current-customer';

/**
 * The storefront customer's sign-in routes.
 *
 * Why: a customer signs in with an emailed link or a password, recovers a forgotten password, chooses one from an invitation and
 * changes it from the account (map stage 14, decision 018). Every answer carries `Cache-Control: no-store`: these responses hold
 * cookies, tokens or personal data.
 *
 * @route POST /store/v1/auth/magic-link
 * @route POST /store/v1/auth/verify
 * @route POST /store/v1/auth/login
 * @route POST /store/v1/auth/password/forgot
 * @route POST /store/v1/auth/password/set
 * @route POST /store/v1/me/password
 * @route POST /store/v1/auth/logout
 */
@Controller()
export class StoreAuthController {
  constructor(
    private readonly signIn: CustomerSignInService,
    private readonly passwords: CustomerPasswordService,
    private readonly cookies: SessionCookies,
  ) {}

  /**
   * Emails a sign-in link.
   *
   * @param body the email
   * @param request the request (address for the rate limit and the link record)
   * @route POST /store/v1/auth/magic-link
   */
  @Route(requestMagicLink)
  @Header('Cache-Control', 'no-store')
  async magicLink(@Body() body: BodyOf<typeof requestMagicLink>, @Req() request: FastifyRequest): Promise<void> {
    await this.signIn.requestMagicLink(body.email, requestMetaOf(request));
  }

  /**
   * Exchanges a sign-in link for a session.
   *
   * @param linkId the one-time link the guard resolved
   * @param request the request (a stale session cookie on it is ended)
   * @param reply the reply, to set the session's cookies and the CSRF header
   * @returns the customer's account
   * @route POST /store/v1/auth/verify
   */
  @Route(verifyMagicLink)
  @Header('Cache-Control', 'no-store')
  async verify(
    @CurrentLink() linkId: number,
    @Req() request: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<ResultOf<typeof verifyMagicLink>> {
    const { me, session } = await this.signIn.verifyLink(
      linkId,
      requestMetaOf(request),
      this.cookies.readToken(request, 'customer'),
    );
    this.cookies.set(reply, 'customer', session.token, session.session.expiresAt);
    return me;
  }

  /**
   * Signs in with email and password.
   *
   * @param body the credentials
   * @param request the request (a stale session cookie on it is ended)
   * @param reply the reply, to set the session's cookies and the CSRF header
   * @returns the next step
   * @route POST /store/v1/auth/login
   */
  @Route(loginCustomer)
  @Header('Cache-Control', 'no-store')
  async login(
    @Body() body: BodyOf<typeof loginCustomer>,
    @Req() request: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<ResultOf<typeof loginCustomer>> {
    const { next, session } = await this.signIn.login(
      body,
      requestMetaOf(request),
      this.cookies.readToken(request, 'customer'),
    );
    this.cookies.set(reply, 'customer', session.token, session.session.expiresAt);
    return { next };
  }

  /**
   * Sends a password reset link.
   *
   * @param body the email
   * @param request the request
   * @route POST /store/v1/auth/password/forgot
   */
  @Route(forgotCustomerPassword)
  @Header('Cache-Control', 'no-store')
  async forgot(@Body() body: BodyOf<typeof forgotCustomerPassword>, @Req() request: FastifyRequest): Promise<void> {
    await this.passwords.forgot(body.email, requestMetaOf(request));
  }

  /**
   * Chooses a password with an invitation or reset link.
   *
   * @param linkId the one-time link the guard resolved
   * @param body the token (already used by the guard) and the new password
   * @route POST /store/v1/auth/password/set
   */
  @Route(setCustomerPasswordByLink)
  @Header('Cache-Control', 'no-store')
  async setPassword(
    @CurrentLink() linkId: number,
    @Body() body: BodyOf<typeof setCustomerPasswordByLink>,
  ): Promise<void> {
    await this.passwords.setByLink(linkId, body.password);
  }

  /**
   * Changes the password of the signed-in customer.
   *
   * @param customer the session's customer
   * @param body the current and the new password
   * @param request the request
   * @param reply the reply, to set the new session's cookies after a forced change
   * @route POST /store/v1/me/password
   */
  @Route(changeMyPassword)
  @Header('Cache-Control', 'no-store')
  async changePassword(
    @CurrentCustomer() customer: CustomerPrincipal,
    @Body() body: BodyOf<typeof changeMyPassword>,
    @Req() request: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<void> {
    const { session } = await this.passwords.change(customer, body, requestMetaOf(request));
    if (session) this.cookies.set(reply, 'customer', session.token, session.session.expiresAt);
  }

  /**
   * Signs out.
   *
   * @param customer the session's customer
   * @param reply the reply, to clear both cookies
   * @route POST /store/v1/auth/logout
   */
  @Route(logoutCustomer)
  @Header('Cache-Control', 'no-store')
  async logout(
    @CurrentCustomer() customer: CustomerPrincipal,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<void> {
    await this.signIn.logout(customer);
    this.cookies.clear(reply, 'customer');
  }
}
