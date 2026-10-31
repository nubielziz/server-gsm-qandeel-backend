// A counting semaphore on the cache Redis (decision 021): at most N holders at a time, each holding a lease that expires.
// Used for the per-supplier `max_concurrency`. Both operations are single Lua scripts, so they are atomic.
import { randomUUID } from 'node:crypto';
import type { Redis } from 'ioredis';

/**
 * A held place in a semaphore.
 *
 * Why: release removes exactly this holder, and only if the lease is still ours, so a late release can never free a place
 * that was handed to someone else after expiry.
 */
export interface SemaphoreLease {
  /** The semaphore name given to `acquire`. */
  readonly name: string;
  /** The random id of this holder. */
  readonly token: string;
  /** The Redis key of the semaphore. */
  readonly key: string;
}

/**
 * Removes expired leases, then takes a place when fewer than `max` are held. The clock is Redis's (TIME), so processes
 * with different system clocks agree. The key lives at least as long as the longest lease.
 * KEYS[1] the sorted set (member = token, score = expiry in ms); ARGV: ttlMs, max, token.
 */
const ACQUIRE = `local time = redis.call('time')
local nowMs = time[1] * 1000 + math.floor(time[2] / 1000)
redis.call('zremrangebyscore', KEYS[1], '-inf', nowMs)
if redis.call('zcard', KEYS[1]) >= tonumber(ARGV[2]) then return 0 end
redis.call('zadd', KEYS[1], nowMs + tonumber(ARGV[1]), ARGV[3])
if redis.call('pttl', KEYS[1]) < tonumber(ARGV[1]) then redis.call('pexpire', KEYS[1], ARGV[1]) end
return 1`;

/**
 * Takes a place in a semaphore.
 *
 * Why: a supplier accepts only `max_concurrency` calls at once (decision 021); a lease that expires frees the place
 * even when the process holding it crashed.
 *
 * Side effects: writes the semaphore key (a sorted set) on the cache Redis.
 *
 * @param redis the cache client
 * @param key the semaphore key from `CacheKeys.semaphore`
 * @param name the semaphore name, kept in the lease
 * @param max the most holders at the same time (at least 1)
 * @param ttlMs how long a lease lasts; make it longer than the longest call it covers
 * @returns the lease, or `null` when all places are taken
 * @throws {RangeError} for a `max` or `ttlMs` that is not a positive integer
 * @throws {Error} when Redis fails; the caller decides (a dispatch job retries later)
 *
 * @see docs/decisions/021-rate-limiting.md
 */
export async function acquireSemaphore(
  redis: Redis,
  key: string,
  name: string,
  max: number,
  ttlMs: number,
): Promise<SemaphoreLease | null> {
  if (!Number.isInteger(max) || max < 1) throw new RangeError(`A semaphore needs max >= 1, got ${max}`);
  if (!Number.isInteger(ttlMs) || ttlMs < 1) throw new RangeError(`A lease needs ttlMs >= 1, got ${ttlMs}`);
  const token = randomUUID();
  const granted = await redis.eval(ACQUIRE, 1, key, String(ttlMs), String(max), token);
  return granted === 1 ? { name, token, key } : null;
}

/**
 * Gives a place back.
 *
 * Why: see {@link SemaphoreLease}. Releasing a lease that already expired is not an error.
 *
 * Side effects: removes the holder from the semaphore key.
 *
 * @param redis the cache client
 * @param lease the lease returned by {@link acquireSemaphore}
 * @returns resolves when the place is free
 * @throws {Error} when Redis fails (the lease then expires by itself)
 */
export async function releaseSemaphore(redis: Redis, lease: SemaphoreLease): Promise<void> {
  await redis.zrem(lease.key, lease.token);
}
