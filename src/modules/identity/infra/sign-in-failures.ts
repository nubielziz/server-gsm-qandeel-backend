// SignInFailures: the per-email count of password sign-in attempts and the temporary lock, per scope (the console, or the shop), on the cache
// Redis (decision 052; it replaces the customers' CustomerSignInFailures of feature 14b). One count per email, whether or not an account exists.
import { Inject, Injectable, Logger } from '@nestjs/common';
import { CLOCK, type Clock } from '../../../common/clock';
import { LogThrottle } from '../../../common/log-throttle';
import { CacheKeys } from '../../../infra/cache';
import { TokenService } from '../../../infra/crypto';
import { RedisService, withoutCredentials } from '../../../infra/redis';
import { type SignInScope, SIGN_IN_LOCK_MS, lockedForSeconds } from '../domain/sign-in-lock';

/** The count outlives the lock a little, so a lock that just ended is still read from the same key. */
const KEY_TTL_MS = SIGN_IN_LOCK_MS + 60_000;
/** One log line per interval while Redis is down (every login would repeat it). */
const LOG_INTERVAL_MS = 30_000;
/** The most emails the in-process fallback remembers; it is emptied when full (a loosened lock, never a wrong refusal). */
const MAX_MEMORY_ENTRIES = 10_000;
/**
 * Takes one attempt back, never below 0, and only from a key that still exists (a key without a TTL must never be made here). Atomic, so
 * a charge that lands at the same moment is never lost.
 */
const GIVE_BACK = `if redis.call('exists', KEYS[1]) == 0 then return 0 end
local n = redis.call('hincrby', KEYS[1], 'n', -1)
if n < 0 then
  redis.call('hset', KEYS[1], 'n', 0)
  return 0
end
return n`;

/** What one counted attempt found: the count with it, and the lock. */
export interface SignInCharge {
  /** Attempts counted for the email since its last lock began, this one included (a correct password takes its own back). */
  readonly attempts: number;
  /** Whole seconds the email stays locked, `0` when no lock runs. */
  readonly lockedForSeconds: number;
}

/** What the in-process fallback keeps per email while the cache Redis is down. */
interface MemoryEntry {
  attempts: number;
  lockedUntilMs: number;
  expiresAtMs: number;
}

/**
 * Counts the password sign-in attempts of an email and keeps its lock.
 *
 * Why: the review of feature 14b and decision 052. A lock that only exists for accounts with a password answers 429 for them and 401
 * for any other email, which tells an attacker who has an account. So the count is keyed by the hashed scope and normalised email
 * alone and does not depend on the account. Every attempt is counted (`charge`) before its password is checked, in one atomic step, so
 * attempts sent at the same moment are all counted before any of them is checked; a correct password takes back only its own attempt
 * (`giveBack`), so a success, whoever's account it signed into, never cancels the failures other attempts caused. The attempt that
 * finds the count beyond ten starts the lock of 15 minutes (`startLock`: the count starts again, `Retry-After` is the time left); a new
 * password for the account deletes both (`clear`). The end of the lock follows the injected clock (decision 031); the Redis key's TTL
 * (16 minutes after the last attempt) only cleans up.
 *
 * If the cache Redis is down each process counts in memory instead (decision 021: lock-outs keep working per instance), and a Redis
 * error never turns into a failed sign-in.
 *
 * Side effects: the hash `gsm:{env}:identity:sign-in-failures:{hash}` (fields `n`, `until`) on the cache Redis, with a TTL; the key holds a
 * keyed hash of the scope and email, never the email.
 *
 * @see docs/cache-keys.md
 */
@Injectable()
export class SignInFailures {
  private readonly logger = new Logger(SignInFailures.name);
  private readonly throttle = new LogThrottle(LOG_INTERVAL_MS);
  private readonly memory = new Map<string, MemoryEntry>();

  constructor(
    private readonly redis: RedisService,
    private readonly keys: CacheKeys,
    private readonly tokens: TokenService,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  /**
   * Counts one attempt of an email, before its password is checked, and reads its lock in the same step.
   *
   * @param scope the console or the shop
   * @param email the email as typed (trimmed and lower-cased here)
   * @returns the count with this attempt and the time left of a running lock
   */
  async charge(scope: SignInScope, email: string): Promise<SignInCharge> {
    const hash = this.hashOf(scope, email);
    const { attempts, lockedUntilMs } = await this.guarded(
      () => this.chargeInRedis(hash),
      () => this.chargeInMemory(hash),
    );
    return { attempts, lockedForSeconds: lockedForSeconds(lockedUntilMs, this.clock.nowMs()) };
  }

  /**
   * Starts the lock of an email now, and starts its count again.
   *
   * Why: called for the first attempt beyond the failures an email may have; the count starts again so that, once the lock has ended,
   * the attempts refused meanwhile do not lock it at once.
   *
   * @param scope the console or the shop
   * @param email the email as typed
   * @returns the whole seconds the lock lasts
   */
  async startLock(scope: SignInScope, email: string): Promise<number> {
    const hash = this.hashOf(scope, email);
    const lockedUntilMs = this.clock.nowMs() + SIGN_IN_LOCK_MS;
    await this.guarded(
      async () => {
        const key = this.keys.signInFailures(hash);
        // Idempotent: attempts that crossed the limit at the same moment each write the same lock.
        await this.run(
          this.redis.cache.multi().hset(key, 'n', 0, 'until', lockedUntilMs).pexpire(key, KEY_TTL_MS).exec(),
        );
      },
      () => this.startLockInMemory(hash, lockedUntilMs),
    );
    return lockedForSeconds(lockedUntilMs, this.clock.nowMs());
  }

  /**
   * Takes one counted attempt back: its password was correct, or it was refused before any password was checked.
   *
   * Why: only the attempt's own count goes; failures other attempts caused stay (two accounts of one email may belong to two people).
   *
   * @param scope the console or the shop
   * @param email the email as typed
   */
  async giveBack(scope: SignInScope, email: string): Promise<void> {
    const hash = this.hashOf(scope, email);
    await this.guarded(
      async () => void (await this.redis.cache.eval(GIVE_BACK, 1, this.keys.signInFailures(hash))),
      () => this.giveBackInMemory(hash),
    );
  }

  /**
   * Forgets the count and the lock of an email.
   *
   * Why: a new password the mailbox owner chose from an emailed link, or one staff set, ends the story of the old one.
   *
   * @param scope the console or the shop
   * @param email the email as typed
   */
  async clear(scope: SignInScope, email: string): Promise<void> {
    const hash = this.hashOf(scope, email);
    this.memory.delete(hash);
    await this.guarded(
      async () => void (await this.redis.cache.del(this.keys.signInFailures(hash))),
      () => undefined,
    );
  }

  /** One `MULTI`: the count goes up, the key's TTL is renewed and the lock is read, so parallel attempts each see their own count. */
  private async chargeInRedis(hash: string): Promise<{ attempts: number; lockedUntilMs: number }> {
    const key = this.keys.signInFailures(hash);
    const [attempts, , until] = await this.run(
      this.redis.cache.multi().hincrby(key, 'n', 1).pexpire(key, KEY_TTL_MS).hget(key, 'until').exec(),
    );
    return { attempts: Number(attempts), lockedUntilMs: Number(until ?? 0) };
  }

  private chargeInMemory(hash: string): { attempts: number; lockedUntilMs: number } {
    const now = this.clock.nowMs();
    const entry = this.live(hash) ?? { attempts: 0, lockedUntilMs: 0, expiresAtMs: 0 };
    entry.attempts += 1;
    entry.expiresAtMs = now + KEY_TTL_MS;
    this.remember(hash, entry);
    return { attempts: entry.attempts, lockedUntilMs: entry.lockedUntilMs };
  }

  private startLockInMemory(hash: string, lockedUntilMs: number): void {
    const entry = this.live(hash) ?? { attempts: 0, lockedUntilMs: 0, expiresAtMs: 0 };
    entry.attempts = 0;
    entry.lockedUntilMs = lockedUntilMs;
    entry.expiresAtMs = this.clock.nowMs() + KEY_TTL_MS;
    this.remember(hash, entry);
  }

  private giveBackInMemory(hash: string): void {
    const entry = this.live(hash);
    if (entry) entry.attempts = Math.max(0, entry.attempts - 1);
  }

  private remember(hash: string, entry: MemoryEntry): void {
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

  /** The key part of an email: a keyed hash of the scope and the trimmed, lower-cased text (Redis shows no address). */
  private hashOf(scope: SignInScope, email: string): string {
    return this.tokens.hash(`sign-in-failures\u0000${scope}\u0000${email.trim().toLowerCase()}`);
  }
}
