// The commission plan routes of feature 11 (RULES commissions 5 to 7, resolution health-commissions-1): list, show, create, change and
// delete a plan. The rate is 0.5 to 15 percent, kind and the labels are required, tiers is a JSON object, a plan in use is never
// deleted, and every write is audited with the demo's verb phrases.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import { eq } from 'drizzle-orm';
import { schema as s } from '../../src/infra/db';
import { type AdminApi, adminWith } from '../support/admin-api';
import { type TestApp, createTestApp } from '../support/app';
import { clearIdentityCaches } from '../support/auth';
import { type CommissionsWorld, assignPlan, commissionsWorld } from '../support/commissions';
import { closeTestDb, resetDb, testDb } from '../support/db';

let t: TestApp;
let world: CommissionsWorld;
let staff: AdminApi;

beforeAll(async () => {
  t = await createTestApp();
});
beforeEach(async () => {
  await resetDb();
  await clearIdentityCaches(t);
  world = await commissionsWorld((await testDb()).db);
  staff = await adminWith(t, ['commissions:*'], { name: 'Omar T.' });
});
afterAll(async () => {
  await resetDb();
  await clearIdentityCaches(t);
  await t.close();
  await closeTestDb();
});

const body = (overrides: Record<string, unknown> = {}) => ({
  name: 'Gold',
  kind: 'referral',
  percent: '3.5',
  basis: 'Order revenue of referred merchants',
  period: 'monthly',
  tiers: { minPayout: '50.0000', minReferrals: 3 },
  isActive: true,
  ...overrides,
});

const auditOf = async (entityId: number) => {
  const { db } = await testDb();
  return db.select().from(s.auditLogs).where(eq(s.auditLogs.entityId, entityId)).orderBy(s.auditLogs.id);
};

describe('GET /admin/commission-plans', () => {
  it('lists the plans id ascending with the percent as a 4-decimal string and tiers as an object', async () => {
    const res = await staff.get('/admin/commission-plans?_start=0&_end=200&_sort=id&_order=asc');
    expect(res.status).toBe(200);
    expect(res.total).toBe(3);
    expect(res.body.map((plan: { name: string }) => plan.name)).toEqual(['Referral', 'Partner', 'Volume rebate']);
    expect(res.body[0]).toMatchObject({
      kind: 'referral',
      basis: 'Order revenue of referred merchants',
      percent: '3.0000',
      tiers: {},
      period: 'monthly',
      isActive: true,
    });
    expect(res.body[2]).toMatchObject({ kind: 'rebate', percent: '1.5000' });
  });

  it('filters by kind and switch, searches by name and sorts by rate', async () => {
    expect(
      (await staff.get('/admin/commission-plans?kind=rebate')).body.map((plan: { name: string }) => plan.name),
    ).toEqual(['Volume rebate']);
    await world.db
      .update(s.commissionPlans)
      .set({ isActive: false })
      .where(eq(s.commissionPlans.id, world.plans.partner));
    expect(
      (await staff.get('/admin/commission-plans?isActive=false')).body.map((plan: { name: string }) => plan.name),
    ).toEqual(['Partner']);
    expect((await staff.get('/admin/commission-plans?q=volume')).total).toBe(1);
    const byRate = await staff.get('/admin/commission-plans?_sort=percent&_order=desc');
    expect(byRate.body.map((plan: { percent: string }) => plan.percent)).toEqual(['5.0000', '3.0000', '1.5000']);
  });

  it('pages with x-total-count', async () => {
    const page = await staff.get('/admin/commission-plans?_start=1&_end=2');
    expect(page.body).toHaveLength(1);
    expect(page.total).toBe(3);
  });

  it('is refused without commissions:read', async () => {
    const other = await adminWith(t, ['orders:read']);
    expect((await other.get('/admin/commission-plans')).status).toBe(403);
    expect((await other.get(`/admin/commission-plans/${world.plans.referral}`)).status).toBe(403);
  });
});

describe('GET /admin/commission-plans/:id', () => {
  it('shows one plan and answers 404 for an unknown one', async () => {
    const res = await staff.get(`/admin/commission-plans/${world.plans.partner}`);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ id: world.plans.partner, name: 'Partner', percent: '5.0000' });
    expect((await staff.get('/admin/commission-plans/99999')).status).toBe(404);
  });
});

describe('POST /admin/commission-plans', () => {
  it('creates a plan with the rate normalised to 4 decimals, answers 201 and writes the audit row', async () => {
    const res = await staff.post('/admin/commission-plans', body());
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({
      name: 'Gold',
      kind: 'referral',
      percent: '3.5000',
      tiers: { minPayout: '50.0000', minReferrals: 3 },
      isActive: true,
    });
    const [audit] = await auditOf(res.body.id);
    expect(audit).toMatchObject({
      action: 'created plan',
      entityType: 'plan',
      entityLabel: 'Gold',
      actorType: 'staff',
      actorName: 'Omar T.',
    });
    // The console prints `<actor> <action> <entityLabel>`.
    expect(`${audit!.actorName} ${audit!.action} ${audit!.entityLabel}`).toBe('Omar T. created plan Gold');
  });

  it('defaults tiers to {} (never []) and isActive to true', async () => {
    const res = await staff.post('/admin/commission-plans', {
      name: 'Plain',
      kind: 'rebate',
      percent: '2',
      basis: 'Own revenue',
      period: 'monthly',
    });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ tiers: {}, isActive: true, percent: '2.0000' });
  });

  it('takes the limits of the rate and refuses anything outside 0.5 to 15 with 422 on percent', async () => {
    expect((await staff.post('/admin/commission-plans', body({ percent: '0.5' }))).status).toBe(201);
    expect((await staff.post('/admin/commission-plans', body({ percent: '15' }))).status).toBe(201);
    for (const percent of ['0.49', '15.01', '0', '100', 'abc', '']) {
      const res = await staff.post('/admin/commission-plans', body({ percent }));
      expect(res.status).toBe(422);
      expect(res.body.errors.map((error: { field: string }) => error.field)).toContain('percent');
    }
    const low = await staff.post('/admin/commission-plans', body({ percent: '0.1' }));
    expect(low.body.errors[0].message).toBe('Enter a rate between 0.5 and 15.');
  });

  it('refuses an unknown kind, empty labels and a tiers value that is not a plain object (422 on the field)', async () => {
    const field = async (overrides: Record<string, unknown>) => {
      const res = await staff.post('/admin/commission-plans', body(overrides));
      expect(res.status).toBe(422);
      return res.body.errors.map((error: { field: string }) => error.field);
    };
    expect(await field({ kind: 'bonus' })).toContain('kind');
    expect(await field({ name: ' ' })).toContain('name');
    expect(await field({ basis: '' })).toContain('basis');
    expect(await field({ period: '' })).toContain('period');
    expect(await field({ tiers: [] })).toContain('tiers');
    expect(await field({ tiers: 'x' })).toContain('tiers');
    expect(await field({ tiers: null })).toContain('tiers');
  });

  it('is refused without commissions:create', async () => {
    const reader = await adminWith(t, ['commissions:read']);
    expect((await reader.post('/admin/commission-plans', body())).status).toBe(403);
  });
});

describe('PATCH /admin/commission-plans/:id', () => {
  it('changes only the keys sent, refreshes updatedAt and audits a new rate as `changed rate of`', async () => {
    const before = (await staff.get(`/admin/commission-plans/${world.plans.referral}`)).body;
    const res = await staff.patch(`/admin/commission-plans/${world.plans.referral}`, { percent: '4.25' });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ name: 'Referral', percent: '4.2500', basis: before.basis, isActive: true });
    expect(Date.parse(res.body.updatedAt)).toBeGreaterThanOrEqual(Date.parse(before.updatedAt));
    const audit = (await auditOf(world.plans.referral)).at(-1)!;
    expect(audit).toMatchObject({ action: 'changed rate of', entityType: 'plan', entityLabel: 'Referral plan' });
    expect(`${audit.actorName} ${audit.action} ${audit.entityLabel}`).toBe('Omar T. changed rate of Referral plan');
    expect(audit.before).toMatchObject({ percent: '3.0000' });
    expect(audit.after).toMatchObject({ percent: '4.2500' });
  });

  it('audits any other change as `edited plan` and can switch a plan off', async () => {
    const res = await staff.patch(`/admin/commission-plans/${world.plans.partner}`, {
      isActive: false,
      tiers: { brackets: [{ from: '1000', percent: '1.0' }] },
    });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ isActive: false, tiers: { brackets: [{ from: '1000', percent: '1.0' }] } });
    expect((await auditOf(world.plans.partner)).at(-1)).toMatchObject({
      action: 'edited plan',
      entityLabel: 'Partner',
    });
  });

  it('gives the current assignments the scope of a new kind', async () => {
    const { db, agent, plans } = world;
    const assignment = await assignPlan(db, agent.id, plans.referral);
    expect((await staff.patch(`/admin/commission-plans/${plans.referral}`, { kind: 'rebate' })).status).toBe(200);
    const [row] = await db.select().from(s.commissionAssignments).where(eq(s.commissionAssignments.id, assignment));
    expect(row!.scope).toBe('own');
  });

  it('applies the same field rules as the create, refuses an empty change and answers 404 for an unknown plan', async () => {
    const bad = await staff.patch(`/admin/commission-plans/${world.plans.referral}`, { percent: '20' });
    expect(bad.status).toBe(422);
    expect(bad.body.errors[0].field).toBe('percent');
    expect((await staff.patch(`/admin/commission-plans/${world.plans.referral}`, { tiers: [] })).status).toBe(422);
    expect((await staff.patch(`/admin/commission-plans/${world.plans.referral}`, {})).status).toBe(422);
    expect((await staff.patch('/admin/commission-plans/99999', { percent: '3' })).status).toBe(404);
  });

  it('is refused without commissions:update', async () => {
    const reader = await adminWith(t, ['commissions:read', 'commissions:create']);
    expect((await reader.patch(`/admin/commission-plans/${world.plans.referral}`, { percent: '3' })).status).toBe(403);
  });
});

describe('DELETE /admin/commission-plans/:id', () => {
  it('deletes a plan nothing refers to with 204 and audits it', async () => {
    const res = await staff.delete(`/admin/commission-plans/${world.plans.rebate}`);
    expect(res.status).toBe(204);
    expect((await staff.get(`/admin/commission-plans/${world.plans.rebate}`)).status).toBe(404);
    expect((await auditOf(world.plans.rebate)).at(-1)).toMatchObject({
      action: 'deleted plan',
      entityLabel: 'Volume rebate',
    });
  });

  it('refuses with 409 PLAN_IN_USE while an assignment is current and names how many', async () => {
    const { db, agent, partner, plans } = world;
    await assignPlan(db, agent.id, plans.referral);
    await assignPlan(db, partner.id, plans.referral);
    const res = await staff.delete(`/admin/commission-plans/${plans.referral}`);
    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({ code: 'PLAN_IN_USE' });
    expect(res.body.detail).toBe('2 merchants are on the Referral plan. End or move those assignments first.');
    expect((await staff.get(`/admin/commission-plans/${plans.referral}`)).status).toBe(200);
  });

  it('keeps a plan that has history (an ended assignment or accruals) and says to switch it off', async () => {
    const { db, agent, plans } = world;
    const assignment = await assignPlan(db, agent.id, plans.referral);
    expect((await staff.delete(`/admin/commission-assignments/${assignment}`)).status).toBe(204);
    const res = await staff.delete(`/admin/commission-plans/${plans.referral}`);
    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({ code: 'PLAN_IN_USE' });
    expect(res.body.detail).toContain('Switch it off');
  });

  it('answers 404 for an unknown plan and refuses without commissions:delete', async () => {
    expect((await staff.delete('/admin/commission-plans/99999')).status).toBe(404);
    const other = await adminWith(t, ['commissions:read', 'commissions:update']);
    expect((await other.delete(`/admin/commission-plans/${world.plans.rebate}`)).status).toBe(403);
  });
});
