// Which audience a request belongs to, for IP rules (scenario ip-rules): the admin console, the storefront, the merchant API
// or something else. Pure; the hook and the future "check an address" route use the same mapping.
import { surfaceOfPath } from '../../../../common/surface';

/**
 * The audience an IP rule can name (`ip_rules.scope`), as far as a request is concerned.
 *
 * Why: a rule has the scope `store`, `api`, `admin` or `all`. A request belongs to one audience: `/admin` is the admin
 * console, `/store/v1` the storefront, `/api/index.php` the merchant API (Dhru). Everything else
 * (the merchant portal, incoming webhooks, the documentation pages) is `other`: only rules with scope `all` reach it. The eight
 * sign-in paths that every account shares belong to two audiences at once ({@link SHARED_SIGN_IN_PATHS}).
 */
export type IpAudience = 'admin' | 'store' | 'api' | 'other';

/** Paths that IP rules never judge: monitors must be able to ask whether the service lives, whoever they are. */
const PROBE_PATHS: ReadonlySet<string> = new Set(['/health', '/metrics']);

/**
 * The sign-in routes that every account uses, whatever its rank: they live on `/client/auth/*`, although a retail account signs in
 * through the shop.
 *
 * Why: decision 064. A retail account's own traffic stays on `/store/v1`, so the store-scoped IP
 * rules cover it, but its sign-in goes through these eight routes of the merchant portal's family. They count as audience `store` too,
 * so a store-scope block also stops a blocked buyer from signing in (merchants behind a store-blocked address are refused there as well:
 * a store block is a fraud block). The other `/client/*` routes stay `other`.
 */
export const SHARED_SIGN_IN_PATHS: readonly string[] = [
  '/client/auth/sign-in',
  '/client/auth/login',
  '/client/auth/2fa',
  '/client/auth/logout',
  '/client/auth/password/change',
  '/client/auth/password/forgot',
  '/client/auth/password/reset',
  '/client/auth/verify-email',
];

const SHARED_SIGN_IN_AUDIENCES: readonly IpAudience[] = ['store', 'other'];

/**
 * Finds the audience of a request path.
 *
 * Why: see {@link IpAudience}. `/health` and `/metrics` belong to no audience: IP rules never judge them (the load balancer
 * and Prometheus must keep working while an attack is blocked, and `/metrics` has its own network or token check). A shared sign-in
 * path has both audiences `store` and `other`: a rule matches when its scope covers either one (a `store` or an `all` rule).
 *
 * @param path the route template or decoded path of the request (`requestPath`)
 * @returns the audience; the two audiences of a shared sign-in path; or `undefined` for a probe path that rules skip
 */
export function ipAudienceOf(path: string): IpAudience | readonly IpAudience[] | undefined {
  if (PROBE_PATHS.has(path)) return undefined;
  if (SHARED_SIGN_IN_PATHS.includes(path)) return SHARED_SIGN_IN_AUDIENCES;
  switch (surfaceOfPath(path)) {
    case 'admin':
      return 'admin';
    case 'store':
      return 'store';
    case 'dhru':
      return 'api';
    case 'client':
    case 'system':
      return 'other';
    // Incoming gateway webhooks are signed: a broad block rule must never cost a payment (lead decision, B118).
    case 'hooks':
      return undefined;
  }
}
