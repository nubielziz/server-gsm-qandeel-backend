// Unit tests of the public-address check behind the SSRF guard (decision 023): IPv4, IPv6, IPv6 forms that embed an IPv4
// address, and the edges of each special-purpose range.
import { describe, expect, it } from 'bun:test';
import { isPublicAddress } from './ip-ranges';

const refused = (...addresses: string[]) => {
  for (const address of addresses) expect(isPublicAddress(address), `${address} must not be public`).toBe(false);
};
const accepted = (...addresses: string[]) => {
  for (const address of addresses) expect(isPublicAddress(address), `${address} must be public`).toBe(true);
};

describe('isPublicAddress, IPv4', () => {
  it('accepts ordinary public addresses', () => {
    accepted('8.8.8.8', '1.1.1.1', '93.184.216.34', '151.101.1.69', '172.15.255.255', '172.32.0.1', '11.0.0.1');
  });

  it('refuses private ranges (RFC 1918) at both edges', () => {
    refused('10.0.0.0', '10.255.255.255', '172.16.0.0', '172.31.255.255', '192.168.0.0', '192.168.255.255');
  });

  it('refuses loopback, "this network", link-local and the cloud metadata address', () => {
    refused('127.0.0.1', '127.255.255.254', '0.0.0.0', '0.1.2.3', '169.254.0.1', '169.254.169.254', '169.254.255.255');
  });

  it('refuses carrier-grade NAT, benchmarking, documentation and protocol-assignment ranges', () => {
    refused(
      '100.64.0.0',
      '100.127.255.255',
      '198.18.0.1',
      '198.19.255.255',
      '192.0.0.1',
      '192.0.2.1',
      '198.51.100.1',
      '203.0.113.1',
      '192.88.99.1',
    );
    accepted('100.63.255.255', '100.128.0.0', '198.17.255.255', '198.20.0.0');
  });

  it('refuses multicast, reserved and broadcast', () => {
    refused('224.0.0.1', '239.255.255.255', '240.0.0.1', '255.255.255.255');
  });
});

describe('isPublicAddress, IPv6', () => {
  it('accepts ordinary public addresses', () => {
    accepted('2606:4700:4700::1111', '2001:4860:4860::8888', '2a00:1450:4001:81b::200e', '2620:fe::fe');
  });

  it('refuses loopback, unspecified, unique local, link-local and site-local', () => {
    refused('::1', '::', 'fc00::1', 'fd12:3456:789a::1', 'fe80::1', 'febf:ffff::1', 'fec0::1');
  });

  it('refuses multicast, documentation, discard, Teredo and ORCHID ranges', () => {
    refused('ff02::1', 'ff00::', '2001:db8::1', '100::1', '2001::1', '2001:10::1', '2001:20::1', '64:ff9b:1::1');
    // benchmarking, documentation (3fff::/20), SRv6 segment ids, IPv4-translated (::ffff:0:a.b.c.d)
    refused('2001:2::1', '3fff::1', '3fff:fff::1', '5f00::1', '::ffff:0:a00:1');
  });

  it('accepts addresses just outside those ranges', () => {
    accepted('2001:4800::1', '2001:db7::1', 'fbff::1', 'fe00::1');
  });

  it('understands compressed, expanded, upper-case and zero-padded forms of the same address', () => {
    refused('0:0:0:0:0:0:0:1', '0000:0000:0000:0000:0000:0000:0000:0001', 'FE80:0:0:0:0:0:0:1', 'FD00:0:0:0::1');
    accepted('2606:4700:4700:0:0:0:0:1111', '2606:4700:4700::1111');
  });

  it('ignores a zone id', () => {
    refused('fe80::1%eth0');
  });
});

describe('isPublicAddress, IPv6 forms that embed an IPv4 address', () => {
  it('judges IPv4-mapped addresses (::ffff:a.b.c.d and the hex form) by the IPv4 rules', () => {
    refused(
      '::ffff:127.0.0.1',
      '::ffff:7f00:1',
      '::ffff:10.0.0.1',
      '::ffff:a00:1',
      '::ffff:192.168.1.1',
      '::ffff:169.254.169.254',
    );
    refused('::FFFF:C0A8:101', '0:0:0:0:0:ffff:7f00:1');
    accepted('::ffff:8.8.8.8', '::ffff:808:808');
  });

  it('judges NAT64 addresses (64:ff9b::/96) by the embedded IPv4 address', () => {
    refused('64:ff9b::127.0.0.1', '64:ff9b::7f00:1', '64:ff9b::a00:1');
    accepted('64:ff9b::8.8.8.8', '64:ff9b::808:808');
  });

  it('judges 6to4 addresses (2002::/16) by the embedded IPv4 address', () => {
    refused('2002:7f00:1::1', '2002:a00:1::', '2002:c0a8:101::1');
    accepted('2002:808:808::1');
  });

  it('judges the deprecated IPv4-compatible form (::a.b.c.d) by the IPv4 rules', () => {
    refused('::127.0.0.1', '::10.0.0.1', '::0.0.0.2');
    accepted('::8.8.8.8');
  });
});

describe('isPublicAddress, things that are not an IP literal', () => {
  it('is never true for host names, empty text or malformed addresses', () => {
    refused(
      '',
      'example.com',
      'localhost',
      '1.2.3',
      '256.1.1.1',
      '1.2.3.4.5',
      '01.2.3.4',
      ':::',
      'gggg::1',
      '1.2.3.4/24',
      ' 8.8.8.8',
    );
  });
});
