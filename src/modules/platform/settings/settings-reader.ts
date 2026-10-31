// SettingsReader: cached, read-only access to the `settings` table for the other modules (platform module owns the table).
// The session lifetimes of the identity module are its first reader; the pipeline hooks (IP allowlist switch, maintenance) follow.
import { Injectable, Logger } from '@nestjs/common';
import { LogThrottle } from '../../../common/log-throttle';
import { CacheKeys, CacheService } from '../../../infra/cache';
import { DbService } from '../../../infra/db';
import { loadAllSettings } from './settings.repository';

/** How long the settings snapshot stays in the cache before it is read again (decision 022). */
export const SETTINGS_TTL_SECONDS = 60;

/** The accepted range of an integer setting. */
export interface IntegerBounds {
  readonly min: number;
  readonly max: number;
}

/** What a whole-number setting needs: the key's default and its accepted range. */
export interface IntegerSetting extends IntegerBounds {
  readonly fallback: number;
}

/**
 * Reads system settings through the cache.
 *
 * Why: decision 022 keeps hot reads such as settings off Postgres. The whole table is one cache entry (a few kilobytes), so
 * any number of keys costs one cache read. The settings write routes (feature 2a) call {@link SettingsReader.invalidate}
 * after the commit, so a change shows within moments and never later than the TTL.
 *
 * Side effects: reads `settings` on a miss and the key `gsm:{env}:platform:settings:all`; logs a warning (at most one a
 * minute per key) when a value is out of range.
 *
 * @see docs/cache-keys.md
 */
@Injectable()
export class SettingsReader {
  private readonly logger = new Logger(SettingsReader.name);
  private readonly throttle = new LogThrottle(60_000);

  constructor(
    private readonly db: DbService,
    private readonly cache: CacheService,
    private readonly keys: CacheKeys,
  ) {}

  /**
   * Returns every setting.
   *
   * @returns key to JSON value; never mutate it (it is shared by concurrent callers)
   */
  all(): Promise<Readonly<Record<string, unknown>>> {
    return this.cache.getOrLoad(this.keys.settings(), SETTINGS_TTL_SECONDS, () => loadAllSettings(this.db.db));
  }

  /**
   * Returns one setting.
   *
   * @param key the setting key
   * @returns the JSON value, or `undefined` when the key was never set
   */
  async get(key: string): Promise<unknown> {
    return (await this.all())[key];
  }

  /**
   * Returns a whole-number setting, or the fallback when it is missing or outside the bounds.
   *
   * Why: a bad value saved by mistake (a text, a negative lifetime) must not log everybody out or keep sessions for ever,
   * so the caller gets its documented default instead and the mistake is logged.
   *
   * @param key the setting key
   * @param fallback the value to use when the setting is missing or invalid
   * @param bounds the accepted range, inclusive
   * @returns the stored integer, or the fallback
   */
  async integer(key: string, fallback: number, bounds: IntegerBounds): Promise<number> {
    return this.pickInteger(await this.all(), key, { ...bounds, fallback });
  }

  /**
   * Returns several whole-number settings with one read of the snapshot.
   *
   * @param specs setting key to its fallback and bounds
   * @returns the same keys with the stored integer or the fallback
   */
  async integers<K extends string>(specs: Readonly<Record<K, IntegerSetting>>): Promise<Record<K, number>> {
    const values = await this.all();
    const result = {} as Record<K, number>;
    for (const key of Object.keys(specs) as K[]) result[key] = this.pickInteger(values, key, specs[key]);
    return result;
  }

  /**
   * Forgets the cached snapshot so the next read sees the table.
   *
   * Why: decision 022 invalidates after the commit: a settings write calls it inside `afterCommit`.
   *
   * Side effects: deletes `gsm:{env}:platform:settings:all`.
   *
   * @throws {Error} when Redis fails, so the caller can log it (the old snapshot then lives until its TTL)
   */
  async invalidate(): Promise<void> {
    await this.cache.del(this.keys.settings());
  }

  private pickInteger(values: Readonly<Record<string, unknown>>, key: string, spec: IntegerSetting): number {
    const value = values[key];
    if (value === undefined) return spec.fallback;
    if (typeof value === 'number' && Number.isInteger(value) && value >= spec.min && value <= spec.max) return value;
    if (this.throttle.attempt(key)) {
      this.logger.warn(
        `Setting "${key}" must be a whole number from ${spec.min} to ${spec.max}; using the default ${spec.fallback}.`,
      );
    }
    return spec.fallback;
  }
}
