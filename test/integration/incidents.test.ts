// Integration tests of the incident routes (feature 12b): GET/POST /admin/incidents and GET/PATCH /admin/incidents/:id through HTTP on the real
// application (docs/contract/endpoints/health.md; resolutions health-commissions-15, -17, ANSWERS system-health Q8, Q9, Q19, Q31, MISMATCHES B104).
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import { eq } from 'drizzle-orm';
import { schema as s } from '../../src/infra/db';
import { type AdminApi, adminWith } from '../support/admin-api';
import { insertAlert, insertRule, insertSupplier } from '../support/alerts';
import { type TestApp, createTestApp } from '../support/app';
import { clearIdentityCaches } from '../support/auth';
import { MINUTE, TestClock } from '../support/clock';
import { closeTestDb, resetDb, testDb } from '../support/db';

const clock = new TestClock('2026-11-07T10:00:00.000Z');
let t: TestApp;
let dana: AdminApi;
let omar: AdminApi;
let reader: AdminApi;
let supplierId: number;

beforeAll(async () => {
  t = await createTestApp({ clock });
});
beforeEach(async () => {
  clock.set('2026-11-07T10:00:00.000Z');
  await resetDb();
  await clearIdentityCaches(t);
  dana = await adminWith(t, ['incidents:*'], { name: 'Dana M.' });
  omar = await adminWith(t, ['incidents:*'], { name: 'Omar T.' });
  reader = await adminWith(t, ['incidents:read'], { name: 'Reader R.' });
  supplierId = await insertSupplier((await testDb()).db, 'Bosphorus Unlock');
});
afterAll(async () => {
  await resetDb();
  await clearIdentityCaches(t);
  await t.close();
  await closeTestDb();
});

const declare = (overrides: Record<string, unknown> = {}) => ({
  title: 'Supplier timeouts',
  severity: 'major',
  components: [`supplier:${supplierId}`],
  summary: 'Bosphorus Unlock answers in about 6 seconds and times out.',
  ...overrides,
});

const audit = async () => (await testDb()).db.select().from(s.auditLogs).orderBy(s.auditLogs.id);

async function firingAlert() {
  const { db } = await testDb();
  const rule = await insertRule(db, { key: `rule_${crypto.randomUUID().slice(0, 8)}` });
  return insertAlert(db, rule, {
    startedAt: clock.now(),
    subjectType: 'supplier',
    subjectId: supplierId,
    subjectLabel: 'Bosphorus Unlock',
  });
}

describe('POST /admin/incidents', () => {
  it('declares an incident: investigating, one timeline line by the staff member, createdBy, and the audit entry', async () => {
    const res = await dana.post('/admin/incidents', declare());
    expect(res.status).toBe(201);
    expect(res.body).toEqual({
      id: expect.any(Number),
      title: 'Supplier timeouts',
      severity: 'major',
      status: 'investigating',
      components: [`supplier:${supplierId}`],
      summary: 'Bosphorus Unlock answers in about 6 seconds and times out.',
      timeline: [
        {
          at: '2026-11-07T10:00:00.000Z',
          status: 'investigating',
          text: 'Incident declared. We are investigating.',
          by: { id: dana.staffId, name: 'Dana M.' },
        },
      ],
      rootCause: null,
      startedAt: '2026-11-07T10:00:00.000Z',
      resolvedAt: null,
      alertEventId: null,
      createdBy: { id: dana.staffId, name: 'Dana M.' },
      resolvedBy: null,
      createdAt: '2026-11-07T10:00:00.000Z',
      updatedAt: '2026-11-07T10:00:00.000Z',
    });
    expect(await audit()).toMatchObject([
      {
        action: 'opened incident',
        entityType: 'incident',
        entityId: res.body.id,
        entityLabel: 'Supplier timeouts',
        actorId: dana.staffId,
      },
    ]);
  });

  it('links the alert it is declared from, which then names the incident (scenario system-alert step 7)', async () => {
    const alert = await firingAlert();
    const res = await dana.post('/admin/incidents', declare({ alertEventId: alert.id }));
    expect(res.status).toBe(201);
    expect(res.body.alertEventId).toBe(alert.id);
    const seen = await (await adminWith(t, ['alerts:read'])).get(`/admin/alerts/${alert.id}`);
    expect(seen.body.incidentId).toBe(res.body.id);
  });

  it('answers 422 on alertEventId for an unknown alert and for an alert that already has an incident (one incident per alert)', async () => {
    const alert = await firingAlert();
    const unknown = await dana.post('/admin/incidents', declare({ alertEventId: 9999 }));
    expect(unknown.status).toBe(422);
    expect(unknown.body.errors).toMatchObject([{ field: 'alertEventId', message: 'No such alert.' }]);
    expect((await dana.post('/admin/incidents', declare({ alertEventId: alert.id }))).status).toBe(201);
    const second = await dana.post('/admin/incidents', declare({ alertEventId: alert.id }));
    expect(second.status).toBe(422);
    expect(second.body.errors).toMatchObject([
      { field: 'alertEventId', message: 'This alert already has an incident.' },
    ]);
  });

  it('lets a resolved alert start an incident, and two incidents with no alert coexist', async () => {
    const { db } = await testDb();
    const rule = await insertRule(db);
    const resolved = await insertAlert(db, rule, {
      startedAt: clock.now(),
      status: 'resolved',
      resolvedAt: clock.now(),
    });
    expect((await dana.post('/admin/incidents', declare({ alertEventId: resolved.id }))).status).toBe(201);
    expect((await dana.post('/admin/incidents', declare())).status).toBe(201);
    expect((await dana.post('/admin/incidents', declare({ title: 'Another one', alertEventId: null }))).status).toBe(
      201,
    );
  });

  it('lets only one of two parallel declarations for the same alert through (the unique index, mapped to 422 on alertEventId)', async () => {
    const alert = await firingAlert();
    const answers = await Promise.all([
      dana.post('/admin/incidents', declare({ alertEventId: alert.id })),
      omar.post('/admin/incidents', declare({ alertEventId: alert.id, title: 'The same alert' })),
    ]);
    expect(answers.map((answer) => answer.status).sort()).toEqual([201, 422]);
    const refused = answers.find((answer) => answer.status === 422)!;
    expect(refused.body.errors).toMatchObject([{ field: 'alertEventId' }]);
    const { db } = await testDb();
    expect(await db.$count(s.incidents)).toBe(1);
  });

  it('answers 422 with a message per field, and on components for an unknown key', async () => {
    const res = await dana.post('/admin/incidents', {
      title: 'ab',
      severity: 'huge',
      components: [],
      summary: 'short',
    });
    expect(res.status).toBe(422);
    expect(res.body.errors.map((error: { field: string }) => error.field).sort()).toEqual([
      'components',
      'severity',
      'summary',
      'title',
    ]);
    const unknown = await dana.post('/admin/incidents', declare({ components: ['api', 'supplier:999', 'nonsense'] }));
    expect(unknown.status).toBe(422);
    expect(unknown.body.errors).toMatchObject([{ field: 'components', message: 'Unknown component: supplier:999.' }]);
  });

  it('knows the core components, supplier ids and gateway ids of the health page', async () => {
    const { db } = await testDb();
    await db
      .insert(s.currencies)
      .values({ code: 'USD', name: 'US dollar', rateToBase: '1', decimals: 2 })
      .onConflictDoNothing();
    const [gateway] = await db
      .insert(s.paymentGateways)
      .values({ code: 'card', driver: 'card', name: 'Card gateway' })
      .returning();
    const res = await dana.post(
      '/admin/incidents',
      declare({
        components: [
          'api',
          'postgres',
          'redis',
          'redis_queue',
          'storage',
          'workers',
          'mail',
          `gateway:${gateway!.id}`,
          `supplier:${supplierId}`,
        ],
      }),
    );
    expect(res.status).toBe(201);
    expect(res.body.components).toHaveLength(9);
  });

  it('refuses a staff member without incidents:create, naming the permission', async () => {
    const denied = await reader.post('/admin/incidents', declare());
    expect(denied.status).toBe(403);
    expect(denied.body.detail).toContain('incidents:create');
    expect(await audit()).toHaveLength(0);
  });
});

describe('PATCH /admin/incidents/:id', () => {
  const declared = async () => (await dana.post('/admin/incidents', declare())).body as { id: number };

  it('adds a timeline line for a status change with an update, by the staff member who made it', async () => {
    const { id } = await declared();
    clock.advance(11 * MINUTE);
    const res = await omar.patch(`/admin/incidents/${id}`, {
      status: 'identified',
      update: 'The supplier confirmed a problem on its side.',
    });
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('identified');
    expect(res.body.timeline).toHaveLength(2);
    expect(res.body.timeline[1]).toEqual({
      at: '2026-11-07T10:11:00.000Z',
      status: 'identified',
      text: 'The supplier confirmed a problem on its side.',
      by: { id: omar.staffId, name: 'Omar T.' },
    });
    expect(res.body.updatedAt).toBe('2026-11-07T10:11:00.000Z');
    expect((await audit()).at(-1)).toMatchObject({ action: 'updated incident', entityId: id, actorId: omar.staffId });
  });

  it('writes the default sentence for a status change without an update, and a line with the current status for an update alone', async () => {
    const { id } = await declared();
    const monitoring = await dana.patch(`/admin/incidents/${id}`, { status: 'monitoring' });
    expect(monitoring.body.timeline[1]).toMatchObject({
      status: 'monitoring',
      text: 'A fix is in place; watching it.',
    });
    const note = await dana.patch(`/admin/incidents/${id}`, { update: '  Watching the error rate.  ' });
    expect(note.body.timeline[2]).toMatchObject({ status: 'monitoring', text: 'Watching the error rate.' });
    expect(note.body.status).toBe('monitoring');
  });

  it('adds no timeline line when only the title, severity, summary or components change', async () => {
    const { id } = await declared();
    const res = await dana.patch(`/admin/incidents/${id}`, {
      title: 'Supplier timeouts and late orders',
      severity: 'critical',
      summary: 'Orders sent to the supplier are late as well.',
      components: ['api', `supplier:${supplierId}`],
    });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      title: 'Supplier timeouts and late orders',
      severity: 'critical',
      components: ['api', `supplier:${supplierId}`],
    });
    expect(res.body.timeline).toHaveLength(1);
  });

  it('closes with the root cause: resolvedAt, resolvedBy, the closing update as the resolved line (scenario system-alert step 11)', async () => {
    const { id } = await declared();
    clock.advance(12 * MINUTE);
    const res = await omar.patch(`/admin/incidents/${id}`, {
      status: 'resolved',
      rootCause: 'The supplier lowered its rate limit without telling us.',
      update: 'Supplier set back to active and our own limit matched to theirs.',
    });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      status: 'resolved',
      rootCause: 'The supplier lowered its rate limit without telling us.',
      resolvedAt: '2026-11-07T10:12:00.000Z',
      resolvedBy: { id: omar.staffId, name: 'Omar T.' },
      createdBy: { id: dana.staffId, name: 'Dana M.' },
    });
    expect(res.body.timeline.at(-1)).toMatchObject({
      status: 'resolved',
      text: 'Supplier set back to active and our own limit matched to theirs.',
      by: { id: omar.staffId, name: 'Omar T.' },
    });
    expect((await audit()).at(-1)).toMatchObject({ action: 'closed incident', entityId: id });
  });

  it('writes the default resolved sentence when no closing update is sent', async () => {
    const { id } = await declared();
    const res = await dana.patch(`/admin/incidents/${id}`, {
      status: 'resolved',
      rootCause: 'A deploy left the workers on an old prefix.',
    });
    expect(res.body.timeline.at(-1)).toMatchObject({ status: 'resolved', text: 'The incident is resolved.' });
  });

  it('answers 422 on rootCause when closing without 10 characters, and accepts one saved earlier', async () => {
    const { id } = await declared();
    const short = await dana.patch(`/admin/incidents/${id}`, { status: 'resolved', rootCause: 'too short' });
    expect(short.status).toBe(422);
    expect(short.body.errors).toMatchObject([{ field: 'rootCause' }]);
    expect((await dana.patch(`/admin/incidents/${id}`, { status: 'resolved' })).body.errors[0].field).toBe('rootCause');
    // Nothing was written by the refused closes.
    const { db } = await testDb();
    expect((await db.select().from(s.incidents))[0]).toMatchObject({ status: 'investigating', resolvedAt: null });
    await dana.patch(`/admin/incidents/${id}`, { rootCause: 'The cause was found on Tuesday.' });
    expect((await dana.patch(`/admin/incidents/${id}`, { status: 'resolved' })).status).toBe(200);
  });

  it('answers 409 INCIDENT_CLOSED for any change to a resolved incident, with no reopen', async () => {
    const { id } = await declared();
    await dana.patch(`/admin/incidents/${id}`, { status: 'resolved', rootCause: 'Found and fixed the problem.' });
    for (const change of [
      { title: 'New title here' },
      { status: 'investigating' },
      { update: 'Late note' },
      { status: 'resolved', rootCause: 'Another root cause.' },
    ]) {
      const res = await dana.patch(`/admin/incidents/${id}`, change);
      expect(res.status, JSON.stringify(change)).toBe(409);
      expect(res.body.code).toBe('INCIDENT_CLOSED');
    }
  });

  it('answers 422 for a bad status, an update over 1000 characters and an empty body; 404 for an unknown incident; 403 without incidents:update', async () => {
    const { id } = await declared();
    expect((await dana.patch(`/admin/incidents/${id}`, { status: 'done' })).body.errors[0].field).toBe('status');
    expect((await dana.patch(`/admin/incidents/${id}`, { update: 'x'.repeat(1001) })).body.errors[0].field).toBe(
      'update',
    );
    expect((await dana.patch(`/admin/incidents/${id}`, {})).status).toBe(422);
    expect((await dana.patch('/admin/incidents/9999', { title: 'Nothing here' })).status).toBe(404);
    const denied = await reader.patch(`/admin/incidents/${id}`, { status: 'identified' });
    expect(denied.status).toBe(403);
    expect(denied.body.detail).toContain('incidents:update');
  });

  it('keeps a component key that no longer exists, but refuses a new unknown one (ANSWERS Q19)', async () => {
    const { id } = await declared();
    const { db } = await testDb();
    await db.delete(s.suppliers).where(eq(s.suppliers.id, supplierId));
    const kept = await dana.patch(`/admin/incidents/${id}`, { components: [`supplier:${supplierId}`, 'api'] });
    expect(kept.status).toBe(200);
    const refused = await dana.patch(`/admin/incidents/${id}`, { components: ['supplier:777'] });
    expect(refused.status).toBe(422);
    expect(refused.body.errors[0].field).toBe('components');
  });
});

describe('GET /admin/incidents', () => {
  /** An ongoing incident, a monitoring one and a resolved one, in that order of start. */
  async function threeIncidents() {
    const first = (
      await dana.post(
        '/admin/incidents',
        declare({ title: 'Checkout errors', severity: 'critical', summary: 'Card payments fail at the last step.' }),
      )
    ).body;
    clock.advance(MINUTE);
    const second = (await dana.post('/admin/incidents', declare({ title: 'Queue stalled', components: ['workers'] })))
      .body;
    await dana.patch(`/admin/incidents/${second.id}`, { status: 'monitoring' });
    clock.advance(MINUTE);
    const third = (await dana.post('/admin/incidents', declare({ title: 'Old supplier trouble', severity: 'minor' })))
      .body;
    await dana.patch(`/admin/incidents/${third.id}`, {
      status: 'resolved',
      rootCause: 'Supplier raised its limit again.',
    });
    return { first, second, third };
  }

  it('lists newest first with the whole timeline and x-total-count', async () => {
    const { first, second, third } = await threeIncidents();
    const res = await reader.get('/admin/incidents');
    expect(res.status).toBe(200);
    expect(res.total).toBe(3);
    expect(res.body.map((incident: { id: number }) => incident.id)).toEqual([third.id, second.id, first.id]);
    expect(res.body[0].timeline).toHaveLength(2);
    expect(res.body[0]).toMatchObject({
      resolvedBy: { name: 'Dana M.' },
      rootCause: 'Supplier raised its limit again.',
    });
  });

  it('filters open=true (every status but resolved), open=false, status and severity', async () => {
    const { first, second, third } = await threeIncidents();
    const ids = async (query: string) =>
      ((await reader.get(`/admin/incidents?${query}`)).body as Array<{ id: number }>).map((i) => i.id);
    expect(await ids('open=true')).toEqual([second.id, first.id]);
    expect(await ids('open=false')).toEqual([third.id]);
    expect(await ids('status=resolved')).toEqual([third.id]);
    expect(await ids('status=investigating&status=monitoring')).toEqual([second.id, first.id]);
    expect(await ids('severity=critical')).toEqual([first.id]);
    expect((await reader.get('/admin/incidents?open=true&_start=0&_end=1')).total).toBe(2);
    expect((await reader.get('/admin/incidents?status=nope')).status).toBe(422);
  });

  it('searches the title and the summary and pages', async () => {
    const { first, second } = await threeIncidents();
    const ids = async (query: string) =>
      ((await reader.get(`/admin/incidents?${query}`)).body as Array<{ id: number }>).map((i) => i.id);
    expect(await ids('q=payments')).toEqual([first.id]);
    expect(await ids('q=queue')).toEqual([second.id]);
    expect(await ids('_start=1&_end=2')).toEqual([second.id]);
  });

  it('refuses a staff member without incidents:read', async () => {
    const nobody = await adminWith(t, ['alerts:read']);
    expect((await nobody.get('/admin/incidents')).status).toBe(403);
  });
});

describe('GET /admin/incidents/:id', () => {
  it('shows one incident with its timeline, and 404 for an unknown one', async () => {
    const { id } = (await dana.post('/admin/incidents', declare())).body;
    const res = await reader.get(`/admin/incidents/${id}`);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ id, timeline: [{ status: 'investigating' }] });
    expect((await reader.get('/admin/incidents/9999')).status).toBe(404);
  });
});
