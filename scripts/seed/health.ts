// Seeder of the health module (feature 9): a week of service checks (the System health uptime bars and the Dashboard supplier health)
// and the run history of the scheduled jobs (the Jobs and Database tabs), shaped like the frontend mock's calm story
// (src/features/system-health/mocks/seedOps.ts, seedIntegrity.ts). Alert rules, alerts and incidents are feature 12b's seed.
//
// It runs after the suppliers seed (a check of `supplier:<id>` needs the supplier) and writes only into empty tables: the worker's own
// checker and job runs are the real data, so a database that already has them keeps them and the seed adds nothing.
import { sql } from 'drizzle-orm';
import { type DbExecutor, schema as s } from '../../src/infra/db';
import { type DemoSeed, demoNumericId, demoRows } from './demo-state';
import { type SeedReport, insertRows, syncIdentity } from './helpers';

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;
/** One sample per component every half hour keeps a week of history near 5,000 rows; the live checker writes one a minute. */
const CHECK_EVERY_MS = 30 * MINUTE_MS;
const HISTORY_DAYS = 7;
/** The core components the checker writes (`mail` waits for the notifications feature's probe). */
const CORE = ['api', 'postgres', 'redis', 'redis_queue', 'storage', 'workers'] as const;
/** The usual answer time of each core component, in milliseconds. */
const CORE_LATENCY: Readonly<Record<string, number | null>> = {
  api: null,
  postgres: 4,
  redis: 1,
  redis_queue: 1,
  storage: 38,
  workers: null,
};

/** A supplier of the demo seed (the fields the checks need). */
interface DemoSupplier {
  id: string;
  enabled: boolean;
}

/** A small, repeatable wobble in `[-1, 1]` so the latencies are not a flat line (no randomness: a re-seed gives the same rows). */
const wobble = (seed: number, index: number): number => Math.sin(seed * 12.9898 + index * 78.233);

/**
 * Seeds a week of `service_checks`.
 *
 * Why: the uptime figures, the history bars and the dashboard's supplier health read these rows. The story is calm with two blips
 * so the bars are not all green: one supplier answered slowly for an hour two days ago, and the queue Redis was down for one sample
 * four days ago. The newest sample of every component is `ok`, so the first thing the console shows is Operational.
 *
 * @param db the transaction to write with
 * @param demo the loaded frontend demo state (its clock and its suppliers)
 * @returns one report; an empty table is the only case that writes
 */
async function seedServiceChecks(db: DbExecutor, demo: DemoSeed): Promise<SeedReport> {
  const [existing] = await db.select({ n: sql<number>`count(*)::int` }).from(s.serviceChecks);
  if ((existing?.n ?? 0) > 0) return { table: 'service_checks', inserted: 0, existing: existing?.n ?? 0 };

  const suppliers = demoRows<DemoSupplier>(demo, 'suppliers').filter((supplier) => supplier.enabled);
  const known = new Set((await db.select({ id: s.suppliers.id }).from(s.suppliers)).map((row) => row.id));
  const supplierIds = suppliers.map((supplier) => demoNumericId(supplier.id)).filter((id) => known.has(id));
  const samples = (HISTORY_DAYS * DAY_MS) / CHECK_EVERY_MS;
  const slowSupplier = supplierIds[1] ?? supplierIds[0];
  const rows: Array<typeof s.serviceChecks.$inferInsert & { id: number }> = [];
  for (let index = 0; index <= samples; index++) {
    const ago = (samples - index) * CHECK_EVERY_MS;
    const checkedAt = new Date(demo.now - ago);
    const add = (
      row: Omit<typeof s.serviceChecks.$inferInsert, 'checkedAt' | 'createdAt' | 'detail'> & { detail?: string },
    ) => rows.push({ id: rows.length + 1, detail: null, ...row, checkedAt, createdAt: checkedAt });
    for (const [position, component] of CORE.entries()) {
      const down = component === 'redis_queue' && ago > 4 * DAY_MS - CHECK_EVERY_MS && ago <= 4 * DAY_MS;
      const base = CORE_LATENCY[component] ?? null;
      add({
        component,
        status: down ? 'down' : 'ok',
        latencyMs: down || base === null ? null : Math.max(1, Math.round(base * (1 + 0.25 * wobble(position, index)))),
        ...(down ? { detail: 'Check failed' } : {}),
      });
    }
    for (const supplierId of supplierIds) {
      const slow = supplierId === slowSupplier && ago > 2 * DAY_MS && ago <= 2 * DAY_MS + HOUR_MS;
      add({
        component: `supplier:${supplierId}`,
        supplierId,
        status: slow ? 'degraded' : 'ok',
        latencyMs: Math.round((slow ? 4200 : 380 + 40 * supplierId) * (1 + 0.15 * wobble(supplierId, index))),
        ...(slow ? { detail: '38% of calls failed in the last 15 minutes' } : {}),
      });
    }
  }
  const report = await insertRows(db, s.serviceChecks, rows);
  await syncIdentity(db, s.serviceChecks);
  return report;
}

/** How one scheduled job leaves its trace: when it is due and what its `result` says (the shapes the real processors write). */
interface JobShape {
  readonly job: string;
  /** Every how many milliseconds the schedule fires. */
  readonly every: number;
  /** Where in the period the run starts (the cron minute), in milliseconds. */
  readonly offset: number;
  /** How many of the newest runs to keep. */
  readonly runs: number;
  readonly typicalMs: number;
  readonly processed: number;
  readonly result: (processed: number, index: number) => Record<string, number>;
}

const JOBS: readonly JobShape[] = [
  {
    job: 'price_sync',
    every: 15 * MINUTE_MS,
    offset: 0,
    runs: 20,
    typicalMs: 9_400,
    processed: 5,
    result: (processed) => ({ suppliers: processed + 1, succeeded: processed, failed: 1 }),
  },
  {
    job: 'balance_check',
    every: 30 * MINUTE_MS,
    offset: 0,
    runs: 20,
    typicalMs: 2_100,
    processed: 5,
    result: (processed) => ({ suppliers: processed, succeeded: processed, failed: 0 }),
  },
  {
    job: 'session_purge',
    every: DAY_MS,
    offset: 3 * HOUR_MS + 15 * MINUTE_MS,
    runs: 14,
    typicalMs: 340,
    processed: 12,
    result: (processed) => ({ deleted: processed }),
  },
  {
    job: 'client_group_promotion',
    every: DAY_MS,
    offset: 3 * HOUR_MS + 30 * MINUTE_MS,
    runs: 14,
    typicalMs: 1_250,
    processed: 2,
    result: (processed) => ({ promoted: processed }),
  },
  {
    job: 'service_checks_purge',
    every: DAY_MS,
    offset: 3 * HOUR_MS + 30 * MINUTE_MS,
    runs: 14,
    typicalMs: 780,
    processed: 0,
    result: () => ({ checks: 0, runs: 0 }),
  },
  {
    // Two weeks of daily size samples: the Database tab's growth per day comes from the first and the last.
    job: 'db_size_sample',
    every: DAY_MS,
    offset: 3 * HOUR_MS + 45 * MINUTE_MS,
    runs: 14,
    typicalMs: 95,
    processed: 1,
    result: (_processed, index) => ({ bytes: 612_000_000 - index * 4_300_000 }),
  },
];

/** The start of the newest scheduled slot of a job at or before `at`. */
const lastDue = (shape: JobShape, at: number): number =>
  Math.floor((at - shape.offset) / shape.every) * shape.every + shape.offset;

/**
 * Seeds the run history of the scheduled jobs.
 *
 * Why: the Jobs tab lists the last run of every scheduler, and the Database tab's growth per day needs two size samples. Each job gets
 * its newest runs on its schedule, each one a `succeeded` row, except one old failed price sync (so the history is not a wall of
 * green); the numbers are small and repeatable.
 *
 * @param db the transaction to write with
 * @param demo the loaded frontend demo state (its clock)
 * @returns one report; an empty table is the only case that writes
 */
async function seedJobRuns(db: DbExecutor, demo: DemoSeed): Promise<SeedReport> {
  const [existing] = await db.select({ n: sql<number>`count(*)::int` }).from(s.jobRuns);
  if ((existing?.n ?? 0) > 0) return { table: 'job_runs', inserted: 0, existing: existing?.n ?? 0 };

  const rows: Array<typeof s.jobRuns.$inferInsert & { id: number }> = [];
  for (const shape of JOBS) {
    // Newest first in `ago`; written oldest first so the ids grow with time.
    for (let ago = shape.runs - 1; ago >= 0; ago--) {
      const due = lastDue(shape, demo.now) - ago * shape.every;
      const startedAt = new Date(due + 800 + Math.round(1200 * Math.abs(wobble(shape.every, ago))));
      if (startedAt.getTime() >= demo.now) continue;
      const failed = shape.job === 'price_sync' && ago === 7;
      const duration = Math.round(shape.typicalMs * (1 + 0.2 * wobble(shape.offset, ago)));
      const processed = failed ? 0 : shape.processed;
      rows.push({
        id: rows.length + 1,
        job: shape.job,
        trigger: 'schedule',
        status: failed ? 'failed' : 'succeeded',
        startedAt,
        finishedAt: new Date(startedAt.getTime() + duration),
        durationMs: duration,
        processed,
        result: failed ? undefined : shape.result(processed, ago),
        error: failed ? 'Rapid IMEI: HTTP 502 Bad Gateway' : null,
        createdAt: startedAt,
        updatedAt: new Date(startedAt.getTime() + duration),
      });
    }
  }
  const report = await insertRows(db, s.jobRuns, rows);
  await syncIdentity(db, s.jobRuns);
  return report;
}

/**
 * Seeds the health module's tables.
 *
 * Why: seed = frontend mocks (decision 014): the System health page and the Dashboard show a week of checks and the jobs' history
 * through the real API. Idempotent: a table that already has rows (the worker's own) is left alone.
 *
 * @param db the transaction to write with
 * @param demo the loaded frontend demo state
 * @returns one report per table
 */
export async function seedHealth(db: DbExecutor, demo: DemoSeed): Promise<SeedReport[]> {
  return [await seedServiceChecks(db, demo), await seedJobRuns(db, demo)];
}
