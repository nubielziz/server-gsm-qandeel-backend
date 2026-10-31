// Health indicators of the two Redis roles (decisions 006, 015): `redis` (cache) and `redis_queue` (with a memory alert).
// Both are non-critical: the API still answers without them, so a failure reports `degraded`, not `down`.
import type { Redis } from 'ioredis';
import type { HealthIndicator } from '../health';

/**
 * Used and maximum memory of a Redis instance.
 *
 * Why: a noeviction queue Redis that fills up refuses writes, so the used/max ratio is the early warning (decision 006).
 */
export interface RedisMemory {
  readonly usedBytes: number;
  /** `maxmemory`; 0 means the instance has no limit. */
  readonly maxBytes: number;
}

/**
 * Reads `used_memory` and `maxmemory` from the text of `INFO memory`.
 *
 * Why: the queue health check and the memory gauges both need these two numbers; parsing is pure so it is unit-tested.
 *
 * @param info the reply of `INFO memory`
 * @returns the two numbers
 * @throws {Error} when `used_memory` is missing, so a changed reply format cannot pass as healthy
 */
export function parseRedisMemory(info: string): RedisMemory {
  const field = (name: string): number | undefined => {
    const match = new RegExp(`^${name}:(\\d+)\\s*$`, 'm').exec(info);
    return match?.[1] === undefined ? undefined : Number(match[1]);
  };
  const usedBytes = field('used_memory');
  if (usedBytes === undefined) throw new Error('INFO memory did not report used_memory');
  return { usedBytes, maxBytes: field('maxmemory') ?? 0 };
}

/** The fraction of `maxmemory` at which the queue Redis counts as unhealthy. */
export const QUEUE_MEMORY_ALERT_RATIO = 0.9;

/**
 * Health indicator for the cache Redis.
 *
 * Why: the console shows the cache state on the System health page ("redis", map B11); losing the cache only costs
 * rebuilds (decision 006), so it is non-critical.
 *
 * @see docs/decisions/015-observability.md
 */
export class RedisHealthIndicator implements HealthIndicator {
  readonly name = 'redis';
  readonly critical = false;

  constructor(private readonly client: Redis) {}

  /**
   * Sends `PING`.
   *
   * @throws {Error} when Redis does not answer `PONG`
   */
  async check(): Promise<void> {
    const reply = await this.client.ping();
    if (reply !== 'PONG') throw new Error(`Redis answered PING with an unexpected reply`);
  }
}

/**
 * Health indicator for the queue Redis, including its memory alert.
 *
 * Why: decision 006 makes the queue Redis its own component: with `noeviction`, a full instance refuses writes, so
 * enqueueing would fail while the instance still answers PING. The check fails at 90 % of `maxmemory`; the reason
 * (percent used) goes to the log through the health service, never to the response.
 *
 * @see docs/decisions/006-redis-topology.md
 */
export class RedisQueueHealthIndicator implements HealthIndicator {
  readonly name = 'redis_queue';
  readonly critical = false;

  constructor(
    private readonly client: Redis,
    private readonly alertRatio: number = QUEUE_MEMORY_ALERT_RATIO,
  ) {}

  /**
   * Reads `INFO memory` (which also proves the connection works) and compares used memory with `maxmemory`.
   *
   * @throws {Error} when Redis is unreachable or memory use is at or above the alert ratio of `maxmemory`
   */
  async check(): Promise<void> {
    const memory = parseRedisMemory(await this.client.info('memory'));
    if (memory.maxBytes > 0 && memory.usedBytes / memory.maxBytes >= this.alertRatio) {
      const percent = Math.round((memory.usedBytes / memory.maxBytes) * 100);
      throw new Error(
        `queue Redis memory is at ${percent} % of maxmemory (${memory.usedBytes} of ${memory.maxBytes} bytes); with noeviction a full instance refuses writes`,
      );
    }
  }
}
