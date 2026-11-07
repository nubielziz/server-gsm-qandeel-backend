// Unit tests of the API key rules (decision 018): the order of the checks, the allowed IP ranges for IPv4 and IPv6, and how a
// refusal is worded on REST v1 and on the Dhru surface.
import { describe, expect, it } from 'bun:test';
import { parseIpAddress } from '../../../../../common/ip-address';
import { type ApiKeyView, checkApiKey, ipAllowedForKey, refusalFor, scopeCovered } from './api-key.rules';

const NOW = Date.UTC(2026, 10, 1, 12, 0, 0);
const address = parseIpAddress('203.0.113.9');
const view = (over: Partial<ApiKeyView> = {}, status: 'active' | 'suspended' | 'pending' = 'active'): ApiKeyView => ({
  id: 7,
  keyHash: 'h'.repeat(64),
  clientId: 3,
  scopes: ['orders:read', 'dhru'],
  allowedIps: [],
  rateLimitPerMin: 60,
  lastUsedAtMs: null,
  expiresAtMs: null,
  revokedAtMs: null,
  client: { username: 'acme', status },
  ...over,
});
const check = (v: ApiKeyView, scope = 'orders:read') => checkApiKey(v, { nowMs: NOW, address, scope });

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
  it('passes a live key of an active merchant that lists the scope', () => {
    expect(check(view())).toBeUndefined();
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

  it('refuses a suspended merchant, and a merchant that is not approved, before looking at the network or the scope', () => {
    expect(check(view({ allowedIps: ['10.0.0.0/8'], scopes: [] }, 'suspended'))).toBe('suspended');
    expect(check(view({}, 'pending'))).toBe('not_active');
  });

  it('refuses an address outside the list, then a missing scope', () => {
    expect(check(view({ allowedIps: ['10.0.0.0/8'], scopes: [] }))).toBe('ip_not_allowed');
    expect(check(view({ scopes: ['orders:write'] }))).toBe('missing_scope');
  });

  it('lets a scope `area:*` cover every action of its area', () => {
    expect(check(view({ scopes: ['orders:*'] }), 'orders:read')).toBeUndefined();
    expect(check(view({ scopes: ['orders:*'] }), 'orders:write')).toBeUndefined();
    expect(check(view({ scopes: ['wallet:*'] }), 'orders:write')).toBe('missing_scope');
    expect(check(view({ scopes: ['order:*'] }), 'orders:write')).toBe('missing_scope');
  });

  it('lets the scope `*` (and its spelling `*:*`) cover every REST v1 permission', () => {
    expect(check(view({ scopes: ['*'] }), 'orders:write')).toBeUndefined();
    expect(check(view({ scopes: ['*'] }), 'wallet:read')).toBeUndefined();
    expect(check(view({ scopes: ['*:*'] }), 'orders:write')).toBeUndefined();
  });

  it('does not cover a permission with a narrower scope, another case, a prefix, or a trailing space', () => {
    for (const scopes of [
      ['orders:read'],
      ['orders'],
      ['Orders:Read'],
      ['ORDERS:WRITE'],
      ['orders:write '],
      ['orders:*x'],
      [],
    ]) {
      expect(check(view({ scopes }), 'orders:write'), JSON.stringify(scopes)).toBe('missing_scope');
    }
    expect(check(view({ scopes: ['orders:write'] }), 'orders:write')).toBeUndefined();
  });

  it('matches the Dhru scope exactly: no wildcard opens the Dhru surface', () => {
    expect(check(view({ scopes: ['dhru'] }), 'dhru')).toBeUndefined();
    for (const scopes of [['*'], ['*:*'], ['dhru:*'], ['Dhru'], ['orders:*'], []]) {
      expect(check(view({ scopes }), 'dhru'), JSON.stringify(scopes)).toBe('missing_scope');
    }
  });

  it('covers no key when the route has no scope, not even `*`', () => {
    expect(check(view({ scopes: ['*'] }), '')).toBe('missing_scope');
    expect(scopeCovered(['*'], '')).toBe(false);
  });
});

describe('refusalFor', () => {
  it('words a credential that is not accepted as 401, and with the standard message on the Dhru surface', () => {
    for (const reason of ['unauthenticated', 'revoked', 'expired'] as const) {
      expect(refusalFor(reason, 'v1', address, 'orders:read'), reason).toMatchObject({
        code: 'UNAUTHORIZED',
        status: 401,
      });
      expect(refusalFor(reason, 'dhru', address, 'dhru'), reason).toMatchObject({
        code: 'UNAUTHORIZED',
        detail: 'Authentication Failed',
      });
    }
    expect(refusalFor('unauthenticated', 'v1', address, 'orders:read').detail).toBeUndefined();
  });

  it('tells apart a revoked key from an unknown one only in words a thief learns nothing from', () => {
    expect(refusalFor('revoked', 'v1', address, 'orders:read').detail).toBe(
      refusalFor('expired', 'v1', address, 'x').detail,
    );
  });

  it('names the address and the scope once the key is proven', () => {
    expect(refusalFor('ip_not_allowed', 'v1', address, 'orders:read')).toMatchObject({
      code: 'IP_NOT_ALLOWED',
      status: 403,
      detail: expect.stringContaining('203.0.113.9') as unknown,
    });
    expect(refusalFor('ip_not_allowed', 'v1', undefined, 'orders:read').detail).toContain('Your network address');
    expect(refusalFor('missing_scope', 'v1', address, 'orders:write')).toMatchObject({
      code: 'FORBIDDEN',
      detail: 'This API key does not have the orders:write permission.',
    });
    expect(refusalFor('missing_scope', 'dhru', address, 'dhru').detail).toBe(
      'This API key cannot be used with the Dhru API.',
    );
  });

  it('uses ACCOUNT_SUSPENDED for a suspended merchant and ACCOUNT_PENDING_APPROVAL for one that is not approved (B153)', () => {
    expect(refusalFor('suspended', 'v1', address, 'x')).toMatchObject({ code: 'ACCOUNT_SUSPENDED', status: 403 });
    for (const surface of ['v1', 'dhru'] as const) {
      expect(refusalFor('not_active', surface, address, 'x')).toMatchObject({
        code: 'ACCOUNT_PENDING_APPROVAL',
        status: 403,
        detail: 'This merchant account has not been approved yet.',
      });
    }
  });
});
