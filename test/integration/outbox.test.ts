// Integration tests of the transactional outbox (decision 020) on the test database and the test queue Redis: an event is
// written in the caller's transaction and exists only if it commits; the relay hands each committed event to the queue of
// its type exactly once (also with two relays, and after a crash between the enqueue and the commit); a rolled-back event
// is never relayed; the queue Redis being down loses nothing; a NOTIFY wakes the relay within a second and the one-second
// tick is the safety net; the metrics tell lag and throughput. Lag, backlog age and the retry wait run on a TestClock
// (decision 031). The waits that remain are real on purpose: the NOTIFY wake-up and the one-second BullMQ tick are the
// behaviour under test, and the tests poll for their effect with `eventually`.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import { eq } from 'drizzle-orm';
import { Client } from 'pg';
import { runWithRequestId } from '../../src/common/request-id';
import { parseEnv } from '../../src/config';
import { DbModule, DbService, schema as s } from '../../src/infra/db';
import { MetricsModule, MetricsService } from '../../src/infra/metrics';
import { QueueWorkersModule, QueuesModule, QueuesService, queueJobId } from '../../src/infra/queues';
import { RedisModule, RedisService } from '../../src/infra/redis';
import {
  OutboxRelay,
  OutboxRelayModule,
  OutboxRouteRegistry,
  OutboxService,
  RELAY_BATCH_SIZE,
} from '../../src/modules/platform';
import { OutboxListener } from '../../src/modules/platform/outbox/outbox-listener';
import { ManualTimers, SECOND, TestClock } from '../support/clock';
import { TEST_DATABASE_URL, closeTestDb, testDb } from '../support/db';
import { type InfraHarness, createForwarder, createInfra, eventually, freePort } from '../support/infra';
import { metricValue } from '../support/metrics';
import { deleteBullKeys, testBullPrefix } from '../support/queues';
import { expectRejection } from '../support/rejection';
import { testInstanceEnv } from '../support/env';

const base = testBullPrefix();
const open: InfraHarness[] = [];
/** Rigs with a listener or workers keep relaying in the background: they are closed after their test, so that they cannot
 * take the events of the next test (every rig shares the database, and the relay takes whatever is pending). */
const background: InfraHarness[] = [];
const QUEUE = 'merchant-webhooks';

interface Rig {
  readonly harness: InfraHarness;
  readonly outbox: OutboxService;
  readonly relay: OutboxRelay;
  readonly queues: QueuesService;
  readonly db: DbService;
}

interface RigOptions {
  /** The BULL_PREFIX; every rig gets its own unless two rigs must share a queue (two workers). */
  readonly prefix?: string;
  /** Start the queue workers, which creates the one-second tick and runs it. */
  readonly workers?: boolean;
  /** Keep the NOTIFY listener (the default is to switch it off, so a test decides when the relay runs). */
  readonly listener?: boolean;
  /** The clock of the rig (decision 031): lag, backlog age and the retry wait are counted on it. Default the system clock. */
  readonly clock?: TestClock;
  /** The timers of the rig (the listener's reconnect wait); default the real ones. */
  readonly timers?: ManualTimers;
  readonly env?: Record<string, string>;
}

let rigs = 0;

/** The relay and its neighbours on the test instances, the way the worker process wires them. */
async function rig(options: RigOptions = {}): Promise<Rig> {
  const noListener = { onApplicationBootstrap: () => undefined, onModuleDestroy: () => undefined, listening: false };
  const harness = await createInfra({
    modules: [
      MetricsModule,
      RedisModule,
      DbModule,
      QueuesModule,
      ...(options.workers ? [QueueWorkersModule] : []),
      OutboxRelayModule,
    ],
    env: { DATABASE_URL_TEST: TEST_DATABASE_URL, BULL_PREFIX: options.prefix ?? `${base}-${++rigs}`, ...options.env },
    overrides: options.listener ? [] : [[OutboxListener, noListener]],
    ...(options.clock ? { clock: options.clock } : {}),
    ...(options.timers ? { timers: options.timers } : {}),
  });
  open.push(harness);
  if (options.listener || options.workers) background.push(harness);
  harness.get(OutboxRouteRegistry).register({ type: 'test.event', queue: QUEUE });
  return {
    harness,
    outbox: harness.get(OutboxService),
    relay: harness.get(OutboxRelay),
    queues: harness.get(QueuesService),
    db: harness.get(DbService),
  };
}

beforeAll(async () => {
  await testDb();
});
afterAll(async () => {
  await Promise.all(open.map((harness) => harness.close().catch(() => undefined)));
  const cleaner = await createInfra({ modules: [MetricsModule, RedisModule] });
  await deleteBullKeys(cleaner.get(RedisService).queue, base);
  await cleaner.close();
  await closeTestDb();
}, 30_000);
// Not resetDb: it restarts the ids, and a new event would get the job id of an old one that the queue still keeps.
beforeEach(async () => {
  const { db } = await testDb();
  await db.delete(s.outboxEvents);
});
afterEach(async () => {
  await Promise.all(background.splice(0).map((harness) => harness.close().catch(() => undefined)));
});

/** Writes one `test.event` in its own committed transaction. */
function addEvent(r: Rig, aggregateId: number) {
  return r.db.runInTransaction(({ tx }) =>
    r.outbox.add(tx, { type: 'test.event', aggregateType: 'orders', aggregateId, payload: { orderId: aggregateId } }),
  );
}

const rows = async () => (await testDb()).db.select().from(s.outboxEvents).orderBy(s.outboxEvents.id);
const jobOf = (r: Rig, eventId: number) => r.queues.queue(QUEUE).getJob(queueJobId('outbox', eventId));
const countJobs = async (r: Rig) =>
  await r.queues.queue(QUEUE).getJobCounts('waiting', 'active', 'delayed', 'completed', 'failed');

describe('OutboxService.add', () => {
  it('writes the event in the transaction of the caller, with the request id next to the ids', async () => {
    const r = await rig();
    const event = await runWithRequestId('req-outbox-1', () => addEvent(r, 42));
    expect(event).toMatchObject({
      type: 'test.event',
      aggregateType: 'orders',
      aggregateId: 42,
      payload: { orderId: 42, meta: { requestId: 'req-outbox-1' } },
      processedAt: null,
      attempts: 0,
    });
    expect(await rows()).toHaveLength(1);
  });

  it('writes nothing, and announces nothing, when the transaction rolls back', async () => {
    const r = await rig();
    const listener = new Client({ connectionString: TEST_DATABASE_URL });
    const heard: string[] = [];
    listener.on('notification', (message) => heard.push(message.payload ?? ''));
    await listener.connect();
    await listener.query('LISTEN outbox');
    try {
      await expectRejection(
        r.db.runInTransaction(async ({ tx }) => {
          await r.outbox.add(tx, {
            type: 'test.event',
            aggregateType: 'orders',
            aggregateId: 1,
            payload: { orderId: 1 },
          });
          throw new Error('the use case failed after writing the event');
        }),
        /the use case failed/,
      );
      const committed = await addEvent(r, 2);
      // Notifications reach a listener in commit order, so once this later one has arrived, everything announced before it
      // has too (no wait for "nothing else comes").
      const { pool } = await testDb();
      await pool.query(`select pg_notify('outbox', 'barrier')`);
      await eventually(() => (heard.includes('barrier') ? true : undefined));
      // Only the committed event was announced, with its id as the payload.
      expect(heard).toEqual([String(committed.id), 'barrier']);
      expect((await rows()).map((row) => row.aggregateId)).toEqual([2]);
    } finally {
      await listener.end();
    }
  });

  it('refuses an event type that no module registered, and an event that is not ids only', async () => {
    const r = await rig();
    await expectRejection(
      r.db.runInTransaction(({ tx }) =>
        r.outbox.add(tx, { type: 'ghost.event', aggregateType: 'orders', aggregateId: 1 }),
      ),
      /No queue is registered for the outbox event type "ghost.event"/,
    );
    await expectRejection(
      r.db.runInTransaction(({ tx }) =>
        r.outbox.add(tx, { type: 'test.event', aggregateType: 'orders', aggregateId: 1, payload: { amount: 12.5 } }),
      ),
      RangeError,
    );
    expect(await rows()).toHaveLength(0);
  });

  it('reports the backlog: how many events wait and for how long', async () => {
    const clock = new TestClock();
    const r = await rig({ clock });
    expect(await r.outbox.backlog(r.db.db)).toEqual({ pending: 0, oldestAgeSeconds: 0 });
    await addEvent(r, 1);
    clock.advance(20 * SECOND);
    await addEvent(r, 2);
    clock.advance(5 * SECOND);
    const backlog = await r.outbox.backlog(r.db.db);
    expect(backlog.pending).toBe(2);
    expect(backlog.oldestAgeSeconds).toBeCloseTo(25, 6);
  });
});

describe('the relay', () => {
  it('hands a committed event to the queue of its type exactly once, and marks it done in the same step', async () => {
    const r = await rig();
    const event = await runWithRequestId('req-relay-1', () => addEvent(r, 42));

    expect(await r.relay.run()).toEqual({ relayed: 1, failed: 0, queueUnavailable: false });
    const job = await jobOf(r, event.id);
    expect(job?.id).toBe(`outbox-${event.id}`);
    expect(job?.name).toBe('test.event');
    expect(job?.data).toEqual({
      eventId: event.id,
      type: 'test.event',
      aggregateType: 'orders',
      aggregateId: 42,
      payload: { orderId: 42 },
      requestId: 'req-relay-1',
    });
    const [row] = await rows();
    expect(row?.processedAt).toBeInstanceOf(Date);
    expect(row?.attempts).toBe(1);

    // A second run finds nothing to do and adds nothing.
    expect(await r.relay.run()).toEqual({ relayed: 0, failed: 0, queueUnavailable: false });
    expect((await countJobs(r)).waiting).toBe(1);
  });

  it('never relays an event whose transaction rolled back', async () => {
    const r = await rig();
    await expectRejection(
      r.db.runInTransaction(async ({ tx }) => {
        await r.outbox.add(tx, {
          type: 'test.event',
          aggregateType: 'orders',
          aggregateId: 9,
          payload: { orderId: 9 },
        });
        throw new Error('rolled back');
      }),
    );
    const kept = await addEvent(r, 10);
    expect(await r.relay.run()).toMatchObject({ relayed: 1 });
    const counts = await countJobs(r);
    expect(counts.waiting).toBe(1);
    expect((await jobOf(r, kept.id))?.data).toMatchObject({ aggregateId: 10 });
  });

  it('shares one run between callers that arrive together', async () => {
    const r = await rig();
    await addEvent(r, 1);
    const first = r.relay.run();
    const joined = r.relay.run();
    expect(joined).toBe(first);
    expect(await first).toMatchObject({ relayed: 1 });
    expect((await countJobs(r)).waiting).toBe(1);
  });

  it('handles an event that was committed before a call, whether or not a run was going on at that moment', async () => {
    const r = await rig();
    for (let n = 1; n <= 20; n++) {
      await addEvent(r, n * 2);
      const running = r.relay.run(); // a run starts and reads the table ...
      const late = await addEvent(r, n * 2 + 1); // ... an event commits meanwhile ...
      await Promise.all([running, r.relay.run()]); // ... and the call that follows must cover it, joined or not
      expect((await rows()).find((row) => row.id === late.id)?.processedAt, `round ${n}`).toBeInstanceOf(Date);
    }
    expect((await countJobs(r)).waiting).toBe(40);
  });

  it('lets two relays share a backlog without handing any event over twice (two workers)', async () => {
    const prefix = `${base}-shared`;
    const a = await rig({ prefix });
    const b = await rig({ prefix });
    for (let n = 1; n <= 150; n++) await addEvent(a, n);
    const [x, y] = await Promise.all([a.relay.run(), b.relay.run()]);
    expect(x.relayed + y.relayed).toBe(150);
    const all = await rows();
    expect(all).toHaveLength(150);
    expect(all.every((row) => row.processedAt !== null && row.attempts === 1)).toBe(true);
    expect((await countJobs(a)).waiting).toBe(150);
  });

  it('empties a backlog bigger than one batch in a single run', async () => {
    const r = await rig();
    const total = RELAY_BATCH_SIZE * 2 + 50;
    for (let n = 1; n <= total; n++) await addEvent(r, n);
    expect(RELAY_BATCH_SIZE).toBe(100);
    expect(await r.relay.run()).toEqual({ relayed: total, failed: 0, queueUnavailable: false });
    expect((await countJobs(r)).waiting).toBe(total);
  }, 30_000);

  it('survives a crash between the enqueue and the commit: the event is handed over again, and the queue keeps one job', async () => {
    const r = await rig();
    const event = await addEvent(r, 5);
    // The crashed pass had added the job and then died before it could set processed_at.
    await r.queues.add(QUEUE, 'test.event', { eventId: event.id }, { jobId: queueJobId('outbox', event.id) });
    expect((await rows())[0]?.processedAt).toBeNull();

    expect(await r.relay.run()).toMatchObject({ relayed: 1 });
    expect((await rows())[0]?.processedAt).toBeInstanceOf(Date);
    expect((await countJobs(r)).waiting).toBe(1);
  });

  it('keeps the events pending while the queue Redis is down, counts no attempt, and hands them over when it is back', async () => {
    const real = new URL(parseEnv({ NODE_ENV: 'test', ...testInstanceEnv() }).redis.queueUrl);
    const forwarder = await createForwarder({ host: real.hostname, port: Number(real.port) });
    const r = await rig({ env: { REDIS_QUEUE_URL_TEST: `redis://127.0.0.1:${forwarder.port}/1` } });
    await addEvent(r, 1);
    await addEvent(r, 2);

    const before = performance.now();
    expect(await r.relay.run()).toEqual({ relayed: 0, failed: 0, queueUnavailable: true });
    expect(performance.now() - before).toBeLessThan(1_500);
    expect((await rows()).map((row) => [row.processedAt, row.attempts])).toEqual([
      [null, 0],
      [null, 0],
    ]);
    const text = await r.harness.get(MetricsService).render();
    expect(metricValue(text, 'outbox_relay_failures_total', { reason: 'queue_unavailable' })).toBe(1);

    await forwarder.start();
    try {
      const result = await eventually(async () => {
        const attempt = await r.relay.run();
        return attempt.queueUnavailable ? undefined : attempt;
      }, 15_000);
      expect(result.relayed).toBe(2);
      expect((await rows()).every((row) => row.processedAt !== null && row.attempts === 1)).toBe(true);
    } finally {
      await forwarder.stop();
    }
  }, 30_000);

  it('does not let an event nobody can handle block the others: it counts an attempt and waits before the next', async () => {
    const clock = new TestClock();
    const r = await rig({ clock });
    const { db } = await testDb();
    // Written behind the service's back, as an older version of the app might have left it.
    const [ghost] = await db
      .insert(s.outboxEvents)
      .values({ type: 'ghost.event', aggregateType: 'orders', aggregateId: 1, payload: { meta: {} } })
      .returning();
    const good = await addEvent(r, 2);

    expect(await r.relay.run()).toEqual({ relayed: 1, failed: 1, queueUnavailable: false });
    expect((await jobOf(r, good.id))?.id).toBe(`outbox-${good.id}`);
    let [ghostNow] = await db.select().from(s.outboxEvents).where(eq(s.outboxEvents.id, ghost!.id));
    expect(ghostNow).toMatchObject({ processedAt: null, attempts: 1 });

    // It waits 2 seconds after the first failure: an immediate run leaves it alone, and so does one a millisecond short.
    expect(await r.relay.run()).toEqual({ relayed: 0, failed: 0, queueUnavailable: false });
    clock.advance(2 * SECOND - 1);
    expect(await r.relay.run()).toEqual({ relayed: 0, failed: 0, queueUnavailable: false });
    [ghostNow] = await db.select().from(s.outboxEvents).where(eq(s.outboxEvents.id, ghost!.id));
    expect(ghostNow?.attempts).toBe(1);

    // After the wait it is tried again, and the wait doubles to 4 seconds.
    clock.advance(1);
    expect(await r.relay.run()).toEqual({ relayed: 0, failed: 1, queueUnavailable: false });
    [ghostNow] = await db.select().from(s.outboxEvents).where(eq(s.outboxEvents.id, ghost!.id));
    expect(ghostNow?.attempts).toBe(2);
    clock.advance(4 * SECOND - 1);
    expect(await r.relay.run()).toEqual({ relayed: 0, failed: 0, queueUnavailable: false });
    clock.advance(1);
    expect(await r.relay.run()).toEqual({ relayed: 0, failed: 1, queueUnavailable: false });
    const text = await r.harness.get(MetricsService).render();
    expect(metricValue(text, 'outbox_relay_failures_total', { reason: 'unmapped_type' })).toBe(3);
  });

  it('publishes throughput, lag and the backlog', async () => {
    const clock = new TestClock();
    const r = await rig({ clock });
    await addEvent(r, 1);
    await addEvent(r, 2);
    clock.advance(30);
    let text = await r.harness.get(MetricsService).render();
    expect(metricValue(text, 'outbox_pending_events')).toBe(2);
    expect(metricValue(text, 'outbox_oldest_pending_age_seconds')).toBeCloseTo(0.03, 6);

    await r.relay.run();
    text = await r.harness.get(MetricsService).render();
    expect(metricValue(text, 'outbox_events_relayed_total', { queue: QUEUE })).toBe(2);
    expect(metricValue(text, 'outbox_relay_lag_seconds_count')).toBe(2);
    expect(metricValue(text, 'outbox_relay_lag_seconds_sum')).toBeCloseTo(0.06, 6);
    expect(metricValue(text, 'outbox_pending_events')).toBe(0);
    expect(metricValue(text, 'outbox_oldest_pending_age_seconds')).toBe(0);
  });
});

describe('the backlog gauges when the database cannot be read', () => {
  it('leave the series out of the scrape instead of showing an empty backlog', async () => {
    const dead = new URL(TEST_DATABASE_URL);
    dead.port = String(await freePort());
    const r = await rig({ env: { DATABASE_URL_TEST: dead.toString() } });
    const text = await r.harness.get(MetricsService).render();
    expect(text).toContain('# HELP outbox_pending_events');
    expect(text).not.toMatch(/^outbox_pending_events /m);
    expect(text).not.toMatch(/^outbox_oldest_pending_age_seconds /m);
    // The counters do not depend on the database and stay in the scrape.
    expect(text).toContain('# HELP outbox_events_relayed_total');
  });
});

describe('waking the relay', () => {
  it('relays within a second of the commit through the NOTIFY wake-up, with no tick running', async () => {
    const r = await rig({ listener: true });
    await eventually(() => (r.harness.get(OutboxListener).listening ? true : undefined));
    const started = performance.now();
    const event = await addEvent(r, 77);
    const job = await eventually(() => jobOf(r, event.id), 3_000);
    expect(performance.now() - started).toBeLessThan(1_500);
    expect(job.data).toMatchObject({ aggregateId: 77 });
    await eventually(async () => ((await rows())[0]?.processedAt ? true : undefined));
  });

  it('relays by the one-second tick when no NOTIFY arrives (the safety net)', async () => {
    const r = await rig({ workers: true });
    // Written without a NOTIFY and with no listener: only the tick can find it.
    const { db } = await testDb();
    const [row] = await db
      .insert(s.outboxEvents)
      .values({ type: 'test.event', aggregateType: 'orders', aggregateId: 88, payload: { orderId: 88, meta: {} } })
      .returning();
    const job = await eventually(() => jobOf(r, row!.id), 6_000);
    expect(job.data).toMatchObject({ aggregateId: 88, requestId: `outbox-${row!.id}` });
    // The tick scheduler exists once, and its jobs are the relay's own.
    const schedulers = await r.queues.queue('outbox-relay').getJobSchedulers();
    expect(schedulers.filter((scheduler) => scheduler.key === 'outbox-relay-tick')).toHaveLength(1);
  }, 20_000);

  it('listens again after its connection is killed, so events are still relayed at once', async () => {
    const timers = new ManualTimers();
    const r = await rig({ listener: true, timers });
    const listener = r.harness.get(OutboxListener);
    await eventually(() => (listener.listening ? true : undefined));
    const { pool } = await testDb();
    const { rows: found } = await pool.query<{ pid: number }>(
      `select pid from pg_stat_activity where datname = current_database() and application_name = 'gsm-outbox-listener' and pid <> pg_backend_pid()`,
    );
    expect(found.length).toBeGreaterThanOrEqual(1);
    for (const { pid } of found) await pool.query('select pg_terminate_backend($1)', [pid]);
    // The listener notices the loss and plans its reconnect; the test fires the timer instead of waiting for it.
    await eventually(() => (timers.pending > 0 ? true : undefined));
    timers.advance(10_000);
    await eventually(() => (listener.listening ? true : undefined), 10_000);

    const event = await addEvent(r, 99);
    expect((await eventually(() => jobOf(r, event.id), 3_000)).data).toMatchObject({ aggregateId: 99 });
  }, 30_000);

  it('gives its Postgres connection back on shutdown', async () => {
    const r = await rig({ listener: true });
    await eventually(() => (r.harness.get(OutboxListener).listening ? true : undefined));
    const { pool } = await testDb();
    const count = async () =>
      Number(
        (
          await pool.query<{ n: string }>(
            `select count(*) as n from pg_stat_activity where datname = current_database() and application_name = 'gsm-outbox-listener'`,
          )
        ).rows[0]?.n,
      );
    const before = await count();
    expect(before).toBeGreaterThanOrEqual(1);
    await r.harness.close();
    await eventually(async () => ((await count()) < before ? true : undefined), 3_000);
  });
});
