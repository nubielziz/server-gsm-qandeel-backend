// Prometheus gauges for the memory of both Redis roles (decisions 006, 015), read when the registry is scraped.
import { Injectable } from '@nestjs/common';
import type { Redis } from 'ioredis';
import { Gauge } from 'prom-client';
import { withTimeout } from '../../common/timeout';
import { MetricsService } from '../metrics';
import { parseRedisMemory, type RedisMemory } from './redis.health';
import { type RedisRole, RedisService } from './redis.service';

/** A scrape must not wait for a stalled Redis. */
const SCRAPE_WAIT_MS = 1_500;
/** Both gauges are collected in the same scrape; a reading younger than this is shared between them. */
const SHARE_READING_MS = 1_000;

/**
 * Publishes `redis_memory_used_bytes{role}` and `redis_memory_max_bytes{role}`.
 *
 * Why: decision 006 wants a memory alert on the noeviction queue Redis; Prometheus (decision 015) charts and alerts on
 * these gauges, while the `redis_queue` health indicator gives the same warning to the console.
 *
 * Side effects: runs `INFO memory` on both Redis roles for every scrape of `/metrics`. When a Redis cannot be read the
 * series of that role are left out of the scrape (a missing series, not a stale number).
 */
@Injectable()
export class RedisMetrics {
  private snapshot: Promise<ReadonlyMap<RedisRole, RedisMemory>> | undefined;
  private snapshotAt = 0;

  constructor(
    metrics: MetricsService,
    private readonly redis: RedisService,
  ) {
    this.register(metrics, 'redis_memory_used_bytes', 'Memory used by a Redis instance, by role.', (m) => m.usedBytes);
    this.register(
      metrics,
      'redis_memory_max_bytes',
      'The maxmemory setting of a Redis instance, by role; 0 means no limit.',
      (m) => m.maxBytes,
    );
  }

  private register(metrics: MetricsService, name: string, help: string, pick: (memory: RedisMemory) => number): void {
    const gauge: Gauge<'role'> = new Gauge({
      name,
      help,
      labelNames: ['role'],
      registers: [metrics.registry],
      collect: async () => {
        const memory = await this.read();
        gauge.reset();
        for (const [role, value] of memory) gauge.set({ role }, pick(value));
      },
    });
  }

  /** Reads both instances once per scrape: the gauge that collects first fetches, the other one shares the result. */
  private read(): Promise<ReadonlyMap<RedisRole, RedisMemory>> {
    if (!this.snapshot || Date.now() - this.snapshotAt > SHARE_READING_MS) {
      this.snapshotAt = Date.now();
      this.snapshot = this.fetch();
    }
    return this.snapshot;
  }

  private async fetch(): Promise<ReadonlyMap<RedisRole, RedisMemory>> {
    const memory = new Map<RedisRole, RedisMemory>();
    const instances: ReadonlyArray<readonly [RedisRole, Redis]> = [
      ['cache', this.redis.cache],
      ['queue', this.redis.queue],
    ];
    await Promise.all(
      instances.map(async ([role, client]) => {
        try {
          memory.set(role, parseRedisMemory(await withTimeout(client.info('memory'), SCRAPE_WAIT_MS, 'INFO memory')));
        } catch {
          // Unreachable: this role has no series in the scrape.
        }
      }),
    );
    return memory;
  }
}
