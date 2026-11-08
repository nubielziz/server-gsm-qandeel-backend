// End-to-end walk of the map scenario `system-alert` (a supplier slows down: alert, acknowledgement, incident, recovery; docs/slices/health.json), step by step on the
// real application. The steps share one story, so the tests of this file run in order. Steps 2, 8 and 9 belong to the suppliers and orders features (the supplier's
// calls, pausing it, the stuck orders): the calls are written the way the supplier layer writes them, and the pause goes through the supplier route.
import { afterAll, beforeAll, describe, expect, it, spyOn } from 'bun:test';
import { eq } from 'drizzle-orm';
import { CacheKeys } from '../../src/infra/cache';
import { schema as s } from '../../src/infra/db';
import { RedisService } from '../../src/infra/redis';
import type { Job } from 'bullmq';
import { desc } from 'drizzle-orm';
import { AlertEvaluationProcessor, AlertNotifier, ComponentChecker, HealthJobsModule } from '../../src/modules/health';
import { type AdminApi, adminWith } from '../support/admin-api';
import { addCalls, insertSupplier, noticeOfCall, pick } from '../support/alerts';
import { type TestApp, createTestApp } from '../support/app';
import { clearIdentityCaches } from '../support/auth';
import { MINUTE, TestClock } from '../support/clock';
import { closeTestDb, resetDb, testDb } from '../support/db';
import {
  mailbox,
  notificationRows,
  seedDefaultTemplates,
  sendAllQueued,
  telegramOutbox,
} from '../support/notifications';
import { deleteBullKeys, testBullPrefix } from '../support/queues';

const prefix = testBullPrefix();
const clock = new TestClock('2026-11-07T10:00:00.000Z');
/** A Prometheus that answers every instant query with one sample: the monitoring probe of the health page and the api metrics. */
const prometheus = Bun.serve({
  port: 0,
  fetch: () =>
    Response.json({ status: 'success', data: { resultType: 'vector', result: [{ metric: {}, value: [0, '120'] }] } }),
});

let t: TestApp;
let dana: AdminApi;
let omar: AdminApi;
let supplierId = 0;
let ruleId = 0;
let alertId = 0;
let incidentId = 0;
let fired: ReturnType<typeof spyOn>;
let resolved: ReturnType<typeof spyOn>;
/** One minute tick of the worker: the job runs, records its `job_runs` row, and the row's result says what it did. */
async function tick() {
  await t.app.get(AlertEvaluationProcessor, { strict: false }).process({ data: {} } as Job);
  const [run] = await (
    await testDb()
  ).db
    .select()
    .from(s.jobRuns)
    .where(eq(s.jobRuns.job, 'alert_evaluation'))
    .orderBy(desc(s.jobRuns.id))
    .limit(1);
  return run!.result;
}
const ago = (ms: number) => new Date(clock.nowMs() - ms);

beforeAll(async () => {
  t = await createTestApp({
    clock,
    env: {
      BULL_PREFIX: prefix,
      PROMETHEUS_URL: `http://127.0.0.1:${prometheus.port}`,
      ALERTS_EMAIL_TO: 'ops@gsm.example',
      ALERTS_TELEGRAM_CHAT_ID: '-1001234567890',
      TELEGRAM_BOT_TOKEN: '1234567890:AAtest-token',
    },
    imports: [HealthJobsModule],
  });
  await resetDb();
  await clearIdentityCaches(t);
  await seedDefaultTemplates((await testDb()).db);
  const notifier = t.app.get(AlertNotifier, { strict: false });
  fired = spyOn(notifier, 'fired');
  resolved = spyOn(notifier, 'resolved');
  dana = await adminWith(t, ['alerts:*', 'incidents:*', 'system:read', 'suppliers:update'], { name: 'Dana M.' });
  omar = await adminWith(t, ['alerts:*', 'incidents:*'], { name: 'Omar T.' });
  supplierId = await insertSupplier((await testDb()).db, 'Bosphorus Unlock');
});
afterAll(async () => {
  await prometheus.stop(true);
  await resetDb();
  await clearIdentityCaches(t);
  await deleteBullKeys(t.app.get(RedisService, { strict: false }).queue, prefix);
  await t.close();
  await closeTestDb();
});

/** Health is cached for 10 s: drop the copy so the page shows the state now. */
async function health() {
  const keys = t.app.get(CacheKeys, { strict: false });
  await t.app.get(RedisService, { strict: false }).cache.unlink(keys.healthSnapshot(), keys.healthSnapshot(true));
  return (await dana.get('/admin/system/health')).body;
}

describe('scenario system-alert: a supplier slows down', () => {
  it('step 1: every minute the worker checks the components and the supplier and writes service_checks', async () => {
    const { db } = await testDb();
    await t.app
      .get(RedisService, { strict: false })
      .cache.set(t.app.get(CacheKeys, { strict: false }).heartbeat('api'), clock.now().toISOString(), 'EX', 120);
    await addCalls(db, supplierId, ['ok', 'ok', 'ok', 'ok'], ago(MINUTE));
    const report = await t.app.get(ComponentChecker, { strict: false }).runOnce();
    expect(report.checked).toBeGreaterThanOrEqual(6);
    const rows = await db.select().from(s.serviceChecks);
    expect(rows.map((row) => row.component)).toEqual(
      expect.arrayContaining(['api', 'postgres', 'redis', 'redis_queue', 'storage', `supplier:${supplierId}`]),
    );
    expect(rows.find((row) => row.component === `supplier:${supplierId}`)).toMatchObject({ supplierId, status: 'ok' });
  });

  it('step 3 (setup): staff add the rule "supplier timeouts above 20 % for three minutes", critical, Telegram and email', async () => {
    const res = await dana.post('/admin/alert-rules', {
      key: 'supplier_timeout_rate',
      name: 'Supplier timeouts',
      metric: 'supplier.timeout_rate',
      comparator: 'gt',
      threshold: 20,
      windowSeconds: 180,
      severity: 'critical',
      channels: ['telegram', 'email'],
    });
    expect(res.status).toBe(201);
    ruleId = res.body.id;
  });

  it('step 2 (suppliers feature): the supplier starts timing out, and the call log says so', async () => {
    const { db } = await testDb();
    clock.advance(2 * MINUTE);
    await addCalls(db, supplierId, ['timeout', 'timeout', 'timeout', 'ok', 'ok', 'timeout'], ago(30_000));
    const logs = await db.select().from(s.supplierApiLogs).where(eq(s.supplierApiLogs.outcome, 'timeout'));
    expect(logs).toHaveLength(4);
  });

  it('step 3: the rule is evaluated over its window: a muted rule opens nothing, the same rule unmuted opens an alert in state firing for the supplier', async () => {
    const until = new Date(clock.nowMs() + 10 * MINUTE).toISOString();
    expect((await dana.patch(`/admin/alert-rules/${ruleId}`, { mutedUntil: until })).body.muted).toBe(true);
    expect(await tick()).toMatchObject({ evaluated: 1, fired: 0 });
    const { db } = await testDb();
    expect(await db.$count(s.alertEvents)).toBe(0);

    expect((await dana.patch(`/admin/alert-rules/${ruleId}`, { mutedUntil: null })).body.muted).toBe(false);
    expect(await tick()).toMatchObject({ evaluated: 1, fired: 1 });
    const [alert] = await db.select().from(s.alertEvents);
    alertId = alert!.id;
    expect(alert).toMatchObject({
      ruleId,
      status: 'firing',
      severity: 'critical',
      subjectType: 'supplier',
      subjectId: supplierId,
      subjectLabel: 'Bosphorus Unlock',
      value: '40.0000',
      startedAt: clock.now(),
      acknowledgedBy: null,
    });
  });

  it("step 4: the rule's channels are told once (one message each, to the ops mailbox and chat); the message does not repeat while the alert is open", async () => {
    expect(fired).toHaveBeenCalledTimes(1);
    expect(pick(noticeOfCall(fired), ['alertId', 'channels', 'severity', 'subjectLabel'])).toEqual({
      alertId,
      channels: ['telegram', 'email'],
      severity: 'critical',
      subjectLabel: 'Bosphorus Unlock',
    });
    clock.advance(MINUTE);
    await addCalls((await testDb()).db, supplierId, ['timeout', 'timeout'], ago(10_000));
    expect(await tick()).toMatchObject({ fired: 0, resolved: 0 });
    expect(fired).toHaveBeenCalledTimes(1);
    expect(resolved).not.toHaveBeenCalled();
    const rows = await notificationRows((await testDb()).db);
    expect(rows.map((row) => `${row.event}:${row.channel}:${row.status}`).sort()).toEqual([
      'alert.fired:email:queued',
      'alert.fired:telegram:queued',
    ]);
    await sendAllQueued(t);
    expect(mailbox(t).sent.map((mail) => [mail.to, mail.subject])).toEqual([
      ['ops@gsm.example', 'Alert (critical): Supplier timeouts - Supplier Bosphorus Unlock'],
    ]);
    expect(telegramOutbox(t).sent).toEqual([
      {
        chatId: '-1001234567890',
        text: 'ALERT critical: Supplier timeouts on Supplier Bosphorus Unlock. supplier.timeout_rate is 40% (limit 20%). The limit is above 20% over 3 min.',
      },
    ]);
  });

  it('step 5: the health page shows the supplier as a problem and the open critical alert', async () => {
    await t.app.get(ComponentChecker, { strict: false }).runOnce();
    const body = await health();
    expect(body.alerts).toMatchObject({ critical: 1, open: { value: 1, state: 'crit' } });
    expect(body.alerts.items).toMatchObject([
      {
        id: alertId,
        ruleName: 'Supplier timeouts',
        severity: 'critical',
        status: 'firing',
        subjectLabel: 'Bosphorus Unlock',
      },
    ]);
    const supplier = body.components.find((component: { key: string }) => component.key === `supplier:${supplierId}`);
    expect(['degraded', 'down']).toContain(supplier.status);
  });

  it('step 6: a staff member acknowledges the alert: the reminders stop, the name and time are kept and audited; the alert stays open', async () => {
    clock.advance(2 * MINUTE);
    const res = await dana.post(`/admin/alerts/${alertId}/ack`, { note: 'Checking with the supplier.' });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      status: 'acknowledged',
      acknowledgedBy: { id: dana.staffId, name: 'Dana M.' },
      acknowledgedAt: clock.now().toISOString(),
    });
    const { db } = await testDb();
    expect((await db.select().from(s.alertEvents))[0]).toMatchObject({
      acknowledgedBy: dana.staffId,
      acknowledgedAt: clock.now(),
    });
    expect((await db.select().from(s.auditLogs).where(eq(s.auditLogs.action, 'acknowledged alert')))[0]).toMatchObject({
      entityId: alertId,
      actorId: dana.staffId,
    });
    // Still counted: an acknowledged critical alert is critical until it resolves.
    expect((await health()).alerts).toMatchObject({ critical: 1, open: { value: 1 } });
  });

  it('step 7: the impact reaches orders, so staff declare an incident (major) from the alert: linked, timeline starting at investigating', async () => {
    const res = await omar.post('/admin/incidents', {
      title: 'Supplier timeouts',
      severity: 'major',
      components: [`supplier:${supplierId}`],
      summary: 'Bosphorus Unlock times out on two calls of three. Orders sent to it are late.',
      alertEventId: alertId,
    });
    expect(res.status).toBe(201);
    incidentId = res.body.id;
    expect(res.body).toMatchObject({ status: 'investigating', alertEventId: alertId, createdBy: { name: 'Omar T.' } });
    expect(res.body.timeline).toMatchObject([
      { status: 'investigating', text: 'Incident declared. We are investigating.', by: { name: 'Omar T.' } },
    ]);
    const { db } = await testDb();
    expect((await db.select().from(s.auditLogs).where(eq(s.auditLogs.action, 'opened incident')))[0]).toMatchObject({
      entityId: incidentId,
    });
    expect((await dana.get(`/admin/alerts/${alertId}`)).body.incidentId).toBe(incidentId);
    expect((await health()).incidents).toMatchObject([{ id: incidentId, severity: 'major', status: 'investigating' }]);
  });

  it('step 8 (suppliers feature): the supplier is paused; the evaluation keeps judging it and the acknowledged alert is not closed by a forgotten ack', async () => {
    const res = await dana.patch(`/admin/suppliers/${supplierId}`, { status: 'paused' });
    expect(res.status).toBe(200);
    clock.advance(MINUTE);
    expect(await tick()).toMatchObject({ resolved: 0 });
    const { db } = await testDb();
    expect((await db.select().from(s.alertEvents))[0]!.status).toBe('acknowledged');
  });

  it('step 10: the checks stay ok for three consecutive minutes, so the alert closes by itself (an acknowledged one too) and the resolved message goes out', async () => {
    clock.advance(4 * MINUTE);
    const { db } = await testDb();
    await addCalls(db, supplierId, ['ok', 'ok', 'ok', 'ok'], ago(MINUTE));
    // Back in range, but one good minute does not close it.
    expect(await tick()).toMatchObject({ fired: 0, resolved: 0 });
    expect((await db.select().from(s.alertEvents))[0]!.status).toBe('acknowledged');
    expect(resolved).not.toHaveBeenCalled();
    for (const closes of [false, false, true]) {
      clock.advance(MINUTE);
      await addCalls(db, supplierId, ['ok'], ago(10_000));
      expect(await tick()).toMatchObject({ fired: 0, resolved: closes ? 1 : 0 });
    }
    expect((await db.select().from(s.alertEvents))[0]).toMatchObject({
      status: 'resolved',
      resolvedAt: clock.now(),
      acknowledgedBy: dana.staffId,
    });
    expect(resolved).toHaveBeenCalledTimes(1);
    expect(pick(noticeOfCall(resolved), ['alertId', 'channels'])).toEqual({ alertId, channels: ['telegram', 'email'] });
    const rows = (await notificationRows(db)).filter((row) => row.event === 'alert.resolved');
    expect(rows.map((row) => `${row.channel}:${row.status}`).sort()).toEqual(['email:queued', 'telegram:queued']);
    await sendAllQueued(t);
    expect(mailbox(t).sent.map((mail) => mail.subject)).toEqual([
      'Alert (critical): Supplier timeouts - Supplier Bosphorus Unlock',
      'Resolved: Supplier timeouts - Supplier Bosphorus Unlock',
    ]);
    expect(telegramOutbox(t).sent.at(-1)?.text).toBe(
      'RESOLVED: Supplier timeouts on Supplier Bosphorus Unlock. supplier.timeout_rate is 0% (limit 20%). The value is back in range.',
    );
    expect((await health()).alerts).toMatchObject({ critical: 0, open: { value: 0 } });
  });

  it('step 11: staff set the supplier active again and close the incident with the cause and the action taken: it stays as the record', async () => {
    expect((await dana.patch(`/admin/suppliers/${supplierId}`, { status: 'active' })).status).toBe(200);
    clock.advance(MINUTE);
    const res = await omar.patch(`/admin/incidents/${incidentId}`, {
      status: 'resolved',
      rootCause: 'The supplier throttled our key after a burst of orders and recovered by itself.',
      update: 'Supplier set back to active; our dispatch concurrency for it was lowered.',
    });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      status: 'resolved',
      resolvedAt: clock.now().toISOString(),
      resolvedBy: { name: 'Omar T.' },
    });
    expect(res.body.timeline.at(-1)).toMatchObject({
      status: 'resolved',
      text: 'Supplier set back to active; our dispatch concurrency for it was lowered.',
    });
    expect((await omar.patch(`/admin/incidents/${incidentId}`, { title: 'Late edit of a record' })).body.code).toBe(
      'INCIDENT_CLOSED',
    );
    const { db } = await testDb();
    expect((await db.select().from(s.incidents))[0]).toMatchObject({
      rootCause: expect.stringContaining('throttled our key'),
      resolvedBy: omar.staffId,
    });
    expect(
      (await db.select().from(s.auditLogs).where(eq(s.auditLogs.entityType, 'incident'))).map((row) => row.action),
    ).toEqual(['opened incident', 'closed incident']);
  });
});
