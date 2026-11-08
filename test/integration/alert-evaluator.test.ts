// Integration tests of the alert evaluator (feature 12b, scenario system-alert steps 3, 4 and 10): every metric of the registry judged against its
// rule over its window, one open alert per rule and subject, mutes, recovery, the notification seam and the job run it records. Time is the TestClock.
import { afterAll, beforeAll, beforeEach, describe, expect, it, spyOn } from 'bun:test';
import type { Job } from 'bullmq';
import { eq } from 'drizzle-orm';
import { EncryptionService } from '../../src/infra/crypto';
import { schema as s } from '../../src/infra/db';
import { QueuesService } from '../../src/infra/queues';
import { RedisService } from '../../src/infra/redis';
import {
  ALERT_EVALUATION_JOB,
  AlertEvaluationProcessor,
  AlertEvaluator,
  AlertNotifier,
  HealthJobsModule,
} from '../../src/modules/health';
import { AlertMetricReader } from '../../src/modules/health/application/alert-metrics';
import { alertsEvaluatedSince } from '../../src/modules/health/infra/alerts-read.repository';
import { type AdminApi, adminWith } from '../support/admin-api';
import { addCalls, insertRule, insertSupplier, noticeOfCall, pick } from '../support/alerts';
import { type TestApp, createTestApp } from '../support/app';
import { clearIdentityCaches } from '../support/auth';
import { CacheKeys } from '../../src/infra/cache';
import { HOUR, MINUTE, TestClock } from '../support/clock';
import { closeTestDb, resetDb, testDb } from '../support/db';
import { eventually } from '../support/infra';
import { insertOrderRow, ordersWorld } from '../support/orders';
import { deleteBullKeys, testBullPrefix } from '../support/queues';
import { insertDelivery, insertEndpoint } from '../support/webhooks';

const prefix = testBullPrefix();
const clock = new TestClock('2026-11-07T10:00:00.000Z');
const promQueries: string[] = [];
let promAnswer: { value: string } | 'down' = { value: '1200' };

/** A Prometheus that answers every instant query with one sample, or fails when told to. */
const prometheus = Bun.serve({
  port: 0,
  fetch(request) {
    promQueries.push(new URL(request.url).searchParams.get('query') ?? '');
    if (promAnswer === 'down') return new Response('down', { status: 500 });
    return Response.json({
      status: 'success',
      data: { resultType: 'vector', result: [{ metric: {}, value: [0, promAnswer.value] }] },
    });
  },
});

let t: TestApp;
let evaluator: AlertEvaluator;
let notifier: AlertNotifier;
let fired: ReturnType<typeof spyOn>;
let resolved: ReturnType<typeof spyOn>;

beforeAll(async () => {
  t = await createTestApp({
    clock,
    env: { BULL_PREFIX: prefix, PROMETHEUS_URL: `http://127.0.0.1:${prometheus.port}` },
    imports: [HealthJobsModule],
  });
  evaluator = t.app.get(AlertEvaluator, { strict: false });
  notifier = t.app.get(AlertNotifier, { strict: false });
});
beforeEach(async () => {
  clock.set('2026-11-07T10:00:00.000Z');
  promQueries.length = 0;
  promAnswer = { value: '1200' };
  await resetDb();
  await clearIdentityCaches(t);
  fired = spyOn(notifier, 'fired');
  resolved = spyOn(notifier, 'resolved');
  // A spy on a method that is already spied returns the same one, with the calls of the earlier tests.
  fired.mockClear();
  resolved.mockClear();
});
afterAll(async () => {
  await prometheus.stop(true);
  await resetDb();
  await clearIdentityCaches(t);
  await deleteBullKeys(t.app.get(RedisService, { strict: false }).queue, prefix);
  await t.close();
  await closeTestDb();
});

const alerts = async () => (await testDb()).db.select().from(s.alertEvents).orderBy(s.alertEvents.id);
const ago = (ms: number) => new Date(clock.nowMs() - ms);
/**
 * Lets a measured metric recover the way production sees it: once a minute, for some minutes, a fresh ok call is inside the window and the evaluator
 * runs (a rate closes its alert only after three consecutive ok minutes, RULES health 8).
 *
 * @returns the report of each run
 */
async function okMinutes(supplier: number, minutes: number) {
  const reports = [];
  for (let i = 0; i < minutes; i += 1) {
    clock.advance(MINUTE);
    await addCalls((await testDb()).db, supplier, ['ok'], ago(10_000));
    reports.push(await evaluator.evaluateAll());
  }
  return reports;
}

describe('supplier call metrics (supplier.timeout_rate, supplier.error_rate)', () => {
  it('fires over the limit with the rule snapshot, the supplier as subject and one notice (scenario step 3, 4)', async () => {
    const { db } = await testDb();
    const rule = await insertRule(db, {
      key: 'supplier_timeout_rate',
      name: 'Supplier timeouts',
      channels: ['telegram', 'email'],
    });
    const slow = await insertSupplier(db, 'Bosphorus Unlock');
    const fine = await insertSupplier(db, 'Gulf Server Hub');
    await addCalls(db, slow, ['timeout', 'timeout', 'ok', 'ok', 'ok', 'ok', 'ok', 'ok'], ago(MINUTE));
    await addCalls(db, fine, ['ok', 'ok', 'ok', 'ok', 'timeout'], ago(MINUTE));
    const report = await evaluator.evaluateAll();
    expect(report).toEqual({ rules: 1, evaluated: 1, unevaluated: 0, unevaluatedRules: [], fired: 1, resolved: 0 });
    const [alert, ...rest] = await alerts();
    expect(rest).toEqual([]);
    expect(alert).toMatchObject({
      ruleId: rule.id,
      ruleName: 'Supplier timeouts',
      metric: 'supplier.timeout_rate',
      comparator: 'gt',
      threshold: '20.0000',
      windowSeconds: 180,
      unit: 'percent',
      status: 'firing',
      severity: 'critical',
      value: '25.0000',
      subjectType: 'supplier',
      subjectId: slow,
      subjectLabel: 'Bosphorus Unlock',
      subjectKey: `supplier:${slow}`,
      startedAt: clock.now(),
      acknowledgedAt: null,
      resolvedAt: null,
    });
    // The notifier is told once, with the channels the rule had.
    expect(fired).toHaveBeenCalledTimes(1);
    expect(pick(noticeOfCall(fired), ['alertId', 'ruleName', 'channels', 'subjectType', 'value'])).toEqual({
      alertId: alert!.id,
      ruleName: 'Supplier timeouts',
      channels: ['telegram', 'email'],
      subjectType: 'supplier',
      value: 25,
    });
    expect(resolved).not.toHaveBeenCalled();
  });

  it('never opens a second alert, and never pages twice, for a subject whose alert is open', async () => {
    const { db } = await testDb();
    await insertRule(db);
    const supplier = await insertSupplier(db, 'Bosphorus Unlock');
    await addCalls(db, supplier, ['timeout', 'ok'], ago(MINUTE));
    await evaluator.evaluateAll();
    clock.advance(MINUTE);
    await addCalls(db, supplier, ['timeout', 'timeout'], ago(10_000));
    expect((await evaluator.evaluateAll()).fired).toBe(0);
    expect(await alerts()).toHaveLength(1);
    expect(fired).toHaveBeenCalledTimes(1);
  });

  it('opens it once when two evaluation runs overlap (the partial unique index decides)', async () => {
    const { db } = await testDb();
    await insertRule(db);
    const supplier = await insertSupplier(db, 'Bosphorus Unlock');
    await addCalls(db, supplier, ['timeout', 'timeout', 'ok'], ago(MINUTE));
    const reports = await Promise.all([evaluator.evaluateAll(), evaluator.evaluateAll(), evaluator.evaluateAll()]);
    expect(reports.reduce((sum, report) => sum + report.fired, 0)).toBe(1);
    expect(await alerts()).toHaveLength(1);
    expect(fired).toHaveBeenCalledTimes(1);
  });

  it('opens one alert per supplier for the same rule', async () => {
    const { db } = await testDb();
    await insertRule(db);
    const a = await insertSupplier(db, 'Supplier A');
    const b = await insertSupplier(db, 'Supplier B');
    for (const id of [a, b]) await addCalls(db, id, ['timeout', 'timeout', 'ok'], ago(MINUTE));
    expect((await evaluator.evaluateAll()).fired).toBe(2);
    expect((await alerts()).map((alert) => alert.subjectLabel).sort()).toEqual(['Supplier A', 'Supplier B']);
  });

  it('measures over the rule window: calls older than the window do not count, and recovery is the window sliding past (scenario step 10)', async () => {
    const { db } = await testDb();
    await insertRule(db, { windowSeconds: 180 });
    const supplier = await insertSupplier(db, 'Bosphorus Unlock');
    // Timeouts four minutes ago are outside a 3 minute window.
    await addCalls(db, supplier, ['timeout', 'timeout', 'timeout'], ago(4 * MINUTE));
    await addCalls(db, supplier, ['ok', 'ok'], ago(MINUTE));
    expect((await evaluator.evaluateAll()).fired).toBe(0);
    // Now timeouts inside the window.
    await addCalls(db, supplier, ['timeout', 'timeout', 'timeout'], ago(30_000));
    expect((await evaluator.evaluateAll()).fired).toBe(1);
    // Two minutes later the bad calls are 2.5 min old: still inside the window, still firing.
    clock.advance(2 * MINUTE);
    const still = await evaluator.evaluateAll();
    expect(still).toMatchObject({ fired: 0, resolved: 0 });
    // Three minutes after them only the later ok calls are inside the window: the value is back in range, but the alert closes only after three
    // consecutive ok minutes (scenario step 10), not when the window slides past.
    clock.advance(MINUTE);
    await addCalls(db, supplier, ['ok', 'ok', 'ok'], ago(MINUTE));
    expect(await evaluator.evaluateAll()).toMatchObject({ fired: 0, resolved: 0 });
    expect((await alerts())[0]!.status).toBe('firing');
    const [afterOne, afterTwo, afterThree] = await okMinutes(supplier, 3);
    expect([afterOne!.resolved, afterTwo!.resolved, afterThree!.resolved]).toEqual([0, 0, 1]);
    expect((await alerts())[0]).toMatchObject({ status: 'resolved', resolvedAt: clock.now() });
    expect(resolved).toHaveBeenCalledTimes(1);
    expect(pick(noticeOfCall(resolved), ['value'])).toEqual({ value: 0 });
  });

  it('resolves an acknowledged alert too when the value is back in range, and not before', async () => {
    const { db } = await testDb();
    await insertRule(db);
    const supplier = await insertSupplier(db, 'Bosphorus Unlock');
    await addCalls(db, supplier, ['timeout', 'ok'], ago(MINUTE));
    await evaluator.evaluateAll();
    const staff: AdminApi = await adminWith(t, ['alerts:update'], { name: 'Dana M.' });
    const [alert] = await alerts();
    expect((await staff.post(`/admin/alerts/${alert!.id}/ack`, {})).status).toBe(200);
    clock.advance(MINUTE);
    expect((await evaluator.evaluateAll()).resolved).toBe(0);
    expect((await alerts())[0]!.status).toBe('acknowledged');
    clock.advance(5 * MINUTE);
    await addCalls(db, supplier, ['ok', 'ok'], ago(30_000));
    // Back in range, but only three consecutive ok minutes close it.
    expect((await evaluator.evaluateAll()).resolved).toBe(0);
    expect((await alerts())[0]!.status).toBe('acknowledged');
    expect((await okMinutes(supplier, 3)).map((report) => report.resolved)).toEqual([0, 0, 1]);
    expect((await alerts())[0]).toMatchObject({ status: 'resolved', acknowledgedBy: staff.staffId });
  });

  it('judges no data as neither a breach nor a recovery: a supplier with no calls in the window changes nothing', async () => {
    const { db } = await testDb();
    await insertRule(db);
    const supplier = await insertSupplier(db, 'Quiet Supplier');
    expect(await evaluator.evaluateAll()).toMatchObject({ fired: 0, resolved: 0 });
    await addCalls(db, supplier, ['timeout'], ago(MINUTE));
    await evaluator.evaluateAll();
    clock.advance(10 * MINUTE);
    expect(await evaluator.evaluateAll()).toMatchObject({ fired: 0, resolved: 0 });
    expect((await alerts())[0]!.status).toBe('firing');
  });

  it('resolves the alert of a supplier that was disabled (its checks are off, nothing is measured any more)', async () => {
    const { db } = await testDb();
    await insertRule(db);
    const supplier = await insertSupplier(db, 'Bosphorus Unlock');
    await addCalls(db, supplier, ['timeout', 'ok'], ago(MINUTE));
    await evaluator.evaluateAll();
    await db.update(s.suppliers).set({ status: 'disabled' }).where(eq(s.suppliers.id, supplier));
    expect((await evaluator.evaluateAll()).resolved).toBe(1);
    expect((await alerts())[0]!.status).toBe('resolved');
  });

  it('judges supplier.error_rate on error calls only', async () => {
    const { db } = await testDb();
    await insertRule(db, { key: 'supplier_errors', metric: 'supplier.error_rate', threshold: '40.0000' });
    const supplier = await insertSupplier(db, 'Erroring Supplier');
    await addCalls(db, supplier, ['timeout', 'timeout', 'timeout', 'ok'], ago(MINUTE));
    expect((await evaluator.evaluateAll()).fired).toBe(0);
    await addCalls(db, supplier, ['error', 'error', 'error'], ago(MINUTE));
    expect(await evaluator.evaluateAll()).toMatchObject({ fired: 1 });
    expect((await alerts())[0]).toMatchObject({ metric: 'supplier.error_rate', value: '42.8571', unit: 'percent' });
  });
});

describe('mutes, switches and deleted rules', () => {
  it('opens nothing while the rule is muted, keeps an open alert open and still resolves it, and fires again when the mute ends', async () => {
    const { db } = await testDb();
    const rule = await insertRule(db, { mutedUntil: new Date(clock.nowMs() + HOUR) });
    const supplier = await insertSupplier(db, 'Bosphorus Unlock');
    await addCalls(db, supplier, ['timeout', 'ok'], ago(MINUTE));
    expect(await evaluator.evaluateAll()).toMatchObject({ evaluated: 1, fired: 0 });
    expect(await alerts()).toHaveLength(0);
    // An alert opened before the mute stays open while muted ...
    await db.update(s.alertRules).set({ mutedUntil: null }).where(eq(s.alertRules.id, rule.id));
    await evaluator.evaluateAll();
    await db
      .update(s.alertRules)
      .set({ mutedUntil: new Date(clock.nowMs() + HOUR) })
      .where(eq(s.alertRules.id, rule.id));
    expect((await evaluator.evaluateAll()).resolved).toBe(0);
    expect((await alerts())[0]!.status).toBe('firing');
    // ... and resolves when the value has been back in range for three minutes, mute or not.
    clock.advance(5 * MINUTE);
    await addCalls(db, supplier, ['ok'], ago(MINUTE));
    expect((await evaluator.evaluateAll()).resolved).toBe(0);
    expect((await okMinutes(supplier, 3)).map((report) => report.resolved)).toEqual([0, 0, 1]);
    // After the mute a new breach fires again.
    clock.advance(2 * HOUR);
    await addCalls(db, supplier, ['timeout'], ago(MINUTE));
    expect((await evaluator.evaluateAll()).fired).toBe(1);
    expect(await alerts()).toHaveLength(2);
  });

  it('skips a rule that is switched off or deleted', async () => {
    const { db } = await testDb();
    await insertRule(db, { key: 'off_rule', isActive: false });
    await insertRule(db, { key: 'deleted_rule', deletedAt: clock.now() });
    const supplier = await insertSupplier(db, 'Bosphorus Unlock');
    await addCalls(db, supplier, ['timeout'], ago(MINUTE));
    expect(await evaluator.evaluateAll()).toMatchObject({ rules: 0, fired: 0 });
  });
});

describe('the other metrics', () => {
  it('supplier.balance: fires below the threshold for a supplier whose balance was read, and not for one never read', async () => {
    const { db } = await testDb();
    await insertRule(db, {
      key: 'balance_low',
      metric: 'supplier.balance',
      comparator: 'lt',
      threshold: '150.0000',
      windowSeconds: 60,
      severity: 'warning',
    });
    const low = await insertSupplier(db, 'Gulf Server Hub', { balance: '118.2000', balanceCheckedAt: ago(MINUTE) });
    await insertSupplier(db, 'New Supplier', { balance: '0.0000', balanceCheckedAt: null });
    await insertSupplier(db, 'Rich Supplier', { balance: '900.0000', balanceCheckedAt: ago(MINUTE) });
    // A balance is a reading of the moment: it must stay low for the rule's whole window before the alert opens ...
    expect((await evaluator.evaluateAll()).fired).toBe(0);
    clock.advance(MINUTE);
    expect((await evaluator.evaluateAll()).fired).toBe(1);
    expect((await alerts())[0]).toMatchObject({ subjectId: low, value: '118.2000', unit: null, severity: 'warning' });
    // ... and back in range for the whole window before it closes.
    await db.update(s.suppliers).set({ balance: '500.0000' }).where(eq(s.suppliers.id, low));
    expect((await evaluator.evaluateAll()).resolved).toBe(0);
    clock.advance(MINUTE);
    expect((await evaluator.evaluateAll()).resolved).toBe(1);
  });

  it('ledger.mismatch_count: reads the newest succeeded integrity run, fires on a mismatch and resolves on a clean run', async () => {
    const { db } = await testDb();
    await insertRule(db, {
      key: 'ledger_mismatch',
      metric: 'ledger.mismatch_count',
      threshold: '0.0000',
      windowSeconds: 60,
    });
    // Never run: no value, nothing happens.
    expect(await evaluator.evaluateAll()).toMatchObject({ fired: 0 });
    const run = (mismatchCount: number, status: 'succeeded' | 'failed' = 'succeeded') =>
      db.insert(s.jobRuns).values({
        job: 'ledger_integrity',
        trigger: 'schedule',
        status,
        startedAt: clock.now(),
        finishedAt: clock.now(),
        result: { mismatchCount },
      });
    await run(2);
    expect(await evaluator.evaluateMetric('ledger.mismatch_count')).toMatchObject({ fired: 1 });
    expect((await alerts())[0]).toMatchObject({
      subjectType: 'system',
      subjectId: null,
      subjectLabel: null,
      value: '2.0000',
      unit: 'count',
      subjectKey: 'system',
    });
    clock.advance(MINUTE);
    // A failed run is not a reading.
    await run(0, 'failed');
    expect((await evaluator.evaluateMetric('ledger.mismatch_count')).resolved).toBe(0);
    clock.advance(MINUTE);
    await run(0);
    expect((await evaluator.evaluateMetric('ledger.mismatch_count')).resolved).toBe(1);
  });

  it('evaluateMetric judges only the rules of that metric', async () => {
    const { db } = await testDb();
    await insertRule(db, { key: 'ledger_mismatch', metric: 'ledger.mismatch_count', threshold: '0.0000' });
    await insertRule(db, { key: 'timeouts' });
    const supplier = await insertSupplier(db, 'Bosphorus Unlock');
    await addCalls(db, supplier, ['timeout'], ago(MINUTE));
    await db.insert(s.jobRuns).values({
      job: 'ledger_integrity',
      trigger: 'schedule',
      status: 'succeeded',
      startedAt: clock.now(),
      result: { mismatchCount: 1 },
    });
    expect(await evaluator.evaluateMetric('ledger.mismatch_count')).toMatchObject({ rules: 1, fired: 1 });
    expect((await alerts()).map((alert) => alert.metric)).toEqual(['ledger.mismatch_count']);
  });

  it('orders.past_sla: counts the open orders past their SLA', async () => {
    const { db } = await testDb();
    const world = await ordersWorld(db);
    await insertRule(db, { key: 'past_sla', metric: 'orders.past_sla', threshold: '3.0000', windowSeconds: 60 });
    const late = () =>
      insertOrderRow(db, {
        serviceId: world.auto.serviceId,
        clientId: world.merchant.id,
        status: 'pending',
        dispatchState: 'pending',
        placedAt: ago(2 * HOUR),
        createdAt: ago(2 * HOUR),
      });
    for (let i = 0; i < 3; i += 1) await late();
    expect((await evaluator.evaluateAll()).fired).toBe(0);
    await late();
    // Over the limit from now on; held for the minute of the window at the next tick.
    expect((await evaluator.evaluateAll()).fired).toBe(0);
    clock.advance(MINUTE);
    expect((await evaluator.evaluateAll()).fired).toBe(1);
    expect((await alerts())[0]).toMatchObject({
      metric: 'orders.past_sla',
      value: '4.0000',
      unit: 'count',
      subjectType: 'system',
    });
  });

  it('webhooks.success_rate: delivered over delivered plus failed inside the window', async () => {
    const { db } = await testDb();
    const world = await ordersWorld(db);
    const endpoint = await insertEndpoint(t.app.get(EncryptionService, { strict: false }), db, world.merchant.id);
    await insertRule(db, {
      key: 'webhook_delivery',
      metric: 'webhooks.success_rate',
      comparator: 'lt',
      threshold: '95.0000',
      windowSeconds: 600,
      severity: 'warning',
    });
    // Nothing delivered in the window: no data.
    expect((await evaluator.evaluateAll()).fired).toBe(0);
    for (let i = 0; i < 9; i += 1)
      await insertDelivery(db, endpoint, { status: 'delivered', nextRetryAt: null, createdAt: ago(MINUTE) });
    await insertDelivery(db, endpoint, { status: 'failed', nextRetryAt: null, createdAt: ago(MINUTE) });
    // An old failure outside the window does not count.
    await insertDelivery(db, endpoint, { status: 'failed', nextRetryAt: null, createdAt: ago(HOUR) });
    expect((await evaluator.evaluateAll()).fired).toBe(1);
    expect((await alerts())[0]).toMatchObject({ metric: 'webhooks.success_rate', value: '90.0000', unit: 'percent' });
  });

  it('queue.oldest_age: one alert per queue, named by the queue, subject id null (sent as 0)', async () => {
    const { db } = await testDb();
    const queues = t.app.get(QueuesService, { strict: false });
    await insertRule(db, {
      key: 'queue_oldest_job',
      metric: 'queue.oldest_age',
      threshold: '3600.0000',
      windowSeconds: 120,
      severity: 'warning',
    });
    await queues.add('files', 'probe', {});
    // BullMQ stamps the job with the real time; the test clock runs two hours ahead of it.
    clock.set(Date.now() + 2 * HOUR);
    expect((await evaluator.evaluateAll()).fired).toBe(0);
    clock.advance(2 * MINUTE);
    const report = await evaluator.evaluateAll();
    expect(report.fired).toBe(1);
    const [alert] = await alerts();
    expect(alert).toMatchObject({
      subjectType: 'queue',
      subjectId: null,
      subjectLabel: 'files',
      subjectKey: 'queue:files',
      unit: 's',
    });
    expect(Number(alert!.value)).toBeGreaterThan(7000);
    // Another queue alert is another subject of the same rule.
    const staff = await adminWith(t, ['alerts:read']);
    expect((await staff.get(`/admin/alerts/${alert!.id}`)).body).toMatchObject({
      subjectType: 'queue',
      subjectId: 0,
      subjectLabel: 'files',
    });
  });

  it('db.connection_usage and redis.memory_usage: read the connection and memory usage as percentages', async () => {
    const { db } = await testDb();
    await insertRule(db, {
      key: 'db_connections',
      metric: 'db.connection_usage',
      threshold: '0.0000',
      windowSeconds: 60,
    });
    await insertRule(db, {
      key: 'redis_memory',
      metric: 'redis.memory_usage',
      threshold: '0.0000',
      windowSeconds: 60,
    });
    expect(await evaluator.evaluateAll()).toMatchObject({ evaluated: 2, unevaluated: 0, fired: 0 });
    clock.advance(MINUTE);
    const report = await evaluator.evaluateAll();
    expect(report).toMatchObject({ evaluated: 2, unevaluated: 0, fired: 2 });
    for (const alert of await alerts()) {
      expect(Number(alert.value), alert.metric).toBeGreaterThan(0);
      expect(Number(alert.value), alert.metric).toBeLessThanOrEqual(100);
      expect(alert.unit).toBe('percent');
    }
  });
});

describe('Prometheus metrics (api.p95, api.rate5xx)', () => {
  it('asks Prometheus over the rule window and fires on its answer', async () => {
    const { db } = await testDb();
    await insertRule(db, {
      key: 'api_p95_latency',
      metric: 'api.p95',
      threshold: '1000.0000',
      windowSeconds: 300,
      severity: 'warning',
    });
    expect((await evaluator.evaluateAll()).fired).toBe(1);
    expect(promQueries.some((query) => query.includes('histogram_quantile(0.95') && query.includes('[300s]'))).toBe(
      true,
    );
    expect((await alerts())[0]).toMatchObject({
      metric: 'api.p95',
      value: '1200.0000',
      unit: 'ms',
      subjectType: 'system',
    });
    // Back under the limit: the first ok evaluation starts the stretch, and the alert closes when it has lasted three minutes.
    promAnswer = { value: '640' };
    const resolvedAfter: number[] = [];
    for (let minute = 0; minute < 4; minute += 1) {
      if (minute > 0) clock.advance(MINUTE);
      resolvedAfter.push((await evaluator.evaluateAll()).resolved);
    }
    expect(resolvedAfter).toEqual([0, 0, 0, 1]);
  });

  it('starts the three ok minutes again when the value breaches in between', async () => {
    const { db } = await testDb();
    await insertRule(db, { key: 'api_p95_latency', metric: 'api.p95', threshold: '1000.0000', windowSeconds: 300 });
    await evaluator.evaluateAll();
    const resolvedAfter: number[] = [];
    for (const answer of ['640', '640', '1500', '640', '640', '640', '640']) {
      clock.advance(MINUTE);
      promAnswer = { value: answer };
      resolvedAfter.push((await evaluator.evaluateAll()).resolved);
    }
    // Two ok minutes, a breach cuts the stretch, then the stretch starts again and closes the alert three minutes after its first ok evaluation.
    expect(resolvedAfter).toEqual([0, 0, 0, 0, 0, 0, 1]);
    expect(await db.$count(s.alertStreaks)).toBe(0);
  });

  it('cannot evaluate those rules while Prometheus is down, still judges the others, and says so in the report (Q15)', async () => {
    const { db } = await testDb();
    await insertRule(db, { key: 'api_rate5xx', metric: 'api.rate5xx', threshold: '2.0000', windowSeconds: 300 });
    await insertRule(db, {
      key: 'db_connections',
      metric: 'db.connection_usage',
      threshold: '99.0000',
      windowSeconds: 120,
    });
    promAnswer = 'down';
    const report = await evaluator.evaluateAll();
    expect(report).toEqual({
      rules: 2,
      evaluated: 1,
      unevaluated: 1,
      unevaluatedRules: ['api_rate5xx'],
      fired: 0,
      resolved: 0,
    });
  });

  it('leaves an open alert as it is while its metric cannot be read', async () => {
    const { db } = await testDb();
    await insertRule(db, { key: 'api_p95_latency', metric: 'api.p95', threshold: '1000.0000', windowSeconds: 300 });
    await evaluator.evaluateAll();
    promAnswer = 'down';
    expect(await evaluator.evaluateAll()).toMatchObject({ unevaluated: 1, resolved: 0 });
    expect((await alerts())[0]!.status).toBe('firing');
  });
});

describe('readings of the moment must hold for the rule window (supplier.balance stands for the five metrics of that kind)', () => {
  /** A rule "supplier balance below 150 for three minutes" and a supplier whose balance the test moves. */
  async function balanceWorld(overrides: Partial<Parameters<typeof insertRule>[1]> = {}) {
    const { db } = await testDb();
    const rule = await insertRule(db, {
      key: 'balance_low',
      metric: 'supplier.balance',
      comparator: 'lt',
      threshold: '150.0000',
      windowSeconds: 180,
      severity: 'warning',
      ...overrides,
    });
    const supplier = await insertSupplier(db, 'Gulf Server Hub', {
      balance: '500.0000',
      balanceCheckedAt: clock.now(),
    });
    const setBalance = (balance: string | null) =>
      db
        .update(s.suppliers)
        .set(balance === null ? { balanceCheckedAt: null } : { balance, balanceCheckedAt: clock.now() })
        .where(eq(s.suppliers.id, supplier));
    const streaks = () => db.select().from(s.alertStreaks);
    /** The worker's minute tick: time passes, then the evaluation runs. */
    const tick = async (by = MINUTE) => {
      clock.advance(by);
      return evaluator.evaluateAll();
    };
    return { db, rule, supplier, setBalance, streaks, tick };
  }

  it('opens the alert only once every evaluation of the whole window saw the breach', async () => {
    const { rule, supplier, setBalance, streaks, tick } = await balanceWorld();
    await setBalance('118.2000');
    const started = clock.now();
    expect(await evaluator.evaluateAll()).toMatchObject({ evaluated: 1, fired: 0 });
    expect(await streaks()).toMatchObject([
      { ruleId: rule.id, subjectKey: `supplier:${supplier}`, kind: 'breach', since: started, seenAt: started },
    ]);
    expect((await tick()).fired).toBe(0);
    expect((await tick()).fired).toBe(0);
    expect(await alerts()).toHaveLength(0);
    expect(await tick()).toMatchObject({ fired: 1 });
    expect(await alerts()).toMatchObject([
      { status: 'firing', value: '118.2000', subjectId: supplier, startedAt: clock.now() },
    ]);
    // The stretch is spent: an open alert needs none.
    expect(await streaks()).toEqual([]);
    expect(fired).toHaveBeenCalledTimes(1);
  });

  it('opens nothing for a spike shorter than the window, and the next breach starts the window again', async () => {
    const { setBalance, streaks, tick } = await balanceWorld();
    await setBalance('118.2000');
    await evaluator.evaluateAll();
    await tick();
    await setBalance('500.0000');
    expect((await tick()).fired).toBe(0);
    expect(await streaks()).toEqual([]);
    // Low again: three more minutes are needed, not one.
    await setBalance('118.2000');
    await tick();
    await tick();
    expect((await tick()).fired).toBe(0);
    expect((await tick()).fired).toBe(1);
  });

  it('closes the alert only once the value stayed in range for the whole window, and a dip back starts the recovery again', async () => {
    const { setBalance, streaks, tick } = await balanceWorld();
    await setBalance('118.2000');
    await evaluator.evaluateAll();
    await tick();
    await tick();
    await tick();
    expect(await alerts()).toHaveLength(1);
    await setBalance('500.0000');
    expect((await tick()).resolved).toBe(0);
    expect(await streaks()).toMatchObject([{ kind: 'clear' }]);
    expect((await tick()).resolved).toBe(0);
    // Low again for a minute: the recovery is over before it was complete.
    await setBalance('118.2000');
    expect((await tick()).resolved).toBe(0);
    expect(await streaks()).toEqual([]);
    await setBalance('500.0000');
    expect((await tick()).resolved).toBe(0);
    expect((await tick()).resolved).toBe(0);
    expect((await tick()).resolved).toBe(0);
    expect(resolved).not.toHaveBeenCalled();
    expect(await tick()).toMatchObject({ resolved: 1 });
    expect((await alerts())[0]).toMatchObject({ status: 'resolved', resolvedAt: clock.now() });
    expect(resolved).toHaveBeenCalledTimes(1);
    expect(await streaks()).toEqual([]);
  });

  it('opens one alert for a value that hovers at the threshold, and neither closes nor reopens it on each crossing', async () => {
    const { setBalance, tick } = await balanceWorld();
    await setBalance('118.2000');
    await evaluator.evaluateAll();
    await tick();
    await tick();
    await tick();
    for (const balance of ['500.0000', '118.2000', '500.0000', '118.2000', '500.0000', '118.2000']) {
      await setBalance(balance);
      expect(await tick()).toMatchObject({ fired: 0, resolved: 0 });
    }
    expect(await alerts()).toMatchObject([{ status: 'firing' }]);
    expect(fired).toHaveBeenCalledTimes(1);
    expect(resolved).not.toHaveBeenCalled();
  });

  it('breaks the stretch on a missing reading (a balance that was never read says nothing)', async () => {
    const { setBalance, streaks, tick } = await balanceWorld();
    await setBalance('118.2000');
    await evaluator.evaluateAll();
    await tick();
    await setBalance(null);
    expect((await tick()).fired).toBe(0);
    expect(await streaks()).toEqual([]);
    await setBalance('118.2000');
    await tick();
    await tick();
    expect((await tick()).fired).toBe(0);
    expect((await tick()).fired).toBe(1);
  });

  it('does not count time nobody looked: a stretch not seen for five minutes is over (the worker was down, the source did not answer)', async () => {
    const { setBalance, streaks, tick } = await balanceWorld();
    await setBalance('118.2000');
    await evaluator.evaluateAll();
    await tick();
    await tick();
    // No evaluation for ten minutes. The balance was low before and is low after, but nobody saw it in between.
    expect((await tick(10 * MINUTE)).fired).toBe(0);
    expect(await streaks()).toMatchObject([{ kind: 'breach', since: clock.now() }]);
    await tick();
    await tick();
    expect((await tick()).fired).toBe(1);
  });

  it('starts the window again when the rule is switched off and on, however briefly, and when it is deleted', async () => {
    const { rule, setBalance, streaks, tick } = await balanceWorld();
    const staff = await adminWith(t, ['alerts:*']);
    await setBalance('118.2000');
    await evaluator.evaluateAll();
    await tick();
    await tick();
    expect(await streaks()).toHaveLength(1);
    expect((await staff.patch(`/admin/alert-rules/${rule.id}`, { isActive: false })).status).toBe(200);
    expect(await streaks()).toEqual([]);
    clock.advance(MINUTE);
    expect((await staff.patch(`/admin/alert-rules/${rule.id}`, { isActive: true })).status).toBe(200);
    // Low for four minutes in all, but only now is the rule watching again.
    expect((await tick()).fired).toBe(0);
    await tick();
    await tick();
    expect(await streaks()).toHaveLength(1);
    expect((await staff.delete(`/admin/alert-rules/${rule.id}`)).status).toBe(204);
    expect(await streaks()).toEqual([]);
  });

  it('writes no stretch back for a rule that was switched off while the evaluation was reading its metric', async () => {
    const { rule, setBalance, streaks } = await balanceWorld();
    const staff = await adminWith(t, ['alerts:*']);
    await setBalance('118.2000');
    const reader = t.app.get(AlertMetricReader, { strict: false });
    const read = reader.read.bind(reader);
    const spy = spyOn(reader, 'read').mockImplementationOnce(async (...args) => {
      const readings = await read(...args);
      expect((await staff.patch(`/admin/alert-rules/${rule.id}`, { isActive: false })).status).toBe(200);
      return readings;
    });
    try {
      expect(await evaluator.evaluateAll()).toMatchObject({ evaluated: 1, fired: 0 });
    } finally {
      spy.mockRestore();
    }
    expect(await streaks()).toEqual([]);
  });

  it('starts the window again when the rule is edited so that it judges differently', async () => {
    const { rule, setBalance, streaks, tick } = await balanceWorld();
    const staff = await adminWith(t, ['alerts:*']);
    await setBalance('118.2000');
    await evaluator.evaluateAll();
    await tick();
    await tick();
    expect((await staff.patch(`/admin/alert-rules/${rule.id}`, { threshold: 160 })).status).toBe(200);
    // Still below the new limit, but it has not been below 160 for three minutes.
    expect((await tick()).fired).toBe(0);
    expect(await streaks()).toMatchObject([{ since: clock.now() }]);
    await tick();
    await tick();
    expect((await tick()).fired).toBe(1);
  });

  it('keeps the running window when only the window length is edited: a longer window waits for the stretch to grow, without starting over', async () => {
    const { rule, setBalance, streaks, tick } = await balanceWorld();
    const staff = await adminWith(t, ['alerts:*']);
    await setBalance('118.2000');
    const began = clock.now();
    await evaluator.evaluateAll();
    await tick();
    await tick();
    expect((await staff.patch(`/admin/alert-rules/${rule.id}`, { windowSeconds: 300 })).status).toBe(200);
    // The stretch survived the edit and is still the one that began at the first evaluation.
    expect(await streaks()).toMatchObject([{ since: began }]);
    // Three minutes in: enough for the old window (180 s), not for the new one (300 s).
    expect((await tick()).fired).toBe(0);
    expect(await streaks()).toMatchObject([{ since: began }]);
    await tick();
    expect((await tick()).fired).toBe(1);
  });

  it('counts the running stretch against a shorter window at once, when only the window length is edited', async () => {
    const { rule, setBalance, streaks, tick } = await balanceWorld({ windowSeconds: 600 });
    const staff = await adminWith(t, ['alerts:*']);
    await setBalance('118.2000');
    const began = clock.now();
    await evaluator.evaluateAll();
    await tick();
    await tick();
    expect((await tick()).fired).toBe(0);
    expect((await staff.patch(`/admin/alert-rules/${rule.id}`, { windowSeconds: 180 })).status).toBe(200);
    expect(await streaks()).toMatchObject([{ since: began }]);
    // Three minutes have passed since the stretch began: the shorter window is already held.
    expect((await evaluator.evaluateAll()).fired).toBe(1);
  });

  it('keeps counting while the rule is muted, opens nothing, and opens the alert at once when the mute ends', async () => {
    const { rule, setBalance, streaks, tick } = await balanceWorld();
    const staff = await adminWith(t, ['alerts:*']);
    expect(
      (await staff.patch(`/admin/alert-rules/${rule.id}`, { mutedUntil: new Date(clock.nowMs() + HOUR).toISOString() }))
        .status,
    ).toBe(200);
    await setBalance('118.2000');
    await evaluator.evaluateAll();
    for (let i = 0; i < 5; i += 1) expect((await tick()).fired).toBe(0);
    expect(await streaks()).toMatchObject([{ kind: 'breach' }]);
    expect((await staff.patch(`/admin/alert-rules/${rule.id}`, { mutedUntil: null })).status).toBe(200);
    expect((await tick()).fired).toBe(1);
  });

  it('forgets the stretch of a supplier that is gone from the readings', async () => {
    const { db, supplier, setBalance, streaks, tick } = await balanceWorld();
    await setBalance('118.2000');
    await evaluator.evaluateAll();
    expect(await streaks()).toHaveLength(1);
    await db.update(s.suppliers).set({ status: 'disabled' }).where(eq(s.suppliers.id, supplier));
    await tick();
    expect(await streaks()).toEqual([]);
  });

  it('holds queue.oldest_age, orders.past_sla, db.connection_usage and redis.memory_usage the same way (their rules are the held kind)', async () => {
    const { db } = await testDb();
    await insertRule(db, {
      key: 'db_connections',
      metric: 'db.connection_usage',
      threshold: '0.0000',
      windowSeconds: 180,
    });
    expect(await evaluator.evaluateAll()).toMatchObject({ evaluated: 1, fired: 0 });
    expect(await db.$count(s.alertStreaks)).toBe(1);
    clock.advance(2 * MINUTE);
    expect((await evaluator.evaluateAll()).fired).toBe(0);
    clock.advance(MINUTE);
    expect((await evaluator.evaluateAll()).fired).toBe(1);
  });

  it('judges the integrity result at once whatever the window: the mismatch count is the outcome of a run, not a stretch of time', async () => {
    const { db } = await testDb();
    await insertRule(db, {
      key: 'ledger_mismatch',
      metric: 'ledger.mismatch_count',
      threshold: '0.0000',
      windowSeconds: 3600,
    });
    const run = (mismatchCount: number) =>
      db.insert(s.jobRuns).values({
        job: 'ledger_integrity',
        trigger: 'schedule',
        status: 'succeeded',
        startedAt: clock.now(),
        finishedAt: clock.now(),
        result: { mismatchCount },
      });
    await run(1);
    expect(await evaluator.evaluateMetric('ledger.mismatch_count')).toMatchObject({ fired: 1 });
    clock.advance(MINUTE);
    await run(0);
    expect(await evaluator.evaluateMetric('ledger.mismatch_count')).toMatchObject({ resolved: 1 });
    expect(await db.$count(s.alertStreaks)).toBe(0);
  });

  it('fires a measured metric (a rate over the window) at the first evaluation and keeps no stretch for it', async () => {
    const { db } = await testDb();
    await insertRule(db, { windowSeconds: 3600 });
    const supplier = await insertSupplier(db, 'Bosphorus Unlock');
    await addCalls(db, supplier, ['timeout', 'ok'], ago(MINUTE));
    expect((await evaluator.evaluateAll()).fired).toBe(1);
    expect(await db.$count(s.alertStreaks)).toBe(0);
  });
});

describe('a rule that changes while an evaluation is reading its metric', () => {
  /** A supplier that times out, a rule that fires on it, and an evaluation whose metric read is followed by `change`. */
  async function world() {
    const { db } = await testDb();
    const rule = await insertRule(db, { key: 'supplier_timeout_rate', name: 'Supplier timeouts' });
    const supplier = await insertSupplier(db, 'Bosphorus Unlock');
    await addCalls(db, supplier, ['timeout', 'timeout', 'ok'], ago(MINUTE));
    const staff = await adminWith(t, ['alerts:*', 'system:read']);
    const reader = t.app.get(AlertMetricReader, { strict: false });
    const read = reader.read.bind(reader);
    /** Runs the evaluation; the rule is changed after its readings were taken and before the alert is opened. */
    const evaluateWhile = async (change: () => Promise<unknown>) => {
      const spy = spyOn(reader, 'read').mockImplementationOnce(async (...args) => {
        const readings = await read(...args);
        await change();
        return readings;
      });
      try {
        return await evaluator.evaluateAll();
      } finally {
        spy.mockRestore();
      }
    };
    const openAlerts = async () => (await staff.get('/admin/alerts?open=true')).total;
    return { db, rule, supplier, staff, evaluateWhile, openAlerts };
  }

  it('opens no alert for a rule that was switched off meanwhile (nothing would ever close it)', async () => {
    const { rule, staff, evaluateWhile, openAlerts } = await world();
    const report = await evaluateWhile(async () => {
      expect((await staff.patch(`/admin/alert-rules/${rule.id}`, { isActive: false })).status).toBe(200);
    });
    expect(report).toMatchObject({ evaluated: 1, fired: 0 });
    expect(await alerts()).toEqual([]);
    expect(await openAlerts()).toBe(0);
    expect(fired).not.toHaveBeenCalled();
    // Later runs skip the rule, so there is nothing to catch up with.
    expect(await evaluator.evaluateAll()).toMatchObject({ rules: 0, fired: 0 });
  });

  it('opens no alert for a rule that was deleted meanwhile', async () => {
    const { rule, staff, evaluateWhile, openAlerts } = await world();
    const report = await evaluateWhile(async () => {
      expect((await staff.delete(`/admin/alert-rules/${rule.id}`)).status).toBe(204);
    });
    expect(report.fired).toBe(0);
    expect(await alerts()).toEqual([]);
    expect(await openAlerts()).toBe(0);
    expect(fired).not.toHaveBeenCalled();
  });

  it('opens no alert for a rule that was muted meanwhile', async () => {
    const { rule, staff, evaluateWhile, openAlerts } = await world();
    const report = await evaluateWhile(async () => {
      const until = new Date(clock.nowMs() + HOUR).toISOString();
      expect((await staff.patch(`/admin/alert-rules/${rule.id}`, { mutedUntil: until })).status).toBe(200);
    });
    expect(report.fired).toBe(0);
    expect(await openAlerts()).toBe(0);
  });

  it('opens no alert when the threshold was raised meanwhile past the value that was read; the next run judges the rule as it is', async () => {
    const { rule, staff, evaluateWhile } = await world();
    const report = await evaluateWhile(async () => {
      expect((await staff.patch(`/admin/alert-rules/${rule.id}`, { threshold: 90 })).status).toBe(200);
    });
    expect(report.fired).toBe(0);
    expect(await alerts()).toEqual([]);
    expect(await evaluator.evaluateAll()).toMatchObject({ fired: 0 });
  });

  it('snapshots the rule as it is now when only its name or severity changed meanwhile', async () => {
    const { rule, staff, evaluateWhile } = await world();
    const report = await evaluateWhile(async () => {
      expect(
        (await staff.patch(`/admin/alert-rules/${rule.id}`, { name: 'Supplier slowdowns', severity: 'warning' }))
          .status,
      ).toBe(200);
    });
    expect(report.fired).toBe(1);
    expect(await alerts()).toMatchObject([{ ruleName: 'Supplier slowdowns', severity: 'warning' }]);
    expect(pick(noticeOfCall(fired), ['ruleName', 'severity'])).toEqual({
      ruleName: 'Supplier slowdowns',
      severity: 'warning',
    });
  });

  it('waits for a change of the rule that is in flight, and opens nothing once it commits switched off', async () => {
    const { db, pool } = await (async () => ({ db: (await testDb()).db, pool: (await testDb()).pool }))();
    const rule = await insertRule(db, { key: 'supplier_timeout_rate' });
    const supplier = await insertSupplier(db, 'Bosphorus Unlock');
    await addCalls(db, supplier, ['timeout', 'timeout', 'ok'], ago(MINUTE));
    // A staff member's PATCH holds the row `for update` until it commits ...
    const change = await pool.connect();
    try {
      await change.query('begin');
      await change.query('select id from alert_rules where id = $1 for update', [rule.id]);
      const run = evaluator.evaluateAll();
      // ... and the evaluation, which has the breach in hand, waits on the lock instead of opening the alert.
      await eventually(async () => {
        const waiting = await pool.query<{ n: number }>(
          `select count(*)::int as n from pg_stat_activity where datname = current_database() and wait_event_type = 'Lock'`,
        );
        return waiting.rows[0]!.n > 0 ? true : undefined;
      }, 10_000);
      await change.query('update alert_rules set is_active = false where id = $1', [rule.id]);
      await change.query('commit');
      expect(await run).toMatchObject({ evaluated: 1, fired: 0 });
    } finally {
      change.release();
    }
    expect(await alerts()).toEqual([]);
  });
});

describe('the evaluation job', () => {
  const process = async (data: object = {}) => {
    const processor = t.app.get(AlertEvaluationProcessor, { strict: false });
    await processor.process({ data } as Job);
  };
  const runs = async () =>
    (await testDb()).db.select().from(s.jobRuns).where(eq(s.jobRuns.job, ALERT_EVALUATION_JOB)).orderBy(s.jobRuns.id);

  it('records a scheduled run with the counts, and the health page counts it as an evaluation only when every rule was judged', async () => {
    const { db } = await testDb();
    await insertRule(db, { key: 'api_p95_latency', metric: 'api.p95', threshold: '1000.0000', windowSeconds: 300 });
    await process();
    expect((await runs())[0]).toMatchObject({
      job: 'alert_evaluation',
      trigger: 'schedule',
      status: 'succeeded',
      processed: 1,
      result: { rules: 1, evaluated: 1, unevaluated: 0, fired: 1, resolved: 0 },
    });
    expect(await alertsEvaluatedSince(db, new Date(clock.nowMs() - 10 * MINUTE))).toBe(true);
    clock.advance(MINUTE);
    promAnswer = 'down';
    await process();
    expect((await runs())[1]).toMatchObject({
      status: 'succeeded',
      result: { unevaluated: 1, unevaluatedRules: ['api_p95_latency'] },
    });
    // The only run in the last 10 minutes that judged every rule is the first one; once it is older, "no alerts" must not read as healthy.
    expect(await alertsEvaluatedSince(db, new Date(clock.nowMs() - 30_000))).toBe(false);
  });

  it('records a manual run on the row the route inserted (data.runId)', async () => {
    const { db } = await testDb();
    const [row] = await db
      .insert(s.jobRuns)
      .values({ job: 'alert_evaluation', trigger: 'manual', status: 'running', startedAt: clock.now() })
      .returning();
    await process({ runId: row!.id });
    expect(await runs()).toHaveLength(1);
    expect((await runs())[0]).toMatchObject({ id: row!.id, trigger: 'manual', status: 'succeeded' });
  });

  it('shows the open alert on the System health page, by the name stored when it fired', async () => {
    const { db } = await testDb();
    await insertRule(db, { name: 'Supplier timeouts' });
    const supplier = await insertSupplier(db, 'Bosphorus Unlock');
    await addCalls(db, supplier, ['timeout', 'ok'], ago(MINUTE));
    await process();
    const keys = t.app.get(CacheKeys, { strict: false });
    await t.app.get(RedisService, { strict: false }).cache.unlink(keys.healthSnapshot(), keys.healthSnapshot(true));
    const staff = await adminWith(t, ['system:read']);
    const health = await staff.get('/admin/system/health');
    expect(health.status).toBe(200);
    expect(health.body.alerts.open).toMatchObject({ value: 1, state: 'crit' });
    expect(health.body.alerts.items).toMatchObject([
      { ruleName: 'Supplier timeouts', severity: 'critical', status: 'firing', subjectLabel: 'Bosphorus Unlock' },
    ]);
  });
});
