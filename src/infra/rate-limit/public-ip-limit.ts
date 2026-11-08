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
 * webhooks are signed, and `/health` and `/metrics` are probes: none of them is limited per IP here, except for a large body
 * (`upload`, 20 a minute): a multipart body or one over 1 MiB on Dhru, REST v1 or the merchant portal is buffered and parsed
 * (up to 25 MiB, B157) before the credentials are known, so an anonymous caller could otherwise make the server read one after
 * another (the per-key limit comes too late for that).
 *
 * @param path the route template or decoded path of the request (`requestPath`)
 * @param access the `access` of the matched route's contract; `undefined` for an unknown route
 * @param largeBody true for a multipart body or a declared `Content-Length` over {@link LARGE_BODY_BYTES}
 * @returns the limiter to charge one point to, or `undefined` when the request is not counted
 */
export function publicLimiterFor(
  path: string,
  access: AccessKind | undefined,
  largeBody = false,
): LimiterName | undefined {
  switch (surfaceOfPath(path)) {
    case 'store':
      return access !== undefined && TOKEN_ACCESS.has(access) ? 'token' : 'ip';
    case 'admin':
      // The sign-in routes count per IP whatever their access: the 2FA steps run on a pending session (P2.6).
      return access === 'public' || AUTH_PATH.test(path) ? 'ip' : undefined;
    case 'client':
      if (access === 'public' || AUTH_PATH.test(path)) return 'ip';
      // A session route still reads its body before the session is checked: a large one (the file upload) is counted.
      return largeBody ? 'upload' : undefined;
    case 'v1':
    case 'dhru':
      return largeBody ? 'upload' : undefined;
    case 'hooks':
    case 'system':
      return undefined;
  }
}

/** A body above this many bytes is a large body for {@link publicLimiterFor} (the general JSON and form limit is 1 MiB). */
export const LARGE_BODY_BYTES = 1024 * 1024;

/**
 * Tells a large body from its headers, before it is read.
 *
 * @param contentType the `Content-Type` header
 * @param contentLength the `Content-Length` header
 * @param unboundedForm true for a form body without a length (chunked) on a route whose form limit is raised above 1 MiB
 *   (`RAISED_BODY_LIMITS`, the Dhru endpoint), which is read up to that limit although it declares nothing
 * @returns true for `multipart/form-data`, a declared length over {@link LARGE_BODY_BYTES} (or one that is not a number) or an
 *   `unboundedForm`; any other body without a length is read under the 1 MiB JSON and form limit, so it is not large
 */
export function isLargeBody(
  contentType: string | undefined,
  contentLength: string | undefined,
  unboundedForm = false,
): boolean {
  if ((contentType ?? '').toLowerCase().startsWith('multipart/form-data')) return true;
  if (contentLength === undefined) return unboundedForm;
  const length = Number(contentLength);
  return !Number.isFinite(length) || length > LARGE_BODY_BYTES;
}
