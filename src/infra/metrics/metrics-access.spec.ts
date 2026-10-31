// Unit tests for the /metrics access rule: private addresses, proxy hints, bearer token (decision 015).
import { describe, expect, it } from 'bun:test';
import { authorizeMetricsRequest, hasForwardingHeaders, isPrivateAddress } from './metrics-access';

const request = (over: Partial<Parameters<typeof authorizeMetricsRequest>[0]> = {}) => ({
  authorization: undefined,
  remoteAddress: '127.0.0.1',
  forwarded: false,
  ...over,
});

describe('isPrivateAddress', () => {
  it('knows loopback, RFC 1918, link-local and unique-local ranges', () => {
    for (const ok of [
      '127.0.0.1',
      '127.255.255.255',
      '10.0.0.1',
      '172.16.0.1',
      '172.31.255.254',
      '192.168.1.1',
      '169.254.0.1',
      '::1',
      'fc00::1',
      'fdff::1',
      'fe80::1',
      '::ffff:192.168.0.5',
    ]) {
      expect(isPrivateAddress(ok), ok).toBe(true);
    }
  });

  it('refuses public, malformed and missing addresses', () => {
    for (const bad of [
      '8.8.8.8',
      '172.15.0.1',
      '172.32.0.1',
      '192.169.0.1',
      '11.0.0.1',
      '2001:db8::1',
      '::ffff:8.8.8.8',
      '',
      'localhost',
      '10.0.0',
      '10.0.0.1/8',
      undefined,
    ]) {
      expect(isPrivateAddress(bad as string), String(bad)).toBe(false);
    }
  });
});

describe('authorizeMetricsRequest', () => {
  it('without a token: private callers only, and not through a proxy', () => {
    expect(authorizeMetricsRequest(request(), undefined)).toBe(true);
    expect(authorizeMetricsRequest(request({ remoteAddress: '8.8.8.8' }), undefined)).toBe(false);
    expect(authorizeMetricsRequest(request({ forwarded: true }), undefined)).toBe(false);
    expect(authorizeMetricsRequest(request({ remoteAddress: undefined }), undefined)).toBe(false);
  });

  it('with a token: the exact bearer token only, from any address', () => {
    const token = 'secret-token-123456';
    expect(
      authorizeMetricsRequest(request({ remoteAddress: '8.8.8.8', authorization: `Bearer ${token}` }), token),
    ).toBe(true);
    expect(authorizeMetricsRequest(request({ forwarded: true, authorization: `bearer ${token}` }), token)).toBe(true);
    expect(authorizeMetricsRequest(request(), token)).toBe(false);
    expect(authorizeMetricsRequest(request({ authorization: `Bearer ${token}0` }), token)).toBe(false);
    expect(authorizeMetricsRequest(request({ authorization: token }), token)).toBe(false);
    expect(authorizeMetricsRequest(request({ authorization: `Bearer ${token} extra` }), token)).toBe(false);
  });
});

describe('hasForwardingHeaders', () => {
  it('spots the usual proxy headers', () => {
    expect(hasForwardingHeaders({ 'x-forwarded-for': '1.2.3.4' })).toBe(true);
    expect(hasForwardingHeaders({ forwarded: 'for=1.2.3.4' })).toBe(true);
    expect(hasForwardingHeaders({ 'x-real-ip': '1.2.3.4' })).toBe(true);
    expect(hasForwardingHeaders({ host: 'example.com' })).toBe(false);
  });
});
