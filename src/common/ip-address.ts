// IP addresses and networks as bytes (IPv4 and IPv6): parsing, "is this address inside that network", printing, and the key
// of a per-client rate limit. Pure functions shared by the IP rules hook, the per-IP limiter and the SSRF guard.
import net from 'node:net';

/**
 * An IP address as bytes.
 *
 * Why: comparing bytes handles IPv4, IPv6 and CIDR prefixes with one routine. An IPv4-mapped IPv6 address
 * (`::ffff:203.0.113.9`, what a dual-stack socket reports for an IPv4 client) is kept as the IPv4 address it carries, so a
 * rule written for `203.0.113.9` also matches that client.
 */
export interface IpAddress {
  readonly family: 4 | 6;
  /** 4 bytes for IPv4, 16 for IPv6. */
  readonly bytes: Uint8Array;
}

/**
 * A network: an address and how many leading bits identify it (`203.0.113.0/24`).
 *
 * Why: IP rules (Postgres `cidr`) and API key allowed IPs are written as networks; host bits after the prefix are ignored
 * when matching.
 */
export interface IpNetwork extends IpAddress {
  readonly prefixLength: number;
}

const V4_MAPPED_PREFIX = [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0xff, 0xff] as const;

/**
 * Parses `a.b.c.d` (four decimal parts) to its 4 bytes.
 *
 * Why: the SSRF guard (decision 023) and the IP rules compare addresses as bytes, with one parser for both.
 *
 * @param text an IPv4 literal
 * @returns the bytes, or `undefined` when the text is not a dotted IPv4 literal
 */
export function parseIpv4Bytes(text: string): Uint8Array | undefined {
  if (!net.isIPv4(text)) return undefined;
  return Uint8Array.from(text.split('.').map(Number));
}

/**
 * Parses an IPv6 literal (with `::`, an embedded IPv4 tail and an optional zone such as `%eth0`) to its 16 bytes.
 *
 * Why: see {@link parseIpv4Bytes}; IPv6 clients and IPv6 rules must work the same way as IPv4 ones.
 *
 * @param text an IPv6 literal
 * @returns the bytes, or `undefined` when the text is not an IPv6 literal
 */
export function parseIpv6Bytes(text: string): Uint8Array | undefined {
  const withoutZone = text.split('%')[0] ?? '';
  if (!net.isIPv6(withoutZone)) return undefined;
  const [head = '', tail, extra] = withoutZone.split('::');
  if (extra !== undefined) return undefined;
  const groups = (part: string): number[] =>
    part === ''
      ? []
      : part.split(':').flatMap((group) => {
          if (!group.includes('.')) return [Number.parseInt(group, 16)];
          const v4 = parseIpv4Bytes(group);
          return v4 ? [((v4[0] ?? 0) << 8) | (v4[1] ?? 0), ((v4[2] ?? 0) << 8) | (v4[3] ?? 0)] : [Number.NaN];
        });
  const first = groups(head);
  const last = tail === undefined ? [] : groups(tail);
  const filled =
    tail === undefined ? first : [...first, ...Array<number>(8 - first.length - last.length).fill(0), ...last];
  if (filled.length !== 8 || filled.some((group) => Number.isNaN(group))) return undefined;
  return Uint8Array.from(filled.flatMap((group) => [group >> 8, group & 0xff]));
}

/**
 * Tells whether the first `prefixLength` bits of two byte strings are equal.
 *
 * Why: this is what "inside a CIDR range" means, for IPv4 and IPv6 alike.
 *
 * @param a one address
 * @param b another address of the same length
 * @param prefixLength how many leading bits to compare (0 matches everything)
 * @returns true when those bits are equal
 */
export function sharesPrefix(a: Uint8Array, b: Uint8Array, prefixLength: number): boolean {
  const wholeBytes = Math.floor(prefixLength / 8);
  for (let i = 0; i < wholeBytes; i++) if (a[i] !== b[i]) return false;
  const rest = prefixLength % 8;
  if (rest === 0) return true;
  const mask = (0xff << (8 - rest)) & 0xff;
  return ((a[wholeBytes] ?? 0) & mask) === ((b[wholeBytes] ?? 0) & mask);
}

/** The IPv4 bytes inside an IPv4-mapped IPv6 address, or `undefined` for any other 16 bytes. */
function mappedIpv4(bytes: Uint8Array): Uint8Array | undefined {
  return V4_MAPPED_PREFIX.every((value, index) => bytes[index] === value) ? bytes.slice(12, 16) : undefined;
}

/** Reads an address literal without folding IPv4-mapped IPv6 into IPv4. */
function parseRaw(text: string): IpAddress | undefined {
  const candidate = text.trim().split('%')[0] ?? '';
  const v4 = parseIpv4Bytes(candidate);
  if (v4) return { family: 4, bytes: v4 };
  const v6 = parseIpv6Bytes(candidate);
  return v6 ? { family: 6, bytes: v6 } : undefined;
}

/**
 * Parses an IP literal; an IPv4-mapped IPv6 address becomes the IPv4 address it carries.
 *
 * Why: the client address comes from the socket or a trusted proxy header in whatever form the platform prints it; every
 * check works on the parsed value, never on text, so `::ffff:203.0.113.9`, `203.0.113.9` and a zone suffix all agree.
 *
 * @param text an IPv4 or IPv6 literal (surrounding spaces and a `%zone` suffix are ignored)
 * @returns the address, or `undefined` when the text is not an IP literal
 */
export function parseIpAddress(text: string): IpAddress | undefined {
  const raw = parseRaw(text);
  if (!raw || raw.family === 4) return raw;
  const mapped = mappedIpv4(raw.bytes);
  return mapped ? { family: 4, bytes: mapped } : raw;
}

/**
 * Parses a network such as `203.0.113.0/24`, `2001:db8::/32` or a single address (a /32 or /128).
 *
 * Why: the text is what Postgres prints for a `cidr` column (`203.0.113.24/32`); it is read once when the rules are
 * loaded, not on every request. A network written as an IPv4-mapped IPv6 range of at least /96 becomes the IPv4 network
 * it stands for.
 *
 * @param text an address, optionally followed by `/prefix`
 * @returns the network, or `undefined` when the address or the prefix is not valid
 */
export function parseNetwork(text: string): IpNetwork | undefined {
  const [address, prefix, extra] = text.trim().split('/');
  if (address === undefined || extra !== undefined) return undefined;
  const raw = parseRaw(address);
  if (!raw) return undefined;
  const maxPrefix = raw.family === 4 ? 32 : 128;
  if (prefix !== undefined && !/^\d{1,3}$/.test(prefix)) return undefined;
  const prefixLength = prefix === undefined ? maxPrefix : Number(prefix);
  if (prefixLength > maxPrefix) return undefined;
  if (raw.family === 6 && prefixLength >= 96) {
    const mapped = mappedIpv4(raw.bytes);
    if (mapped) return { family: 4, bytes: mapped, prefixLength: prefixLength - 96 };
  }
  return { family: raw.family, bytes: raw.bytes, prefixLength };
}

/**
 * Tells whether an address is inside a network. Different families never match.
 *
 * Why: IP rules and API key allowed IPs (decision 018) match a client address against CIDR ranges.
 *
 * @param network the network
 * @param address the address to test
 * @returns true when the first `prefixLength` bits agree
 */
export function networkContains(network: IpNetwork, address: IpAddress): boolean {
  return network.family === address.family && sharesPrefix(network.bytes, address.bytes, network.prefixLength);
}

/**
 * Prints an address in its usual form: dotted IPv4, or compressed lower-case IPv6 (RFC 5952).
 *
 * Why: error details and log lines show the address the way a person writes it.
 *
 * @param address a parsed address
 * @returns the text
 */
export function formatIpAddress(address: IpAddress): string {
  if (address.family === 4) return [...address.bytes].join('.');
  const groups = Array.from(
    { length: 8 },
    (_, i) => ((address.bytes[2 * i] ?? 0) << 8) | (address.bytes[2 * i + 1] ?? 0),
  );
  // The longest run of zero groups (two or more) becomes "::"; on a tie the first run wins.
  let bestStart = -1;
  let bestLength = 0;
  for (let start = 0; start < 8;) {
    if (groups[start] !== 0) {
      start++;
      continue;
    }
    let end = start;
    while (end < 8 && groups[end] === 0) end++;
    if (end - start > bestLength) {
      bestStart = start;
      bestLength = end - start;
    }
    start = end;
  }
  const hex = (list: number[]) => list.map((group) => group.toString(16)).join(':');
  if (bestLength < 2) return hex(groups);
  return `${hex(groups.slice(0, bestStart))}::${hex(groups.slice(bestStart + bestLength))}`;
}

/**
 * The key under which a client is rate limited: the IPv4 address, or the /64 network of an IPv6 address.
 *
 * Why: one subscriber usually holds a whole IPv6 /64, so limiting single IPv6 addresses would let a client dodge the limit
 * by rotating addresses. An IPv4-mapped address shares the key of its IPv4 address.
 *
 * @param address the parsed client address, `undefined` when it could not be read
 * @returns a short text key (`203.0.113.9`, `2001:db8:1:2::/64`, or `unknown`)
 */
export function ipRateLimitKey(address: IpAddress | undefined): string {
  if (!address) return 'unknown';
  if (address.family === 4) return formatIpAddress(address);
  const prefix = formatIpAddress({
    family: 6,
    bytes: Uint8Array.from([...address.bytes.slice(0, 8), 0, 0, 0, 0, 0, 0, 0, 0]),
  });
  return `${prefix}/64`;
}
