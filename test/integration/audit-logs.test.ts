// Integration tests of the audit log routes (feature 2a, scenarios admin-team and ip-rules): the list with its filters, search and
// sorts, the snapshots of actor and record names, the masking of secrets, and one entry, through HTTP on the real application.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import { eq } from 'drizzle-orm';
import { schema as s } from '../../src/infra/db';
import { SessionService } from '../../src/modules/identity';
import { AuditService } from '../../src/modules/platform';
import { adminWith } from '../support/admin-api';
import { type TestApp, createTestApp } from '../support/app';
import { clearIdentityCaches } from '../support/auth';
import { TestClock } from '../support/clock';
import { closeTestDb, resetDb, testDb } from '../support/db';

const clock = new TestClock();
let t: TestApp;

beforeAll(async () => {
  t = await createTestApp({ clock });
});
beforeEach(async () => {
  clock.reset();
  await resetDb();
  await clearIdentityCaches(t);
});
afterAll(async () => {
  await resetDb();
  await clearIdentityCaches(t);
  await t.close();
  await closeTestDb();
});

const ids = (body: Array<{ id: number }>) => body.map((row) => row.id);

type AuditValues = typeof s.auditLogs.$inferInsert;

/** Writes audit rows straight to the table with explicit times (the service always stamps the current time). */
async function addEntries(
  entries: Array<Partial<AuditValues> & Pick<AuditValues, 'action' | 'entityType' | 'createdAt'>>,
) {
  const { db } = await testDb();
  const rows = await db
    .insert(s.auditLogs)
    .values(
      entries.map((entry) => ({
        actorType: 'staff' as const,
        actorId: 1,
        actorName: 'Rami K.',
        entityId: 1,
        ...entry,
      })),
    )
    .returning({ id: s.auditLogs.id });
  return rows.map((row) => row.id);
}

/** A small history: staff actions on several kinds of record, a merchant's own action and a system row, across four days. */
async function history() {
  const [suspend, ipRule, setting, system, client, rename] = await addEntries([
    {
      action: 'suspended admin',
      entityType: 'staff',
      entityId: 6,
      entityLabel: 'Yusuf M.',
      before: { status: 'active' },
      after: { status: 'suspended', reason: 'Left the team' },
      ip: '203.0.113.24',
      createdAt: new Date('2026-10-30T23:59:59.999Z'),
    },
    {
      action: 'blocked IP',
      entityType: 'ip_rule',
      entityId: 3,
      entityLabel: '198.51.100.7',
      actorName: 'Lina S.',
      actorId: 2,
      createdAt: new Date('2026-10-31T00:00:00.000Z'),
    },
    {
      action: 'changed settings',
      entityType: 'setting',
      entityId: 0,
      entityLabel: 'imeiRetentionDays',
      createdAt: new Date('2026-10-31T12:00:00.000Z'),
    },
    {
      action: 'ran the nightly promotion',
      entityType: 'client_group',
      entityId: 2,
      actorType: 'system',
      actorId: null,
      actorName: '',
      entityLabel: '',
      ip: null,
      createdAt: new Date('2026-11-01T02:00:00.000Z'),
    },
    {
      action: 'placed an order via the API',
      entityType: 'order',
      entityId: 41,
      actorType: 'client',
      actorId: 9,
      actorName: 'Zain Mobile Hub',
      entityLabel: 'Order 41',
      createdAt: new Date('2026-11-01T23:59:59.999Z'),
    },
    {
      action: 'edited admin',
      entityType: 'staff',
      entityId: 2,
      entityLabel: 'Lina S.',
      createdAt: new Date('2026-11-02T00:00:00.000Z'),
    },
  ]);
  return { suspend: suspend!, ipRule: ipRule!, setting: setting!, system: system!, client: client!, rename: rename! };
}

describe('GET /admin/audit-logs', () => {
  it('lists entries newest first with the snapshots as written, and the exact total', async () => {
    const h = await history();
    const rami = await adminWith(t, ['audit:read']);
    const res = await rami.get('/admin/audit-logs');
    expect(res.status).toBe(200);
    expect(res.total).toBe(6);
    expect(ids(res.body)).toEqual([h.rename, h.client, h.system, h.setting, h.ipRule, h.suspend]);
    expect(res.body.find((row: { id: number }) => row.id === h.suspend)).toEqual({
      id: h.suspend,
      createdAt: '2026-10-30T23:59:59.999Z',
      action: 'suspended admin',
      entityType: 'staff',
      entityId: 6,
      actorType: 'staff',
      actorId: 1,
      actorName: 'Rami K.',
      entityLabel: 'Yusuf M.',
      before: { status: 'active' },
      after: { status: 'suspended', reason: 'Left the team' },
      ip: '203.0.113.24',
    });
  });

  it('answers null for what was never known: a system row has no actor name, id or address, and an empty label is null', async () => {
    const h = await history();
    const rami = await adminWith(t, ['audit:read']);
    const system = (await rami.get(`/admin/audit-logs/${h.system}`)).body;
    expect(system).toMatchObject({
      actorType: 'system',
      actorId: null,
      actorName: null,
      entityLabel: null,
      ip: null,
      before: null,
      after: null,
    });
    const setting = (await rami.get(`/admin/audit-logs/${h.setting}`)).body;
    // A settings change has no numeric record: 0, and the label names the key.
    expect(setting).toMatchObject({ entityId: 0, entityLabel: 'imeiRetentionDays', ip: null });
    const client = (await rami.get(`/admin/audit-logs/${h.client}`)).body;
    expect(client).toMatchObject({ actorType: 'client', actorId: 9, actorName: 'Zain Mobile Hub' });
  });

  it('filters by actor type, actor, record type and record', async () => {
    const h = await history();
    const rami = await adminWith(t, ['audit:read']);
    expect(ids((await rami.get('/admin/audit-logs?actorType=system')).body)).toEqual([h.system]);
    expect(ids((await rami.get('/admin/audit-logs?actorType=client')).body)).toEqual([h.client]);
    expect((await rami.get('/admin/audit-logs?actorType=staff')).total).toBe(4);
    expect(ids((await rami.get('/admin/audit-logs?actorId=2')).body)).toEqual([h.ipRule]);
    expect(ids((await rami.get('/admin/audit-logs?entityType=staff')).body)).toEqual([h.rename, h.suspend]);
    expect(ids((await rami.get('/admin/audit-logs?entityType=staff&entityId=6')).body)).toEqual([h.suspend]);
    expect(ids((await rami.get('/admin/audit-logs?entityType=order&actorType=client')).body)).toEqual([h.client]);
    expect((await rami.get('/admin/audit-logs?entityType=nothing')).total).toBe(0);
  });

  it('searches the actor name, the action and the record label, ignoring case', async () => {
    const h = await history();
    const rami = await adminWith(t, ['audit:read']);
    expect(ids((await rami.get('/admin/audit-logs?q=ZAIN')).body)).toEqual([h.client]);
    expect(ids((await rami.get('/admin/audit-logs?q=blocked')).body)).toEqual([h.ipRule]);
    expect(ids((await rami.get('/admin/audit-logs?q=yusuf')).body)).toEqual([h.suspend]);
    // The actor name and the label are both searched.
    expect(ids((await rami.get('/admin/audit-logs?q=lina')).body)).toEqual([h.rename, h.ipRule]);
    expect(ids((await rami.get('/admin/audit-logs?q=imeiretention')).body)).toEqual([h.setting]);
    expect((await rami.get('/admin/audit-logs?q=rami')).total).toBe(3);
    expect(ids((await rami.get('/admin/audit-logs?q=admin&actorType=staff')).body)).toEqual([h.rename, h.suspend]);
    expect((await rami.get('/admin/audit-logs?q=no-such-text')).total).toBe(0);
    // A SQL wildcard typed into the box is text, not a pattern.
    expect((await rami.get('/admin/audit-logs?q=%25')).total).toBe(0);
  });

  it('keeps entries from the first day through the last day inclusive (UTC days), and each bound alone', async () => {
    const h = await history();
    const rami = await adminWith(t, ['audit:read']);
    expect(ids((await rami.get('/admin/audit-logs?from=2026-10-31&to=2026-11-01')).body)).toEqual([
      h.client,
      h.system,
      h.setting,
      h.ipRule,
    ]);
    expect(ids((await rami.get('/admin/audit-logs?from=2026-11-02')).body)).toEqual([h.rename]);
    expect(ids((await rami.get('/admin/audit-logs?to=2026-10-30')).body)).toEqual([h.suspend]);
    expect(ids((await rami.get('/admin/audit-logs?from=2026-10-31&to=2026-10-31')).body)).toEqual([
      h.setting,
      h.ipRule,
    ]);
    expect((await rami.get('/admin/audit-logs?from=2026-11-03')).total).toBe(0);
    // Combined with the other filters.
    expect(ids((await rami.get('/admin/audit-logs?from=2026-10-31&entityType=ip_rule')).body)).toEqual([h.ipRule]);
  });

  it('sorts by time or id in both directions, and pages with the exact total', async () => {
    const h = await history();
    const rami = await adminWith(t, ['audit:read']);
    expect(ids((await rami.get('/admin/audit-logs?_sort=createdAt&_order=asc')).body)).toEqual([
      h.suspend,
      h.ipRule,
      h.setting,
      h.system,
      h.client,
      h.rename,
    ]);
    expect(ids((await rami.get('/admin/audit-logs?_sort=id&_order=desc&_end=2')).body)).toEqual([h.rename, h.client]);
    const page = await rami.get('/admin/audit-logs?_sort=id&_order=asc&_start=2&_end=4');
    expect(ids(page.body)).toEqual([h.setting, h.system]);
    expect(page.total).toBe(6);
    const filtered = await rami.get('/admin/audit-logs?actorType=staff&_start=0&_end=1');
    expect(filtered.body).toHaveLength(1);
    expect(filtered.total).toBe(4);
  });

  it('refuses a filter, sort or date the contract does not allow (422) and needs audit:read', async () => {
    const rami = await adminWith(t, ['audit:read']);
    for (const query of [
      'actorType=robot',
      'actorId=abc',
      'from=2026-13-01',
      'from=yesterday',
      'to=2026-02-30',
      '_sort=action',
    ]) {
      expect((await rami.get(`/admin/audit-logs?${query}`)).status, query).toBe(422);
    }
    const nobody = await adminWith(t, ['staff:read']);
    const refused = await nobody.get('/admin/audit-logs');
    expect(refused.status).toBe(403);
    expect(refused.body.detail).toContain('audit:read');
    expect((await rami.anonymous('GET', '/admin/audit-logs')).status).toBe(401);
  });

  it('shows what the application writes: the actor and record names are snapshots, and secrets are masked', async () => {
    const owner = await adminWith(t, ['*'], { name: 'Rami K.', ip: '203.0.113.50' });
    const created = await owner.post('/admin/roles', { name: 'Support', permissions: ['staff:read'] });
    expect(created.status).toBe(201);
    // Rename the actor: the entry written before keeps the old name, the one written after has the new one.
    const { db } = await testDb();
    await db.update(s.staffUsers).set({ name: 'Rami Khalil' }).where(eq(s.staffUsers.id, owner.staffId));
    await t.app.get(SessionService).invalidateSubject('staff', owner.staffId);
    await owner.patch(`/admin/roles/${created.body.id}`, { name: 'Support team' });

    const list = await owner.get('/admin/audit-logs?_sort=id&_order=asc');
    expect(list.body.map((row: { actorName: string; action: string }) => [row.actorName, row.action])).toEqual([
      ['Rami K.', expect.any(String)],
      ['Rami Khalil', expect.any(String)],
    ]);
    expect(list.body[0]).toMatchObject({
      actorType: 'staff',
      actorId: owner.staffId,
      entityType: 'role',
      entityLabel: 'Support',
      ip: '203.0.113.50',
    });

    // A snapshot that carries a secret key reads back masked, nested or not.
    await db.transaction(async (tx) => {
      await t.app.get(AuditService).record(tx, {
        action: 'changed a gateway',
        entityType: 'payment_gateway',
        entityId: 5,
        entityLabel: 'Stripe',
        before: { name: 'Stripe', apiKey: 'sk_live_old', nested: { webhookSecret: 'whsec_old', mode: 'live' } },
        after: { name: 'Stripe', apiKey: 'sk_live_new', passwordHash: '$argon2id$x', token: 'abc' },
      });
    });
    const last = (await owner.get('/admin/audit-logs?_sort=id&_order=desc&_end=1')).body[0];
    expect(last.before).toEqual({
      name: 'Stripe',
      apiKey: '[redacted]',
      nested: { webhookSecret: '[redacted]', mode: 'live' },
    });
    expect(last.after).toEqual({
      name: 'Stripe',
      apiKey: '[redacted]',
      passwordHash: '[redacted]',
      token: '[redacted]',
    });
    expect(JSON.stringify(last)).not.toMatch(/sk_live|whsec_|argon2id|abc/);
  });
});

describe('GET /admin/audit-logs/:id', () => {
  it('shows one entry, answers 404 for an unknown id and 422 for a malformed one, and needs audit:read', async () => {
    const h = await history();
    const rami = await adminWith(t, ['audit:read']);
    const shown = await rami.get(`/admin/audit-logs/${h.ipRule}`);
    expect(shown.status).toBe(200);
    expect(shown.body).toMatchObject({
      id: h.ipRule,
      action: 'blocked IP',
      entityType: 'ip_rule',
      entityLabel: '198.51.100.7',
      actorName: 'Lina S.',
    });
    const missing = await rami.get('/admin/audit-logs/999999');
    expect(missing.status).toBe(404);
    expect(missing.body.code).toBe('NOT_FOUND');
    expect((await rami.get('/admin/audit-logs/abc')).status).toBe(422);
    const nobody = await adminWith(t, ['staff:read']);
    expect((await nobody.get(`/admin/audit-logs/${h.ipRule}`)).status).toBe(403);
  });
});
