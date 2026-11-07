// Pure rules of the IP rule routes: how a typed address or range is checked and written, and how a stored one is read back.
// No I/O, so the rules are unit-tested.
import { type IpNetwork, formatIpAddress, parseNetwork } from '../../../common/ip-address';

/** The widest IPv4 range a rule may cover (a /16 holds 65 536 addresses; scenario ip-rules step 1). */
export const WIDEST_IPV4_PREFIX = 16;
/** The widest IPv6 range a rule may cover (a /48 is one site; the console only sends single IPv6 addresses). */
export const WIDEST_IPV6_PREFIX = 48;

/** A checked address or range. */
export type CidrResult =
  | {
      readonly ok: true;
      /** The text to store in the `cidr` column: network address and prefix (`203.0.113.0/24`, `203.0.113.5/32`). */
      readonly stored: string;
      /** The wire spelling: the same without `/32` or `/128`. */
      readonly wire: string;
      readonly network: IpNetwork;
    }
  | { readonly ok: false; readonly message: string };

/**
 * Checks and normalises an address or range typed into an IP rule.
 *
 * Why: scenario ip-rules step 1 and ANSWERS access: the rule list keeps one spelling per network, so duplicates are found by
 * comparing networks; host bits after the prefix (`203.0.113.5/24`) are a typing mistake, not a wider rule; and a rule
 * wider than /16 (IPv4) would block or allow an absurd share of the internet.
 *
 * @param input the text as typed (`203.0.113.5`, `203.0.113.0/24`, `2001:db8::1`, an IPv4-mapped IPv6 address)
 * @returns the stored and wire spellings and the parsed network, or the sentence to show on the `cidr` field
 */
export function normaliseCidr(input: string): CidrResult {
  const network = parseNetwork(input);
  if (!network) {
    return { ok: false, message: 'Enter an IP address, or a range like 203.0.113.0/24.' };
  }
  const widest = network.family === 4 ? WIDEST_IPV4_PREFIX : WIDEST_IPV6_PREFIX;
  if (network.prefixLength < widest) {
    return {
      ok: false,
      message:
        network.family === 4
          ? `Ranges wider than /${widest} are not allowed. Use /${widest} or narrower.`
          : `IPv6 ranges wider than /${widest} are not allowed.`,
    };
  }
  const masked = maskedBytes(network);
  if (masked.some((byte, index) => byte !== network.bytes[index])) {
    const suggestion = formatIpAddress({ family: network.family, bytes: masked });
    return {
      ok: false,
      message: `This range has bits set after /${network.prefixLength}. Did you mean ${suggestion}/${network.prefixLength}?`,
    };
  }
  const address = formatIpAddress(network);
  const single = network.prefixLength === (network.family === 4 ? 32 : 128);
  return {
    ok: true,
    stored: `${address}/${network.prefixLength}`,
    wire: single ? address : `${address}/${network.prefixLength}`,
    network,
  };
}

/** The address bytes with every bit after the prefix cleared. */
function maskedBytes(network: IpNetwork): Uint8Array {
  const bytes = new Uint8Array(network.bytes);
  for (let bit = network.prefixLength; bit < bytes.length * 8; bit++) {
    bytes[bit >> 3] = bytes[bit >> 3]! & ~(0x80 >> (bit & 7));
  }
  return bytes;
}

/**
 * Writes a stored `cidr` the way the wire does: a single host loses its `/32` or `/128`.
 *
 * Why: the console and the rest of the API show a single address without a prefix (RESOLUTIONS identity-platform-5); ranges
 * keep theirs. One formatter serves IP rules now and API key allowed IPs later (feature 7b).
 *
 * @param stored what Postgres prints for a `cidr` (`203.0.113.24/32`, `203.0.113.0/24`, `2001:db8::1/128`)
 * @returns the wire spelling
 */
export function cidrToWire(stored: string): string {
  // An IPv6 /32 is a range (an ISP allocation), only an IPv6 /128 and an IPv4 /32 are single hosts.
  return stored.includes(':') ? stored.replace(/\/128$/, '') : stored.replace(/\/32$/, '');
}
