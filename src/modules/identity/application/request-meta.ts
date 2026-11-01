// What the sign-in use cases need to know about the HTTP request, read once by the controller (no Fastify types below it).
import type { FastifyRequest } from 'fastify';
import { formatIpAddress, ipRateLimitKey } from '../../../common/ip-address';
import { clientAddressOf } from '../security/ip-rules/ip-rules.hook';

/** The caller of a sign-in request. */
export interface RequestMeta {
  /** The client address as text (an IPv4-mapped IPv6 address shows as its IPv4 address); stored in sessions and audit rows. */
  readonly ip: string;
  /** The `User-Agent` header (the session store cuts it to 512 characters). */
  readonly userAgent: string;
  /** The key of per-address rate limits: the IPv4 address or the /64 of an IPv6 one. */
  readonly limitKey: string;
}

/**
 * Reads the caller of a request.
 *
 * Why: sessions, `last_login_ip`, audit rows and rate limits must all see the same address, the one the IP rules judged
 * (`request.ip` behind the trusted proxy chain, decision 018).
 *
 * @param request the Fastify request
 * @returns the address, user agent and rate-limit key
 */
export function requestMetaOf(request: Pick<FastifyRequest, 'ip' | 'headers'>): RequestMeta {
  const address = clientAddressOf(request);
  const agent = request.headers['user-agent'];
  return {
    ip: address ? formatIpAddress(address) : request.ip,
    userAgent: typeof agent === 'string' ? agent : '',
    limitKey: ipRateLimitKey(address),
  };
}
