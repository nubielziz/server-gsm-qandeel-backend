// Unit tests of the sealed cache entry and the TTL jitter (decisions 022 and 055).
import { describe, expect, it } from 'bun:test';
import { createHmac } from 'node:crypto';
import {
  CACHE_ENTRY_VERSION,
  CACHE_MAC_LABEL,
  type CacheEntry,
  CacheValueTooLargeError,
  MAX_CACHED_VALUE_BYTES,
  TTL_JITTER_RATIO,
  cacheMacKey,
  jitterTtlMs,
  openEntry,
  sealEntry,
} from '@src/infra/cache/cache-entry';
import { hashToken } from '@src/infra/crypto/tokens';

const SECRET = 'a server secret of at least thirty-two characters';
const MAC = cacheMacKey(SECRET);
const KEY = 'gsm:test:infra:test:one';

/** Seals and opens in one step; the test fails when the entry is refused. */
function roundTrip(value: unknown, freshUntil: number): CacheEntry {
  const opened = openEntry(MAC, KEY, sealEntry(MAC, KEY, value, freshUntil));
  if (typeof opened === 'string') throw new Error(`the entry was ${opened}`);
  return opened;
}

describe('jitterTtlMs', () => {
  it('spreads the TTL by +-15 %: the lowest draw gives 85 %, the middle 100 %, the highest draw 115 %', () => {
    expect(TTL_JITTER_RATIO).toBe(0.15);
    expect(jitterTtlMs(100, () => 0)).toBe(85_000);
    expect(jitterTtlMs(100, () => 0.5)).toBe(100_000);
    expect(jitterTtlMs(100, () => 0.999999999)).toBe(115_000);
  });

  it('stays inside the band for any random draw', () => {
    for (let i = 0; i < 2000; i++) {
      const ms = jitterTtlMs(60);
      expect(ms).toBeGreaterThanOrEqual(51_000);
      expect(ms).toBeLessThanOrEqual(69_000);
    }
  });

  it('actually spreads the values, so entries written together do not expire together', () => {
    const distinct = new Set(Array.from({ length: 200 }, () => jitterTtlMs(60)));
    expect(distinct.size).toBeGreaterThan(100);
  });

  it('returns whole milliseconds, at least 1, and accepts fractional seconds', () => {
    expect(Number.isInteger(jitterTtlMs(0.333))).toBe(true);
    expect(jitterTtlMs(0.0001, () => 0)).toBe(1);
    expect(jitterTtlMs(0.2, () => 0.5)).toBe(200);
  });

  it('refuses a TTL that is not a positive finite number', () => {
    for (const ttl of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => jitterTtlMs(ttl), String(ttl)).toThrow(RangeError);
    }
  });
});

describe('sealEntry and openEntry (decision 055)', () => {
  it('seals and opens JSON values with their freshness time', () => {
    for (const value of [{ a: 1, b: ['x', null], c: { d: true } }, [1, 2, 3], 'text', 42, 0, false, '']) {
      expect(roundTrip(value, 123_456)).toEqual({ value, negative: false, freshUntil: 123_456 });
    }
    const text = sealEntry(MAC, KEY, { a: 1 }, 99);
    expect(text.startsWith(`${CACHE_ENTRY_VERSION}:v:99:`)).toBe(true);
    expect(text.endsWith(':{"a":1}')).toBe(true);
  });

  it('stores null and undefined as a negative entry', () => {
    for (const value of [null, undefined]) {
      const text = sealEntry(MAC, KEY, value, 99);
      expect(text.startsWith('c1:n:99:')).toBe(true);
      expect(openEntry(MAC, KEY, text)).toEqual({ value: null, negative: true, freshUntil: 99 });
    }
  });

  it('keeps falsy real values (0, false, empty string) apart from a negative entry', () => {
    expect(roundTrip(0, 1).negative).toBe(false);
    expect(roundTrip(false, 1).negative).toBe(false);
    expect(roundTrip('', 1).negative).toBe(false);
  });

  it('turns Dates into ISO strings, as JSON does', () => {
    expect(roundTrip({ at: new Date('2026-10-31T10:00:00.000Z') }, 1).value).toEqual({
      at: '2026-10-31T10:00:00.000Z',
    });
  });

  it('accepts a value of exactly 100 KB and refuses one byte more', () => {
    const exact = 'x'.repeat(MAX_CACHED_VALUE_BYTES - 2); // two bytes for the JSON quotes
    expect(() => sealEntry(MAC, KEY, exact, 1)).not.toThrow();
    const over = 'x'.repeat(MAX_CACHED_VALUE_BYTES - 1);
    expect(() => sealEntry(MAC, KEY, over, 1)).toThrow(CacheValueTooLargeError);
    try {
      sealEntry(MAC, KEY, over, 1);
    } catch (error) {
      expect((error as CacheValueTooLargeError).bytes).toBe(MAX_CACHED_VALUE_BYTES + 1);
      expect((error as CacheValueTooLargeError).limit).toBe(MAX_CACHED_VALUE_BYTES);
      expect((error as Error).message).not.toContain('xxxx');
    }
  });

  it('measures bytes, not characters', () => {
    const arabic = 'ع'.repeat(MAX_CACHED_VALUE_BYTES / 2); // 2 bytes each
    expect(() => sealEntry(MAC, KEY, arabic, 1)).toThrow(CacheValueTooLargeError);
  });

  it('refuses values that have no JSON form, and a freshness time that is not a whole number from 0', () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    for (const value of [() => 1, Symbol('x'), 10n, circular])
      expect(() => sealEntry(MAC, KEY, value, 1)).toThrow(TypeError);
    for (const freshUntil of [-1, 1.5, Number.NaN, Number.MAX_SAFE_INTEGER + 2]) {
      expect(() => sealEntry(MAC, KEY, 'v', freshUntil), String(freshUntil)).toThrow(RangeError);
    }
  });

  it('reads garbage and the previous JSON envelope as unreadable', () => {
    for (const text of [
      '',
      'not json',
      '[]',
      'null',
      '{"v":1,"f":9999999999999}',
      '{"n":1,"f":9999999999999}',
      'c1:v:1:short:1',
      'c2:v:1:' + 'A'.repeat(43) + ':1',
      'c1:x:1:' + 'A'.repeat(43) + ':1',
    ]) {
      expect(openEntry(MAC, KEY, text), text).toBe('unreadable');
    }
  });

  it('refuses an entry sealed with another key', () => {
    const text = sealEntry(
      cacheMacKey('another secret of at least thirty-two characters'),
      KEY,
      { role: '*' },
      9_999_999_999_999,
    );
    expect(openEntry(MAC, KEY, text)).toBe('forged');
  });

  it('refuses an entry moved to another cache key', () => {
    const text = sealEntry(MAC, KEY, { staffId: 1 }, 9_999_999_999_999);
    expect(openEntry(MAC, `${KEY}-other`, text)).toBe('forged');
  });

  it('refuses an entry whose freshness time, kind or value was changed after sealing', () => {
    const text = sealEntry(MAC, KEY, { staffId: 1 }, 1_000);
    const [version, kind, fresh, seal] = text.split(':') as [string, string, string, string];
    const payload = text.slice(`${version}:${kind}:${fresh}:${seal}:`.length);
    expect(openEntry(MAC, KEY, `c1:v:9999999999999:${seal}:${payload}`), 'freshness').toBe('forged');
    expect(openEntry(MAC, KEY, `c1:v:01000:${seal}:${payload}`), 'the same time, written with a leading zero').toBe(
      'forged',
    );
    expect(openEntry(MAC, KEY, `c1:n:1000:${seal}:`), 'kind').toBe('forged');
    expect(openEntry(MAC, KEY, `c1:v:1000:${seal}:{"staffId":2}`), 'value').toBe('forged');
  });

  it('checks the seal before it parses the value', () => {
    // A payload that is not JSON, sealed by the application: the seal holds, so the parse decides.
    const digits = '1000';
    const payload = '{not json';
    const seal = createHmac('sha256', MAC)
      .update(`c1\n${KEY}\nv\n${digits}\n`, 'utf8')
      .update(payload, 'utf8')
      .digest('base64url');
    expect(openEntry(MAC, KEY, `c1:v:${digits}:${seal}:${payload}`)).toBe('unreadable');
    // The same text with one seal character changed is refused before the payload is read.
    const changed = (seal[0] === 'A' ? 'B' : 'A') + seal.slice(1);
    expect(openEntry(MAC, KEY, `c1:v:${digits}:${changed}:${payload}`)).toBe('forged');
  });

  it('derives a 32-byte key from a secret, different per secret and different from the secret', () => {
    const key = cacheMacKey(SECRET);
    expect(key.length).toBe(32);
    expect(key.equals(cacheMacKey(SECRET))).toBe(true);
    expect(key.equals(cacheMacKey(`${SECRET}!`))).toBe(false);
    expect(key.toString('utf8')).not.toContain(SECRET);
    expect(key.equals(Buffer.from(SECRET).subarray(0, 32))).toBe(false);
  });

  it('never equals a credential hash the application writes into a key name', () => {
    // Session and API key cache keys carry HMAC(TOKEN_PEPPER, presented text); the seal key must never be one of them.
    const hex = cacheMacKey(SECRET).toString('hex');
    expect(hex).not.toBe(hashToken(SECRET, CACHE_MAC_LABEL));
    expect(hex).not.toBe(hashToken(SECRET, 'cache entry seal v1'));
    expect(hex).not.toBe(createHmac('sha256', CACHE_MAC_LABEL).update(SECRET).digest('hex'));
  });
});
