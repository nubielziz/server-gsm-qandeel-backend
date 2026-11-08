// OptionalCustomerSession: reads the storefront customer's session on the public checkout routes, which serve guests and signed-in
// customers on one path (feature 14b, scenario b2c-account: a signed-in buyer checks out as the account).
import { Injectable } from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import { CSRF_HEADER, CsrfService, SessionAuthenticator } from '../../identity';

/**
 * Finds out whether a public storefront request comes from a signed-in customer.
 *
 * Why: `POST /store/v1/checkout-sessions` and `POST /store/v1/checkout-sessions/:token/consents` are public routes (a guest has no
 * session), so the access guard and the CSRF guard did not look at the cookie. A request that does carry a full customer session
 * acts as that account, and decision 018 says a cookie-authenticated write needs the `X-CSRF-Token` header: the check is made here,
 * before the caller writes anything. A request with no cookie, an unknown, ended or pending session, or a suspended customer is
 * simply a guest.
 *
 * Side effects: may write `sessions.last_seen_at` (at most once a minute) and, for a suspended customer, revoke the sessions.
 */
@Injectable()
export class OptionalCustomerSession {
  constructor(
    private readonly authenticator: SessionAuthenticator,
    private readonly csrf: CsrfService,
  ) {}

  /**
   * Returns the customer a request is signed in as.
   *
   * @param request the Fastify request
   * @returns the customer id of a usable full session, or `undefined` for a guest
   * @throws {AppError} `CSRF_FAILED` (403) when the request has a usable session but no matching `X-CSRF-Token` header
   */
  async customerId(request: FastifyRequest): Promise<number | undefined> {
    const auth = await this.authenticator.authenticateOptional('customer', request, { stages: ['active'] });
    if (auth?.principal.kind !== 'customer') return undefined;
    this.csrf.assert(auth.view.tokenHash, request.headers[CSRF_HEADER]);
    return auth.principal.customerId;
  }
}
