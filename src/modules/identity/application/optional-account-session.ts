// OptionalAccountSessionService: reads the retail account's session on the public checkout routes, which serve guests and signed-in
// accounts on one path (decision 064, scenario b2c-account: a signed-in buyer checks out as the account).
import { Injectable } from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import { AppError } from '../../../common/errors';
import { OptionalAccountSession } from '../ports/optional-account-session';
import { CSRF_HEADER, CsrfService } from '../security/csrf';
import { SessionAuthenticator } from '../security/session-authenticator';

/** What a merchant rank is told at the shop's retail door: it orders from its own price list. */
const MERCHANT_AT_RETAIL_DOOR = 'Your account orders from its price list.';

/**
 * Finds out whether a public storefront request comes from a signed-in retail account.
 *
 * Why: `POST /store/v1/checkout-sessions` and its consents route are public routes (a guest has no session), so the access guard and the
 * CSRF guard did not look at the cookie. A request that carries a full session acts as that account, and decision 018 says a
 * cookie-authenticated write needs the `X-CSRF-Token` header: the check is made here, before the caller writes anything. The rank comes
 * next: a merchant rank never buys at the retail door, as a guest or otherwise (the safest rule for the checkout, decision 064), so its
 * session is refused rather than treated as a guest. A request with no cookie, an unknown, ended or pending session, or a suspended
 * account is simply a guest.
 *
 * Side effects: may write `sessions.last_seen_at` (at most once a minute) and, for a suspended account, revoke the sessions.
 */
@Injectable()
export class OptionalAccountSessionService implements OptionalAccountSession {
  constructor(
    private readonly authenticator: SessionAuthenticator,
    private readonly csrf: CsrfService,
  ) {}

  /**
   * Returns the retail account a request is signed in as.
   *
   * @param request the Fastify request
   * @returns the account id of a usable full session of a retail account, or `undefined` for a visitor with no live session
   * @throws {AppError} `CSRF_FAILED` (403) when the request has a usable session but no matching `X-CSRF-Token` header, then
   *   `RANK_NOT_ALLOWED` (403) when that session belongs to a merchant rank
   * @see POST /store/v1/checkout-sessions
   */
  async retailAccountId(request: FastifyRequest): Promise<number | undefined> {
    const auth = await this.authenticator.authenticateOptional('account', request, { stages: ['active'] });
    if (auth?.principal.kind !== 'account') return undefined;
    this.csrf.assert(auth.view.tokenHash, request.headers[CSRF_HEADER]);
    if (auth.principal.rank.kind !== 'retail')
      throw new AppError('RANK_NOT_ALLOWED', { detail: MERCHANT_AT_RETAIL_DOOR });
    return auth.principal.accountId;
  }
}
