// The path of a request as the router sees it, for the pipeline hooks that decide by surface (IP rules, maintenance, limits).

/**
 * The part of a Fastify request the path is read from.
 *
 * Why: a structural type, so the pipeline hooks and their unit tests need no real request.
 */
export interface PathSource {
  /** The raw request target, query string included. */
  readonly url: string;
  /** What the router matched; `url` is the route template (`/admin/staff/:id`) and is empty for an unknown route. */
  readonly routeOptions?: { readonly url?: string | undefined } | undefined;
}

/**
 * Reads the path of a request the way the router resolved it.
 *
 * Why: the pipeline hooks decide by surface (`/admin`, `/store/v1`, ...) before any route code runs. Fastify's router decodes
 * percent-escapes before it matches (`/%61dmin/staff` reaches `/admin/staff`), so the hooks must not judge the raw target:
 * a matched route is judged by its template, an unknown route by its decoded path. Either way a request cannot dodge a
 * rule by spelling its path differently.
 *
 * @param request the request (its raw target and the matched route)
 * @returns the route template when one matched, otherwise the decoded path without query string or fragment
 */
export function requestPath(request: PathSource): string {
  const template = request.routeOptions?.url;
  if (template !== undefined && template !== '' && template !== '*') return template;
  const end = request.url.search(/[?#]/);
  const raw = end === -1 ? request.url : request.url.slice(0, end);
  try {
    return decodeURI(raw);
  } catch {
    // A malformed escape: the router answers 400/404 itself; judge the text as it was sent.
    return raw;
  }
}
