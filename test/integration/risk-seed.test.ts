// The risk seed (feature 18): the demo's rules, blocklist, IMEI checks and data requests appear with the ids, kinds, displays and
// statuses of the frontend mocks, through the real API, and a second run changes nothing.
import { afterAll, beforeAll, describe, expect, it, setDefaultTimeout } from 'bun:test';
import { existsSync } from 'node:fs';
import { inArray } from 'drizzle-orm';
import { demoStatePath, loadDemoState } from '../../scripts/seed/demo-state';
import { runSeed } from '../../scripts/seed/run';
import { schema as s } from '../../src/infra/db';
import { IpRuleCache } from '../../src/modules/identity';
import { MaintenanceService } from '../../src/modules/platform';
import { RiskScreening } from '../../src/modules/risk';
import { type AdminApi, adminWith } from '../support/admin-api';
import { type TestApp, createTestApp } from '../support/app';
import { clearIdentityCaches } from '../support/auth';
import { closeTestDb, resetDb, testDb } from '../support/db';

setDefaultTimeout(180_000);

const frontendPresent = existsSync(demoStatePath());
let t: TestApp;
let staff: AdminApi;

beforeAll(async () => {
  if (!frontendPresent) return;
  t = await createTestApp();
  await resetDb();
  await clearIdentityCaches(t);
  const { db } = await testDb();
  await runSeed(db, await loadDemoState(), t.config);
  await t.app.get(IpRuleCache).invalidate();
  staff = await adminWith(t, ['risk:*', 'customers:privacy']);
});

afterAll(async () => {
  if (!frontendPresent) return;
  await resetDb();
  await clearIdentityCaches(t);
  await t.app.get(IpRuleCache).invalidate();
  await t.app.get(MaintenanceService).invalidate();
  await t.close();
  await closeTestDb();
});

describe.skipIf(!frontendPresent)('the risk seed', () => {
  it("writes the demo's five blocklist entries by their demo ids, authors by name, hashed values and no readable email", async () => {
    const res = await staff.get('/admin/blocklist?_sort=createdAt&_order=asc');
    expect(res.total).toBe(5);
    expect(res.body.map((row: { id: number }) => row.id).sort()).toEqual([1, 2, 3, 5, 6]);
    const byId = (id: number) => res.body.find((row: { id: number }) => row.id === id);
    expect(byId(1)).toMatchObject({
      kind: 'email',
      display: 'jt.****@tempbox.example',
      source: 'chargeback',
      createdBy: null,
    });
    expect(byId(3)).toMatchObject({
      kind: 'domain',
      display: 'tempbox.example',
      source: 'manual',
      createdBy: { name: 'Rami K.' },
    });
    expect(byId(5)).toMatchObject({ kind: 'imei', display: '35 389011 884201 9', createdBy: { name: 'Lina S.' } });
    expect(byId(6)).toMatchObject({ kind: 'country', display: 'Region under sanctions' });
    const { db } = await testDb();
    const rows = await db.select().from(s.blocklistEntries);
    expect(new Set(rows.map((row) => row.valueHash)).size).toBe(5);
  });

  it('seeded IMEI and domain entries really block: a payment from that domain or for that IMEI is blocked', async () => {
    const { db } = await testDb();
    const screening = t.app.get(RiskScreening);
    const blocked = await db.transaction((tx) =>
      screening.assess(tx, {
        customerId: null,
        email: 'someone@tempbox.example',
        amountUsd: '10.0000',
        paymentMethod: 'card',
        imei: '353890118842019',
      }),
    );
    expect(blocked.block).toBe(true);
    expect(blocked.signals).toEqual(['Email domain is on the blocklist', 'IMEI is on the blocklist']);
  });

  it("writes the demo's IMEI checks with their ids, the TAC's device, the result by kind and the six oldest erased", async () => {
    const list = await staff.get('/admin/imei-checks?_start=0&_end=20');
    expect(list.total).toBeGreaterThan(800);
    expect(list.body[0]).toMatchObject({
      source: expect.stringMatching(/pre_order|storefront_free/),
      cost: expect.any(String),
      orderId: null,
    });
    expect(list.body[0].imei).toMatch(/^\d{15}$/);
    const oldest = await staff.get('/admin/imei-checks?_sort=createdAt&_order=asc&_start=0&_end=8');
    const masks = oldest.body.slice(0, 6).map((row: { imei: string }) => row.imei);
    for (const mask of masks) expect(mask).toMatch(/^\d{8}•{7}$/);
    expect(oldest.body[6].imei).toMatch(/^\d{15}$/);
    expect((await staff.get('/admin/imei-checks?status=blacklisted')).total).toBeGreaterThan(0);
  });

  it("writes the demo's two data requests (done becomes completed) and the rules with the demo's numbers", async () => {
    const requests = await staff.get('/admin/data-requests');
    expect(requests.total).toBe(2);
    expect(requests.body.find((row: { id: number }) => row.id === 31)).toMatchObject({
      customerId: 4,
      kind: 'export',
      status: 'completed',
      handledBy: 1,
    });
    expect(requests.body.find((row: { id: number }) => row.id === 32)).toMatchObject({
      customerId: 16,
      kind: 'erasure',
      status: 'open',
      handledBy: null,
    });
    const rules = await staff.get('/admin/risk/rules');
    const valueOf = (id: string) => rules.body.rules.find((rule: { id: string }) => rule.id === id);
    expect(valueOf('reviewThreshold')).toMatchObject({ on: true, value: 50 });
    expect(valueOf('blockThreshold')).toMatchObject({ on: true, value: 80 });
    expect(valueOf('blockDisposableEmail')).toMatchObject({ on: false });
    expect(valueOf('require3ds')).toMatchObject({ on: true });
  });

  it("shows the demo's review queue: the four held storefront orders, oldest payment first, with the demo's scores and signals", async () => {
    const queue = (await staff.get('/admin/risk/queue')).body;
    expect(queue.held.map((row: { orderId: number }) => row.orderId)).toEqual([20490, 20491, 20494, 20495]);
    expect(queue.held[0]).toMatchObject({
      orderId: 20490,
      score: 67,
      signals: ['IMEI was checked blacklisted before', 'New customer, first order above $40', 'VPN or proxy IP'],
      customer: { id: 10 },
    });
    expect(queue.held[3]).toMatchObject({ orderId: 20495, score: 87, customer: { id: 21 } });
    // Every held order is paid, pending and never sent anywhere; their assessments are unreviewed `review` rows.
    const { db } = await testDb();
    const orders = await db
      .select()
      .from(s.orders)
      .where(inArray(s.orders.id, [20490, 20491, 20494, 20495]));
    expect(orders.map((order) => [order.status, order.dispatchState, order.supplierRef])).toEqual(
      orders.map(() => ['pending', 'held', null]),
    );
    const held = await db
      .select()
      .from(s.riskAssessments)
      .where(inArray(s.riskAssessments.orderId, [20490, 20491, 20494, 20495]));
    expect(held).toHaveLength(4);
    for (const row of held) {
      expect(row).toMatchObject({
        decision: 'review',
        provider: 'internal',
        reviewedBy: null,
        reviewedAt: null,
        outcome: null,
        orderId: row.id,
        checkoutSessionId: row.id,
      });
    }
  });

  it("shows the demo's recent decisions: SF-20464 refunded by Rami K., then SF-20400 approved by Lina S.", async () => {
    const queue = (await staff.get('/admin/risk/queue')).body;
    expect(queue.recent).toHaveLength(2);
    expect(queue.recent[0]).toMatchObject({
      orderId: 20464,
      score: 84,
      outcome: 'refunded',
      reviewedBy: { name: 'Rami K.' },
      customer: { id: 25 },
    });
    expect(queue.recent[1]).toMatchObject({
      orderId: 20400,
      score: 71,
      outcome: 'approved',
      reviewedBy: { name: 'Lina S.' },
      customer: { id: 19 },
    });
    expect(Date.parse(queue.recent[0].reviewedAt)).toBeGreaterThan(Date.parse(queue.recent[1].reviewedAt));
    // A decided order is not held any more, and the figures count the decisions of the last 30 days only.
    expect(queue.held.map((row: { orderId: number }) => row.orderId)).not.toContain(20464);
    expect(queue.stats.decided30d).toBeLessThanOrEqual(2);
    expect(queue.stats.approved30d + queue.stats.refunded30d).toBe(queue.stats.decided30d);
  });

  it('lets staff decide a seeded held order: approving releases it by the placement rule and the queue shrinks', async () => {
    const { db } = await testDb();
    expect((await staff.post('/admin/risk/orders/20490/approve')).status).toBe(204);
    const [order] = await db
      .select()
      .from(s.orders)
      .where(inArray(s.orders.id, [20490]));
    expect(order).toMatchObject({ status: 'pending' });
    expect(order!.dispatchState).not.toBe('held');
    const queue = (await staff.get('/admin/risk/queue')).body;
    expect(queue.held.map((row: { orderId: number }) => row.orderId)).toEqual([20491, 20494, 20495]);
    expect(queue.recent[0]).toMatchObject({ orderId: 20490, outcome: 'approved' });
  });

  it('is idempotent: a second run inserts nothing', async () => {
    const { db } = await testDb();
    const reports = await runSeed(db, await loadDemoState(), t.config);
    for (const report of reports.filter((r) =>
      ['blocklist_entries', 'imei_checks', 'data_requests', 'risk_assessments'].includes(r.table),
    )) {
      expect(report.inserted, report.table).toBe(0);
    }
    // A decision made after the first run (the approval above) is not undone by seeding again.
    const queue = (await staff.get('/admin/risk/queue')).body;
    expect(queue.held.map((row: { orderId: number }) => row.orderId)).toEqual([20491, 20494, 20495]);
  });
});
