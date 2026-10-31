// SSRF guard for outbound requests (decision 023): a URL is accepted only when it uses https (or http outside production)
// and its host is, or resolves only to, public addresses.
import dns from 'node:dns';
import net from 'node:net';
import { withTimeout } from '../../common/timeout';
import { isPublicAddress } from './ip-ranges';

/** Resolves a host name to its addresses; replaceable in tests. */
export type HostLookup = (hostname: string) => Promise<readonly string[]>;

/** Why a URL was refused. */
export type UnsafeUrlReason =
  'invalid_url' | 'scheme_not_allowed' | 'credentials_in_url' | 'dns_failure' | 'non_public_address';

/**
 * Raised when a URL must not be requested.
 *
 * Why: the caller turns it into a field error (validating a webhook URL) or a failed delivery (sending one). The message
 * names the reason and the host only: never the path, the query or credentials, which may hold secrets.
 */
export class UnsafeUrlError extends Error {
  constructor(
    readonly reason: UnsafeUrlReason,
    readonly host: string | undefined,
  ) {
    super(`The URL is not allowed (${reason})${host ? ` for host ${host}` : ''}.`);
    this.name = 'UnsafeUrlError';
  }
}

/** The URL that passed the check and the addresses its host resolved to. */
export interface PublicUrl {
  readonly url: URL;
  readonly addresses: readonly string[];
}

/** Options of {@link assertPublicHttpUrl}. */
export interface PublicUrlOptions {
  /** Refuse plain `http:` (true in production). */
  readonly httpsOnly: boolean;
  /** DNS resolver; defaults to the system resolver (`dns.lookup`, all addresses). */
  readonly lookup?: HostLookup;
  /** Longest wait for DNS in milliseconds; default 3000. */
  readonly dnsTimeoutMs?: number;
}

const DEFAULT_DNS_TIMEOUT_MS = 3_000;

const systemLookup: HostLookup = async (hostname) => {
  const answers = await dns.promises.lookup(hostname, { all: true, order: 'verbatim' });
  return answers.map((answer) => answer.address);
};

/**
 * Checks that a URL may be requested: right scheme, no credentials, and a host that is (or resolves only to) public
 * addresses.
 *
 * Why: decision 023 and the merchant webhook rule: `https` only in production, the host must resolve to public addresses
 * (no private, loopback, link-local, multicast or reserved ranges, IPv4 or IPv6, including IPv4-mapped IPv6), redirects
 * are not followed. A host that resolves to several addresses is refused if any one is not public.
 *
 * Limits: the check resolves the name once and the request resolves it again, so a DNS server that answers differently the
 * second time (rebinding) can slip through. Callers check before every delivery, never follow redirects and use short
 * timeouts; a network-level egress rule is the complete answer in production.
 *
 * Side effects: one DNS lookup for a host name (none for an IP literal).
 *
 * @param input the URL as configured by a merchant, a staff member or a supplier record
 * @param options https-only switch and the resolver
 * @returns the parsed URL and the addresses it resolves to
 * @throws {UnsafeUrlError} with the reason when the URL must not be requested
 *
 * @see docs/decisions/023-outbound-http.md
 */
export async function assertPublicHttpUrl(input: string | URL, options: PublicUrlOptions): Promise<PublicUrl> {
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    throw new UnsafeUrlError('invalid_url', undefined);
  }
  // The URL parser has already turned decimal, octal and hex IPv4 forms (http://2130706433/) into dotted decimal.
  const host = url.hostname.replace(/^\[|\]$/g, '');
  if (host === '') throw new UnsafeUrlError('invalid_url', undefined);
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && !options.httpsOnly)) {
    throw new UnsafeUrlError('scheme_not_allowed', host);
  }
  if (url.username !== '' || url.password !== '') throw new UnsafeUrlError('credentials_in_url', host);

  let addresses: readonly string[];
  if (net.isIP(host) !== 0) {
    addresses = [host];
  } else {
    try {
      addresses = await withTimeout(
        (options.lookup ?? systemLookup)(host),
        options.dnsTimeoutMs ?? DEFAULT_DNS_TIMEOUT_MS,
        'DNS lookup',
      );
    } catch {
      throw new UnsafeUrlError('dns_failure', host);
    }
    if (addresses.length === 0) throw new UnsafeUrlError('dns_failure', host);
  }
  if (!addresses.every((address) => isPublicAddress(address))) throw new UnsafeUrlError('non_public_address', host);
  return { url, addresses };
}
