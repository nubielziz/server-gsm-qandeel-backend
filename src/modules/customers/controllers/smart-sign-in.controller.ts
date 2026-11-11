// HTTP controller of the smart sign-in (feature 24A, POST /client/auth/sign-in). Thin: it reads both kinds' session cookies, calls the
// use case and sets the cookies and the CSRF header of the kind that signed in; the rules live in SmartSignInService.
import { Body, Controller, Header, Req, Res } from '@nestjs/common';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { type BodyOf, type ResultOf, Route } from '../../../common/contract';
import { requestMetaOf, SessionCookies } from '../../identity';
import { SmartSignInService } from '../application/smart-sign-in.service';
import { smartSignIn } from '../contracts/smart-sign-in.contracts';

/**
 * The one sign-in form of the site.
 *
 * Why: feature 24A (ROADMAP 1.3): merchants and customers sign in from the same form. The answer carries `Cache-Control: no-store`
 * (it holds cookies and a token). `kind` tells the site which surface the cookies and the `X-CSRF-Token` header belong to
 * (`merchant` → `/client`, `customer` → `/store/v1`).
 *
 * @route POST /client/auth/sign-in
 */
@Controller()
export class SmartSignInController {
  constructor(
    private readonly signIn: SmartSignInService,
    private readonly cookies: SessionCookies,
  ) {}

  /**
   * Signs a merchant or a customer in with email and password.
   *
   * @param body the credentials
   * @param request the request (the stale session cookie of the kind that signs in is ended)
   * @param reply the reply, to set that kind's session cookies and CSRF header
   * @returns the account kind and the next step
   * @route POST /client/auth/sign-in
   */
  @Route(smartSignIn)
  @Header('Cache-Control', 'no-store')
  async signInWithPassword(
    @Body() body: BodyOf<typeof smartSignIn>,
    @Req() request: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<ResultOf<typeof smartSignIn>> {
    const { kind, next, session } = await this.signIn.signIn(body, requestMetaOf(request), {
      client: this.cookies.readToken(request, 'client'),
      customer: this.cookies.readToken(request, 'customer'),
    });
    this.cookies.set(reply, kind === 'merchant' ? 'client' : 'customer', session.token, session.session.expiresAt);
    return { kind, next };
  }
}
