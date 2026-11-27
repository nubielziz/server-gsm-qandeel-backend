// Unit tests of the API key rules (B155): allowed addresses, the key text and the wire shape.
import { describe, expect, it } from 'bun:test';
import {
  API_KEY_LEADER,
  API_KEY_PREFIX_LENGTH,
  MAX_ALLOWED_IPS,
  type ApiKeyColumns,
  apiKeyToWire,
  checkAllowedIps,
  classifyKeyChange,
  composeApiKey,
  nextDefaultKeyName,
} from '@src/modules/identity/domain/api-key-input';

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
    allowedIps: ['203.0.113.55/32', '198.51.100.0/24', '2001:db8::1/128', '2001:db8::/32'],
    rateLimitPerMin: 60,
    lastUsedAt: null,
    lastUsedIp: null,
    expiresAt: null,
    revokedAt: null,
    createdAt: new Date('2026-10-01T08:00:00.000Z'),
    createdBy: null,
  };

  it('drops /32 and /128 of a single host, keeps ranges (an IPv6 /32 is a range), and sends "" for a key never used', () => {
    expect(apiKeyToWire(row)).toEqual({
      id: 7,
      clientId: 1,
      name: 'Production',
      prefix: 'gsm_Qx4f',
      allowedIps: ['203.0.113.55', '198.51.100.0/24', '2001:db8::1', '2001:db8::/32'],
      rateLimitPerMin: 60,
      lastUsedAt: null,
      lastUsedIp: '',
      expiresAt: null,
      revokedAt: null,
      createdAt: '2026-10-01T08:00:00.000Z',
      createdByStaff: false,
    });
  });

  it('says a key was made by staff when created_by is set, and not otherwise', () => {
    expect(apiKeyToWire({ ...row, createdBy: 3 }).createdByStaff).toBe(true);
    expect(apiKeyToWire(row).createdByStaff).toBe(false);
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

describe('classifyKeyChange', () => {
  const stored = { allowedIps: ['198.51.100.7/32', '203.0.113.9/32'], rateLimitPerMin: 60 };
  const open = { allowedIps: [], rateLimitPerMin: 60 };

  it('says none when nothing is sent or the sent values equal the stored ones, whatever the order of the addresses', () => {
    expect(classifyKeyChange(stored, {})).toBe('none');
    expect(classifyKeyChange(stored, { rateLimitPerMin: 60 })).toBe('none');
    expect(classifyKeyChange(stored, { allowedIps: ['203.0.113.9/32', '198.51.100.7/32'] })).toBe('none');
    expect(classifyKeyChange(open, { allowedIps: [] })).toBe('none');
  });

  it('says widens when the restriction is removed, an address is added or replaced, or the limit rises', () => {
    expect(classifyKeyChange(stored, { allowedIps: [] })).toBe('widens');
    expect(classifyKeyChange(stored, { allowedIps: [...stored.allowedIps, '192.0.2.1/32'] })).toBe('widens');
    expect(classifyKeyChange(stored, { allowedIps: ['192.0.2.1/32'] })).toBe('widens');
    expect(classifyKeyChange(stored, { allowedIps: ['198.51.100.7/32', '192.0.2.1/32'] })).toBe('widens');
    expect(classifyKeyChange(stored, { rateLimitPerMin: 61 })).toBe('widens');
    expect(classifyKeyChange(open, { rateLimitPerMin: 6000 })).toBe('widens');
  });

  it('says narrows when addresses are dropped or a restriction is added to an open key, or the limit falls', () => {
    expect(classifyKeyChange(stored, { allowedIps: ['198.51.100.7/32'] })).toBe('narrows');
    expect(classifyKeyChange(open, { allowedIps: ['198.51.100.7/32'] })).toBe('narrows');
    expect(classifyKeyChange(stored, { rateLimitPerMin: 59 })).toBe('narrows');
    expect(classifyKeyChange(stored, { rateLimitPerMin: 1, allowedIps: ['203.0.113.9/32'] })).toBe('narrows');
  });

  it('says widens when one part widens and the other narrows', () => {
    expect(classifyKeyChange(stored, { allowedIps: [], rateLimitPerMin: 1 })).toBe('widens');
    expect(classifyKeyChange(stored, { allowedIps: ['198.51.100.7/32'], rateLimitPerMin: 6000 })).toBe('widens');
  });

  it('does not treat a narrower range inside a stored range as a subset: only the same entries count', () => {
    const ranged = { allowedIps: ['198.51.100.0/24'], rateLimitPerMin: 60 };
    expect(classifyKeyChange(ranged, { allowedIps: ['198.51.100.7/32'] })).toBe('widens');
    expect(classifyKeyChange(ranged, { allowedIps: ['198.51.100.0/24'] })).toBe('none');
  });
});

describe('classifyKeyChange: the expiry (decision 078)', () => {
  const day = 86_400_000;
  const t0 = new Date('2026-11-01T10:00:00.000Z');
  const later = new Date(t0.getTime() + day);
  const earlier = new Date(t0.getTime() - day);
  const never = { allowedIps: ['198.51.100.7/32'], rateLimitPerMin: 60, expiresAt: null };
  const expiring = { allowedIps: ['198.51.100.7/32'], rateLimitPerMin: 60, expiresAt: t0 };

  it('says none when the expiry is not sent, is the stored time, or stays "never"', () => {
    expect(classifyKeyChange(never, {})).toBe('none');
    expect(classifyKeyChange(expiring, {})).toBe('none');
    expect(classifyKeyChange(expiring, { expiresAt: new Date(t0.getTime()) })).toBe('none');
    expect(classifyKeyChange(never, { expiresAt: null })).toBe('none');
    // A stored key without the property reads as "never".
    expect(classifyKeyChange({ allowedIps: [], rateLimitPerMin: 60 }, { expiresAt: null })).toBe('none');
  });

  it('says widens when the expiry is removed or moved later, also from a time that has passed', () => {
    expect(classifyKeyChange(expiring, { expiresAt: null })).toBe('widens');
    expect(classifyKeyChange(expiring, { expiresAt: later })).toBe('widens');
    expect(classifyKeyChange({ ...expiring, expiresAt: earlier }, { expiresAt: later })).toBe('widens');
  });

  it('says narrows when a key that never expired gets an expiry or the expiry moves earlier', () => {
    expect(classifyKeyChange(never, { expiresAt: later })).toBe('narrows');
    expect(classifyKeyChange(expiring, { expiresAt: earlier })).toBe('narrows');
  });

  it('lets a widening expiry win over a narrowing limit or list, and a narrowing expiry never hide a wider list', () => {
    expect(classifyKeyChange(expiring, { expiresAt: later, rateLimitPerMin: 1 })).toBe('widens');
    expect(classifyKeyChange(expiring, { expiresAt: earlier, allowedIps: [] })).toBe('widens');
    expect(classifyKeyChange(expiring, { expiresAt: earlier, rateLimitPerMin: 61 })).toBe('widens');
    expect(classifyKeyChange(expiring, { expiresAt: earlier, rateLimitPerMin: 30 })).toBe('narrows');
  });
});

describe('nextDefaultKeyName', () => {
  it('starts at API key 1 for an account with no key and for names that hold no number', () => {
    expect(nextDefaultKeyName([])).toBe('API key 1');
    expect(nextDefaultKeyName(['Production', 'Test key'])).toBe('API key 1');
  });

  it('takes the smallest whole number from 1 that no name holds in that exact form', () => {
    expect(nextDefaultKeyName(['API key 1'])).toBe('API key 2');
    expect(nextDefaultKeyName(['API key 1', 'API key 2', 'API key 4'])).toBe('API key 3');
    expect(nextDefaultKeyName(['API key 2', 'API key 3'])).toBe('API key 1');
    expect(nextDefaultKeyName(['API key 3', 'API key 1', 'API key 2'])).toBe('API key 4');
  });

  it('is not fooled by a number that only looks like one', () => {
    for (const lookalike of [
      'API key 0',
      'API key 01',
      'api key 1',
      'API key 1 ',
      'API key  1',
      'API key 1b',
      'API key',
      'API key -1',
      'API key 1.5',
      'X API key 1',
    ]) {
      expect(nextDefaultKeyName([lookalike])).toBe('API key 1');
    }
  });

  it('counts numbers past nine, and ignores one too long to be a plausible number', () => {
    const names = Array.from({ length: 12 }, (_, index) => `API key ${index + 1}`);
    expect(nextDefaultKeyName(names)).toBe('API key 13');
    expect(nextDefaultKeyName(['API key 9999999999999999999999'])).toBe('API key 1');
  });
});
