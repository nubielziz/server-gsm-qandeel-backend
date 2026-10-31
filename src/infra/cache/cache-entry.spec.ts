// Unit tests of the cache entry envelope and the TTL jitter (decision 022).
import { describe, expect, it } from 'bun:test';
import {
  CacheValueTooLargeError,
  MAX_CACHED_VALUE_BYTES,
  TTL_JITTER_RATIO,
  decodeEntry,
  encodeEntry,
  jitterTtlMs,
} from './cache-entry';

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

describe('encodeEntry and decodeEntry', () => {
  it('round-trips JSON values with their freshness time', () => {
    for (const value of [{ a: 1, b: ['x', null], c: { d: true } }, [1, 2, 3], 'text', 42, 0, false, '']) {
      const entry = decodeEntry(encodeEntry(value, 123_456));
      expect(entry).toEqual({ value, negative: false, freshUntil: 123_456 });
    }
  });

  it('stores null and undefined as a negative entry', () => {
    for (const value of [null, undefined]) {
      const text = encodeEntry(value, 99);
      expect(decodeEntry(text)).toEqual({ value: null, negative: true, freshUntil: 99 });
    }
  });

  it('keeps a value that is falsy but real (0, false, empty string) apart from a negative entry', () => {
    expect(decodeEntry(encodeEntry(0, 1))?.negative).toBe(false);
    expect(decodeEntry(encodeEntry(false, 1))?.negative).toBe(false);
    expect(decodeEntry(encodeEntry('', 1))?.negative).toBe(false);
  });

  it('turns Dates into ISO strings, as JSON does', () => {
    const entry = decodeEntry(encodeEntry({ at: new Date('2026-10-31T10:00:00.000Z') }, 1));
    expect(entry?.value).toEqual({ at: '2026-10-31T10:00:00.000Z' });
  });

  it('accepts a value of exactly 100 KB and refuses one byte more', () => {
    const exact = 'x'.repeat(MAX_CACHED_VALUE_BYTES - 2); // two bytes for the JSON quotes
    expect(() => encodeEntry(exact, 1)).not.toThrow();
    const over = 'x'.repeat(MAX_CACHED_VALUE_BYTES - 1);
    expect(() => encodeEntry(over, 1)).toThrow(CacheValueTooLargeError);
    try {
      encodeEntry(over, 1);
    } catch (error) {
      expect((error as CacheValueTooLargeError).bytes).toBe(MAX_CACHED_VALUE_BYTES + 1);
      expect((error as CacheValueTooLargeError).limit).toBe(MAX_CACHED_VALUE_BYTES);
      expect((error as Error).message).not.toContain('xxxx');
    }
  });

  it('measures bytes, not characters', () => {
    const arabic = 'ع'.repeat(MAX_CACHED_VALUE_BYTES / 2); // 2 bytes each
    expect(() => encodeEntry(arabic, 1)).toThrow(CacheValueTooLargeError);
  });

  it('refuses values that have no JSON form', () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    for (const value of [() => 1, Symbol('x'), 10n, circular]) expect(() => encodeEntry(value, 1)).toThrow(TypeError);
  });

  it('reads garbage as "no entry" instead of throwing', () => {
    for (const text of ['', 'not json', '[]', '"x"', 'null', '{}', '{"f":"soon","v":1}', '{"v":1}', '{"f":5}']) {
      expect(decodeEntry(text), text).toBeUndefined();
    }
  });
});
