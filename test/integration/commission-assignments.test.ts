// The commission assignment routes of feature 11 (RULES commissions 8 and 9, resolutions health-commissions-2 and -12, MISMATCHES B42,
// M155): put a merchant on a plan, change the plan (the current row ends, a new one starts), end it, and the agent figures on the rows.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import { eq } from 'drizzle-orm';
import { schema as s } from '../../src/infra/db';
import { type AdminApi, adminWith } from '../support/admin-api';
import { type TestApp, createTestApp } from '../support/app';
import { clearIdentityCaches } from '../support/auth';
import { TestClock } from '../support/clock';
import { type CommissionsWorld, assignPlan, commissionsWorld, placeOrder } from '../support/commissions';
import { closeTestDb, resetDb, testDb } from '../support/db';
import { IMEIS } from '../support/orders';

const clock = new TestClock('2026-11-05T08:00:00.000Z');
let t: TestApp;
let world: CommissionsWorld;
let staff: AdminApi;

beforeAll(async () => {
  t = await createTestApp({ clock });
});
beforeEach(async () => {
  clock.set('2026-11-05T08:00:00.000Z');
  await resetDb();
  await clearIdentityCaches(t);
  world = await commissionsWorld((await testDb()).db);
  staff = await adminWith(t, ['commissions:*', 'orders:*'], { name: 'Omar T.' });
});
afterAll(async () => {
  await resetDb();
  await clearIdentityCaches(t);
  await t.close();
  await closeTestDb();
});

const auditOf = async (entityId: number) => {
  const { db } = await testDb();
  return db
    .select()
    .from(s.auditLogs)
    .where(eq(s.auditLogs.entityId, entityId))
    .orderBy(s.auditLogs.id)
    .then((rows) => rows.filter((row) => row.entityType === 'merchant'));
};

describe('POST /admin/commission-assignments', () => {
  it('puts a merchant on a plan: the scope follows the kind, startsAt is the clock, the merchant and the plan are joined', async () => {
    const { agent, plans } = world;
    const res = await staff.post('/admin/commission-assignments', { beneficiaryId: agent.id, planId: plans.referral });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({
      planId: plans.referral,
      beneficiaryId: agent.id,
      scope: 'referrals',
      startsAt: '2026-11-05T08:00:00.000Z',
      endsAt: null,
      beneficiary: { id: agent.id, name: 'Zain Mobile Hub' },
      plan: { id: plans.referral, name: 'Referral', percent: '3.0000' },
      referredCount: 1,
      revenue30d: '0.0000',
      readyAmount: '0.0000',
      approvedAmount: '0.0000',
    });
    const rebate = await staff.post('/admin/commission-assignments', {
      beneficiaryId: world.merchant.id,
      planId: plans.rebate,
    });
    expect(rebate.body).toMatchObject({ scope: 'own', plan: { name: 'Volume rebate', percent: '1.5000' } });
    expect((await auditOf(agent.id)).at(-1)).toMatchObject({
      action: 'assigned plan to',
      entityLabel: 'Zain Mobile Hub, Referral plan',
      actorName: 'Omar T.',
    });
  });

  it('answers 409 ALREADY_ASSIGNED with the merchant and the plan when the merchant is on a plan', async () => {
    const { agent, plans } = world;
    await assignPlan(world.db, agent.id, plans.referral);
    const res = await staff.post('/admin/commission-assignments', { beneficiaryId: agent.id, planId: plans.partner });
    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({
      code: 'ALREADY_ASSIGNED',
      detail: 'Zain Mobile Hub is already on the Referral plan',
    });
  });

  it('lets exactly one of two racing requests win and answers the other 409 ALREADY_ASSIGNED', async () => {
    const { agent, plans, db } = world;
    const [a, b] = await Promise.all([
      staff.post('/admin/commission-assignments', { beneficiaryId: agent.id, planId: plans.referral }),
      staff.post('/admin/commission-assignments', { beneficiaryId: agent.id, planId: plans.partner }),
    ]);
    expect([a.status, b.status].sort()).toEqual([201, 409]);
    const loser = a.status === 409 ? a : b;
    expect(loser.body.code).toBe('ALREADY_ASSIGNED');
    expect(loser.body.detail).toMatch(/^Zain Mobile Hub is already on the (Referral|Partner) plan$/);
    const rows = await db
      .select()
      .from(s.commissionAssignments)
      .where(eq(s.commissionAssignments.beneficiaryId, agent.id));
    expect(rows).toHaveLength(1);
  });

  it('answers 422 for an unknown merchant, an unknown plan and a plan that is switched off', async () => {
    const { agent, plans, db } = world;
    const unknownMerchant = await staff.post('/admin/commission-assignments', {
      beneficiaryId: 99999,
      planId: plans.referral,
    });
    expect(unknownMerchant.status).toBe(422);
    expect(unknownMerchant.body.errors[0].field).toBe('beneficiaryId');
    const unknownPlan = await staff.post('/admin/commission-assignments', { beneficiaryId: agent.id, planId: 99999 });
    expect(unknownPlan.status).toBe(422);
    expect(unknownPlan.body.errors[0].field).toBe('planId');
    await db.update(s.commissionPlans).set({ isActive: false }).where(eq(s.commissionPlans.id, plans.partner));
    const off = await staff.post('/admin/commission-assignments', { beneficiaryId: agent.id, planId: plans.partner });
    expect(off.status).toBe(422);
    expect(off.body.errors[0]).toMatchObject({ field: 'planId' });
  });

  it('is refused without commissions:create', async () => {
    const reader = await adminWith(t, ['commissions:read']);
    const res = await reader.post('/admin/commission-assignments', {
      beneficiaryId: world.agent.id,
      planId: world.plans.referral,
    });
    expect(res.status).toBe(403);
  });
});

describe('GET /admin/commission-assignments', () => {
  it('lists current assignments newest first with the joins, and hides the ones that ended unless asked', async () => {
    const { db, agent, partner, plans } = world;
    const first = await assignPlan(db, agent.id, plans.referral);
    clock.advance(1000);
    const second = (
      await staff.post('/admin/commission-assignments', { beneficiaryId: partner.id, planId: plans.partner })
    ).body.id;
    expect((await staff.delete(`/admin/commission-assignments/${first}`)).status).toBe(204);

    const current = await staff.get('/admin/commission-assignments?_start=0&_end=200&_sort=createdAt&_order=desc');
    expect(current.total).toBe(1);
    expect(current.body.map((row: { id: number }) => row.id)).toEqual([second]);

    const all = await staff.get('/admin/commission-assignments?includeEnded=true&_sort=id&_order=asc');
    expect(all.total).toBe(2);
    expect(all.body.map((row: { id: number; endsAt: string | null }) => [row.id, row.endsAt !== null])).toEqual([
      [first, true],
      [second, false],
    ]);
    expect(all.body[0].beneficiary).toEqual({ id: agent.id, name: 'Zain Mobile Hub', country: '' });
  });

  it('filters by plan and by merchant', async () => {
    const { db, agent, partner, plans } = world;
    await assignPlan(db, agent.id, plans.referral);
    await assignPlan(db, partner.id, plans.partner);
    expect(
      (await staff.get(`/admin/commission-assignments?planId=${plans.partner}`)).body.map(
        (row: { beneficiaryId: number }) => row.beneficiaryId,
      ),
    ).toEqual([partner.id]);
    expect((await staff.get(`/admin/commission-assignments?beneficiaryId=${agent.id}`)).total).toBe(1);
  });

  it('carries the agent figures of M155: referred merchants, their revenue of the last 30 days, ready and approved commission', async () => {
    const { db, agent, plans, merchant, auto } = world;
    await assignPlan(db, agent.id, plans.referral);
    const done = await placeOrder(t, merchant.id, auto.serviceId, IMEIS[0]);
    const second = await placeOrder(t, merchant.id, auto.serviceId, IMEIS[1]);
    await placeOrder(t, merchant.id, auto.serviceId, IMEIS[2]);
    for (const id of [done, second])
      expect((await staff.post(`/admin/orders/${id}/reply`, { code: 'ok' })).status).toBe(204);
    const [first] = await db.select().from(s.commissionAccruals).orderBy(s.commissionAccruals.id);
    expect((await staff.post('/admin/commission-accruals/approve', { ids: [first!.id] })).status).toBe(200);

    const [row] = (await staff.get('/admin/commission-assignments')).body;
    expect(row).toMatchObject({
      referredCount: 1,
      // Two completed orders of 17.28; the open one is not revenue yet.
      revenue30d: '34.5600',
      readyAmount: '0.5184',
      approvedAmount: '0.5184',
    });

    // An order that completed 31 days ago is out of the 30-day window.
    clock.advance(31 * 86_400_000);
    staff = await adminWith(t, ['commissions:*']);
    expect((await staff.get('/admin/commission-assignments')).body[0].revenue30d).toBe('0.0000');
  });
});

describe('GET /admin/commission-assignments/:id', () => {
  it('shows an assignment, an ended one with its end, and answers 404 for an unknown one', async () => {
    const { db, agent, plans } = world;
    const id = await assignPlan(db, agent.id, plans.referral);
    expect((await staff.get(`/admin/commission-assignments/${id}`)).body).toMatchObject({ id, endsAt: null });
    expect((await staff.delete(`/admin/commission-assignments/${id}`)).status).toBe(204);
    expect((await staff.get(`/admin/commission-assignments/${id}`)).body).toMatchObject({
      id,
      endsAt: '2026-11-05T08:00:00.000Z',
    });
    expect((await staff.get('/admin/commission-assignments/99999')).status).toBe(404);
  });
});

describe('PATCH /admin/commission-assignments/:id', () => {
  it('ends the current assignment and starts a new one on the new plan in one go; the answer is the new row', async () => {
    const { db, agent, plans } = world;
    const id = await assignPlan(db, agent.id, plans.referral);
    clock.advance(60_000);
    const res = await staff.patch(`/admin/commission-assignments/${id}`, { planId: plans.partner });
    expect(res.status).toBe(200);
    expect(res.body.id).not.toBe(id);
    expect(res.body).toMatchObject({
      planId: plans.partner,
      beneficiaryId: agent.id,
      scope: 'referrals',
      startsAt: '2026-11-05T08:01:00.000Z',
      endsAt: null,
      plan: { name: 'Partner', percent: '5.0000' },
    });
    const rows = await db.select().from(s.commissionAssignments).orderBy(s.commissionAssignments.id);
    expect(rows.map((row) => [row.planId, row.endsAt?.toISOString() ?? null])).toEqual([
      [plans.referral, '2026-11-05T08:01:00.000Z'],
      [plans.partner, null],
    ]);
    expect((await auditOf(agent.id)).at(-1)).toMatchObject({
      action: 'changed commission plan of',
      entityLabel: 'Zain Mobile Hub',
      before: { plan: 'Referral' },
      after: { plan: 'Partner' },
    });
  });

  it('earns the new rate on orders completed after the change, and keeps the rate of the accruals already earned', async () => {
    const { db, agent, plans, merchant, auto } = world;
    const id = await assignPlan(db, agent.id, plans.referral);
    const first = await placeOrder(t, merchant.id, auto.serviceId, IMEIS[0]);
    expect((await staff.post(`/admin/orders/${first}/reply`, { code: 'ok' })).status).toBe(204);
    expect((await staff.patch(`/admin/commission-assignments/${id}`, { planId: plans.partner })).status).toBe(200);
    const second = await placeOrder(t, merchant.id, auto.serviceId, IMEIS[1]);
    expect((await staff.post(`/admin/orders/${second}/reply`, { code: 'ok' })).status).toBe(204);
    const accruals = await db.select().from(s.commissionAccruals).orderBy(s.commissionAccruals.id);
    expect(accruals.map((row) => [row.planId, row.percent])).toEqual([
      [plans.referral, '3.0000'],
      [plans.partner, '5.0000'],
    ]);
  });

  it('answers 409 ALREADY_ASSIGNED for the plan the merchant is on, 422 for a bad plan, 404 for an ended or unknown assignment', async () => {
    const { db, agent, plans } = world;
    const id = await assignPlan(db, agent.id, plans.referral);
    expect((await staff.patch(`/admin/commission-assignments/${id}`, { planId: plans.referral })).body).toMatchObject({
      code: 'ALREADY_ASSIGNED',
    });
    const unknown = await staff.patch(`/admin/commission-assignments/${id}`, { planId: 99999 });
    expect(unknown.status).toBe(422);
    expect(unknown.body.errors[0].field).toBe('planId');
    await db.update(s.commissionPlans).set({ isActive: false }).where(eq(s.commissionPlans.id, plans.partner));
    expect((await staff.patch(`/admin/commission-assignments/${id}`, { planId: plans.partner })).status).toBe(422);
    expect((await staff.patch('/admin/commission-assignments/99999', { planId: plans.referral })).status).toBe(404);
    expect((await staff.delete(`/admin/commission-assignments/${id}`)).status).toBe(204);
    expect((await staff.patch(`/admin/commission-assignments/${id}`, { planId: plans.rebate })).status).toBe(404);
  });

  it('is refused without commissions:update', async () => {
    const id = await assignPlan(world.db, world.agent.id, world.plans.referral);
    const reader = await adminWith(t, ['commissions:read', 'commissions:create']);
    expect((await reader.patch(`/admin/commission-assignments/${id}`, { planId: world.plans.partner })).status).toBe(
      403,
    );
  });
});

describe('DELETE /admin/commission-assignments/:id', () => {
  it('ends the assignment with 204: no accrual after it, and accruals already earned stay approvable (never HAS_PENDING)', async () => {
    const { db, agent, plans, merchant, auto } = world;
    const id = await assignPlan(db, agent.id, plans.referral);
    const order = await placeOrder(t, merchant.id, auto.serviceId, IMEIS[0]);
    expect((await staff.post(`/admin/orders/${order}/reply`, { code: 'ok' })).status).toBe(204);
    const [accrual] = await db.select().from(s.commissionAccruals);

    const res = await staff.delete(`/admin/commission-assignments/${id}`);
    expect(res.status).toBe(204);
    const [row] = await db.select().from(s.commissionAssignments).where(eq(s.commissionAssignments.id, id));
    expect(row!.endsAt?.toISOString()).toBe('2026-11-05T08:00:00.000Z');
    expect((await auditOf(agent.id)).at(-1)).toMatchObject({
      action: 'ended plan of',
      entityLabel: 'Zain Mobile Hub, Referral plan',
    });

    const later = await placeOrder(t, merchant.id, auto.serviceId, IMEIS[1]);
    expect((await staff.post(`/admin/orders/${later}/reply`, { code: 'ok' })).status).toBe(204);
    expect(await db.select().from(s.commissionAccruals)).toHaveLength(1);

    const approval = await staff.post('/admin/commission-accruals/approve', { ids: [accrual!.id] });
    expect(approval.body).toMatchObject({ approved: 1, total: '0.5184' });
  });

  it('lets the merchant take a new plan after the old one ended', async () => {
    const { db, agent, plans } = world;
    const id = await assignPlan(db, agent.id, plans.referral);
    expect((await staff.delete(`/admin/commission-assignments/${id}`)).status).toBe(204);
    const again = await staff.post('/admin/commission-assignments', { beneficiaryId: agent.id, planId: plans.partner });
    expect(again.status).toBe(201);
  });

  it('answers 404 for an unknown or already ended assignment and is refused without commissions:delete', async () => {
    const id = await assignPlan(world.db, world.agent.id, world.plans.referral);
    expect((await staff.delete('/admin/commission-assignments/99999')).status).toBe(404);
    const other = await adminWith(t, ['commissions:read', 'commissions:update']);
    expect((await other.delete(`/admin/commission-assignments/${id}`)).status).toBe(403);
    expect((await staff.delete(`/admin/commission-assignments/${id}`)).status).toBe(204);
    expect((await staff.delete(`/admin/commission-assignments/${id}`)).status).toBe(404);
  });
});
