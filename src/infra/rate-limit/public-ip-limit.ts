// Which public requests the per-IP rate limit counts, and against which limiter (decision 021). Pure; the hook calls it.
import type { AccessKind } from '../../common/contract';
import { surfaceOfPath } from '../../common/surface';
import type { LimiterName } from './limiters';

/** Routes that carry a capability token in the path or body: checkout, tracking, ticket and sign-in link tokens. */
const TOKEN_ACCESS: ReadonlySet<AccessKind> = new Set([
  'checkout-token',
  'tracking-token',
  'ticket-token',
  'link-token',
]);

/** The sign-in steps of the admin console and the merchant portal (login, 2FA, password); `me` and logout are not. */
const AUTH_PATH = /^\/(admin|client)\/auth\/(login|2fa|password)(\/|$)/;

/**
 * Picks the limiter for a request on a public surface.
 *
 * Why: decision 021 limits, before authentication, per client IP: the public store routes and the sign-in family
 * (`ip`: 300 a minute), and the token routes (`token`: 30 a minute, so a capability token cannot be guessed at speed). The
 * store surface is limited as a whole, matched or not, so a scanner probing unknown paths is counted too. Admin and
 * merchant-portal routes are limited only when they are public (sign-in, password and registration routes); their
 * session-authenticated routes have per-principal limits after authentication. REST v1 and Dhru have a limit per API key,
 * webhooks are signed, and `/health` and `/metrics` are probes: none of them is limited per IP here.
 *
 * @param path the route template or decoded path of the request (`requestPath`)
 * @param access the `access` of the matched route's contract; `undefined` for an unknown route
 * @returns the limiter to charge one point to, or `undefined` when the request is not counted
 */
export function publicLimiterFor(path: string, access: AccessKind | undefined): LimiterName | undefined {
  switch (surfaceOfPath(path)) {
    case 'store':
      return access !== undefined && TOKEN_ACCESS.has(access) ? 'token' : 'ip';
    case 'admin':
    case 'client':
      // The sign-in routes count per IP whatever their access: the 2FA steps run on a pending session (P2.6).
      return access === 'public' || AUTH_PATH.test(path) ? 'ip' : undefined;
    case 'v1':
    case 'dhru':
    case 'hooks':
    case 'system':
      return undefined;
  }
}
