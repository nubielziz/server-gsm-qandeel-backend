// What is stored under a cache key (decision 022): a small JSON envelope with the value and the time it stops being
// fresh, plus the TTL jitter. Pure functions, unit-tested without Redis.

/**
 * The largest JSON value the cache accepts.
 *
 * Why: CLAUDE.md keeps values under about 100 KB; a bigger one is a sign that a list or a document belongs in the
 * database or in object storage, and it would slow every read of a shared Redis.
 */
export const MAX_CACHED_VALUE_BYTES = 100 * 1024;

/**
 * How far a TTL is spread around its nominal value (+-15 %).
 *
 * Why: entries written together would otherwise expire together and send a burst of loads to Postgres (decision 022).
 */
export const TTL_JITTER_RATIO = 0.15;

/**
 * Raised when a value is too large to cache.
 *
 * Why: a programming error that must show up in the first test run, not at 3 a.m. when a list has grown.
 */
export class CacheValueTooLargeError extends Error {
  constructor(
    readonly bytes: number,
    readonly limit: number,
  ) {
    super(`The value is ${bytes} bytes as JSON; the cache accepts at most ${limit}.`);
    this.name = 'CacheValueTooLargeError';
  }
}

/**
 * A decoded cache entry.
 *
 * Why: the envelope carries the freshness time next to the value, which is what makes stale-while-revalidate possible
 * (the key outlives the freshness by the stale window).
 */
export interface CacheEntry {
  /** The cached value; `null` for a negative entry. */
  readonly value: unknown;
  /** True when the entry records "the source has nothing" (short negative caching). */
  readonly negative: boolean;
  /** Epoch milliseconds until which the entry counts as fresh. */
  readonly freshUntil: number;
}

/**
 * Spreads a TTL by +-15 %.
 *
 * Why: see {@link TTL_JITTER_RATIO}.
 *
 * @param ttlSeconds the nominal TTL in seconds (may be fractional)
 * @param random a source of numbers in [0, 1), replaceable in tests
 * @returns the TTL in whole milliseconds, at least 1
 * @throws {RangeError} when the TTL is not a positive finite number
 */
export function jitterTtlMs(ttlSeconds: number, random: () => number = Math.random): number {
  if (!Number.isFinite(ttlSeconds) || ttlSeconds <= 0) {
    throw new RangeError(`A cache TTL must be a positive number of seconds, got ${ttlSeconds}`);
  }
  const factor = 1 + (random() * 2 - 1) * TTL_JITTER_RATIO;
  return Math.max(1, Math.round(ttlSeconds * 1000 * factor));
}

/**
 * Serialises a value and its freshness time.
 *
 * Why: values are JSON (no class instances, no Dates: they come back as strings), so the cache never needs a schema.
 * `null` and `undefined` become a negative entry.
 *
 * @param value the loaded value
 * @param freshUntil epoch milliseconds until which the entry is fresh
 * @returns the text to store
 * @throws {CacheValueTooLargeError} when the JSON of the value exceeds {@link MAX_CACHED_VALUE_BYTES}
 * @throws {TypeError} when the value has no JSON form (a function, a symbol, a BigInt, a circular structure)
 */
export function encodeEntry(value: unknown, freshUntil: number): string {
  if (value === null || value === undefined) return `{"n":1,"f":${freshUntil}}`;
  const json = JSON.stringify(value) as string | undefined;
  if (json === undefined) throw new TypeError('The value has no JSON form and cannot be cached.');
  const bytes = Buffer.byteLength(json);
  if (bytes > MAX_CACHED_VALUE_BYTES) throw new CacheValueTooLargeError(bytes, MAX_CACHED_VALUE_BYTES);
  return `{"v":${json},"f":${freshUntil}}`;
}

/**
 * Reads a stored envelope.
 *
 * @param text what Redis returned
 * @returns the entry, or `undefined` when the text is not one of ours (it is then treated as a miss and overwritten)
 */
export function decodeEntry(text: string): CacheEntry | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (typeof parsed !== 'object' || parsed === null) return undefined;
  const envelope = parsed as { v?: unknown; f?: unknown; n?: unknown };
  if (typeof envelope.f !== 'number') return undefined;
  if (envelope.n === 1) return { value: null, negative: true, freshUntil: envelope.f };
  if (!('v' in envelope)) return undefined;
  return { value: envelope.v, negative: false, freshUntil: envelope.f };
}
