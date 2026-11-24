// The rules a merchant API key must pass (decision 018, 026): revoked, expired, merchant status and allowed IPs, as pure functions, plus
// how a refusal is worded on the Dhru surface (its envelope). No I/O here.
import { type IpAddress, formatIpAddress, networkContains, parseNetwork } from '../../../../../common/ip-address';
import { AppError } from '../../../../../common/errors';
import type { ClientStatus } from '../../../db/schema';

/**
 * An API key as the guards see it (and as the cache holds it: plain JSON, times in milliseconds).
 *
 * Why: decision 018 resolves the key by its keyed hash and checks revoked/expired, allowed IPs, the per-minute limit and
 * the merchant's status; one cached view holds all of it, so a request costs one cache read. Never holds the key itself.
 */
export interface ApiKeyView {
  readonly id: number;
  /** HMAC of the key (decision 019): the cache key of this view and the row's lookup column. */
  readonly keyHash: string;
  readonly clientId: number;
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
  'unauthenticated' | 'revoked' | 'expired' | 'suspended' | 'not_active' | 'ip_not_allowed';

/** What {@link checkApiKey} needs to know about the request. */
export interface ApiKeyCheck {
  /** The current time in milliseconds. */
  readonly nowMs: number;
  /** The client address; `undefined` when it could not be read. */
  readonly address: IpAddress | undefined;
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
 * Runs the checks that follow a successful lookup, in order.
 *
 * Why: revoked and expired keys are refused as unauthenticated; a merchant that is suspended or not yet approved cannot use
 * its keys; then the network. A key carries no scope: every live key of an active merchant is a Dhru credential (decision 026).
 *
 * @param view the key and its merchant
 * @param check the time and the client address
 * @returns the reason the key is refused, or `undefined` when every check passes
 */
export function checkApiKey(view: ApiKeyView, check: ApiKeyCheck): ApiKeyRefusalReason | undefined {
  if (view.revokedAtMs !== null) return 'revoked';
  if (view.expiresAtMs !== null && view.expiresAtMs <= check.nowMs) return 'expired';
  if (view.client.status === 'suspended') return 'suspended';
  if (view.client.status !== 'active') return 'not_active';
  if (!ipAllowedForKey(view.allowedIps, check.address)) return 'ip_not_allowed';
  return undefined;
}

/** The standard Dhru message for a credential that is not accepted (decision 026). */
const DHRU_AUTH_FAILED = 'Authentication Failed';

/**
 * Words a refusal for the Dhru surface.
 *
 * Why: the Dhru surface always answers HTTP 200 with its envelope, and client software knows `Authentication Failed` (decision 026). A
 * credential that is not accepted gets that standard message and nothing more. Once the key and the username are proven, the merchant is
 * told what is wrong (a network address that is not on the key's list), because only the owner of the credentials can see it.
 *
 * @param reason why the key was refused
 * @param address the client address, named in the message about allowed IPs
 * @returns the error to throw
 */
export function refusalFor(reason: ApiKeyRefusalReason, address: IpAddress | undefined): AppError {
  switch (reason) {
    case 'unauthenticated':
    case 'revoked':
    case 'expired':
      return new AppError('UNAUTHORIZED', { detail: DHRU_AUTH_FAILED });
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
  }
}
