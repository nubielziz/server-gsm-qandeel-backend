// Integration tests of the alert routes (feature 12b): GET /admin/alerts, GET /admin/alerts/:id and POST /admin/alerts/:id/ack through HTTP on
// the real application (docs/contract/endpoints/health.md; resolutions health-commissions-5, -14, -17, ANSWERS system-health Q9, Q28, Q31).
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import { eq } from 'drizzle-orm';
import { schema as s } from '../../src/infra/db';
import type { AlertRule } from '../../src/modules/health/db/schema';
import { type AdminApi, adminWith } from '../support/admin-api';
import { insertAlert, insertRule, insertSupplier } from '../support/alerts';
import { type TestApp, createTestApp } from '../support/app';
import { clearIdentityCaches } from '../support/auth';
import { HOUR, MINUTE, TestClock } from '../support/clock';
import { closeTestDb, resetDb, testDb } from '../support/db';

const clock = new TestClock('2026-11-07T10:00:00.000Z');
let t: TestApp;
let reader: AdminApi;
let acker: AdminApi;
let rule: AlertRule;

beforeAll(async () => {
  t = await createTestApp({ clock });
});
beforeEach(async () => {
  clock.set('2026-11-07T10:00:00.000Z');
  await resetDb();
  await clearIdentityCaches(t);
  reader = await adminWith(t, ['alerts:read'], { name: 'Omar T.' });
  acker = await adminWith(t, ['alerts:read', 'alerts:update'], { name: 'Dana M.' });
  rule = await insertRule((await testDb()).db, { key: 'supplier_timeout_rate', name: 'Supplier timeouts' });
});
afterAll(async () => {
  await resetDb();
  await clearIdentityCaches(t);
  await t.close();
  await closeTestDb();
});

const ago = (ms: number) => new Date(clock.nowMs() - ms);

/** Four alerts of the rule: a firing supplier alert, an acknowledged system one, and two resolved ones. */
async function seedAlerts() {
  const { db } = await testDb();
  const supplierId = await insertSupplier(db, 'Bosphorus Unlock');
  const resolved = await insertAlert(db, rule, {
    startedAt: ago(3 * HOUR),
    status: 'resolved',
    resolvedAt: ago(2 * HOUR),
    severity: 'warning',
    note: 'Supplier rate limit',
  });
  const queue = await insertAlert(db, rule, {
    startedAt: ago(2 * HOUR),
    status: 'resolved',
    resolvedAt: ago(HOUR),
    subjectType: 'queue',
    subjectLabel: 'orders.dispatch',
    unit: 's',
    value: '192.0000',
  });
  const acked = await insertAlert(db, rule, {
    startedAt: ago(HOUR),
    status: 'acknowledged',
    acknowledgedBy: acker.staffId,
    acknowledgedAt: ago(30 * MINUTE),
    note: 'Checking with the supplier.',
  });
  const firing = await insertAlert(db, rule, {
    startedAt: ago(10 * MINUTE),
    subjectType: 'supplier',
    subjectId: supplierId,
    subjectLabel: 'Bosphorus Unlock',
  });
  return { resolved, queue, acked, firing, supplierId };
}

describe('GET /admin/alerts', () => {
  it('lists newest first with the rule snapshot, the subject, who acknowledged and x-total-count', async () => {
    const { firing, acked, supplierId } = await seedAlerts();
    const res = await reader.get('/admin/alerts');
    expect(res.status).toBe(200);
    expect(res.total).toBe(4);
    expect(res.body.map((alert: { id: number }) => alert.id)).toEqual([
      firing.id,
      acked.id,
      expect.any(Number),
      expect.any(Number),
    ]);
    expect(res.body[0]).toEqual({
      id: firing.id,
      ruleId: rule.id,
      rule: {
        id: rule.id,
        key: 'supplier_timeout_rate',
        name: 'Supplier timeouts',
        metric: 'supplier.timeout_rate',
        comparator: 'gt',
        threshold: 20,
        windowSeconds: 180,
        unit: 'percent',
      },
      status: 'firing',
      severity: 'critical',
      value: 23.4,
      subjectType: 'supplier',
      subjectId: supplierId,
      subjectLabel: 'Bosphorus Unlock',
      startedAt: '2026-11-07T09:50:00.000Z',
      acknowledgedAt: null,
      acknowledgedBy: null,
      resolvedAt: null,
      note: null,
      incidentId: null,
    });
    expect(res.body[1]).toMatchObject({
      status: 'acknowledged',
      acknowledgedBy: { id: acker.staffId, name: 'Dana M.' },
      acknowledgedAt: '2026-11-07T09:30:00.000Z',
      note: 'Checking with the supplier.',
    });
  });

  it('never sends a null subjectType or subjectId: a system or queue alert is subject 0, a queue names itself in subjectLabel (B103)', async () => {
    const { queue, acked } = await seedAlerts();
    const rows = (await reader.get('/admin/alerts?_sort=id&_order=asc')).body as Array<{
      id: number;
      subjectType: string;
      subjectId: number;
      subjectLabel: string | null;
    }>;
    expect(rows.find((alert) => alert.id === queue.id)).toMatchObject({
      subjectType: 'queue',
      subjectId: 0,
      subjectLabel: 'orders.dispatch',
    });
    expect(rows.find((alert) => alert.id === acked.id)).toMatchObject({
      subjectType: 'system',
      subjectId: 0,
      subjectLabel: null,
    });
  });

  it('filters by status (repeat the key for several), severity and open=true (firing or acknowledged), with the total of the union (Q28)', async () => {
    const { firing, acked, resolved } = await seedAlerts();
    const ids = async (query: string) =>
      ((await reader.get(`/admin/alerts?${query}`)).body as Array<{ id: number }>).map((a) => a.id);
    expect(await ids('status=firing')).toEqual([firing.id]);
    expect(await ids('status=firing&status=acknowledged')).toEqual([firing.id, acked.id]);
    expect(await ids('open=true')).toEqual([firing.id, acked.id]);
    const open = await reader.get('/admin/alerts?open=true&_start=0&_end=1');
    expect(open.total).toBe(2);
    expect(open.body).toHaveLength(1);
    expect(await ids('open=false&_sort=id&_order=asc')).toHaveLength(2);
    expect(await ids('severity=warning')).toEqual([resolved.id]);
    expect((await reader.get('/admin/alerts?status=gone')).status).toBe(422);
  });

  it('searches the rule name, the subject label and the note, and sorts by startedAt, id or severity', async () => {
    const { firing, queue, resolved } = await seedAlerts();
    const ids = async (query: string) =>
      ((await reader.get(`/admin/alerts?${query}`)).body as Array<{ id: number }>).map((a) => a.id);
    expect(await ids('q=bosphorus')).toEqual([firing.id]);
    expect(await ids('q=dispatch')).toEqual([queue.id]);
    expect(await ids('q=rate limit')).toEqual([resolved.id]);
    expect(await ids('q=Supplier timeouts')).toHaveLength(4);
    expect((await ids('_sort=startedAt&_order=asc'))[0]).toBe(resolved.id);
    // Severity sorts as text: warning comes last ascending, first descending.
    expect((await ids('_sort=severity&_order=desc'))[0]).toBe(resolved.id);
  });

  it('keeps what fired when the rule is edited later (the snapshot), and names the incident declared from the alert', async () => {
    const { firing } = await seedAlerts();
    const { db } = await testDb();
    await db
      .update(s.alertRules)
      .set({ name: 'Renamed', threshold: '50.0000', windowSeconds: 600, metric: 'api.p95' })
      .where(eq(s.alertRules.id, rule.id));
    const [incident] = await db
      .insert(s.incidents)
      .values({
        title: 'Supplier timeouts',
        severity: 'major',
        components: ['supplier:1'],
        summary: 'Timeouts on one supplier.',
        alertEventId: firing.id,
      })
      .returning();
    const shown = (await reader.get(`/admin/alerts/${firing.id}`)).body;
    expect(shown.rule).toMatchObject({
      name: 'Supplier timeouts',
      threshold: 20,
      windowSeconds: 180,
      metric: 'supplier.timeout_rate',
      unit: 'percent',
    });
    expect(shown.incidentId).toBe(incident!.id);
  });

  it('refuses a staff member without alerts:read', async () => {
    const nobody = await adminWith(t, ['system:read']);
    const res = await nobody.get('/admin/alerts');
    expect(res.status).toBe(403);
    expect(res.body.detail).toContain('alerts:read');
  });
});

describe('GET /admin/alerts/:id', () => {
  it('shows one alert and answers 404 for an unknown one', async () => {
    const { acked } = await seedAlerts();
    const shown = await reader.get(`/admin/alerts/${acked.id}`);
    expect(shown.status).toBe(200);
    expect(shown.body).toMatchObject({ id: acked.id, status: 'acknowledged' });
    expect((await reader.get('/admin/alerts/9999')).status).toBe(404);
    expect((await reader.get('/admin/alerts/abc')).status).toBe(422);
  });
});

describe('POST /admin/alerts/:id/ack', () => {
  it('acknowledges a firing alert with a note: who, when, the audit entry; the alert stays open', async () => {
    const { firing } = await seedAlerts();
    clock.advance(2 * MINUTE);
    const res = await acker.post(`/admin/alerts/${firing.id}/ack`, { note: '  Checking with the supplier.  ' });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      id: firing.id,
      status: 'acknowledged',
      acknowledgedAt: '2026-11-07T10:02:00.000Z',
      acknowledgedBy: { id: acker.staffId, name: 'Dana M.' },
      note: 'Checking with the supplier.',
      resolvedAt: null,
    });
    const { db } = await testDb();
    const audit = (await db.select().from(s.auditLogs))[0];
    expect(audit).toMatchObject({
      action: 'acknowledged alert',
      entityType: 'alert',
      entityId: firing.id,
      entityLabel: 'Supplier timeouts · Bosphorus Unlock',
      actorId: acker.staffId,
    });
    // Still open: the list and the rule say so.
    expect((await reader.get('/admin/alerts?open=true')).total).toBe(2);
  });

  it('accepts an empty body ({}), and stores no note', async () => {
    const { firing } = await seedAlerts();
    const res = await acker.post(`/admin/alerts/${firing.id}/ack`, {});
    expect(res.status).toBe(200);
    expect(res.body.note).toBeNull();
  });

  it('answers 409 ALERT_ACKNOWLEDGED naming who, and 409 ALERT_RESOLVED for an alert the server closed', async () => {
    const { firing, resolved, acked } = await seedAlerts();
    expect((await acker.post(`/admin/alerts/${firing.id}/ack`, {})).status).toBe(200);
    const again = await acker.post(`/admin/alerts/${firing.id}/ack`, {});
    expect(again.status).toBe(409);
    expect(again.body.code).toBe('ALERT_ACKNOWLEDGED');
    expect(again.body.detail).toBe('Dana M. already acknowledged this alert.');
    expect((await acker.post(`/admin/alerts/${acked.id}/ack`, {})).body.code).toBe('ALERT_ACKNOWLEDGED');
    const closed = await acker.post(`/admin/alerts/${resolved.id}/ack`, {});
    expect(closed.status).toBe(409);
    expect(closed.body.code).toBe('ALERT_RESOLVED');
  });

  it('lets two parallel acknowledgements through once: one 200, one 409, one audit row', async () => {
    const { firing } = await seedAlerts();
    const other = await adminWith(t, ['alerts:update'], { name: 'Rami K.' });
    const answers = await Promise.all([
      acker.post(`/admin/alerts/${firing.id}/ack`, {}),
      other.post(`/admin/alerts/${firing.id}/ack`, {}),
    ]);
    expect(answers.map((answer) => answer.status).sort()).toEqual([200, 409]);
    const { db } = await testDb();
    expect(await db.$count(s.auditLogs)).toBe(1);
  });

  it('answers 422 on note over 500 characters, 404 for an unknown alert, and 403 without alerts:update', async () => {
    const { firing } = await seedAlerts();
    const long = await acker.post(`/admin/alerts/${firing.id}/ack`, { note: 'x'.repeat(501) });
    expect(long.status).toBe(422);
    expect(long.body.errors).toMatchObject([{ field: 'note' }]);
    expect((await acker.post(`/admin/alerts/${firing.id}/ack`, { note: 'x'.repeat(500) })).status).toBe(200);
    expect((await acker.post('/admin/alerts/9999/ack', {})).status).toBe(404);
    const denied = await reader.post(`/admin/alerts/${firing.id}/ack`, {});
    expect(denied.status).toBe(403);
    expect(denied.body.detail).toContain('alerts:update');
  });
});
