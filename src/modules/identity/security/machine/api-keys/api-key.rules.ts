// The rules a merchant API key must pass (decision 018, 026): revoked, expired, merchant status, allowed IPs and scope, as pure
// functions, plus how a refusal is worded on REST v1 (problem+json) and on the Dhru surface (its envelope). No I/O here.
import { type IpAddress, formatIpAddress, networkContains, parseNetwork } from '../../../../../common/ip-address';
import { AppError } from '../../../../../common/errors';
import type { Surface } from '../../../../../common/surface';
import type { ClientStatus } from '../../../db/schema';
import { grants } from '../../permission-grammar';

/**
 * An API key as the guards see it (and as the cache holds it: plain JSON, times in milliseconds).
 *
 * Why: decision 018 resolves the key by its keyed hash and checks revoked/expired, allowed IPs, scopes, the per-minute limit and
 * the merchant's status; one cached view holds all of it, so a request costs one cache read. Never holds the key itself.
 */
export interface ApiKeyView {
  readonly id: number;
  /** HMAC of the key (decision 019): the cache key of this view and the row's lookup column. */
  readonly keyHash: string;
  readonly clientId: number;
  readonly scopes: readonly string[];
  /** CIDR ranges as Postgres prints them; empty means any address. */
  readonly allowedIps: readonly string[];
  readonly rateLimitPerMin: number;
  readonly lastUsedAtMs: number | null;
  readonly expiresAtMs: number | null;
  readonly revokedAtMs: number | null;
  readonly client: { readonly username: string; readonly name: string; readonly status: ClientStatus };
}

/**
 * Why a key was refused.
 *
 * Why: tests and logs tell the cases apart; {@link refusalFor} words each one for the surface.
 */
export type ApiKeyRefusalReason =
  'unauthenticated' | 'revoked' | 'expired' | 'suspended' | 'not_active' | 'ip_not_allowed' | 'missing_scope';

/** What {@link checkApiKey} needs to know about the request. */
export interface ApiKeyCheck {
  /** The current time in milliseconds. */
  readonly nowMs: number;
  /** The client address; `undefined` when it could not be read. */
  readonly address: IpAddress | undefined;
  /** The scope the route needs: the contract's `permission`, or `dhru` for the Dhru surface. */
  readonly scope: string;
}

/**
 * Tells whether an address is covered by a key's list of allowed ranges.
 *
 * Why: decision 018: a key may be limited to the merchant's server addresses (IPv4 and IPv6, single addresses or CIDR). An empty
 * list means "any address". A list whose entries cannot be read matches nothing: a broken restriction must not open the key.
 *
 * @param allowed the ranges (`203.0.113.0/24`, `2001:db8::1`)
 * @param address the client address; `undefined` when it could not be read
 * @returns true when the key may be used from the address
 */
export function ipAllowedForKey(allowed: readonly string[], address: IpAddress | undefined): boolean {
  if (allowed.length === 0) return true;
  if (!address) return false;
  return allowed.some((range) => {
    const network = parseNetwork(range);
    return network !== undefined && networkContains(network, address);
  });
}

/**
 * The scope a key needs to call the Dhru endpoint.
 *
 * Why: decision 018 and 026: the Dhru surface has one endpoint with eight actions, so it takes one scope instead of the
 * per-route permission of REST v1. A key must list `dhru` itself: no wildcard (`*`, `*:*`) opens the Dhru surface, because
 * decision 026 limits the credentials of that surface to the Dhru scope and a merchant who gave a key wide REST permissions did
 * not thereby choose to expose it to Dhru client software.
 */
export const DHRU_SCOPE = 'dhru';

/**
 * Tells whether a key's scopes cover the scope a route needs.
 *
 * Why: decision 018 gives scopes the permission grammar: a scope `orders:*` covers every `orders:` action and `*` covers every
 * REST v1 permission (so a key created with a wildcard works on every route it is meant for), through the same
 * {@link grants} the staff guards use. The exceptions are on purpose: the Dhru scope is matched exactly (see
 * {@link DHRU_SCOPE}), and a route with no scope is never covered, so a missing contract scope cannot be opened by `*`.
 * Matching is case sensitive and has no prefix rule: `orders` and `ORDERS:WRITE` do not cover `orders:write`.
 *
 * @param scopes the scopes stored on the key
 * @param required the scope the route needs (`orders:write`, or `dhru`)
 * @returns true when the key may call the route
 */
export function scopeCovered(scopes: readonly string[], required: string): boolean {
  if (required === '') return false;
  if (required === DHRU_SCOPE) return scopes.includes(DHRU_SCOPE);
  return grants(scopes, required);
}

/**
 * Runs the checks that follow a successful lookup, in order.
 *
 * Why: revoked and expired keys are refused as unauthenticated; a merchant that is suspended or not yet approved cannot use
 * its keys; then the network and the scope. The key's scopes follow the permission grammar of decision 018 ({@link scopeCovered}):
 * `area:action` covers itself, `area:*` covers every action of the area and `*` covers every REST v1 permission; the
 * Dhru scope is matched exactly.
 *
 * @param view the key and its merchant
 * @param check the time, the client address and the scope the route needs
 * @returns the reason the key is refused, or `undefined` when every check passes
 */
export function checkApiKey(view: ApiKeyView, check: ApiKeyCheck): ApiKeyRefusalReason | undefined {
  if (view.revokedAtMs !== null) return 'revoked';
  if (view.expiresAtMs !== null && view.expiresAtMs <= check.nowMs) return 'expired';
  if (view.client.status === 'suspended') return 'suspended';
  if (view.client.status !== 'active') return 'not_active';
  if (!ipAllowedForKey(view.allowedIps, check.address)) return 'ip_not_allowed';
  if (!scopeCovered(view.scopes, check.scope)) return 'missing_scope';
  return undefined;
}

/** The standard Dhru message for a credential that is not accepted (decision 026). */
const DHRU_AUTH_FAILED = 'Authentication Failed';

/**
 * Words a refusal for the surface it happens on.
 *
 * Why: REST v1 answers problem+json with a catalog code; the Dhru surface always answers HTTP 200 with its envelope, and
 * client software knows `Authentication Failed` (decision 026). A credential that is not accepted gets that standard message and
 * nothing more. Once the key and the username are proven, the merchant is told what is wrong (a network address that is not
 * on the key's list, a missing scope), because only the owner of the credentials can see it.
 *
 * @param reason why the key was refused
 * @param surface the surface of the route (`dhru` or `v1`)
 * @param address the client address, named in the message about allowed IPs
 * @param scope the scope the route needs, named in the message about a missing scope
 * @returns the error to throw
 */
export function refusalFor(
  reason: ApiKeyRefusalReason,
  surface: Surface,
  address: IpAddress | undefined,
  scope: string,
): AppError {
  const dhru = surface === 'dhru';
  switch (reason) {
    case 'unauthenticated':
      return new AppError('UNAUTHORIZED', dhru ? { detail: DHRU_AUTH_FAILED } : {});
    case 'revoked':
    case 'expired':
      return new AppError('UNAUTHORIZED', {
        detail: dhru ? DHRU_AUTH_FAILED : 'The API key is revoked or has expired.',
      });
    case 'suspended':
      return new AppError('ACCOUNT_SUSPENDED', { detail: 'This merchant account is suspended.' });
    case 'not_active':
      // B153: a merchant waiting for approval gets its own code (Dhru shows the detail in the envelope); it never signs out.
      return new AppError('ACCOUNT_PENDING_APPROVAL', {
        detail: 'This merchant account has not been approved yet.',
      });
    case 'ip_not_allowed': {
      const who = address ? `Your network address (${formatIpAddress(address)})` : 'Your network address';
      return new AppError('IP_NOT_ALLOWED', {
        detail: `${who} is not on the list of addresses allowed for this API key.`,
      });
    }
    case 'missing_scope':
      return new AppError('FORBIDDEN', {
        detail: dhru
          ? 'This API key cannot be used with the Dhru API.'
          : `This API key does not have the ${scope} permission.`,
      });
  }
}
