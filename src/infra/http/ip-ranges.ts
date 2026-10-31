// Which IP addresses are public (decision 023): IPv4 and IPv6 literals are parsed to bytes and compared with the special-
// purpose ranges of IANA, including addresses that embed an IPv4 address. Used by the SSRF guard. Pure functions.
import net from 'node:net';

/** A network as address text and prefix length. */
type Network = readonly [address: string, prefixLength: number];

/** IPv4 ranges that are not public unicast (RFC 6890 and friends). */
const BLOCKED_V4: readonly Network[] = [
  ['0.0.0.0', 8], // "this network"
  ['10.0.0.0', 8], // private
  ['100.64.0.0', 10], // carrier-grade NAT
  ['127.0.0.0', 8], // loopback
  ['169.254.0.0', 16], // link-local, including the cloud metadata address 169.254.169.254
  ['172.16.0.0', 12], // private
  ['192.0.0.0', 24], // IETF protocol assignments
  ['192.0.2.0', 24], // documentation
  ['192.88.99.0', 24], // 6to4 relay anycast
  ['192.168.0.0', 16], // private
  ['198.18.0.0', 15], // benchmarking
  ['198.51.100.0', 24], // documentation
  ['203.0.113.0', 24], // documentation
  ['224.0.0.0', 4], // multicast
  ['240.0.0.0', 4], // reserved, including the broadcast address
];

/** IPv6 ranges that are not public unicast. Addresses that embed IPv4 are judged by the IPv4 rules first. */
const BLOCKED_V6: readonly Network[] = [
  ['::', 128], // unspecified
  ['::1', 128], // loopback
  ['64:ff9b:1::', 48], // local-use NAT64
  ['100::', 64], // discard-only
  ['::ffff:0:0:0', 96], // IPv4-translated
  ['2001::', 32], // Teredo
  ['2001:2::', 48], // benchmarking
  ['2001:10::', 28], // ORCHID
  ['2001:20::', 28], // ORCHIDv2
  ['2001:db8::', 32], // documentation
  ['3fff::', 20], // documentation
  ['5f00::', 16], // SRv6 segment identifiers
  ['fc00::', 7], // unique local
  ['fe80::', 10], // link-local
  ['fec0::', 10], // site-local (deprecated)
  ['ff00::', 8], // multicast
];

/** Parses `a.b.c.d` (four decimal parts, as the URL parser normalises every IPv4 form) to bytes. */
function parseV4(text: string): Uint8Array | undefined {
  if (!net.isIPv4(text)) return undefined;
  return Uint8Array.from(text.split('.').map(Number));
}

/** Parses an IPv6 address (with `::`, an embedded IPv4 tail and an optional zone) to 16 bytes. */
function parseV6(text: string): Uint8Array | undefined {
  const withoutZone = text.split('%')[0] ?? '';
  if (!net.isIPv6(withoutZone)) return undefined;
  const [head = '', tail, extra] = withoutZone.split('::');
  if (extra !== undefined) return undefined;
  const groups = (part: string): number[] =>
    part === ''
      ? []
      : part.split(':').flatMap((group) => {
          if (!group.includes('.')) return [Number.parseInt(group, 16)];
          const v4 = parseV4(group);
          return v4 ? [((v4[0] ?? 0) << 8) | (v4[1] ?? 0), ((v4[2] ?? 0) << 8) | (v4[3] ?? 0)] : [Number.NaN];
        });
  const first = groups(head);
  const last = tail === undefined ? [] : groups(tail);
  const filled =
    tail === undefined ? first : [...first, ...Array<number>(8 - first.length - last.length).fill(0), ...last];
  if (filled.length !== 8 || filled.some((group) => Number.isNaN(group))) return undefined;
  return Uint8Array.from(filled.flatMap((group) => [group >> 8, group & 0xff]));
}

/** A network with its address already parsed to bytes. */
interface ParsedNetwork {
  readonly base: Uint8Array;
  readonly prefixLength: number;
}

function parseNetworks(networks: readonly Network[], parse: (text: string) => Uint8Array | undefined) {
  return networks.map(([address, prefixLength]): ParsedNetwork => {
    const base = parse(address);
    if (!base) throw new Error(`Invalid network in the table: ${address}`);
    return { base, prefixLength };
  });
}

const BLOCKED_V4_PARSED = parseNetworks(BLOCKED_V4, parseV4);
const BLOCKED_V6_PARSED = parseNetworks(BLOCKED_V6, parseV6);

/** True when the first `prefixLength` bits of `bytes` equal those of the network. */
function inNetwork(bytes: Uint8Array, { base, prefixLength }: ParsedNetwork): boolean {
  const wholeBytes = Math.floor(prefixLength / 8);
  for (let i = 0; i < wholeBytes; i++) if (bytes[i] !== base[i]) return false;
  const rest = prefixLength % 8;
  if (rest === 0) return true;
  const mask = (0xff << (8 - rest)) & 0xff;
  return ((bytes[wholeBytes] ?? 0) & mask) === ((base[wholeBytes] ?? 0) & mask);
}

const startsWith = (bytes: Uint8Array, prefix: readonly number[]) =>
  prefix.every((value, index) => bytes[index] === value);

/** The IPv4 address hidden inside an IPv6 address, for the forms that carry one; `undefined` for any other address. */
function embeddedV4(bytes: Uint8Array): Uint8Array | undefined {
  // ::ffff:a.b.c.d (IPv4-mapped), 64:ff9b::a.b.c.d (NAT64) and ::a.b.c.d (IPv4-compatible, deprecated)
  const mapped = startsWith(bytes, [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0xff, 0xff]);
  const nat64 = startsWith(bytes, [0x00, 0x64, 0xff, 0x9b, 0, 0, 0, 0, 0, 0, 0, 0]);
  const compatible = startsWith(bytes, [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
  if (mapped || nat64 || compatible) return bytes.slice(12, 16);
  // 2002:aabb:ccdd::/48 (6to4) carries the IPv4 address in bytes 2 to 5.
  if (startsWith(bytes, [0x20, 0x02])) return bytes.slice(2, 6);
  return undefined;
}

/**
 * Tells whether an IP literal is a public unicast address.
 *
 * Why: decision 023 sends merchant-webhook and supplier requests only to public hosts, so a configured URL cannot be used
 * to reach Postgres, Redis, MinIO or a cloud metadata endpoint (SSRF). The test is a deny list of every special-purpose
 * range (private, loopback, link-local, carrier-grade NAT, multicast, reserved, documentation, ...) for both IP versions;
 * IPv6 forms that embed an IPv4 address (IPv4-mapped `::ffff:127.0.0.1`, NAT64, 6to4) are judged by the embedded address.
 *
 * @param address an IPv4 or IPv6 literal without brackets (a zone suffix is ignored)
 * @returns true for a public address; false for a non-public one and for anything that is not an IP literal
 *
 * @see docs/decisions/023-outbound-http.md
 */
export function isPublicAddress(address: string): boolean {
  const v4 = parseV4(address);
  if (v4) return !BLOCKED_V4_PARSED.some((network) => inNetwork(v4, network));
  const v6 = parseV6(address);
  if (!v6) return false;
  const embedded = embeddedV4(v6);
  if (embedded) return !BLOCKED_V4_PARSED.some((network) => inNetwork(embedded, network));
  return !BLOCKED_V6_PARSED.some((network) => inNetwork(v6, network));
}
