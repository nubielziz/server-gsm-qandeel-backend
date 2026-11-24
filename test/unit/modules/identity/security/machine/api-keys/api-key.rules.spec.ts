// Unit tests of the API key rules (decision 018, 064): the order of the checks (revoked, expired, suspended or blocked, not active, not a
// merchant rank, the network), the allowed IP ranges for IPv4 and IPv6, and how a refusal is worded on the Dhru surface.
import { describe, expect, it } from 'bun:test';
import { parseIpAddress } from '@src/common/ip-address';
import type { RankKind } from '@src/modules/identity';
import {
  type ApiKeyView,
  type StoredApiKey,
  apiKeyViewOf,
  checkApiKey,
  ipAllowedForKey,
  refusalFor,
} from '@src/modules/identity/security/machine/api-keys/api-key.rules';

const NOW = Date.UTC(2026, 10, 1, 12, 0, 0);
const address = parseIpAddress('203.0.113.9');
type Status = ApiKeyView['client']['status'];
const view = (
  over: Partial<ApiKeyView> = {},
  status: Status = 'active',
  rankKind: RankKind = 'merchant',
): ApiKeyView => ({
  id: 7,
  keyHash: 'h'.repeat(64),
  clientId: 3,
  allowedIps: [],
  rateLimitPerMin: 60,
  lastUsedAtMs: null,
  expiresAtMs: null,
  revokedAtMs: null,
  client: { username: 'acme', name: 'Acme Trading', status, rankKind },
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

  it('refuses a suspended or blocked account as suspended, and an erased one as not active, before looking at the network', () => {
    expect(check(view({ allowedIps: ['10.0.0.0/8'] }, 'suspended'))).toBe('suspended');
    expect(check(view({ allowedIps: ['10.0.0.0/8'] }, 'blocked'))).toBe('suspended');
    expect(check(view({ allowedIps: ['10.0.0.0/8'] }, 'anonymized'))).toBe('not_active');
  });

  it('refuses a status this code does not know as suspended, never as fine (the retired pending status included)', () => {
    const odd = (status: string) => view({}, status as Status);
    expect(check(odd('pending'))).toBe('suspended');
    expect(check(odd('something-new'))).toBe('suspended');
  });

  it('refuses a key of an account that is not of a merchant rank, after the status and before the network', () => {
    expect(check(view({}, 'active', 'retail'))).toBe('not_merchant');
    expect(check(view({ allowedIps: ['10.0.0.0/8'] }, 'active', 'retail'))).toBe('not_merchant');
    // The status is judged first: a suspended retail account is told apart from an active one only by the status reason.
    expect(check(view({}, 'suspended', 'retail'))).toBe('suspended');
    expect(check(view({}, 'anonymized', 'retail'))).toBe('not_active');
  });

  it('refuses a view that has no rank kind (an older cached shape): the check fails closed', () => {
    const stale = view();
    const { rankKind: _dropped, ...client } = stale.client;
    expect(check({ ...stale, client } as ApiKeyView)).toBe('not_merchant');
    expect(check({ ...stale, client: { ...client, rankKind: 'something' } } as unknown as ApiKeyView)).toBe(
      'not_merchant',
    );
  });

  it('puts the revoked and expired reasons before every account reason', () => {
    expect(check(view({ revokedAtMs: NOW - 1 }, 'active', 'retail'))).toBe('revoked');
    expect(check(view({ expiresAtMs: NOW - 1 }, 'suspended', 'retail'))).toBe('expired');
  });

  it('refuses an address outside the list', () => {
    expect(check(view({ allowedIps: ['10.0.0.0/8'] }))).toBe('ip_not_allowed');
    expect(check(view({ allowedIps: ['203.0.113.0/24'] }))).toBeUndefined();
  });
});

describe('apiKeyViewOf', () => {
  const stored = (over: Partial<StoredApiKey['client']> = {}): StoredApiKey => ({
    id: 7,
    keyHash: 'h'.repeat(64),
    clientId: 3,
    allowedIps: ['203.0.113.0/24'],
    rateLimitPerMin: 60,
    lastUsedAtMs: 5,
    expiresAtMs: null,
    revokedAtMs: null,
    client: { username: 'acme', name: 'Acme Trading', status: 'active', groupId: 12, ...over },
  });

  it('gives merchant rights to the stored kind b2b and to nothing else', () => {
    expect(apiKeyViewOf(stored(), 'b2b').client.rankKind).toBe('merchant');
    expect(apiKeyViewOf(stored(), 'b2c_retail').client.rankKind).toBe('retail');
    // A rank that cannot be read, or a kind this code never heard of, never opens the key: the check fails closed.
    expect(apiKeyViewOf(stored(), undefined).client.rankKind).toBe('retail');
    expect(apiKeyViewOf(stored(), '').client.rankKind).toBe('retail');
    expect(apiKeyViewOf(stored(), 'b2b-plus').client.rankKind).toBe('retail');
  });

  it('keeps every other field, drops the group id (it is not part of the cached view) and leaves the stored key alone', () => {
    const input = stored();
    const view = apiKeyViewOf(input, 'b2b');
    expect(view).toEqual({
      id: 7,
      keyHash: 'h'.repeat(64),
      clientId: 3,
      allowedIps: ['203.0.113.0/24'],
      rateLimitPerMin: 60,
      lastUsedAtMs: 5,
      expiresAtMs: null,
      revokedAtMs: null,
      client: { username: 'acme', name: 'Acme Trading', status: 'active', rankKind: 'merchant' },
    });
    expect(view.client).not.toHaveProperty('groupId');
    expect(input.client.groupId).toBe(12);
  });

  it('keeps a missing username as null, so the key matches no Dhru username', () => {
    expect(apiKeyViewOf(stored({ username: null }), 'b2c_retail').client.username).toBeNull();
  });

  it('feeds the checks: a key of a b2c_retail account is refused as not a merchant, one of a b2b account passes', () => {
    expect(check(apiKeyViewOf(stored(), 'b2b'))).toBeUndefined();
    expect(check(apiKeyViewOf(stored(), 'b2c_retail'))).toBe('not_merchant');
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

  it('uses ACCOUNT_SUSPENDED for a suspended merchant', () => {
    expect(refusalFor('suspended', address)).toMatchObject({ code: 'ACCOUNT_SUSPENDED', status: 403 });
  });

  it('words a key of an account that is not active, or not of a merchant rank, with the standard Dhru message and nothing more', () => {
    for (const reason of ['not_active', 'not_merchant'] as const) {
      expect(refusalFor(reason, address), reason).toMatchObject({
        code: 'UNAUTHORIZED',
        status: 401,
        detail: 'Authentication Failed',
      });
    }
  });
});
