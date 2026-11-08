// The commissions seed (feature 11): the demo's plans, the plan of each demo agent, the demo's accruals linked to the seeded orders and to
// their commission journals, and the demo's referral links appear through the real API with the ids, names and amounts of the frontend
// mock. Runs the whole seed once, like the other seed tests.
import { afterAll, beforeAll, describe, expect, it, setDefaultTimeout } from 'bun:test';
import { existsSync } from 'node:fs';
import { and, eq, isNotNull } from 'drizzle-orm';
import { demoNumericId, demoRows, demoStatePath, loadDemoState } from '../../scripts/seed/demo-state';
import { runSeed } from '../../scripts/seed/run';
import { schema as s } from '../../src/infra/db';
import { type AdminApi, adminWith } from '../support/admin-api';
import { type TestApp, createTestApp } from '../support/app';
import { clearIdentityCaches } from '../support/auth';
import { closeTestDb, resetDb, testDb } from '../support/db';

setDefaultTimeout(180_000);

const frontendPresent = existsSync(demoStatePath());
let t: TestApp;
let staff: AdminApi;
let demoAccruals: Array<{ id: string; agent: string; amount: number; status: string }> = [];
let demoMerchants: Array<{
  id: string;
  name: string;
  referredBy: string | null;
  isAgent: boolean;
  plan: string | null;
}> = [];

beforeAll(async () => {
  if (!frontendPresent) return;
  t = await createTestApp();
  await resetDb();
  await clearIdentityCaches(t);
  const demo = await loadDemoState();
  demoAccruals = demoRows(demo, 'accruals');
  demoMerchants = demoRows(demo, 'merchants');
  await runSeed((await testDb()).db, demo, t.config);
  staff = await adminWith(t, ['commissions:*', 'reports:read']);
});
afterAll(async () => {
  if (!frontendPresent) return;
  await resetDb();
  await clearIdentityCaches(t);
  await t.close();
  await closeTestDb();
});

describe.skipIf(!frontendPresent)('the commissions seed', () => {
  it("writes the demo's two plans and the rebate plan the console's mock adds, with 4-decimal rates", async () => {
    const list = await staff.get('/admin/commission-plans?_end=200');
    expect(list.total).toBe(3);
    expect(
      list.body.map((plan: { name: string; kind: string; percent: string }) => [plan.name, plan.kind, plan.percent]),
    ).toEqual([
      ['Referral', 'referral', '3.0000'],
      ['Partner', 'referral', '5.0000'],
      ['Volume rebate', 'rebate', '1.5000'],
    ]);
    expect(list.body[1].tiers).toEqual({ minPayout: '100.0000', minReferrals: 3 });
    expect(list.body[2].tiers).toEqual({
      brackets: [
        { from: '1000', percent: '1.0' },
        { from: '5000', percent: '1.5' },
      ],
    });
  });

  it("puts each demo agent on its plan with the figures of the agents table, and seeds the demo's referral links", async () => {
    const agents = demoMerchants.filter((merchant) => merchant.isAgent && merchant.plan);
    const list = await staff.get('/admin/commission-assignments?_end=200');
    expect(list.total).toBe(agents.length);
    for (const agent of agents) {
      const row = list.body.find((item: { beneficiaryId: number }) => item.beneficiaryId === demoNumericId(agent.id));
      expect(row).toMatchObject({
        planId: demoNumericId(agent.plan!),
        scope: 'referrals',
        endsAt: null,
        beneficiary: { name: agent.name },
      });
      const referred = demoMerchants.filter((merchant) => merchant.referredBy === agent.id).length;
      expect(row.referredCount).toBe(referred);
    }
  });

  it("links the demo's accruals to the seeded orders and merchants, in the demo's states and amounts", async () => {
    const { db } = await testDb();
    const rows = await db.select().from(s.commissionAccruals).orderBy(s.commissionAccruals.id);
    expect(rows).toHaveLength(demoAccruals.length);
    for (const demo of demoAccruals.slice(0, 20)) {
      const row = rows.find((item) => item.id === demoNumericId(demo.id))!;
      expect(row.status as string).toBe(demo.status);
      expect(row.beneficiaryId).toBe(demoNumericId(demo.agent));
      expect(row.amount).toBe(demo.amount.toFixed(4));
    }
    const accrued = await staff.get('/admin/commission-accruals?status=accrued&_start=0&_end=1');
    expect(accrued.total).toBe(demoAccruals.filter((accrual) => accrual.status === 'accrued').length);
    const first = await staff.get(`/admin/commission-accruals/${demoNumericId(demoAccruals[0]!.id)}`);
    expect(first.body).toMatchObject({
      status: 'approved',
      beneficiary: { name: expect.any(String) },
      merchant: { name: expect.any(String) },
    });
    expect(first.body.approvedAt).not.toBeNull();
  });

  it("ties every approved accrual to the demo's `commission` journal of that accrual", async () => {
    const { db } = await testDb();
    const approved = await db
      .select({ id: s.commissionAccruals.id, ledgerTxId: s.commissionAccruals.ledgerTxId })
      .from(s.commissionAccruals)
      .where(and(eq(s.commissionAccruals.status, 'approved'), isNotNull(s.commissionAccruals.approvedAt)));
    expect(approved.length).toBe(demoAccruals.filter((accrual) => accrual.status === 'approved').length);
    expect(approved.every((row) => row.ledgerTxId !== null)).toBe(true);
    const unpaid = await db
      .select({ id: s.commissionAccruals.id })
      .from(s.commissionAccruals)
      .where(and(eq(s.commissionAccruals.status, 'accrued'), isNotNull(s.commissionAccruals.ledgerTxId)));
    expect(unpaid).toHaveLength(0);
  });

  it('feeds the reports: the profit report sees the seeded completed orders and the exposure report the seeded wallets', async () => {
    const profit = await staff.get('/admin/reports/profit?groupBy=service');
    expect(profit.status).toBe(200);
    expect(profit.body.rows.length).toBeGreaterThan(0);
    const exposure = await staff.get('/admin/reports/wallet-exposure');
    expect(exposure.body.totals.clients).toBeGreaterThan(0);
    const top = await staff.get('/admin/reports/top-clients?days=14&limit=6');
    expect(top.status).toBe(200);
    expect(Array.isArray(top.body)).toBe(true);
  });

  it('is idempotent: a second run writes nothing', async () => {
    const { db } = await testDb();
    const reports = await runSeed(db, await loadDemoState(), t.config);
    const mine = reports.filter((report) =>
      ['commission_plans', 'commission_assignments', 'commission_accruals'].includes(report.table),
    );
    expect(mine).toHaveLength(3);
    for (const report of mine) expect(report.inserted).toBe(0);
  });
});
