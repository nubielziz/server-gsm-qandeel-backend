// Unit tests of the IP rule input rules: normalising typed addresses and ranges, host bits, the widest range, the wire form.
import { describe, expect, it } from 'bun:test';
import { cidrToWire, normaliseCidr } from './ip-rule-input';

describe('normaliseCidr', () => {
  it('writes a single address with its full prefix to store and without it on the wire', () => {
    expect(normaliseCidr('203.0.113.5')).toMatchObject({ ok: true, stored: '203.0.113.5/32', wire: '203.0.113.5' });
    expect(normaliseCidr(' 203.0.113.5/32 ')).toMatchObject({
      ok: true,
      stored: '203.0.113.5/32',
      wire: '203.0.113.5',
    });
    expect(normaliseCidr('2001:DB8::1')).toMatchObject({ ok: true, stored: '2001:db8::1/128', wire: '2001:db8::1' });
  });

  it('keeps a range with its prefix', () => {
    expect(normaliseCidr('203.0.113.0/24')).toMatchObject({
      ok: true,
      stored: '203.0.113.0/24',
      wire: '203.0.113.0/24',
    });
    expect(normaliseCidr('10.1.0.0/16')).toMatchObject({ ok: true, stored: '10.1.0.0/16' });
    expect(normaliseCidr('2001:db8:1::/48')).toMatchObject({ ok: true, stored: '2001:db8:1::/48' });
  });

  it('reads an IPv4-mapped IPv6 address as the IPv4 address', () => {
    expect(normaliseCidr('::ffff:203.0.113.9')).toMatchObject({ ok: true, stored: '203.0.113.9/32' });
  });

  it('refuses host bits after the prefix and says what was probably meant', () => {
    const result = normaliseCidr('203.0.113.5/24');
    expect(result.ok).toBe(false);
    expect(result).toMatchObject({ message: expect.stringContaining('203.0.113.0/24') });
  });

  it('refuses an IPv4 range wider than /16 and an IPv6 range wider than /48', () => {
    expect(normaliseCidr('10.0.0.0/15')).toMatchObject({ ok: false, message: expect.stringContaining('/16') });
    expect(normaliseCidr('0.0.0.0/0')).toMatchObject({ ok: false });
    expect(normaliseCidr('2001:db8::/32')).toMatchObject({ ok: false, message: expect.stringContaining('/48') });
  });

  it('refuses text that is not an address', () => {
    for (const text of ['', 'office', '203.0.113', '203.0.113.256', '203.0.113.0/33', '1.2.3.4/24/5']) {
      expect(normaliseCidr(text).ok).toBe(false);
    }
  });
});

describe('cidrToWire', () => {
  it('drops an IPv4 /32 and an IPv6 /128 only', () => {
    expect(cidrToWire('203.0.113.24/32')).toBe('203.0.113.24');
    expect(cidrToWire('2001:db8::1/128')).toBe('2001:db8::1');
    expect(cidrToWire('203.0.113.0/24')).toBe('203.0.113.0/24');
    expect(cidrToWire('10.0.0.0/8')).toBe('10.0.0.0/8');
    expect(cidrToWire('2001:db8::/32')).toBe('2001:db8::/32');
  });
});
