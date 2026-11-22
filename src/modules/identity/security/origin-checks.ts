// The Origin rules of the CSRF guard (decisions 018 and 045): whether a request was started by one of the pages its
// surface trusts.

/** The request headers the Origin rules read. */
export interface OriginHeaders {
  readonly origin?: string | undefined;
  readonly 'sec-fetch-site'?: string | readonly string[] | undefined;
}

/** Detail of the refusal when a request that needs an Origin has none. */
export const ORIGIN_MISSING_DETAIL = 'This request must come from an allowed website (the Origin header is missing).';
/** Detail of the refusal when the Origin is not one of the surface's allowed origins. */
export const ORIGIN_NOT_ALLOWED_DETAIL = 'This request comes from a website that is not allowed to call this API.';
/** Detail of the refusal of an `originCheck` GET that the browser did not mark as started by the page's own origin. */
export const NOT_STARTED_HERE_DETAIL = 'This request must be started from this site.';

/**
 * Judges a mutation without a session: the Origin must be exactly one of the allowed origins.
 *
 * Why: decisions 018 and 045: nothing binds a CSRF token to a caller that has no session (sign-in, password set by emailed
 * token, register), so the page that started the request must be one of the surface's own pages.
 *
 * @param origin the `Origin` request header, if any
 * @param allowed the exact origins of the route's audience
 * @returns `undefined` when the request may go on, otherwise the detail of the `CSRF_FAILED` refusal
 */
export function sessionlessOriginRefusal(origin: string | undefined, allowed: readonly string[]): string | undefined {
  if (origin !== undefined && allowed.includes(origin)) return undefined;
  return origin === undefined ? ORIGIN_MISSING_DETAIL : ORIGIN_NOT_ALLOWED_DETAIL;
}

/**
 * Judges a GET with `originCheck`: `Sec-Fetch-Site: same-origin`, or an Origin that is one of the allowed origins.
 *
 * Why: decision 045: a download or a stream carries no CSRF token, so it must have been started by the surface's own page; a
 * request marked `same-site` alone is not enough, because every host of the registrable domain is same-site. A same-origin
 * GET carries no `Origin` header (fetch spec), which is why `same-origin` is accepted on its own.
 *
 * @param headers the request headers (`origin`, `sec-fetch-site`); a repeated `Sec-Fetch-Site` is not `same-origin`
 * @param allowed the exact origins of the route's audience
 * @returns `undefined` when the request may go on, otherwise the detail of the `CSRF_FAILED` refusal
 */
export function originCheckedGetRefusal(headers: OriginHeaders, allowed: readonly string[]): string | undefined {
  const site = headers['sec-fetch-site'];
  if (site === 'same-origin') return undefined;
  const origin = headers.origin;
  if (origin !== undefined) return allowed.includes(origin) ? undefined : ORIGIN_NOT_ALLOWED_DETAIL;
  return site === undefined ? ORIGIN_MISSING_DETAIL : NOT_STARTED_HERE_DETAIL;
}
