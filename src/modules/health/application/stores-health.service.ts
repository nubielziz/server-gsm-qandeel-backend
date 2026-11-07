// The data store pages (`GET /admin/system/database` and `/cache`): Postgres from `pg_stat_*` and the cache Redis from `INFO`. The
// two Redis roles are never mixed: this reads the cache Redis only (B98); the queue Redis is the `redis_queue` component.
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Inject, Injectable } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { CLOCK, type Clock } from '../../../common/clock';
import { DbService, MIGRATIONS_FOLDER } from '../../../infra/db';
import { RedisService } from '../../../infra/redis';
import { type Measure, SPEC, measure, worst } from '../domain/measure';
import { succeededResults } from '../infra/job-runs-admin.repository';
import { isDatabaseDown } from './database-guard';

const MINUTE_MS = 60_000;
const DAY_MS = 86_400_000;
const UNKNOWN = (unit: Measure['unit']): Measure => ({ value: null, unit, state: 'unknown' });

function infoNumber(info: string, key: string): number | null {
  const match = new RegExp(`^${key}:(\\d+(?:\\.\\d+)?)`, 'm').exec(info);
  return match ? Number(match[1]) : null;
}

/** The answer of `GET /admin/system/database` when Postgres cannot be read: status `down`, empty lists, unknown measures. */
function databaseDown() {
  return {
    status: 'down' as const,
    connections: { used: 0, max: 0, usage: UNKNOWN('percent'), poolWait: UNKNOWN('ms'), waitingClients: 0 },
    locks: { waiting: 0, longestWait: UNKNOWN('s') },
    replicaLag: null,
    size: { bytes: 0, growthPerDayBytes: null },
    pendingMigrations: [] as string[],
    slowQueries: [] as Array<{ id: string; query: string; calls: number; meanMs: number; totalMs: number }>,
    longTransactions: [] as Array<{ pid: number; durationSeconds: number; state: string; query: string }>,
  };
}

/**
 * Reads the state of Postgres and of the cache Redis.
 *
 * Why: one read feeds the Postgres card, the slow-query and long-transaction lists (M250), and one the Redis card. Nothing secret
 * or network-specific is sent (no hostnames, no credentials, no connection strings). A store that cannot be read is a `down`
 * answer with unknown measures (M247, M251), not an error: the page must show that the store is down.
 *
 * Side effects: reads `pg_stat_activity`, `pg_locks`, `pg_stat_replication`, `pg_stat_statements` (when installed), the Drizzle
 * migration table, `job_runs`, and Redis `INFO` and `PING`; no writes.
 */
@Injectable()
export class StoresHealthService {
  constructor(
    private readonly db: DbService,
    private readonly redis: RedisService,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  /**
   * `GET /admin/system/database`.
   *
   * @returns connections, locks, replica lag, size and growth, pending migrations, slow queries and long transactions
   */
  async database() {
    try {
      return await this.readDatabase();
    } catch (error) {
      if (isDatabaseDown(error)) return databaseDown();
      throw error;
    }
  }

  /**
   * `GET /admin/system/cache`.
   *
   * @returns memory, evictions, hit rate, clients and latency of the cache Redis
   */
  async cache() {
    const now = this.clock.now();
    const started = performance.now();
    let memory: string;
    let stats: string;
    let clients: string;
    try {
      await this.redis.cache.ping();
      [memory, stats, clients] = await Promise.all([
        this.redis.cache.info('memory'),
        this.redis.cache.info('stats'),
        this.redis.cache.info('clients'),
      ]);
    } catch {
      return {
        status: 'down' as const,
        memory: { usedBytes: 0, maxBytes: null, usage: UNKNOWN('percent') },
        evictionsPerMin: UNKNOWN('per_min'),
        hitRate: UNKNOWN('percent'),
        clients: UNKNOWN('count'),
        latency: UNKNOWN('ms'),
      };
    }
    const latencyMs = performance.now() - started;
    const used = infoNumber(memory, 'used_memory') ?? 0;
    const max = infoNumber(memory, 'maxmemory') ?? 0;
    const usage = max > 0 ? (used / max) * 100 : null;
    // Evictions and hit rate are deltas over the last minutes, from the counters each checker run stored (not since restart).
    let evictions: number | null = null;
    let hitRate: number | null = null;
    try {
      const samples = await succeededResults(this.db.db, 'service_checks', new Date(now.getTime() - 10 * MINUTE_MS));
      const base = samples.find((sample) => typeof sample.result.cacheHits === 'number');
      const minutes = base ? (now.getTime() - base.startedAt.getTime()) / MINUTE_MS : 0;
      if (base && minutes >= 0.5) {
        const hits = (infoNumber(stats, 'keyspace_hits') ?? 0) - Number(base.result.cacheHits);
        const misses = (infoNumber(stats, 'keyspace_misses') ?? 0) - Number(base.result.cacheMisses ?? 0);
        const evicted = (infoNumber(stats, 'evicted_keys') ?? 0) - Number(base.result.cacheEvictedKeys ?? 0);
        evictions = Math.max(0, evicted) / minutes;
        hitRate = hits + misses > 0 ? (Math.max(0, hits) / (hits + misses)) * 100 : null;
      }
    } catch {
      // Without Postgres the deltas are unknown; the rest of the card is live.
    }
    const parts = {
      usage: measure(SPEC.memory, usage),
      evictionsPerMin: measure(SPEC.evictions, evictions),
      hitRate: measure(SPEC.hitRate, hitRate),
      clients: measure(SPEC.clients, infoNumber(clients, 'connected_clients')),
      latency: measure(SPEC.redisLatency, latencyMs),
    };
    const verdict = worst(Object.values(parts).map((part) => (part.state === 'unknown' ? 'ok' : part.state)));
    return {
      status: verdict === 'crit' ? ('degraded' as const) : ('ok' as const),
      memory: { usedBytes: used, maxBytes: max > 0 ? max : null, usage: parts.usage },
      evictionsPerMin: parts.evictionsPerMin,
      hitRate: parts.hitRate,
      clients: parts.clients,
      latency: parts.latency,
    };
  }

  private async readDatabase() {
    const db = this.db.db;
    const now = this.clock.now();
    // Server-side durations (lock waits, transaction ages) use the database's own clock: they measure what Postgres sees, not business time.
    const [activity, locks, replica, size, long] = await Promise.all([
      db.execute<{ used: number; max: number }>(
        sql`select (select count(*) from pg_stat_activity where datname = current_database())::int as used, current_setting('max_connections')::int as max`,
      ),
      db.execute<{ waiting: number; longest: number }>(
        sql`select (select count(*) from pg_locks where not granted)::int as waiting,
          coalesce((select max(extract(epoch from (clock_timestamp() - state_change))) from pg_stat_activity where wait_event_type = 'Lock'), 0)::float as longest`,
      ),
      db.execute<{ replicas: number; lag: number | null }>(
        sql`select count(*)::int as replicas, max(extract(epoch from replay_lag))::float as lag from pg_stat_replication`,
      ),
      db.execute<{ bytes: string }>(sql`select pg_database_size(current_database())::text as bytes`),
      db.execute<{ pid: number; seconds: number; state: string | null; query: string }>(
        sql`select pid, extract(epoch from (clock_timestamp() - xact_start))::float as seconds, state, left(query, 300) as query
          from pg_stat_activity
          where xact_start is not null and datname = current_database() and pid <> pg_backend_pid()
            and clock_timestamp() - xact_start > interval '60 seconds'
          order by xact_start limit 20`,
      ),
    ]);
    const used = activity.rows[0]?.used ?? 0;
    const max = activity.rows[0]?.max ?? 0;
    const usage = measure(SPEC.connections, max > 0 ? (used / max) * 100 : null);
    const longest = measure(SPEC.lockWait, locks.rows[0]?.longest ?? 0);
    const lag =
      replica.rows[0] && replica.rows[0].replicas > 0 ? measure(SPEC.replicaLag, replica.rows[0].lag ?? 0) : null;
    const states = [usage.state, longest.state, ...(lag ? [lag.state] : [])];
    return {
      status: states.includes('crit') ? ('degraded' as const) : ('ok' as const),
      connections: {
        used,
        max,
        usage,
        // The pool wait is not measured yet (no pool instrumentation): unknown, never a made-up zero.
        poolWait: UNKNOWN('ms'),
        waitingClients: this.db.pool.waitingCount,
      },
      locks: { waiting: locks.rows[0]?.waiting ?? 0, longestWait: longest },
      replicaLag: lag,
      size: { bytes: Number(size.rows[0]?.bytes ?? 0), growthPerDayBytes: await this.growth(now) },
      pendingMigrations: await this.pendingMigrations(),
      slowQueries: await this.slowQueries(),
      longTransactions: long.rows.map((row) => ({
        pid: row.pid,
        durationSeconds: Math.round(row.seconds),
        state: row.state ?? 'unknown',
        query: row.query,
      })),
    };
  }

  /** Bytes gained per day between the oldest and the newest daily size sample of the last 8 days; null with fewer than two. */
  private async growth(now: Date): Promise<number | null> {
    const samples = (await succeededResults(this.db.db, 'db_size_sample', new Date(now.getTime() - 8 * DAY_MS))).filter(
      (sample) => typeof sample.result.bytes === 'number',
    );
    const first = samples[0];
    const last = samples[samples.length - 1];
    if (!first || !last || first === last) return null;
    const days = (last.startedAt.getTime() - first.startedAt.getTime()) / DAY_MS;
    return days <= 0 ? null : Math.round((Number(last.result.bytes) - Number(first.result.bytes)) / days);
  }

  /** The bundled migrations that the database has not applied (journal tags whose time is not in the migration table). */
  private async pendingMigrations(): Promise<string[]> {
    try {
      const journal = JSON.parse(await readFile(join(MIGRATIONS_FOLDER, 'meta', '_journal.json'), 'utf8')) as {
        entries: Array<{ tag: string; when: number }>;
      };
      const applied = await this.db.db.execute<{ created_at: string }>(
        sql`select created_at::text from drizzle.__drizzle_migrations`,
      );
      const times = new Set(applied.rows.map((row) => Number(row.created_at)));
      return journal.entries.filter((entry) => !times.has(entry.when)).map((entry) => entry.tag);
    } catch {
      // No migration table yet (a database never migrated) or an unreadable journal: nothing can be said, so nothing is listed.
      return [];
    }
  }

  /** The 10 statements with the highest mean time, or none when the `pg_stat_statements` extension is not installed. */
  private async slowQueries() {
    try {
      const rows = await this.db.db.execute<{ id: string; query: string; calls: string; mean: number; total: number }>(
        sql`select queryid::text as id, left(query, 500) as query, calls::text as calls, mean_exec_time::float as mean, total_exec_time::float as total
          from pg_stat_statements where dbid = (select oid from pg_database where datname = current_database())
          order by mean_exec_time desc limit 10`,
      );
      return rows.rows.map((row) => ({
        id: row.id,
        query: row.query,
        calls: Number(row.calls),
        meanMs: Math.round(row.mean * 100) / 100,
        totalMs: Math.round(row.total),
      }));
    } catch {
      return [];
    }
  }
}
