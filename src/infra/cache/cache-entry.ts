// What is stored under a cache key (decisions 022 and 055): the value, the time it stops being fresh and a seal that binds both
// to the key, plus the TTL jitter. Pure functions, unit-tested without Redis.
import { createHmac, hkdfSync, timingSafeEqual } from 'node:crypto';

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
 * An opened cache entry.
 *
 * Why: the entry carries the freshness time next to the value, which is what makes stale-while-revalidate possible
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
 * The format version of a sealed entry, its first field.
 *
 * Why: decision 055: a later format can be told from this one, and an entry of an earlier release (a JSON envelope) is unreadable.
 */
export const CACHE_ENTRY_VERSION = 'c1';

/**
 * The salt of the seal key's derivation.
 *
 * Why: decision 055: the seal key is derived from a server secret for this one use, so it is never the secret itself.
 */
export const CACHE_MAC_LABEL = 'gsm-cache-entry-mac';

/** The info text of the seal key's derivation (HKDF): which use the derived bytes serve. */
const CACHE_MAC_INFO = 'cache entry seal v1';

/** The two kinds of entry: a value, or "the source has nothing" (a negative entry). */
type EntryKind = 'v' | 'n';

/** `c1:<kind>:<freshUntil>:<seal>:`, the head of a sealed entry; the value's JSON follows it. */
const SEALED_HEAD = /^c1:([vn]):(\d{1,16}):([A-Za-z0-9_-]{43}):/;

/**
 * Derives the key that seals cache entries: HKDF-SHA256 over the secret, with {@link CACHE_MAC_LABEL} as the salt.
 *
 * Why: decision 055: the cache Redis is another process, so an entry is used only when the application sealed it. The key must never
 * equal a value the application writes into a key name: `HMAC(TOKEN_PEPPER, text)` is how credentials are hashed into the session and
 * API key cache keys, so the derivation is HKDF, which no credential hash can produce.
 *
 * @param secret the server secret (`TOKEN_PEPPER`)
 * @returns 32 bytes
 */
export function cacheMacKey(secret: string): Buffer {
  return Buffer.from(hkdfSync('sha256', secret, CACHE_MAC_LABEL, CACHE_MAC_INFO, 32));
}

/** HMAC-SHA256 over the version, the key, the kind and the freshness digits (one line each), then the payload. */
function sealOf(macKey: Uint8Array, key: string, kind: EntryKind, freshDigits: string, payload: string): Buffer {
  return createHmac('sha256', macKey)
    .update(`${CACHE_ENTRY_VERSION}\n${key}\n${kind}\n${freshDigits}\n`, 'utf8')
    .update(payload, 'utf8')
    .digest();
}

/**
 * Serialises and seals a value for one key: `c1:<kind>:<freshUntil>:<seal>:<value JSON>`.
 *
 * Why: decision 055: the seal (HMAC-SHA256, base64url) covers the format version, the key, the kind, the freshness time and the exact
 * JSON text, so an entry moved to another key, given another freshness time or changed in any byte is refused when it is opened.
 * Values are JSON (no class instances, no Dates: they come back as strings), so the cache never needs a schema. `null` and
 * `undefined` become a negative entry.
 *
 * @param macKey the seal key ({@link cacheMacKey})
 * @param key the cache key the entry is stored under
 * @param value the loaded value
 * @param freshUntil epoch milliseconds until which the entry is fresh
 * @returns the text to store
 * @throws {RangeError} when `freshUntil` is not a whole number from 0
 * @throws {CacheValueTooLargeError} when the JSON of the value exceeds {@link MAX_CACHED_VALUE_BYTES}
 * @throws {TypeError} when the value has no JSON form (a function, a symbol, a BigInt, a circular structure)
 */
export function sealEntry(macKey: Uint8Array, key: string, value: unknown, freshUntil: number): string {
  if (!Number.isSafeInteger(freshUntil) || freshUntil < 0) {
    throw new RangeError(
      `A cache entry's freshness time must be a whole number of milliseconds from 0, got ${freshUntil}`,
    );
  }
  let kind: EntryKind = 'n';
  let payload = '';
  if (value !== null && value !== undefined) {
    const json = JSON.stringify(value) as string | undefined;
    if (json === undefined) throw new TypeError('The value has no JSON form and cannot be cached.');
    const bytes = Buffer.byteLength(json);
    if (bytes > MAX_CACHED_VALUE_BYTES) throw new CacheValueTooLargeError(bytes, MAX_CACHED_VALUE_BYTES);
    kind = 'v';
    payload = json;
  }
  const digits = String(freshUntil);
  const seal = sealOf(macKey, key, kind, digits, payload).toString('base64url');
  return `${CACHE_ENTRY_VERSION}:${kind}:${digits}:${seal}:${payload}`;
}

/**
 * What {@link openEntry} found: the entry, `'unreadable'` for text that is not a sealed entry (garbage, an entry of an earlier
 * release), or `'forged'` for one whose seal does not match.
 */
export type OpenedEntry = CacheEntry | 'unreadable' | 'forged';

/**
 * Checks the seal of a stored entry and reads it.
 *
 * Why: decision 055: the cache Redis is another process; an entry the application did not write, or wrote for another key or another
 * freshness time, is never used. The seal is checked, in constant time, before anything of the value is parsed.
 *
 * @param macKey the seal key ({@link cacheMacKey})
 * @param key the cache key the text was read from
 * @param text what Redis returned
 * @returns the entry, `'unreadable'` or `'forged'`; either refusal is treated as a miss and the entry is overwritten
 */
export function openEntry(macKey: Uint8Array, key: string, text: string): OpenedEntry {
  const head = SEALED_HEAD.exec(text);
  if (!head) return 'unreadable';
  const kind = head[1] as EntryKind;
  const digits = head[2] as string;
  const payload = text.slice(head[0].length);
  const given = Buffer.from(head[3] as string, 'base64url');
  if (given.length !== 32) return 'forged';
  // The digit text itself is sealed, not a re-printed number: "0123" and "123" are different entries.
  if (!timingSafeEqual(given, sealOf(macKey, key, kind, digits, payload))) return 'forged';
  const freshUntil = Number(digits);
  if (!Number.isSafeInteger(freshUntil)) return 'unreadable';
  if (kind === 'n') return payload === '' ? { value: null, negative: true, freshUntil } : 'unreadable';
  try {
    return { value: JSON.parse(payload) as unknown, negative: false, freshUntil };
  } catch {
    return 'unreadable';
  }
}
