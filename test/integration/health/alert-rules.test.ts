// Integration tests of the alert rule routes (feature 12b): GET/POST /admin/alert-rules, GET/PATCH/DELETE /admin/alert-rules/:id through
// HTTP on the real application (docs/contract/endpoints/health.md; resolutions health-commissions-13, ANSWERS system-health Q29 to Q31).
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import { eq } from 'drizzle-orm';
import { schema as s } from '@src/infra/db';
import { type AdminApi, adminWith } from '../../support/admin-api';
import { insertAlert, insertRule } from '../../support/alerts';
import { type TestApp, createTestApp } from '../../support/app';
import { clearIdentityCaches } from '../../support/auth';
import { HOUR, MINUTE, TestClock } from '../../support/clock';
import { closeTestDb, resetDb, testDb } from '../../support/db';

const clock = new TestClock('2026-11-07T10:00:00.000Z');
let t: TestApp;
let staff: AdminApi;
let reader: AdminApi;

beforeAll(async () => {
  t = await createTestApp({ clock });
});
beforeEach(async () => {
  clock.set('2026-11-07T10:00:00.000Z');
  await resetDb();
  await clearIdentityCaches(t);
  staff = await adminWith(t, ['alerts:*'], { name: 'Dana M.' });
  reader = await adminWith(t, ['alerts:read'], { name: 'Omar T.' });
});
afterAll(async () => {
  await resetDb();
  await clearIdentityCaches(t);
  await t.close();
  await closeTestDb();
});

const body = (overrides: Record<string, unknown> = {}) => ({
  key: 'supplier_timeout_rate',
  name: 'Supplier timeouts',
  metric: 'supplier.timeout_rate',
  comparator: 'gt',
  threshold: 20,
  windowSeconds: 180,
  severity: 'critical',
  channels: ['telegram', 'email'],
  ...overrides,
});

const audit = async () => (await testDb()).db.select().from(s.auditLogs).orderBy(s.auditLogs.id);

describe('POST /admin/alert-rules', () => {
  it('adds a rule: the server sets the unit, createdBy and an empty mute, and audits it', async () => {
    const res = await staff.post('/admin/alert-rules', body());
    expect(res.status).toBe(201);
    expect(res.body).toEqual({
      id: expect.any(Number),
      key: 'supplier_timeout_rate',
      name: 'Supplier timeouts',
      metric: 'supplier.timeout_rate',
      comparator: 'gt',
      threshold: 20,
      windowSeconds: 180,
      severity: 'critical',
      channels: ['telegram', 'email'],
      isActive: true,
      mutedUntil: null,
      unit: 'percent',
      open: false,
      muted: false,
      createdAt: '2026-11-07T10:00:00.000Z',
      updatedAt: null,
    });
    const { db } = await testDb();
    const [row] = await db.select().from(s.alertRules);
    expect(row).toMatchObject({ createdBy: staff.staffId, updatedBy: null, deletedAt: null, threshold: '20.0000' });
    expect(await audit()).toMatchObject([
      {
        action: 'added alert rule',
        entityType: 'alert_rule',
        entityId: res.body.id,
        entityLabel: 'Supplier timeouts',
        actorId: staff.staffId,
      },
    ]);
  });

  it('gives each metric the unit of the registry, null for the supplier balance (B101, health-commissions-13)', async () => {
    const units: Record<string, string | null> = {
      'supplier.timeout_rate': 'percent',
      'supplier.error_rate': 'percent',
      'supplier.balance': null,
      'api.p95': 'ms',
      'api.rate5xx': 'percent',
      'queue.oldest_age': 's',
      'orders.past_sla': 'count',
      'ledger.mismatch_count': 'count',
      'db.connection_usage': 'percent',
      'redis.memory_usage': 'percent',
    };
    for (const [metric, unit] of Object.entries(units)) {
      const res = await staff.post('/admin/alert-rules', body({ key: `k_${metric.replace('.', '_')}`, metric }));
      expect(res.status, metric).toBe(201);
      expect(res.body.unit, metric).toBe(unit);
    }
  });

  it('refuses the retired metric of the deliveries to merchants like any unknown metric', async () => {
    const res = await staff.post(
      '/admin/alert-rules',
      body({ key: 'retired_metric', metric: 'webhooks.success_rate' }),
    );
    expect(res.status).toBe(422);
  });

  it('answers 422 with a message per field', async () => {
    const res = await staff.post('/admin/alert-rules', {
      key: 'Bad Key',
      name: 'ab',
      metric: 'made.up',
      comparator: 'eq',
      threshold: 'twenty',
      windowSeconds: 30,
      severity: 'urgent',
      channels: [],
      isActive: 'yes',
    });
    expect(res.status).toBe(422);
    const fields = res.body.errors.map((error: { field: string }) => error.field).sort();
    expect(fields).toEqual(
      ['channels', 'comparator', 'isActive', 'key', 'metric', 'name', 'severity', 'threshold', 'windowSeconds'].sort(),
    );
    const message = (field: string) =>
      res.body.errors.find((error: { field: string }) => error.field === field).message;
    expect(message('metric')).toBe('Unknown metric. Choose one from the list.');
    expect(message('windowSeconds')).toBe('Enter a whole number of seconds from 60 to 86400.');
  });

  it('refuses a window outside 60 to 86400 seconds and a channel that is not telegram or email', async () => {
    for (const windowSeconds of [59, 86_401, 90.5]) {
      const res = await staff.post('/admin/alert-rules', body({ windowSeconds }));
      expect(res.body.errors?.[0]?.field, String(windowSeconds)).toBe('windowSeconds');
    }
    const accepted = await staff.post('/admin/alert-rules', body({ key: 'edge_low', windowSeconds: 60 }));
    expect(accepted.status).toBe(201);
    const channel = await staff.post('/admin/alert-rules', body({ key: 'sms_rule', channels: ['sms'] }));
    expect(channel.body.errors[0].field).toBe('channels');
  });

  it('answers 422 on key for a duplicate, and lets a deleted rule give its key back', async () => {
    const first = await staff.post('/admin/alert-rules', body());
    const again = await staff.post('/admin/alert-rules', body({ name: 'Other name' }));
    expect(again.status).toBe(422);
    expect(again.body.errors).toMatchObject([{ field: 'key', message: 'A rule with this key already exists.' }]);
    expect((await staff.delete(`/admin/alert-rules/${first.body.id}`)).status).toBe(204);
    expect((await staff.post('/admin/alert-rules', body())).status).toBe(201);
  });

  it('keeps one copy of a channel listed twice', async () => {
    const res = await staff.post('/admin/alert-rules', body({ channels: ['email', 'email'] }));
    expect(res.body.channels).toEqual(['email']);
  });

  it('refuses a staff member without alerts:create (403 naming the permission), a missing CSRF token and a signed-out console', async () => {
    const denied = await reader.post('/admin/alert-rules', body());
    expect(denied.status).toBe(403);
    expect(denied.body.detail).toContain('alerts:create');
    expect((await staff.withoutCsrf('POST', '/admin/alert-rules', body())).body.code).toBe('CSRF_FAILED');
    expect((await staff.anonymous('POST', '/admin/alert-rules', body())).status).toBe(401);
    expect(await audit()).toHaveLength(0);
  });
});

describe('POST /admin/alert-rules without a key (decision 077)', () => {
  /** A rule body without the key. */
  const unkeyed = (overrides: Record<string, unknown> = {}) => body({ key: undefined, ...overrides });
  const ruleRows = async () => (await testDb()).db.select().from(s.alertRules).orderBy(s.alertRules.id);

  it('makes the key from the name: the stored row, the answer and the audit row carry it', async () => {
    const res = await staff.post('/admin/alert-rules', unkeyed());
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ key: 'supplier_timeouts', name: 'Supplier timeouts', unit: 'percent' });
    const [row] = await ruleRows();
    expect(row).toMatchObject({ id: res.body.id, key: 'supplier_timeouts', createdBy: staff.staffId, deletedAt: null });
    const [entry] = await audit();
    expect(entry).toMatchObject({
      action: 'added alert rule',
      entityType: 'alert_rule',
      entityId: res.body.id,
      entityLabel: 'Supplier timeouts',
      actorId: staff.staffId,
    });
    expect(entry!.after).toMatchObject({ key: 'supplier_timeouts', name: 'Supplier timeouts' });
    expect((await reader.get(`/admin/alert-rules/${res.body.id}`)).body.key).toBe('supplier_timeouts');
  });

  it('takes _2, _3 when another rule holds the key, a typed one included, and never answers 422 for it', async () => {
    expect((await staff.post('/admin/alert-rules', body({ key: 'supplier_timeouts' }))).status).toBe(201);
    const second = await staff.post('/admin/alert-rules', unkeyed());
    const third = await staff.post('/admin/alert-rules', unkeyed());
    expect([second.status, second.body.key]).toEqual([201, 'supplier_timeouts_2']);
    expect([third.status, third.body.key]).toEqual([201, 'supplier_timeouts_3']);
    // A typed key that is taken is still a 422 on key.
    const typed = await staff.post('/admin/alert-rules', body({ key: 'supplier_timeouts_2' }));
    expect(typed.status).toBe(422);
    expect(typed.body.errors).toMatchObject([{ field: 'key', message: 'A rule with this key already exists.' }]);
    expect((await ruleRows()).map((row) => row.key)).toEqual([
      'supplier_timeouts',
      'supplier_timeouts_2',
      'supplier_timeouts_3',
    ]);
    expect((await audit()).map((row) => (row.after as { key: string }).key)).toEqual([
      'supplier_timeouts',
      'supplier_timeouts_2',
      'supplier_timeouts_3',
    ]);
  });

  it('lets a deleted rule give its key back: the made key is the base again', async () => {
    const first = await staff.post('/admin/alert-rules', unkeyed());
    expect((await staff.delete(`/admin/alert-rules/${first.body.id}`)).status).toBe(204);
    const again = await staff.post('/admin/alert-rules', unkeyed());
    expect([again.status, again.body.key]).toEqual([201, 'supplier_timeouts']);
  });

  it('keeps a typed key exactly as before, whatever the name would make', async () => {
    const typed = await staff.post('/admin/alert-rules', body({ key: 'my_own_key' }));
    expect([typed.status, typed.body.key]).toEqual([201, 'my_own_key']);
    const bad = await staff.post('/admin/alert-rules', body({ key: 'Bad Key' }));
    expect(bad.status).toBe(422);
    expect(bad.body.errors).toMatchObject([{ field: 'key' }]);
    expect(await ruleRows()).toHaveLength(1);
  });

  it('judges every other field as before, and reports no problem on key for a request without one', async () => {
    const res = await staff.post('/admin/alert-rules', unkeyed({ name: 'ab', metric: 'made.up' }));
    expect(res.status).toBe(422);
    expect(res.body.errors.map((error: { field: string }) => error.field).sort()).toEqual(['metric', 'name']);
    expect(await ruleRows()).toHaveLength(0);
    expect(await audit()).toHaveLength(0);
  });

  it('makes a key in the format of a key from any name: a digit first, a short name, a name in another script, a long name', async () => {
    const keys: string[] = [];
    for (const name of [
      '5xx rate',
      'A!!',
      'CPU',
      '\u062a\u0646\u0628\u064a\u0647 \u0627\u0644\u0645\u0648\u0631\u062f',
      '!!!',
      `${'long '.repeat(12)}name`,
      'D\u00e9lai des commandes',
    ]) {
      const res = await staff.post('/admin/alert-rules', unkeyed({ name }));
      expect(res.status, name).toBe(201);
      keys.push(res.body.key);
    }
    expect(keys).toEqual([
      'rule_5xx_rate',
      'rule_a',
      'cpu',
      'rule',
      'rule_2',
      'long_long_long_long_long_long_long_long_l',
      'delai_des_commandes',
    ]);
    for (const key of keys) expect(key).toMatch(/^[a-z][a-z0-9_]{2,40}$/);
  });

  it('cuts a long name to 41 characters and still fits the suffix of the next one', async () => {
    const name = `${'x'.repeat(30)} ${'y'.repeat(30)}`;
    const first = await staff.post('/admin/alert-rules', unkeyed({ name }));
    const second = await staff.post('/admin/alert-rules', unkeyed({ name }));
    expect(first.body.key).toBe(`${'x'.repeat(30)}_${'y'.repeat(10)}`);
    expect(first.body.key).toHaveLength(41);
    expect(second.body.key).toBe(`${'x'.repeat(30)}_${'y'.repeat(8)}_2`);
    expect(second.body.key).toHaveLength(41);
  });

  it('gives six creates of one name at the same moment six different keys, each with its audit row', async () => {
    const answers = await Promise.all(Array.from({ length: 6 }, () => staff.post('/admin/alert-rules', unkeyed())));
    expect(answers.map((answer) => answer.status)).toEqual([201, 201, 201, 201, 201, 201]);
    const keys = answers.map((answer) => answer.body.key as string).sort();
    expect(keys).toEqual([
      'supplier_timeouts',
      'supplier_timeouts_2',
      'supplier_timeouts_3',
      'supplier_timeouts_4',
      'supplier_timeouts_5',
      'supplier_timeouts_6',
    ]);
    expect((await ruleRows()).map((row) => row.key).sort()).toEqual(keys);
    expect((await audit()).map((row) => (row.after as { key: string }).key).sort()).toEqual(keys);
  });

  it('lets a made key and a typed one that meet at the same moment both be written: only the typed one can be refused', async () => {
    const answers = await Promise.all([
      staff.post('/admin/alert-rules', body({ key: 'supplier_timeouts' })),
      staff.post('/admin/alert-rules', unkeyed()),
    ]);
    const made = answers[1];
    expect(made.status).toBe(201);
    if (answers[0].status === 201) expect(made.body.key).toBe('supplier_timeouts_2');
    else {
      expect(answers[0].status).toBe(422);
      expect(made.body.key).toBe('supplier_timeouts');
    }
  });

  it('leaves the change of a rule alone: the made key is a normal key that PATCH can still move, and a taken one is refused', async () => {
    const first = await staff.post('/admin/alert-rules', unkeyed());
    const second = await staff.post('/admin/alert-rules', unkeyed({ name: 'Other rule' }));
    expect((await staff.patch(`/admin/alert-rules/${second.body.id}`, { key: first.body.key })).status).toBe(422);
    const moved = await staff.patch(`/admin/alert-rules/${second.body.id}`, { key: 'moved_key' });
    expect([moved.status, moved.body.key]).toEqual([200, 'moved_key']);
  });

  it('refuses a staff member without alerts:create before it makes anything', async () => {
    expect((await reader.post('/admin/alert-rules', unkeyed())).status).toBe(403);
    expect(await ruleRows()).toHaveLength(0);
  });
});

describe('GET /admin/alert-rules', () => {
  it('lists the rules by name with x-total-count, pages them, and leaves deleted rules out', async () => {
    const { db } = await testDb();
    const rules = [];
    for (const name of ['Charlie', 'Alpha', 'Bravo', 'Delta']) rules.push(await insertRule(db, { name }));
    await insertRule(db, { name: 'Gone', deletedAt: clock.now() });
    const all = await reader.get('/admin/alert-rules');
    expect(all.status).toBe(200);
    expect(all.total).toBe(4);
    expect(all.body.map((rule: { name: string }) => rule.name)).toEqual(['Alpha', 'Bravo', 'Charlie', 'Delta']);
    const page = await reader.get('/admin/alert-rules?_start=1&_end=3');
    expect(page.total).toBe(4);
    expect(page.body.map((rule: { name: string }) => rule.name)).toEqual(['Bravo', 'Charlie']);
    expect(rules).toHaveLength(4);
  });

  it('sorts, filters by severity, isActive and metric, and searches the name, key and metric', async () => {
    const { db } = await testDb();
    await insertRule(db, {
      key: 'api_latency',
      name: 'API latency',
      metric: 'api.p95',
      severity: 'warning',
      threshold: '1500.0000',
    });
    await insertRule(db, {
      key: 'ledger_check',
      name: 'Ledger mismatch',
      metric: 'ledger.mismatch_count',
      threshold: '0.0000',
    });
    await insertRule(db, { key: 'old_rule', name: 'Old rule', isActive: false });
    expect(
      (await reader.get('/admin/alert-rules?severity=warning')).body.map((rule: { key: string }) => rule.key),
    ).toEqual(['api_latency']);
    expect(
      (await reader.get('/admin/alert-rules?isActive=false')).body.map((rule: { key: string }) => rule.key),
    ).toEqual(['old_rule']);
    expect((await reader.get('/admin/alert-rules?metric=ledger.mismatch_count')).total).toBe(1);
    expect((await reader.get('/admin/alert-rules?q=mismatch')).body[0].key).toBe('ledger_check');
    expect((await reader.get('/admin/alert-rules?q=api.p95')).body[0].key).toBe('api_latency');
    expect((await reader.get('/admin/alert-rules?_sort=key&_order=desc')).body[0].key).toBe('old_rule');
    expect((await reader.get('/admin/alert-rules?metric=made.up')).status).toBe(422);
  });

  it('says a rule is open while an alert of it is firing or acknowledged, and muted while mutedUntil is ahead', async () => {
    const { db } = await testDb();
    const quiet = await insertRule(db, { name: 'A quiet rule' });
    const firing = await insertRule(db, { name: 'B firing rule', mutedUntil: new Date(clock.nowMs() + HOUR) });
    const resolved = await insertRule(db, { name: 'C resolved rule', mutedUntil: new Date(clock.nowMs() - HOUR) });
    await insertAlert(db, firing, { startedAt: clock.now() });
    await insertAlert(db, resolved, { startedAt: clock.now(), status: 'resolved', resolvedAt: clock.now() });
    const rows = (await reader.get('/admin/alert-rules')).body;
    expect(rows.map((rule: { id: number; open: boolean; muted: boolean }) => [rule.id, rule.open, rule.muted])).toEqual(
      [
        [quiet.id, false, false],
        [firing.id, true, true],
        // A past mute is not a mute.
        [resolved.id, false, false],
      ],
    );
  });

  it('sends threshold as a JSON number and the channels as a list', async () => {
    const { db } = await testDb();
    await insertRule(db, { threshold: '1500.5000', channels: ['email'] });
    const [rule] = (await reader.get('/admin/alert-rules')).body;
    expect(rule.threshold).toBe(1500.5);
    expect(rule.channels).toEqual(['email']);
  });

  it('refuses a staff member without alerts:read', async () => {
    const nobody = await adminWith(t, ['system:read']);
    const res = await nobody.get('/admin/alert-rules');
    expect(res.status).toBe(403);
    expect(res.body.detail).toContain('alerts:read');
  });
});

describe('GET /admin/alert-rules/:id', () => {
  it('shows one rule, and answers 404 for an unknown or a deleted one', async () => {
    const { db } = await testDb();
    const rule = await insertRule(db, { name: 'Shown' });
    const gone = await insertRule(db, { name: 'Gone', deletedAt: clock.now() });
    const shown = await reader.get(`/admin/alert-rules/${rule.id}`);
    expect(shown.status).toBe(200);
    expect(shown.body).toMatchObject({ id: rule.id, name: 'Shown', unit: 'percent', open: false });
    expect((await reader.get(`/admin/alert-rules/${gone.id}`)).status).toBe(404);
    expect((await reader.get('/admin/alert-rules/9999')).status).toBe(404);
  });
});

describe('PATCH /admin/alert-rules/:id', () => {
  it('changes only the fields sent and sets updatedAt, updatedBy and the audit entry', async () => {
    const { id } = (await staff.post('/admin/alert-rules', body())).body;
    clock.advance(5 * MINUTE);
    const res = await staff.patch(`/admin/alert-rules/${id}`, { threshold: 35, name: 'Supplier timeouts (strict)' });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      key: 'supplier_timeout_rate',
      name: 'Supplier timeouts (strict)',
      threshold: 35,
      windowSeconds: 180,
      comparator: 'gt',
      updatedAt: '2026-11-07T10:05:00.000Z',
    });
    const { db } = await testDb();
    expect((await db.select().from(s.alertRules))[0]).toMatchObject({ updatedBy: staff.staffId });
    const entries = await audit();
    expect(entries.at(-1)).toMatchObject({
      action: 'changed alert rule',
      entityId: id,
      entityLabel: 'Supplier timeouts (strict)',
      before: { threshold: 20 },
      after: { threshold: 35 },
    });
  });

  it('recomputes the unit when the metric changes, and closes the alerts of the old metric', async () => {
    const { id } = (await staff.post('/admin/alert-rules', body())).body;
    const { db } = await testDb();
    const [rule] = await db.select().from(s.alertRules).where(eq(s.alertRules.id, id));
    const alert = await insertAlert(db, rule!, { startedAt: clock.now() });
    clock.advance(MINUTE);
    const res = await staff.patch(`/admin/alert-rules/${id}`, { metric: 'api.p95', threshold: 1500 });
    expect(res.body).toMatchObject({ metric: 'api.p95', unit: 'ms', open: false });
    const [closed] = await db.select().from(s.alertEvents).where(eq(s.alertEvents.id, alert.id));
    expect(closed).toMatchObject({ status: 'resolved', resolvedAt: clock.now() });
    // The alert keeps what fired: the old metric and unit.
    expect(closed).toMatchObject({ metric: 'supplier.timeout_rate', unit: 'percent' });
  });

  it('switches a rule off, resolving its open alerts, and back on (audit verbs turned off / turned on)', async () => {
    const { id } = (await staff.post('/admin/alert-rules', body())).body;
    const { db } = await testDb();
    const [rule] = await db.select().from(s.alertRules).where(eq(s.alertRules.id, id));
    const firing = await insertAlert(db, rule!, { startedAt: clock.now() });
    const acked = await insertAlert(db, rule!, {
      startedAt: clock.now(),
      subjectType: 'supplier',
      subjectId: 7,
      subjectLabel: 'Gulf',
      status: 'acknowledged',
    });
    clock.advance(MINUTE);
    const off = await staff.patch(`/admin/alert-rules/${id}`, { isActive: false });
    expect(off.body).toMatchObject({ isActive: false, open: false });
    const alerts = await db.select().from(s.alertEvents).orderBy(s.alertEvents.id);
    expect(alerts.map((alert) => [alert.id, alert.status])).toEqual([
      [firing.id, 'resolved'],
      [acked.id, 'resolved'],
    ]);
    expect((await staff.patch(`/admin/alert-rules/${id}`, { isActive: true })).body.isActive).toBe(true);
    expect((await audit()).slice(-2).map((entry) => entry.action)).toEqual([
      'turned off alert rule',
      'turned on alert rule',
    ]);
  });

  it('mutes until a future time, keeps open alerts open, unmutes with null, and audits muted / unmuted', async () => {
    const { id } = (await staff.post('/admin/alert-rules', body())).body;
    const { db } = await testDb();
    const [rule] = await db.select().from(s.alertRules).where(eq(s.alertRules.id, id));
    const alert = await insertAlert(db, rule!, { startedAt: clock.now() });
    const until = new Date(clock.nowMs() + 2 * HOUR).toISOString();
    const muted = await staff.patch(`/admin/alert-rules/${id}`, { mutedUntil: until });
    expect(muted.body).toMatchObject({ mutedUntil: until, muted: true, open: true });
    expect((await db.select().from(s.alertEvents).where(eq(s.alertEvents.id, alert.id)))[0]!.status).toBe('firing');
    const unmuted = await staff.patch(`/admin/alert-rules/${id}`, { mutedUntil: null });
    expect(unmuted.body).toMatchObject({ mutedUntil: null, muted: false });
    expect((await audit()).slice(-2).map((entry) => entry.action)).toEqual(['muted alert rule', 'unmuted alert rule']);
  });

  it('answers 422 on mutedUntil for a past time, and 422 for an empty body', async () => {
    const { id } = (await staff.post('/admin/alert-rules', body())).body;
    const past = await staff.patch(`/admin/alert-rules/${id}`, {
      mutedUntil: new Date(clock.nowMs() - MINUTE).toISOString(),
    });
    expect(past.status).toBe(422);
    expect(past.body.errors).toMatchObject([{ field: 'mutedUntil' }]);
    const now = await staff.patch(`/admin/alert-rules/${id}`, { mutedUntil: clock.now().toISOString() });
    expect(now.status).toBe(422);
    expect((await staff.patch(`/admin/alert-rules/${id}`, {})).status).toBe(422);
    expect((await staff.patch(`/admin/alert-rules/${id}`, { mutedUntil: 'tomorrow' })).body.errors[0].field).toBe(
      'mutedUntil',
    );
  });

  it('checks the fields it is sent like create does, and the key against the other rules', async () => {
    const { id } = (await staff.post('/admin/alert-rules', body())).body;
    await staff.post('/admin/alert-rules', body({ key: 'other_rule' }));
    const res = await staff.patch(`/admin/alert-rules/${id}`, { key: 'other_rule', windowSeconds: 10 });
    expect(res.status).toBe(422);
    expect(res.body.errors.map((error: { field: string }) => error.field).sort()).toEqual(['windowSeconds']);
    const dup = await staff.patch(`/admin/alert-rules/${id}`, { key: 'other_rule' });
    expect(dup.body.errors).toMatchObject([{ field: 'key' }]);
    // Its own key is not a duplicate.
    expect((await staff.patch(`/admin/alert-rules/${id}`, { key: 'supplier_timeout_rate' })).status).toBe(200);
  });

  it('answers 404 for an unknown or deleted rule, and 403 without alerts:update', async () => {
    expect((await staff.patch('/admin/alert-rules/9999', { threshold: 1 })).status).toBe(404);
    const { id } = (await staff.post('/admin/alert-rules', body())).body;
    const denied = await reader.patch(`/admin/alert-rules/${id}`, { threshold: 1 });
    expect(denied.status).toBe(403);
    expect(denied.body.detail).toContain('alerts:update');
    await staff.delete(`/admin/alert-rules/${id}`);
    expect((await staff.patch(`/admin/alert-rules/${id}`, { threshold: 1 })).status).toBe(404);
  });
});

describe('DELETE /admin/alert-rules/:id', () => {
  it('soft-deletes: the rule leaves the list, its open alerts close and its alert history keeps the rule', async () => {
    const { id } = (await staff.post('/admin/alert-rules', body())).body;
    const { db } = await testDb();
    const [rule] = await db.select().from(s.alertRules).where(eq(s.alertRules.id, id));
    const alert = await insertAlert(db, rule!, { startedAt: clock.now() });
    clock.advance(MINUTE);
    const res = await staff.delete(`/admin/alert-rules/${id}`);
    expect(res.status).toBe(204);
    expect(res.body).toBeUndefined();
    expect((await reader.get('/admin/alert-rules')).body).toEqual([]);
    expect((await reader.get(`/admin/alert-rules/${id}`)).status).toBe(404);
    const [kept] = await db.select().from(s.alertRules);
    expect(kept).toMatchObject({ id, deletedAt: clock.now(), updatedBy: staff.staffId });
    expect((await db.select().from(s.alertEvents).where(eq(s.alertEvents.id, alert.id)))[0]).toMatchObject({
      status: 'resolved',
      resolvedAt: clock.now(),
    });
    // The alert still carries its rule.
    const shown = await reader.get(`/admin/alerts/${alert.id}`);
    expect(shown.body.rule).toMatchObject({ id, key: kept!.key, name: 'Supplier timeouts' });
    expect((await audit()).at(-1)).toMatchObject({
      action: 'deleted alert rule',
      entityId: id,
      entityLabel: 'Supplier timeouts',
    });
  });

  it('answers 404 for an unknown or already deleted rule, and 403 without alerts:delete', async () => {
    const { id } = (await staff.post('/admin/alert-rules', body())).body;
    const denied = await reader.delete(`/admin/alert-rules/${id}`);
    expect(denied.status).toBe(403);
    expect(denied.body.detail).toContain('alerts:delete');
    expect((await staff.delete(`/admin/alert-rules/${id}`)).status).toBe(204);
    expect((await staff.delete(`/admin/alert-rules/${id}`)).status).toBe(404);
    expect((await staff.delete('/admin/alert-rules/9999')).status).toBe(404);
  });
});
