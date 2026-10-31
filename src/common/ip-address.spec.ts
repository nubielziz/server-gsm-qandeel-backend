// Unit tests of the IP address helpers: parsing of IPv4, IPv6 and networks, IPv4-mapped addresses, containment, printing
// and the rate-limit key.
import { describe, expect, it } from 'bun:test';
import {
  formatIpAddress,
  ipRateLimitKey,
  networkContains,
  parseIpAddress,
  parseIpv4Bytes,
  parseIpv6Bytes,
  parseNetwork,
  sharesPrefix,
} from './ip-address';

const ip = (text: string) => {
  const parsed = parseIpAddress(text);
  if (!parsed) throw new Error(`not an address: ${text}`);
  return parsed;
};
const net = (text: string) => {
  const parsed = parseNetwork(text);
  if (!parsed) throw new Error(`not a network: ${text}`);
  return parsed;
};

describe('parseIpAddress', () => {
  it('reads IPv4 and IPv6 literals', () => {
    expect(ip('203.0.113.9')).toEqual({ family: 4, bytes: Uint8Array.from([203, 0, 113, 9]) });
    expect(ip('2001:db8::1').family).toBe(6);
    expect(ip('::1').bytes).toEqual(Uint8Array.from([0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1]));
  });

  it('folds an IPv4-mapped IPv6 address into the IPv4 address it carries', () => {
    expect(ip('::ffff:203.0.113.9')).toEqual(ip('203.0.113.9'));
    expect(ip('::FFFF:cb00:7109')).toEqual(ip('203.0.113.9'));
    expect(ip('2001:db8::ffff:203.0.113.9').family).toBe(6);
  });

  it('ignores spaces and a zone suffix, and is case-insensitive', () => {
    expect(ip(' fe80::1%eth0 ')).toEqual(ip('FE80::1'));
  });

  it('refuses anything that is not an address', () => {
    for (const bad of [
      '',
      'abc',
      '1.2.3',
      '1.2.3.4.5',
      '256.1.1.1',
      '1.2.3.4/24',
      '::g',
      ':::',
      '<script>',
      '1.2.3.4\n5',
    ]) {
      expect(parseIpAddress(bad), JSON.stringify(bad)).toBeUndefined();
    }
  });
});

describe('parseIpv4Bytes and parseIpv6Bytes', () => {
  it('parse only their own family', () => {
    expect(parseIpv4Bytes('10.0.0.1')).toEqual(Uint8Array.from([10, 0, 0, 1]));
    expect(parseIpv4Bytes('::1')).toBeUndefined();
    expect(parseIpv6Bytes('10.0.0.1')).toBeUndefined();
    expect(parseIpv6Bytes('::ffff:1.2.3.4')).toEqual(
      Uint8Array.from([0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 255, 255, 1, 2, 3, 4]),
    );
  });
});

describe('parseNetwork', () => {
  it('reads a CIDR range and a single address', () => {
    expect(net('203.0.113.0/24')).toMatchObject({ family: 4, prefixLength: 24 });
    expect(net('203.0.113.24')).toMatchObject({ family: 4, prefixLength: 32 });
    expect(net('203.0.113.24/32')).toMatchObject({ family: 4, prefixLength: 32 });
    expect(net('2001:db8::/32')).toMatchObject({ family: 6, prefixLength: 32 });
    expect(net('2001:db8::1')).toMatchObject({ family: 6, prefixLength: 128 });
    expect(net('0.0.0.0/0')).toMatchObject({ family: 4, prefixLength: 0 });
  });

  it('turns a mapped IPv6 range of at least /96 into the IPv4 network it stands for', () => {
    expect(net('::ffff:203.0.113.0/120')).toMatchObject({ family: 4, prefixLength: 24 });
    expect(net('::ffff:203.0.113.9/128')).toMatchObject({ family: 4, prefixLength: 32 });
    expect(net('::ffff:0:0/80').family).toBe(6);
  });

  it('refuses a bad address, a prefix out of range and extra parts', () => {
    for (const bad of [
      '',
      '/24',
      '1.2.3.4/33',
      '1.2.3.4/',
      '1.2.3.4/-1',
      '1.2.3.4/24/1',
      '::/129',
      'x/8',
      '1.2.3.4/ 8',
      '1.2.3.4/1e1',
    ]) {
      expect(parseNetwork(bad), JSON.stringify(bad)).toBeUndefined();
    }
  });
});

describe('networkContains', () => {
  it('matches the addresses of an IPv4 range and ignores host bits', () => {
    expect(networkContains(net('203.0.113.160/28'), ip('203.0.113.175'))).toBe(true);
    expect(networkContains(net('203.0.113.160/28'), ip('203.0.113.176'))).toBe(false);
    expect(networkContains(net('203.0.113.160/28'), ip('203.0.113.159'))).toBe(false);
    expect(networkContains(net('203.0.113.77/24'), ip('203.0.113.1'))).toBe(true);
    expect(networkContains(net('198.51.100.5'), ip('198.51.100.5'))).toBe(true);
    expect(networkContains(net('198.51.100.5'), ip('198.51.100.6'))).toBe(false);
    expect(networkContains(net('0.0.0.0/0'), ip('8.8.8.8'))).toBe(true);
  });

  it('matches IPv6 ranges and single addresses', () => {
    expect(networkContains(net('2001:db8::/32'), ip('2001:db8:ffff::1'))).toBe(true);
    expect(networkContains(net('2001:db8::/32'), ip('2001:db9::1'))).toBe(false);
    expect(networkContains(net('2001:db8::1'), ip('2001:db8::1'))).toBe(true);
    expect(networkContains(net('2001:db8::1'), ip('2001:db8::2'))).toBe(false);
    expect(networkContains(net('2001:db8:0:1::/65'), ip('2001:db8:0:1:8000::'))).toBe(false);
    expect(networkContains(net('2001:db8:0:1::/65'), ip('2001:db8:0:1:7fff::'))).toBe(true);
  });

  it('never matches across families, but a mapped client address matches the IPv4 rule', () => {
    expect(networkContains(net('0.0.0.0/0'), ip('2001:db8::1'))).toBe(false);
    expect(networkContains(net('::/0'), ip('203.0.113.9'))).toBe(false);
    expect(networkContains(net('203.0.113.0/24'), ip('::ffff:203.0.113.9'))).toBe(true);
  });
});

describe('sharesPrefix', () => {
  it('compares whole bytes and the bits of the last one', () => {
    const a = Uint8Array.from([0b1010_1010, 0b1111_0000]);
    expect(sharesPrefix(a, Uint8Array.from([0b1010_1010, 0b1111_1111]), 12)).toBe(true);
    expect(sharesPrefix(a, Uint8Array.from([0b1010_1010, 0b1110_1111]), 12)).toBe(false);
    expect(sharesPrefix(a, Uint8Array.from([0, 0]), 0)).toBe(true);
    expect(sharesPrefix(a, Uint8Array.from([0b1010_1011, 0]), 8)).toBe(false);
  });
});

describe('formatIpAddress', () => {
  it('prints IPv4 dotted and IPv6 compressed (RFC 5952)', () => {
    expect(formatIpAddress(ip('203.0.113.9'))).toBe('203.0.113.9');
    expect(formatIpAddress(ip('2001:0db8:0000:0000:0000:0000:0000:0001'))).toBe('2001:db8::1');
    expect(formatIpAddress(ip('::1'))).toBe('::1');
    expect(formatIpAddress(ip('::'))).toBe('::');
    expect(formatIpAddress(ip('2001:db8:0:0:1:0:0:1'))).toBe('2001:db8::1:0:0:1');
    expect(formatIpAddress(ip('2001:db8:0:1:1:1:1:1'))).toBe('2001:db8:0:1:1:1:1:1');
    expect(formatIpAddress(ip('1:0:0:0:0:0:0:0'))).toBe('1::');
    expect(formatIpAddress(ip('FE80::ABCD'))).toBe('fe80::abcd');
  });
});

describe('ipRateLimitKey', () => {
  it('is the address for IPv4 and the /64 network for IPv6', () => {
    expect(ipRateLimitKey(ip('203.0.113.9'))).toBe('203.0.113.9');
    expect(ipRateLimitKey(ip('2001:db8:1:2:aaaa:bbbb:cccc:dddd'))).toBe('2001:db8:1:2::/64');
    expect(ipRateLimitKey(ip('2001:db8:1:2:1::1'))).toBe(ipRateLimitKey(ip('2001:db8:1:2:ffff::')));
    expect(ipRateLimitKey(ip('2001:db8:1:3::1'))).not.toBe(ipRateLimitKey(ip('2001:db8:1:2::1')));
  });

  it('gives a mapped address the key of its IPv4 address, and "unknown" for no address', () => {
    expect(ipRateLimitKey(ip('::ffff:203.0.113.9'))).toBe('203.0.113.9');
    expect(ipRateLimitKey(undefined)).toBe('unknown');
  });
});
