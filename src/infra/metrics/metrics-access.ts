// Who may read /metrics (map rule "internal network or token", decision 015): a pure function used by the API guard
// and by the worker's own metrics listener, so both processes enforce exactly the same rule.
import { createHash, timingSafeEqual } from 'node:crypto';
import net from 'node:net';

/** What the access rule needs to know about a request. */
export interface MetricsAccessRequest {
  /** The `Authorization` header value. */
  readonly authorization: string | undefined;
  /** The address of the caller (the socket peer, or the client IP resolved through a trusted proxy chain). */
  readonly remoteAddress: string | undefined;
  /** True when the request carries `X-Forwarded-For`, `Forwarded` or `X-Real-IP`. */
  readonly forwarded: boolean;
}

const privateRanges = new net.BlockList();
for (const [network, prefix] of [
  ['127.0.0.0', 8],
  ['10.0.0.0', 8],
  ['172.16.0.0', 12],
  ['192.168.0.0', 16],
  ['169.254.0.0', 16],
] as const) {
  privateRanges.addSubnet(network, prefix, 'ipv4');
}
for (const [network, prefix] of [
  ['::1', 128],
  ['fc00::', 7],
  ['fe80::', 10],
] as const) {
  privateRanges.addSubnet(network, prefix, 'ipv6');
}

/**
 * Tells whether an address is loopback or on a private network (RFC 1918, link-local, IPv6 unique-local).
 *
 * Why: the map allows `/metrics` from the internal network.
 *
 * @param address an IPv4 or IPv6 address; IPv4-mapped IPv6 (`::ffff:10.0.0.1`) is understood
 * @returns false for anything that is not a valid private address, including `undefined`
 */
export function isPrivateAddress(address: string | undefined): boolean {
  if (!address) return false;
  const family = net.isIP(address);
  if (family === 0) return false;
  return privateRanges.check(address, family === 4 ? 'ipv4' : 'ipv6');
}

/** Compares two strings without leaking where they differ (hashes first, so lengths do not matter). */
function sameSecret(a: string, b: string): boolean {
  return timingSafeEqual(createHash('sha256').update(a).digest(), createHash('sha256').update(b).digest());
}

/**
 * Decides whether a request may read the metrics.
 *
 * Why: the map allows "internal network or token". With `METRICS_TOKEN` set, the bearer token is required from every
 * caller (a private address alone is not enough); without a token only private/loopback callers are allowed, and
 * never a request that passed through a proxy (forwarding headers), because behind an undeclared proxy the socket
 * peer is the proxy and the public internet would look internal.
 *
 * @param request the caller's address, header and proxy hints
 * @param token the configured `METRICS_TOKEN`, if any
 * @returns true when access is allowed
 */
export function authorizeMetricsRequest(request: MetricsAccessRequest, token: string | undefined): boolean {
  if (token) {
    // The auth scheme name is case-insensitive (RFC 9110 § 11.1).
    const match = /^Bearer\s+(\S+)$/i.exec(request.authorization ?? '');
    return match?.[1] !== undefined && sameSecret(match[1], token);
  }
  return !request.forwarded && isPrivateAddress(request.remoteAddress);
}

/**
 * Checks request headers for proxy hints.
 *
 * Why: a request that passed through a proxy cannot be trusted to come from the internal network.
 *
 * @param headers lower-cased Node headers
 * @returns true when `x-forwarded-for`, `forwarded` or `x-real-ip` is present
 */
export function hasForwardingHeaders(headers: Readonly<Record<string, unknown>>): boolean {
  return (
    headers['x-forwarded-for'] !== undefined || headers.forwarded !== undefined || headers['x-real-ip'] !== undefined
  );
}
