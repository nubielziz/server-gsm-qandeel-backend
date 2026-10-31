// Which audience a request belongs to, for IP rules (scenario ip-rules): the admin console, the storefront, the merchant API
// or something else. Pure; the hook and the future "check an address" route use the same mapping.
import { surfaceOfPath } from '../../../../common/surface';

/**
 * The audience an IP rule can name (`ip_rules.scope`), as far as a request is concerned.
 *
 * Why: a rule has the scope `store`, `api`, `admin` or `all`. A request belongs to one audience: `/admin` is the admin
 * console, `/store/v1` the storefront, `/v1` and `/api/index.php` the merchant API (REST v1 and Dhru). Everything else
 * (the merchant portal, incoming webhooks, the documentation pages) is `other`: only rules with scope `all` reach it.
 */
export type IpAudience = 'admin' | 'store' | 'api' | 'other';

/** Paths that IP rules never judge: monitors must be able to ask whether the service lives, whoever they are. */
const PROBE_PATHS: ReadonlySet<string> = new Set(['/health', '/metrics']);

/**
 * Finds the audience of a request path.
 *
 * Why: see {@link IpAudience}. `/health` and `/metrics` belong to no audience: IP rules never judge them (the load balancer
 * and Prometheus must keep working while an attack is blocked, and `/metrics` has its own network or token check).
 *
 * @param path the route template or decoded path of the request (`requestPath`)
 * @returns the audience, or `undefined` for a probe path that rules skip
 */
export function ipAudienceOf(path: string): IpAudience | undefined {
  if (PROBE_PATHS.has(path)) return undefined;
  switch (surfaceOfPath(path)) {
    case 'admin':
      return 'admin';
    case 'store':
      return 'store';
    case 'v1':
    case 'dhru':
      return 'api';
    case 'client':
    case 'hooks':
    case 'system':
      return 'other';
  }
}
