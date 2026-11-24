// HTTP controller of the one sign-in (feature 24A, POST /client/auth/sign-in; decision 064). Thin: it calls the sign-in port, which opens the
// session and sets its cookies on the reply, and derives the area word of the answer from the rank.
import { Body, Controller, Header, Req, Res } from '@nestjs/common';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { type BodyOf, type ResultOf, Route } from '../../../common/contract';
import { AccountSignIn } from '../../identity';
import { smartSignIn } from '../contracts/smart-sign-in.contracts';

/**
 * The one sign-in form of the site.
 *
 * Why: feature 24A (ROADMAP 1.3): every account signs in from the same form (decision 064). The answer carries `Cache-Control: no-store`
 * (it holds cookies and a token). `rank.kind` tells the shop which area to show; `kind` (`merchant` or `customer`) says the same thing for the
 * shop of the time before accounts became one and goes with the contract release.
 *
 * @route POST /client/auth/sign-in
 */
@Controller()
export class SmartSignInController {
  constructor(private readonly signIn: AccountSignIn) {}

  /**
   * Signs an account in with email and password.
   *
   * @param body the credentials
   * @param request the request (a stale session cookie on it is ended)
   * @param reply the reply, to set the session's cookies and the CSRF header
   * @returns the area word, the next step and the rank
   * @route POST /client/auth/sign-in
   */
  @Route(smartSignIn)
  @Header('Cache-Control', 'no-store')
  async signInWithPassword(
    @Body() body: BodyOf<typeof smartSignIn>,
    @Req() request: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<ResultOf<typeof smartSignIn>> {
    const { next, rank } = await this.signIn.signIn(body, request, reply);
    return { kind: rank.kind === 'merchant' ? 'merchant' : 'customer', next, rank };
  }
}
