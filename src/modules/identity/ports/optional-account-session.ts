// The seam to the session of a signed-in visitor on a public route (decision 064): the checkout routes serve guests and retail accounts on one path.
import type { FastifyRequest } from 'fastify';

/**
 * Finds out whether a public storefront request comes from a signed-in retail account.
 *
 * Why: `POST /store/v1/checkout-sessions` and its consents route are public (a guest has no session), so the access guard did not look at the
 * cookie. A request that carries a full session of a retail account acts as that account; a merchant rank is refused, because a merchant
 * does not buy through the shop; a cookie-authenticated write needs its CSRF token. A request with no usable session is a guest.
 *
 * Side effects (of the implementation): may write `sessions.last_seen_at` (at most once a minute).
 */
export abstract class OptionalAccountSession {
  /**
   * Returns the retail account a request is signed in as.
   *
   * @param request the Fastify request
   * @returns the account id of a usable full session of a retail account, or `undefined` for a visitor with no live session
   * @throws {AppError} `RANK_NOT_ALLOWED` (403) for a session of a merchant rank, `CSRF_FAILED` (403) when the session has no matching `X-CSRF-Token` header
   */
  abstract retailAccountId(request: FastifyRequest): Promise<number | undefined>;
}
