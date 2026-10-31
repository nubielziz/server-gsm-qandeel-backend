// Process-level tests of the worker (decisions 001, 020) with real Bun child processes on the test instances: the real
// `bun src/worker.ts` starts the outbox relay and stops cleanly on SIGTERM, and a worker that is running a job when SIGTERM
// arrives finishes the job first and closes its connections afterwards (the check of the Phase 0 spike, now a test).
// Bun reads tsconfig.json from the working directory, so the children run from the repository root.
import { afterAll, describe, expect, it } from 'bun:test';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { eq } from 'drizzle-orm';
import { schema as s } from '../../src/infra/db';
import { MetricsModule } from '../../src/infra/metrics';
import { QueuesModule, QueuesService, queueJobId } from '../../src/infra/queues';
import { RedisModule, RedisService } from '../../src/infra/redis';
import { TEST_DATABASE_URL, closeTestDb, testDb } from '../support/db';
import { createInfra, eventually, freePort, type InfraHarness } from '../support/infra';
import { deleteBullKeys, testBullPrefix, waitForState } from '../support/queues';

const ROOT = join(import.meta.dir, '../..');
const base = testBullPrefix();
type Child = ReturnType<typeof Bun.spawn>;
const children: Child[] = [];
const harnesses: InfraHarness[] = [];

afterAll(async () => {
  for (const child of children) child.kill();
  await Promise.all(harnesses.map((harness) => harness.close().catch(() => undefined)));
  const cleaner = await createInfra({ modules: [MetricsModule, RedisModule] });
  await deleteBullKeys(cleaner.get(RedisService).queue, base);
  await cleaner.close();
  await closeTestDb();
}, 30_000);

/** A child process with its output lines collected, so a test can wait for a marker. */
function spawn(script: string, env: Record<string, string>) {
  const child = Bun.spawn([process.execPath, '--no-env-file', script], {
    cwd: ROOT,
    env: {
      PATH: process.env.PATH ?? '',
      HOME: process.env.HOME ?? tmpdir(),
      NODE_ENV: 'test',
      HOST: '127.0.0.1',
      ...env,
    },
    stdout: 'pipe',
    stderr: 'pipe',
  });
  children.push(child);
  const lines: string[] = [];
  const pump = async (stream: ReadableStream<Uint8Array>) => {
    const decoder = new TextDecoder();
    let pending = '';
    for await (const chunk of stream) {
      pending += decoder.decode(chunk, { stream: true });
      const parts = pending.split('\n');
      pending = parts.pop() ?? '';
      lines.push(...parts);
    }
  };
  void pump(child.stdout);
  void pump(child.stderr);
  return { child, lines };
}

/** Sends a signal and waits for the exit, up to a limit; returns the exit code and how long it took. */
async function stop(child: Child, signal: 'SIGTERM' | 'SIGINT' = 'SIGTERM') {
  const started = performance.now();
  child.kill(signal);
  const code = await Promise.race([child.exited, Bun.sleep(12_000).then(() => 'timeout' as const)]);
  return { code, ms: performance.now() - started };
}

const harness = async (prefix: string): Promise<InfraHarness> => {
  const created = await createInfra({
    modules: [MetricsModule, RedisModule, QueuesModule],
    env: { BULL_PREFIX: prefix },
  });
  harnesses.push(created);
  return created;
};

describe('the real worker (bun src/worker.ts)', () => {
  it('starts the outbox relay and stops cleanly on SIGTERM', async () => {
    const prefix = `${base}-real`;
    const port = await freePort();
    const { child, lines } = spawn('src/worker.ts', {
      WORKER_METRICS_PORT: String(port),
      DATABASE_URL_TEST: TEST_DATABASE_URL,
      BULL_PREFIX: prefix,
      LOG_LEVEL: 'info',
    });
    const observer = await harness(prefix);
    const { db, pool } = await testDb();

    // 1. The relay's one-second scheduler is created in Redis by the worker process.
    await eventually(async () => {
      const schedulers = await observer.get(QueuesService).queue('outbox-relay').getJobSchedulers();
      return schedulers.some((scheduler) => scheduler.key === 'outbox-relay-tick') ? true : undefined;
    }, 15_000);

    // 2. The relay runs against the database: it tries an event whose type no module registered and counts an attempt.
    const [orphan] = await db
      .insert(s.outboxEvents)
      .values({ type: 'ghost.event', aggregateType: 'orders', aggregateId: 1, payload: { meta: {} } })
      .returning({ id: s.outboxEvents.id });
    await eventually(async () => {
      const [row] = await db.select().from(s.outboxEvents).where(eq(s.outboxEvents.id, orphan!.id));
      return row && row.attempts >= 1 ? true : undefined;
    }, 10_000);

    // 3. Its own metrics listener shows the ticks and the NOTIFY connection is open.
    // (The tick that found the event may still be running when the attempt shows: wait for a tick that has finished.)
    const metrics = await eventually(async () => {
      const text = await (await fetch(`http://127.0.0.1:${port}/metrics`)).text();
      return /queue_jobs_processed_total\{queue="outbox-relay",job="tick",outcome="completed"\} [1-9]/.test(text)
        ? text
        : undefined;
    }, 10_000);
    expect(metrics).toContain('outbox_relay_failures_total{reason="unmapped_type"}');
    const listening = async () =>
      Number(
        (
          await pool.query<{ n: string }>(
            `select count(*) as n from pg_stat_activity where application_name = 'gsm-outbox-listener'`,
          )
        ).rows[0]?.n,
      );
    expect(await listening()).toBeGreaterThanOrEqual(1);

    // 4. SIGTERM: it exits (Nest re-raises the signal, so 143 counts as clean) and gives its connections back.
    const { code, ms } = await stop(child);
    expect([0, 143]).toContain(code as number);
    expect(ms).toBeLessThan(6_000);
    // Postgres notices a closed connection a moment after the process is gone.
    await eventually(async () => ((await listening()) === 0 ? true : undefined), 3_000);
    expect(lines.some((line) => /error/i.test(line) && /"level":(50|60)/.test(line))).toBe(false);
    await db.delete(s.outboxEvents).where(eq(s.outboxEvents.id, orphan!.id));
  }, 40_000);
});

describe('a worker that is running a job when SIGTERM arrives', () => {
  it('finishes the job first and closes its connections afterwards', async () => {
    const prefix = `${base}-slow`;
    const port = await freePort();
    const { child, lines } = spawn('test/support/slow-worker.ts', {
      WORKER_METRICS_PORT: String(port),
      DATABASE_URL_TEST: TEST_DATABASE_URL,
      BULL_PREFIX: prefix,
    });
    const observer = await harness(prefix);
    const queues = observer.get(QueuesService);
    await eventually(() => (lines.some((line) => line.includes('[MARK] worker ready')) ? true : undefined), 20_000);

    const jobId = queueJobId('slow', 1);
    await queues.add('imports', 'bulk', { ms: 2_500 }, { jobId });
    await eventually(
      () => (lines.some((line) => line.includes(`[MARK] job start ${jobId}`)) ? true : undefined),
      10_000,
    );

    const { code, ms } = await stop(child);
    // The job had about 2 s left: the process waited for it, then closed.
    expect([0, 143]).toContain(code as number);
    expect(ms).toBeGreaterThan(1_000);
    expect(ms).toBeLessThan(10_000);

    const marks = lines.filter((line) => line.includes('[MARK]'));
    const at = (text: string) => marks.findIndex((line) => line.includes(text));
    expect(at(`job done ${jobId}`), marks.join('\n')).toBeGreaterThan(-1);
    expect(at('shutdown: connections close now')).toBeGreaterThan(at(`job done ${jobId}`));
    // The result reached Redis, which only works while the worker's connection is still open.
    const job = await waitForState(() => queues.queue('imports').getJob(jobId), 'completed', 5_000);
    expect(job.returnvalue).toBe('done');
  }, 45_000);
});
