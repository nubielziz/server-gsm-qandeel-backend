// Unit tests of the API key rules (B155): scopes, allowed addresses, the key text and the wire shape.
import { describe, expect, it } from 'bun:test';
import {
  API_KEY_LEADER,
  API_KEY_PREFIX_LENGTH,
  MAX_ALLOWED_IPS,
  type ApiKeyColumns,
  apiKeyToWire,
  checkAllowedIps,
  checkScopes,
  composeApiKey,
  scopeProblem,
} from './api-key-input';

describe('scopeProblem', () => {
  it('accepts the merchant scopes', () => {
    for (const scope of ['dhru', 'account:read', 'orders:read', 'orders:write', 'services:read']) {
      expect(scopeProblem(scope), scope).toBeUndefined();
    }
  });

  it('accepts the area wildcards of those scopes', () => {
    for (const scope of ['orders:*', 'account:*', 'services:*']) expect(scopeProblem(scope), scope).toBeUndefined();
  });

  it('refuses a scope outside the merchant list, a wildcard of another area, `*` and near misses', () => {
    for (const scope of [
      '*',
      '*:*',
      'staff:read',
      'wallet:*',
      'orders',
      'ORDERS:READ',
      'orders:create',
      'dhru:*',
      ' dhru',
      '',
    ]) {
      expect(scopeProblem(scope), JSON.stringify(scope)).toContain('Unknown scope');
    }
  });
});

describe('checkScopes', () => {
  it('keeps the order and drops repeats', () => {
    expect(checkScopes(['orders:read', 'dhru', 'orders:read'])).toEqual({ ok: true, value: ['orders:read', 'dhru'] });
  });

  it('names every refused scope by its position', () => {
    const result = checkScopes(['orders:read', 'staff:read', 'dhru', '*']);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors.map((error) => error.field)).toEqual(['scopes.1', 'scopes.3']);
  });
});

describe('checkAllowedIps', () => {
  it('stores a bare address with its host prefix and keeps a range as written', () => {
    expect(checkAllowedIps(['203.0.113.55', '198.51.100.0/24', '2001:db8::1'])).toEqual({
      ok: true,
      value: ['203.0.113.55/32', '198.51.100.0/24', '2001:db8::1/128'],
    });
  });

  it('drops repeats after normalising, so an address written twice in two spellings is one entry', () => {
    expect(checkAllowedIps(['203.0.113.55', '203.0.113.55/32'])).toEqual({ ok: true, value: ['203.0.113.55/32'] });
  });

  it('accepts an empty list: any address', () => {
    expect(checkAllowedIps([])).toEqual({ ok: true, value: [] });
  });

  it('refuses text that is not an address, host bits after the prefix and a range that is too wide', () => {
    const result = checkAllowedIps(['203.0.113.55', 'not-an-ip', '203.0.113.5/24', '10.0.0.0/8']);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.map((error) => error.field)).toEqual(['allowedIps.1', 'allowedIps.2', 'allowedIps.3']);
      expect(result.errors[1]?.message).toContain('203.0.113.0/24');
    }
  });

  it('is a known limit that a key lists at most 20 addresses (the contract enforces it)', () => {
    expect(MAX_ALLOWED_IPS).toBe(20);
  });
});

describe('composeApiKey', () => {
  it('starts with the leader and keeps the first 8 characters as the prefix', () => {
    const { key, prefix } = composeApiKey('Qx4fD0nQ2hX8mV3vT9cKzY6bJ1aW5eRuLs7NpG4HtM0');
    expect(key.startsWith(API_KEY_LEADER)).toBe(true);
    expect(prefix).toBe(key.slice(0, API_KEY_PREFIX_LENGTH));
    expect(prefix).toBe('gsm_Qx4f');
  });
});

describe('apiKeyToWire', () => {
  const row: ApiKeyColumns = {
    id: 7,
    clientId: 1,
    name: 'Production',
    prefix: 'gsm_Qx4f',
    scopes: ['orders:read'],
    allowedIps: ['203.0.113.55/32', '198.51.100.0/24', '2001:db8::1/128', '2001:db8::/32'],
    rateLimitPerMin: 60,
    lastUsedAt: null,
    lastUsedIp: null,
    expiresAt: null,
    revokedAt: null,
    createdAt: new Date('2026-10-01T08:00:00.000Z'),
  };

  it('drops /32 and /128 of a single host, keeps ranges (an IPv6 /32 is a range), and sends "" for a key never used', () => {
    expect(apiKeyToWire(row)).toEqual({
      id: 7,
      clientId: 1,
      name: 'Production',
      prefix: 'gsm_Qx4f',
      scopes: ['orders:read'],
      allowedIps: ['203.0.113.55', '198.51.100.0/24', '2001:db8::1', '2001:db8::/32'],
      rateLimitPerMin: 60,
      lastUsedAt: null,
      lastUsedIp: '',
      expiresAt: null,
      revokedAt: null,
      createdAt: '2026-10-01T08:00:00.000Z',
    });
  });

  it('writes times as ISO text and keeps the last address of a used key', () => {
    const wire = apiKeyToWire({
      ...row,
      lastUsedAt: new Date('2026-11-01T09:30:00.000Z'),
      lastUsedIp: '203.0.113.55',
      revokedAt: new Date('2026-11-02T00:00:00.000Z'),
    });
    expect(wire.lastUsedAt).toBe('2026-11-01T09:30:00.000Z');
    expect(wire.lastUsedIp).toBe('203.0.113.55');
    expect(wire.revokedAt).toBe('2026-11-02T00:00:00.000Z');
  });
});
