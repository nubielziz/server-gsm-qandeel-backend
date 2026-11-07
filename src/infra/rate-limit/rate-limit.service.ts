// Rate limiting on the cache Redis (decision 021): named limiters from limiters.ts through rate-limiter-flexible, a helper
// that throws RATE_LIMITED with Retry-After, and a Redis semaphore for per-supplier concurrency.
import { createHash } from 'node:crypto';
import { Injectable, Logger } from '@nestjs/common';
import { Counter } from 'prom-client';
import { RateLimiterMemory, RateLimiterRedis, RateLimiterRes } from 'rate-limiter-flexible';
import { AppError } from '../../common/errors';
import { CacheKeys } from '../cache';
import { MetricsService } from '../metrics';
import { RedisService } from '../redis';
import { type LimiterName, RATE_LIMITERS } from './limiters';
import { type SemaphoreLease, acquireSemaphore, releaseSemaphore } from './semaphore';

/**
 * The answer of one rate-limit check.
 *
 * Why: the caller needs the numbers for the `Retry-After` header (and, for the API surfaces, rate-limit headers).
 */
export interface RateLimitResult {
  /** False when the budget is used up (or the key is locked out). */
  readonly allowed: boolean;
  /** Points left in the window after this call (0 when refused). */
  readonly remaining: number;
  /** Points per window that applied to this call. */
  readonly limit: number;
  /** Seconds until the key may try again; 0 when allowed, at least 1 when refused. */
  readonly retryAfterSeconds: number;
  /** Seconds until the window ends and the counter starts over (the `RateLimit-Reset` header of REST v1); at least 1. */
  readonly resetSeconds: number;
}

/** Options of a rate-limit call. */
export interface RateLimitOptions {
  /** Replaces the limiter's points for this key: `api_keys.rate_limit_per_min`, `suppliers.rate_limit_per_min`. */
  readonly limit?: number;
}

/** The most limiter instances kept (one per limiter and distinct per-key limit); the map restarts when it is full. */
const MAX_LIMITER_INSTANCES = 500;
const MAX_KEY_LENGTH = 256;

/**
 * Builds the `429 RATE_LIMITED` error with its `Retry-After`.
 *
 * Why: the console reads `Retry-After` on every 429 (ALIGNMENT § 6); the exception filter turns `retryAfterSeconds` into
 * the header, so every limiter refuses in the same way.
 *
 * @param retryAfterSeconds seconds until the caller may try again (at least 1)
 * @returns the error to throw
 */
export function rateLimitedError(retryAfterSeconds: number): AppError {
  const seconds = Math.max(1, Math.ceil(retryAfterSeconds));
  return new AppError('RATE_LIMITED', {
    detail: `Too many requests. Try again in ${seconds} second${seconds === 1 ? '' : 's'}.`,
    retryAfterSeconds: seconds,
  });
}

/**
 * Named rate limiters and a concurrency semaphore on the cache Redis.
 *
 * Why: decision 021 gives every kind of traffic its own budget and keeps counts consistent across API instances.
 * Counters live on the cache Redis: if an entry is evicted a limit loosens briefly, nothing here is a source of truth.
 * While Redis is down each process falls back to an in-memory limiter with the same numbers, so limits (and sign-in
 * lock-outs) keep working per instance instead of switching off.
 *
 * Side effects: counter keys `gsm:{env}:ratelimit:{limiter}:{key}` and semaphore keys on the cache Redis, with TTLs;
 * `rate_limit_denied_total{limiter}` counts refusals.
 *
 * @see docs/decisions/021-rate-limiting.md
 */
@Injectable()
export class RateLimitService {
  private readonly logger = new Logger(RateLimitService.name);
  private readonly limiters = new Map<string, RateLimiterRedis>();
  private readonly denied: Counter<'limiter'>;

  constructor(
    private readonly redis: RedisService,
    private readonly keys: CacheKeys,
    metrics: MetricsService,
  ) {
    this.denied = new Counter({
      name: 'rate_limit_denied_total',
      help: 'Calls refused by a rate limiter, by limiter name.',
      labelNames: ['limiter'],
      registers: [metrics.registry],
    });
  }

  /**
   * Builds a key from several parts, hashed, for limiters whose natural key holds personal data (email + IP).
   *
   * Why: Redis keys are visible to anyone with access to the instance and to monitoring; an email address must not be
   * one. The parts are lower-cased and trimmed, so `Rami@x.com` and `rami@x.com ` share a budget.
   *
   * @param parts the pieces that identify the caller, for example the email and the IP
   * @returns a 32-character hex key
   */
  static compositeKey(...parts: string[]): string {
    const normalised = parts.map((part) => part.trim().toLowerCase()).join('\u0000');
    return createHash('sha256').update(normalised).digest('hex').slice(0, 32);
  }

  /**
   * Counts a call against a limiter and says whether it may proceed.
   *
   * Why: decision 021. The caller decides what a refusal means (a 429, a delayed job).
   *
   * Side effects: adds `points` to the counter of `key` in the limiter's window; may start a lock-out.
   *
   * @param name the limiter
   * @param key who is being limited (an IP, an API key id, a supplier id, or `compositeKey(...)`)
   * @param points how many points this call costs
   * @param options a per-key limit that replaces the limiter's points
   * @returns the decision
   * @throws {RangeError} for an empty or oversize key, or points/limit that are not positive integers
   */
  async consume(name: LimiterName, key: string, points = 1, options: RateLimitOptions = {}): Promise<RateLimitResult> {
    this.assertInput(key, points, options);
    const limit = options.limit ?? RATE_LIMITERS[name].points;
    try {
      const result = await this.limiterFor(name, limit).consume(key, points);
      return {
        allowed: true,
        remaining: result.remainingPoints,
        limit,
        retryAfterSeconds: 0,
        resetSeconds: Math.max(1, Math.ceil(result.msBeforeNext / 1000)),
      };
    } catch (rejection) {
      // The library rejects with a RateLimiterRes when the budget is used up, and with an Error for anything else.
      if (!(rejection instanceof RateLimiterRes)) throw rejection;
      this.denied.inc({ limiter: name });
      const seconds = Math.max(1, Math.ceil(rejection.msBeforeNext / 1000));
      return { allowed: false, remaining: 0, limit, retryAfterSeconds: seconds, resetSeconds: seconds };
    }
  }

  /**
   * Counts a call and throws `429 RATE_LIMITED` (with `Retry-After`) when it is refused.
   *
   * Why: guards and use cases refuse in one line, the same way everywhere (decision 021, ALIGNMENT § 6).
   *
   * Side effects: see {@link RateLimitService.consume}.
   *
   * @param name the limiter
   * @param key who is being limited
   * @param points how many points this call costs
   * @param options a per-key limit that replaces the limiter's points
   * @returns the decision (always `allowed`), for rate-limit response headers
   * @throws {AppError} `RATE_LIMITED` when the budget is used up or the key is locked out
   */
  async enforce(name: LimiterName, key: string, points = 1, options: RateLimitOptions = {}): Promise<RateLimitResult> {
    const result = await this.consume(name, key, points, options);
    if (!result.allowed) throw rateLimitedError(result.retryAfterSeconds);
    return result;
  }

  /**
   * Forgets the counter (and any lock-out) of a key.
   *
   * Why: a successful sign-in clears the failed attempts of that email + IP (decision 021).
   *
   * Side effects: deletes the counter key.
   *
   * @param name the limiter
   * @param key who was being limited
   * @returns resolves when the counter is gone
   */
  async reset(name: LimiterName, key: string): Promise<void> {
    this.assertInput(key, 1, {});
    await this.limiterFor(name, RATE_LIMITERS[name].points).delete(key);
  }

  /**
   * Takes a place in a named semaphore.
   *
   * Why: decision 021 limits calls in flight to a supplier (`suppliers.max_concurrency`); a dispatch job that gets
   * `null` delays itself instead of failing.
   *
   * Side effects: a lease in the semaphore's sorted set on the cache Redis, expiring after `ttlMs`.
   *
   * @param name what is limited, for example `supplier-12`
   * @param max the most holders at once
   * @param ttlMs the lease length; longer than the longest call it covers
   * @returns the lease to pass to {@link RateLimitService.release}, or `null` when every place is taken
   * @throws {RangeError} for a bad `max`/`ttlMs`; {@link Error} for a name that is not letters, digits, `.`, `_` or `-`,
   *   or when Redis fails
   */
  async acquire(name: string, max: number, ttlMs: number): Promise<SemaphoreLease | null> {
    return acquireSemaphore(this.redis.cache, this.keys.semaphore(name), name, max, ttlMs);
  }

  /**
   * Gives a place back (always call it in a `finally`).
   *
   * Why: see {@link RateLimitService.acquire}. A release that fails is only logged: the lease expires by itself.
   *
   * Side effects: removes the lease from the semaphore.
   *
   * @param lease the lease returned by `acquire`
   * @returns resolves when done; never throws
   */
  async release(lease: SemaphoreLease): Promise<void> {
    try {
      await releaseSemaphore(this.redis.cache, lease);
    } catch (error) {
      this.logger.warn(`Releasing semaphore ${lease.name} failed; the lease expires by itself: ${String(error)}`);
    }
  }

  private assertInput(key: string, points: number, options: RateLimitOptions): void {
    if (key === '' || key.length > MAX_KEY_LENGTH) {
      throw new RangeError(`A rate limit key must be 1 to ${MAX_KEY_LENGTH} characters`);
    }
    if (!Number.isInteger(points) || points < 1)
      throw new RangeError(`Points must be a positive integer, got ${points}`);
    if (options.limit !== undefined && (!Number.isInteger(options.limit) || options.limit < 1)) {
      throw new RangeError(`A per-key limit must be a positive integer, got ${options.limit}`);
    }
  }

  /** The Redis limiter of a name and a limit; the counters are shared by every limit of the same name. */
  private limiterFor(name: LimiterName, limit: number): RateLimiterRedis {
    const id = `${name}:${limit}`;
    const known = this.limiters.get(id);
    if (known) return known;
    if (this.limiters.size >= MAX_LIMITER_INSTANCES) this.limiters.clear();
    const config = RATE_LIMITERS[name];
    const shared = {
      keyPrefix: this.keys.rateLimit(name),
      points: limit,
      duration: config.windowSeconds,
      blockDuration: 'blockSeconds' in config ? config.blockSeconds : 0,
    };
    const limiter = new RateLimiterRedis({
      ...shared,
      storeClient: this.redis.cache,
      // Do not wait for a dead connection: go straight to the in-memory limiter below.
      rejectIfRedisNotReady: true,
      insuranceLimiter: new RateLimiterMemory(shared),
    });
    this.limiters.set(id, limiter);
    return limiter;
  }
}
