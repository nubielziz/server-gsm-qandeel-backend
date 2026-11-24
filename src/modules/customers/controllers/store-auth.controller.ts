// HTTP controller of the shop's sign-in routes (map domain I, /store/v1/auth/* and /store/v1/me/password, stage 14; decision 064). Thin: it
// reads the request, calls the use case through its port and sets the cookies and headers; the password routes are aliases of the
// `/client/auth/*` use cases and the rules live in the application services behind the ports.
import { type ExecutionContext, Body, Controller, Header, Req, Res, createParamDecorator } from '@nestjs/common';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { type BodyOf, type ResultOf, Route } from '../../../common/contract';
import { AppError } from '../../../common/errors';
import {
  type AccountPrincipal,
  AccountLinkSignIn,
  AccountOwnPassword,
  AccountSignIn,
  CurrentAccount,
  SessionCookies,
  principalOf,
  requestMetaOf,
} from '../../identity';
import { CustomerAccountService } from '../application/customer-account.service';
import {
  changeMyPassword,
  forgotCustomerPassword,
  loginCustomer,
  logoutCustomer,
  requestMagicLink,
  setCustomerPasswordByLink,
  verifyMagicLink,
} from '../contracts/store-auth.contracts';

/**
 * Parameter decorator: the one-time link a `link-token` route was opened with.
 *
 * Why: the guard resolved the token in the body to the `auth_tokens` row without spending it; the exchange reads that row by its id.
 *
 * @throws {AppError} `TOKEN_INVALID` (410) when the request was not authenticated by a link token
 */
const CurrentLink = createParamDecorator((_data: unknown, context: ExecutionContext): number => {
  const principal = principalOf(context.switchToHttp().getRequest<FastifyRequest>());
  if (principal?.kind !== 'capability' || principal.access !== 'link-token') throw new AppError('TOKEN_INVALID');
  return principal.resourceId;
});

/**
 * The shop's sign-in routes.
 *
 * Why: a retail account signs in with an emailed link or a password, recovers a forgotten password, chooses one from an invitation and
 * changes it from the account (map stage 14, decision 018). The password routes run the use cases of the `/client/auth/*` family (one
 * sign-in, one forgot, one set-by-link, one sign-out for every account) and go when the contract release retires the aliases. Every answer
 * carries `Cache-Control: no-store`: these responses hold cookies, tokens or personal data.
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
    private readonly signIn: AccountSignIn,
    private readonly links: AccountLinkSignIn,
    private readonly passwords: AccountOwnPassword,
    private readonly accounts: CustomerAccountService,
    private readonly cookies: SessionCookies,
  ) {}

  /**
   * Emails a sign-in link.
   *
   * @param body the email
   * @param request the request (address for the rate limit and the link record, and the asking-browser cookie it already carried)
   * @param reply the reply, to set the asking-browser cookie
   * @route POST /store/v1/auth/magic-link
   */
  @Route(requestMagicLink)
  @Header('Cache-Control', 'no-store')
  async magicLink(
    @Body() body: BodyOf<typeof requestMagicLink>,
    @Req() request: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<void> {
    const browser = await this.links.requestLink(
      body.email,
      requestMetaOf(request),
      this.cookies.readLinkBrowser(request),
    );
    this.cookies.setLinkBrowser(reply, browser.browserKey, browser.expiresAt);
  }

  /**
   * Exchanges a sign-in link for a session.
   *
   * @param linkId the one-time link the guard resolved
   * @param body the token (read by the guard) and the choice to claim the orders of the guest row of the email
   * @param request the request (a stale session cookie on it is ended; its asking-browser cookie tells whether it asked for the link)
   * @param reply the reply, to set the session's cookies and the CSRF header
   * @returns the account the link opened, whether this browser asked for the link, the masked address, the next step and the claim result
   * @route POST /store/v1/auth/verify
   */
  @Route(verifyMagicLink)
  @Header('Cache-Control', 'no-store')
  async verify(
    @CurrentLink() linkId: number,
    @Body() body: BodyOf<typeof verifyMagicLink>,
    @Req() request: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<ResultOf<typeof verifyMagicLink>> {
    const browserKey = this.cookies.readLinkBrowser(request);
    const exchanged = await this.links.exchange(
      {
        linkId,
        claimGuestOrders: body.claimGuestOrders ?? false,
        ...(browserKey === undefined ? {} : { browserKey }),
      },
      request,
      reply,
    );
    const me = await this.accounts.meOf(exchanged.accountId);
    return {
      ...me,
      requestedHere: exchanged.requestedHere,
      maskedEmail: exchanged.maskedEmail,
      next: exchanged.next,
      claimedOrders: exchanged.claimedOrders,
      ...(exchanged.claimSkipped === undefined ? {} : { claimSkipped: exchanged.claimSkipped }),
    };
  }

  /**
   * Signs in with email and password (the alias of `POST /client/auth/sign-in` that answers the next step only).
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
    const { next } = await this.signIn.signIn(body, request, reply);
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
    await this.signIn.forgotPassword(body.email, requestMetaOf(request));
  }

  /**
   * Chooses a password with an invitation or reset link.
   *
   * @param body the token and the new password
   * @param request the request
   * @route POST /store/v1/auth/password/set
   */
  @Route(setCustomerPasswordByLink)
  @Header('Cache-Control', 'no-store')
  async setPassword(
    @Body() body: BodyOf<typeof setCustomerPasswordByLink>,
    @Req() request: FastifyRequest,
  ): Promise<void> {
    await this.signIn.resetPassword(body, requestMetaOf(request));
  }

  /**
   * Changes the password of the signed-in account.
   *
   * Why: an active session runs the account's own change; a `pending_password` session (a temporary password, the shop of the time before
   * accounts became one) runs the forced change, which rotates the session and sets its cookies on the reply.
   *
   * @param account the session's account
   * @param body the current and the new password
   * @param request the request
   * @param reply the reply, to set the new session's cookies after a forced change
   * @route POST /store/v1/me/password
   */
  @Route(changeMyPassword)
  @Header('Cache-Control', 'no-store')
  async changePassword(
    @CurrentAccount() account: AccountPrincipal,
    @Body() body: BodyOf<typeof changeMyPassword>,
    @Req() request: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<void> {
    if (account.stage === 'pending_password') {
      await this.signIn.changeForcedPassword(account, body.newPassword, request, reply);
      return;
    }
    await this.passwords.change(account, body);
  }

  /**
   * Signs out.
   *
   * @param account the session's account
   * @param reply the reply, to clear the cookies
   * @route POST /store/v1/auth/logout
   */
  @Route(logoutCustomer)
  @Header('Cache-Control', 'no-store')
  async logout(
    @CurrentAccount() account: AccountPrincipal,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<void> {
    await this.signIn.signOut(account, reply);
  }
}
