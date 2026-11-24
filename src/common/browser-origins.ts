// Which browser origins each HTTP surface trusts (decision 045): the console's on the staff surfaces, the shop's on the
// merchant and storefront surfaces, none on the machine surfaces. Read by the CORS hook (src/app.bootstrap.ts) and the CSRF guard.
import type { AppConfig } from '../config';
import { surfaceOfPath, type Surface } from './surface';

/**
 * Methods a page of the route's audience on another origin (a development console or shop) may use (ALIGNMENT § 6).
 *
 * Why: ALIGNMENT § 6 lists exactly these methods; no others are granted.
 */
export const CORS_METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'] as const;
/**
 * Request headers a preflight may ask for (ALIGNMENT § 6).
 *
 * Why: ALIGNMENT § 6: the console and the shop send only these, so a preflight asking for anything else is refused.
 */
export const CORS_ALLOWED_HEADERS = ['Content-Type', 'X-CSRF-Token', 'Idempotency-Key', 'Accept'] as const;
/**
 * Response headers a page of the route's audience on another origin (a development console or shop) may read (ALIGNMENT § 6).
 *
 * Why: browsers hide other response headers from scripts; the pages read these (pager total, request id, CSRF token,
 * retry delay, download name).
 */
export const CORS_EXPOSED_HEADERS = [
  'x-total-count',
  'x-request-id',
  'x-csrf-token',
  'retry-after',
  'content-disposition',
] as const;
/**
 * How long a browser may cache a preflight answer.
 *
 * Why: ALIGNMENT § 6 asks for 600, so a page does not preflight every call.
 */
export const CORS_MAX_AGE_SECONDS = 600;

/** The two browser audiences whose origins the configuration lists. */
export type BrowserAudience = 'console' | 'shop';

/** The configured origins of the two audiences. */
export type BrowserOrigins = Pick<AppConfig['http'], 'consoleOrigins' | 'shopOrigins'>;

const REFERENCE_PATH = /^\/reference(?:\/|$)/;

/**
 * Maps a contract surface to the audience whose origins it trusts.
 *
 * Why: decision 045: staff surfaces trust the console's origins, merchant and shop surfaces the shop's, machine surfaces none.
 *
 * @param surface the surface of a route contract
 * @returns `console` for admin; `shop` for client and store; `undefined` for dhru, hooks and system
 */
export function audienceOfSurface(surface: Surface): BrowserAudience | undefined {
  if (surface === 'admin') return 'console';
  if (surface === 'client' || surface === 'store') return 'shop';
  return undefined;
}

/**
 * Maps a request path to the audience whose origins it trusts; `/reference` (a staff page without a contract) belongs to the console.
 *
 * Why: decision 045: the CORS hook sees a path, not a contract, and must agree with the CSRF guard.
 *
 * @param path the request path without query string (see `requestPath`); never throws
 * @returns the audience, or `undefined` for every machine path, `/health`, `/docs` and unknown paths
 */
export function audienceOfPath(path: string): BrowserAudience | undefined {
  if (REFERENCE_PATH.test(path)) return 'console';
  return audienceOfSurface(surfaceOfPath(path));
}

/**
 * Picks the configured origins of an audience.
 *
 * Why: decision 045: one list per audience; no audience means no origin is trusted.
 *
 * @param origins the configured lists
 * @param audience the audience, or `undefined` for a machine surface
 * @returns the exact origins of that audience (empty for `undefined`)
 */
export function originsOf(origins: BrowserOrigins, audience: BrowserAudience | undefined): readonly string[] {
  if (audience === 'console') return origins.consoleOrigins;
  if (audience === 'shop') return origins.shopOrigins;
  return [];
}

/** What the CORS hook answers one request. */
export type CorsDecision =
  | { readonly origin: false }
  | {
      readonly origin: string;
      readonly credentials: true;
      readonly methods: string[];
      readonly allowedHeaders: string[];
      readonly exposedHeaders: string[];
      readonly maxAge: number;
      readonly strictPreflight: false;
    };

/**
 * Decides the CORS answer of one request from its path and its Origin header.
 *
 * Why: decision 045: a page may read an answer, with credentials, only when its Origin is exactly one of the origins of the
 * path's audience; every other request (no Origin, an unlisted one, any machine path) gets no CORS header at all.
 *
 * @param origins the configured lists
 * @param path the request path (see `requestPath`)
 * @param origin the `Origin` request header, if any
 * @returns `{ origin: false }` (no CORS header) or the grant with credentials
 */
export function corsDecision(origins: BrowserOrigins, path: string, origin: string | undefined): CorsDecision {
  const allowed = originsOf(origins, audienceOfPath(path));
  if (origin === undefined || !allowed.includes(origin)) return { origin: false };
  return {
    origin,
    credentials: true,
    methods: [...CORS_METHODS],
    allowedHeaders: [...CORS_ALLOWED_HEADERS],
    exposedHeaders: [...CORS_EXPOSED_HEADERS],
    maxAge: CORS_MAX_AGE_SECONDS,
    // An OPTIONS request from a listed origin without Access-Control-Request-Method is answered like a preflight, never with the
    // plugin's plain-text 400 (decision 028: every error is problem+json).
    strictPreflight: false,
  };
}
