// Unit tests of the API key rules (decision 018): the order of the checks, the allowed IP ranges for IPv4 and IPv6, and how a
// refusal is worded on the Dhru surface.
import { describe, expect, it } from 'bun:test';
import { parseIpAddress } from '@src/common/ip-address';
import {
  type ApiKeyView,
  checkApiKey,
  ipAllowedForKey,
  refusalFor,
} from '@src/modules/identity/security/machine/api-keys/api-key.rules';

const NOW = Date.UTC(2026, 10, 1, 12, 0, 0);
const address = parseIpAddress('203.0.113.9');
const view = (over: Partial<ApiKeyView> = {}, status: 'active' | 'suspended' | 'pending' = 'active'): ApiKeyView => ({
  id: 7,
  keyHash: 'h'.repeat(64),
  clientId: 3,
  allowedIps: [],
  rateLimitPerMin: 60,
  lastUsedAtMs: null,
  expiresAtMs: null,
  revokedAtMs: null,
  client: { username: 'acme', name: 'Acme Trading', status },
  ...over,
});
const check = (v: ApiKeyView) => checkApiKey(v, { nowMs: NOW, address });

describe('ipAllowedForKey', () => {
  it('lets any address use a key with no list', () => {
    expect(ipAllowedForKey([], address)).toBe(true);
    expect(ipAllowedForKey([], undefined)).toBe(true);
  });

  it('matches single addresses and CIDR ranges, IPv4 and IPv6', () => {
    expect(ipAllowedForKey(['203.0.113.9'], address)).toBe(true);
    expect(ipAllowedForKey(['203.0.113.0/24'], address)).toBe(true);
    expect(ipAllowedForKey(['203.0.112.0/24'], address)).toBe(false);
    expect(ipAllowedForKey(['198.51.100.1', '203.0.113.8/29'], address)).toBe(true);
    const v6 = parseIpAddress('2001:db8:1:2::5');
    expect(ipAllowedForKey(['2001:db8:1::/48'], v6)).toBe(true);
    expect(ipAllowedForKey(['2001:db8:2::/48'], v6)).toBe(false);
    expect(ipAllowedForKey(['2001:db8:1:2::5/128'], v6)).toBe(true);
  });

  it('never matches an address of the other family, and treats an IPv4-mapped IPv6 address as its IPv4 address', () => {
    expect(ipAllowedForKey(['2001:db8::/32'], address)).toBe(false);
    expect(ipAllowedForKey(['203.0.113.0/24'], parseIpAddress('2001:db8::1'))).toBe(false);
    expect(ipAllowedForKey(['203.0.113.0/24'], parseIpAddress('::ffff:203.0.113.77'))).toBe(true);
  });

  it('refuses when the address is unknown or when no entry of the list can be read (a broken list does not open the key)', () => {
    expect(ipAllowedForKey(['203.0.113.0/24'], undefined)).toBe(false);
    expect(ipAllowedForKey(['not-an-address', '203.0.113.0/99', ''], address)).toBe(false);
    expect(ipAllowedForKey(['not-an-address', '203.0.113.0/24'], address)).toBe(true);
  });
});

describe('checkApiKey', () => {
  it('passes a live key of an active merchant, whatever scopes an old row still holds', () => {
    expect(check(view())).toBeUndefined();
    expect(check({ ...view(), scopes: ['orders:read'] } as ApiKeyView)).toBeUndefined();
  });

  it('refuses a revoked key before anything else', () => {
    expect(check(view({ revokedAtMs: NOW - 1, expiresAtMs: NOW - 1, allowedIps: ['10.0.0.0/8'] }, 'suspended'))).toBe(
      'revoked',
    );
  });

  it('refuses a key at the moment it expires, not before', () => {
    expect(check(view({ expiresAtMs: NOW }))).toBe('expired');
    expect(check(view({ expiresAtMs: NOW - 1 }))).toBe('expired');
    expect(check(view({ expiresAtMs: NOW + 1 }))).toBeUndefined();
  });

  it('refuses a suspended merchant, and a merchant that is not approved, before looking at the network', () => {
    expect(check(view({ allowedIps: ['10.0.0.0/8'] }, 'suspended'))).toBe('suspended');
    expect(check(view({}, 'pending'))).toBe('not_active');
  });

  it('refuses an address outside the list', () => {
    expect(check(view({ allowedIps: ['10.0.0.0/8'] }))).toBe('ip_not_allowed');
    expect(check(view({ allowedIps: ['203.0.113.0/24'] }))).toBeUndefined();
  });
});

describe('refusalFor', () => {
  it('words a credential that is not accepted with the standard Dhru message', () => {
    for (const reason of ['unauthenticated', 'revoked', 'expired'] as const) {
      expect(refusalFor(reason, address), reason).toMatchObject({
        code: 'UNAUTHORIZED',
        detail: 'Authentication Failed',
      });
    }
  });

  it('names the address once the key is proven', () => {
    expect(refusalFor('ip_not_allowed', address)).toMatchObject({
      code: 'IP_NOT_ALLOWED',
      status: 403,
      detail: expect.stringContaining('203.0.113.9') as unknown,
    });
    expect(refusalFor('ip_not_allowed', undefined).detail).toContain('Your network address');
  });

  it('uses ACCOUNT_SUSPENDED for a suspended merchant and ACCOUNT_PENDING_APPROVAL for one that is not approved (B153)', () => {
    expect(refusalFor('suspended', address)).toMatchObject({ code: 'ACCOUNT_SUSPENDED', status: 403 });
    expect(refusalFor('not_active', address)).toMatchObject({
      code: 'ACCOUNT_PENDING_APPROVAL',
      status: 403,
      detail: 'This merchant account has not been approved yet.',
    });
  });
});
