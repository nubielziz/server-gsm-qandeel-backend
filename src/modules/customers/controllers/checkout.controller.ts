// HTTP controller of the storefront checkout (map domain I, stage 14): open a session, read it, record consents. Thin: the rules live
// in CheckoutSessionService and ConsentService. The token routes read the session id the capability guard resolved.
import { Body, Controller, Req, Res } from '@nestjs/common';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { type BodyOf, type ResultOf, Route } from '../../../common/contract';
import { AppError } from '../../../common/errors';
import { CurrentPrincipal, type CapabilityGrant, type Principal } from '../../identity';
import { CheckoutSessionService } from '../application/checkout-session.service';
import { ConsentService } from '../application/consent.service';
import { OptionalCustomerSession } from '../application/optional-customer-session';
import { openCheckoutSession, recordCheckoutConsents, showCheckoutSession } from '../contracts/checkout.contracts';

/** The session id the capability guard found; a handler behind a `checkout-token` route always has one. */
function sessionIdOf(principal: Principal | undefined): CapabilityGrant['id'] {
  if (principal?.kind !== 'capability' || principal.access !== 'checkout-token') throw new AppError('NOT_FOUND');
  return principal.resourceId;
}

/** The session answers hold the checkout token or sit behind it: nothing may keep a copy (ALIGNMENT § 6). */
const NO_STORE = 'no-store';

/** The user agent of a request, empty when it sent none. */
function userAgentOf(request: FastifyRequest): string {
  const header = request.headers['user-agent'];
  return typeof header === 'string' ? header : '';
}

/**
 * The storefront checkout routes.
 *
 * Why: the shop opens a session to lock the price, tax and exchange rate, shows it back, and records consent before payment
 * (scenario b2c-paid steps 2 and 3). The anti-bot check, the per-IP limit and the token lookup limit run before these.
 *
 * @route POST /store/v1/checkout-sessions
 * @route GET /store/v1/checkout-sessions/:token
 * @route POST /store/v1/checkout-sessions/:token/consents
 */
@Controller()
export class CheckoutController {
  constructor(
    private readonly sessions: CheckoutSessionService,
    private readonly consents: ConsentService,
    private readonly signedIn: OptionalCustomerSession,
  ) {}

  /**
   * Opens a checkout, as the signed-in customer when the request carries a customer session.
   *
   * @param body the service, the buyer's email and country, and the order input
   * @param request the request, for the session cookie, the visitor's address and user agent
   * @param reply the reply, for the cache header
   * @returns the new session
   * @throws {AppError} `CSRF_FAILED` when a customer session comes without its CSRF header (nothing is written)
   * @route POST /store/v1/checkout-sessions
   */
  @Route(openCheckoutSession)
  async open(
    @Body() body: BodyOf<typeof openCheckoutSession>,
    @Req() request: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<ResultOf<typeof openCheckoutSession>> {
    reply.header('cache-control', NO_STORE);
    const customerId = await this.signedIn.customerId(request);
    return this.sessions.open({ ...body, customerId, ip: request.ip, userAgent: userAgentOf(request) });
  }

  /**
   * Reads a checkout.
   *
   * @param principal the holder of the checkout token
   * @param reply the reply, for the cache header
   * @returns the session
   * @route GET /store/v1/checkout-sessions/:token
   */
  @Route(showCheckoutSession)
  show(
    @CurrentPrincipal() principal: Principal | undefined,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<ResultOf<typeof showCheckoutSession>> {
    reply.header('cache-control', NO_STORE);
    return this.sessions.show(sessionIdOf(principal));
  }

  /**
   * Records consents.
   *
   * @param principal the holder of the checkout token
   * @param body the purposes with their answers
   * @param request the request, for the session cookie, the visitor's address and user agent
   * @param reply the reply, for the cache header
   * @returns the records and where the session's consent stands
   * @throws {AppError} `CSRF_FAILED` when a customer session comes without its CSRF header (nothing is written)
   * @route POST /store/v1/checkout-sessions/:token/consents
   */
  @Route(recordCheckoutConsents)
  async record(
    @CurrentPrincipal() principal: Principal | undefined,
    @Body() body: BodyOf<typeof recordCheckoutConsents>,
    @Req() request: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<ResultOf<typeof recordCheckoutConsents>> {
    reply.header('cache-control', NO_STORE);
    const customerId = await this.signedIn.customerId(request);
    return this.consents.record(
      sessionIdOf(principal),
      body,
      { ip: request.ip, userAgent: userAgentOf(request) },
      customerId,
    );
  }
}
