// CustomerSignInFailures: the wrong-password counter and the temporary lock of a customer email, on the cache Redis (store sign-in,
// POST /store/v1/auth/login). One counter per email, whether or not an account exists.
import { Inject, Injectable, Logger } from '@nestjs/common';
import { CLOCK, type Clock } from '../../../common/clock';
import { LogThrottle } from '../../../common/log-throttle';
import { CacheKeys } from '../../../infra/cache';
import { TokenService } from '../../../infra/crypto';
import { RedisService, withoutCredentials } from '../../../infra/redis';
import { LOCK_DURATION_MS, lockedForSeconds, locksAfter } from '../domain/lockout';

/** The counter outlives the lock a little, so a lock that just ended is still read from the same key. */
const KEY_TTL_MS = LOCK_DURATION_MS + 60_000;
/** One log line per interval while Redis is down (every login would repeat it). */
const LOG_INTERVAL_MS = 30_000;
/** The most emails the in-process fallback remembers; it is emptied when full (a loosened lock, never a wrong refusal). */
const MAX_MEMORY_ENTRIES = 10_000;

/** What the in-process fallback keeps per email while the cache Redis is down. */
interface MemoryEntry {
  failures: number;
  lockedUntilMs: number;
  expiresAtMs: number;
}

/**
 * Counts the wrong passwords of an email and says whether it is locked.
 *
 * Why: the review of feature 14b. A lock that only exists for accounts with a password answers 429 for them and 401 for any other
 * email, which tells an attacker who has an account. So the counter is keyed by the hashed normalised email alone, is charged on
 * every `401` (unknown email, guest, account without a password, wrong password) and is read before the account is. The tenth
 * failure in a row locks the email for 15 minutes (`Retry-After` is the time left); a correct password, or a new password for the
 * account, clears it. The end of the lock follows the injected clock (decision 031); the Redis key's TTL only cleans up.
 *
 * If the cache Redis is down each process counts in memory instead (decision 021: lock-outs keep working per instance), and a
 * Redis error never turns into a failed sign-in.
 *
 * Side effects: the hash `gsm:{env}:customers:sign-in-failures:{hash}` (fields `n`, `until`) on the cache Redis, with a TTL; the
 * key holds a keyed hash of the email, never the email.
 *
 * @see docs/cache-keys.md
 */
@Injectable()
export class CustomerSignInFailures {
  private readonly logger = new Logger(CustomerSignInFailures.name);
  private readonly throttle = new LogThrottle(LOG_INTERVAL_MS);
  private readonly memory = new Map<string, MemoryEntry>();

  constructor(
    private readonly redis: RedisService,
    private readonly keys: CacheKeys,
    private readonly tokens: TokenService,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  /**
   * Says how long an email stays locked.
   *
   * @param email the email as typed (trimmed and lower-cased here)
   * @returns whole seconds while locked, `0` when the email may try
   */
  async lockedFor(email: string): Promise<number> {
    const hash = this.hashOf(email);
    const lockedUntilMs = await this.guarded(
      async () => Number((await this.redis.cache.hget(this.keys.customerSignInFailures(hash), 'until')) ?? 0),
      () => this.live(hash)?.lockedUntilMs ?? 0,
    );
    return lockedForSeconds(lockedUntilMs, this.clock.nowMs());
  }

  /**
   * Counts one wrong sign-in of an email; the tenth in a row starts the lock.
   *
   * @param email the email as typed
   */
  async recordFailure(email: string): Promise<void> {
    const hash = this.hashOf(email);
    await this.guarded(
      () => this.recordInRedis(hash),
      () => this.recordInMemory(hash),
    );
  }

  /**
   * Forgets the failures and the lock of an email.
   *
   * Why: a correct password proves the owner, and a new password (reset link, staff, own change) ends the story of the old one.
   *
   * @param email the email as typed
   */
  async clear(email: string): Promise<void> {
    const hash = this.hashOf(email);
    this.memory.delete(hash);
    await this.guarded(
      async () => void (await this.redis.cache.del(this.keys.customerSignInFailures(hash))),
      () => undefined,
    );
  }

  /** The count is atomic (`HINCRBY`), so parallel guesses are all counted; the lock write after it is idempotent. */
  private async recordInRedis(hash: string): Promise<void> {
    const key = this.keys.customerSignInFailures(hash);
    const [incremented] = await this.run(this.redis.cache.multi().hincrby(key, 'n', 1).pexpire(key, KEY_TTL_MS).exec());
    if (!locksAfter(Number(incremented))) return;
    // The count starts again after the lock; the lock itself is the `until` time.
    await this.run(
      this.redis.cache
        .multi()
        .hset(key, 'n', 0, 'until', this.clock.nowMs() + LOCK_DURATION_MS)
        .pexpire(key, KEY_TTL_MS)
        .exec(),
    );
  }

  private recordInMemory(hash: string): void {
    const now = this.clock.nowMs();
    const entry = this.live(hash) ?? { failures: 0, lockedUntilMs: 0, expiresAtMs: 0 };
    entry.failures += 1;
    entry.expiresAtMs = now + KEY_TTL_MS;
    if (locksAfter(entry.failures)) {
      entry.failures = 0;
      entry.lockedUntilMs = now + LOCK_DURATION_MS;
    }
    if (this.memory.size >= MAX_MEMORY_ENTRIES && !this.memory.has(hash)) this.memory.clear();
    this.memory.set(hash, entry);
  }

  /** The in-process entry of an email, unless it has expired. */
  private live(hash: string): MemoryEntry | undefined {
    const entry = this.memory.get(hash);
    if (!entry) return undefined;
    if (entry.expiresAtMs > this.clock.nowMs()) return entry;
    this.memory.delete(hash);
    return undefined;
  }

  /** Runs the Redis way; on any Redis error logs it (throttled) and runs the in-process way instead. */
  private async guarded<T>(viaRedis: () => Promise<T>, viaMemory: () => T): Promise<T> {
    try {
      return await viaRedis();
    } catch (error) {
      const allowed = this.throttle.attempt('redis:sign-in-failures');
      if (allowed) {
        this.logger.warn(
          `The cache Redis failed; the sign-in lock counts in memory on this instance (${allowed.suppressed} similar lines dropped): ${withoutCredentials(String(error))}`,
        );
      }
      return viaMemory();
    }
  }

  /** The replies of a `MULTI`/`EXEC`; throws when Redis dropped the transaction or one command failed. */
  private async run(exec: Promise<Array<[Error | null, unknown]> | null>): Promise<unknown[]> {
    const replies = await exec;
    if (!replies) throw new Error('Redis dropped the sign-in failure transaction');
    return replies.map(([error, value]) => {
      if (error) throw error;
      return value;
    });
  }

  /** The key part of an email: a keyed hash of the trimmed, lower-cased text (Redis shows no address). */
  private hashOf(email: string): string {
    return this.tokens.hash(`customer-sign-in-failures\u0000${email.trim().toLowerCase()}`);
  }
}
