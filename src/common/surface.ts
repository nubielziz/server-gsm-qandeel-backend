// The HTTP surfaces of the API (docs/route-manifest.json) and how a request path maps to one.
// Used for metrics labels, error envelopes (Dhru keeps its own, decision 026) and contract consistency checks.

/**
 * HTTP surfaces served by this process; outgoing `events` and `supplier` calls are not routes of ours.
 *
 * Why: metrics labels, error envelopes and the OpenAPI filter all switch on the surface of a route (decisions 015, 017,
 * 026, 028).
 */
export type Surface = 'admin' | 'client' | 'v1' | 'store' | 'dhru' | 'hooks' | 'system';

const PREFIXES: ReadonlyArray<readonly [RegExp, Surface]> = [
  [/^\/admin(?:\/|$)/, 'admin'],
  [/^\/client(?:\/|$)/, 'client'],
  [/^\/store\/v1(?:\/|$)/, 'store'],
  [/^\/v1(?:\/|$)/, 'v1'],
  [/^\/api\/index\.php$/, 'dhru'],
  [/^\/webhooks(?:\/|$)/, 'hooks'],
];

/**
 * Finds the surface a path belongs to, from the bases in the map (`/admin`, `/client`, `/v1`, `/store/v1`,
 * `/api/index.php`, `/webhooks`); everything else (`/health`, `/metrics`, docs) is `system`.
 *
 * Why: metrics, error envelopes and contract checks are per surface (docs/route-manifest.json).
 *
 * @param path a route template or a request path (a query string is ignored)
 * @returns the surface
 */
export function surfaceOfPath(path: string): Surface {
  const clean = path.split('?')[0] ?? path;
  for (const [pattern, surface] of PREFIXES) if (pattern.test(clean)) return surface;
  return 'system';
}
