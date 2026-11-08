// The merchant portal's commission routes of feature 11 (MISMATCHES B164): GET /client/referrals (code, link, plan, referred merchants as
// names and dates) and GET /client/commissions (the merchant's own accruals, never the order or plan id). A merchant never sees another
// merchant's records; a merchant waiting for approval is refused.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import { eq } from 'drizzle-orm';
import { schema as s } from '../../src/infra/db';
import { type TestApp, createTestApp } from '../support/app';
import { clearIdentityCaches, insertMerchant } from '../support/auth';
import { type CommissionsWorld, assignPlan, commissionsWorld, insertAccrual } from '../support/commissions';
import { closeTestDb, resetDb, testDb } from '../support/db';
import { insertOrderRow, json, portalFor } from '../support/orders';

let t: TestApp;
let world: CommissionsWorld;

beforeAll(async () => {
  t = await createTestApp();
});
beforeEach(async () => {
  await resetDb();
  await clearIdentityCaches(t);
  world = await commissionsWorld((await testDb()).db);
});
afterAll(async () => {
  await resetDb();
  await clearIdentityCaches(t);
  await t.close();
  await closeTestDb();
});

const day = (iso: string) => new Date(`${iso}T12:00:00.000Z`);

describe('GET /client/referrals', () => {
  it('answers the code, the link built from the portal address, the current plan and the referred merchants newest first', async () => {
    const { db, agent, plans, merchant } = world;
    await db.update(s.clients).set({ referralCode: 'GSM0001' }).where(eq(s.clients.id, agent.id));
    await db
      .update(s.clients)
      .set({ createdAt: day('2026-09-20') })
      .where(eq(s.clients.id, merchant.id));
    await assignPlan(db, agent.id, plans.referral);
    await insertMerchant(db, { name: 'Casablanca Unlock', referredById: agent.id, createdAt: day('2026-10-02') });
    await insertMerchant(db, { name: 'Lagos Gadget Fix', referredById: agent.id, createdAt: day('2026-10-20') });

    const res = await (await portalFor(t, agent.id)).get('/client/referrals');
    expect(res.statusCode).toBe(200);
    const body = json(res);
    expect(body).toMatchObject({
      referralCode: 'GSM0001',
      referralLink: `${t.config.http.portalBaseUrl}/register?ref=GSM0001`,
      plan: {
        name: 'Referral',
        kind: 'referral',
        percent: '3.0000',
        basis: 'Order revenue of referred merchants',
        period: 'monthly',
      },
      referredCount: 3,
    });
    expect(body.plan.startsAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(body.referred).toEqual([
      { name: 'Lagos Gadget Fix', joinedAt: '2026-10-20T12:00:00.000Z' },
      { name: 'Casablanca Unlock', joinedAt: '2026-10-02T12:00:00.000Z' },
      { name: 'Cairo GSM Lab', joinedAt: '2026-09-20T12:00:00.000Z' },
    ]);
  });

  it('shows names and dates only: nothing that identifies the referred merchants or their orders', async () => {
    const { db, agent, plans, merchant } = world;
    await assignPlan(db, agent.id, plans.referral);
    const order = await insertOrderRow(db, {
      clientId: merchant.id,
      serviceId: world.auto.serviceId,
      status: 'completed',
    });
    await insertAccrual(db, { beneficiaryId: agent.id, planId: plans.referral, orderId: order.id });
    const body = json(await (await portalFor(t, agent.id)).get('/client/referrals'));
    expect(Object.keys(body.referred[0]).sort()).toEqual(['joinedAt', 'name']);
    // No id of anyone appears anywhere in the answer.
    expect(JSON.stringify(body)).not.toContain('"id"');
    expect(Object.keys(body).sort()).toEqual(['plan', 'referralCode', 'referralLink', 'referred', 'referredCount']);
    expect(Object.keys(body.plan).sort()).toEqual(['basis', 'kind', 'name', 'percent', 'period', 'startsAt']);
  });

  it('answers a null plan for a merchant that is on none and an empty list for one that referred nobody', async () => {
    const res = await (await portalFor(t, world.other.id)).get('/client/referrals');
    expect(json(res)).toMatchObject({ plan: null, referredCount: 0, referred: [] });
  });

  it('shows a rebate plan too, and not an assignment that ended', async () => {
    const { db, agent, plans } = world;
    const id = await assignPlan(db, agent.id, plans.rebate);
    expect(json(await (await portalFor(t, agent.id)).get('/client/referrals')).plan).toMatchObject({
      kind: 'rebate',
      percent: '1.5000',
    });
    await db.update(s.commissionAssignments).set({ endsAt: new Date() }).where(eq(s.commissionAssignments.id, id));
    expect(json(await (await portalFor(t, agent.id)).get('/client/referrals')).plan).toBeNull();
  });

  it('lists at most 100 referred merchants and still counts them all', async () => {
    const { db, agent } = world;
    const group = (await db.select({ id: s.clientGroups.id }).from(s.clientGroups).limit(1))[0]!.id;
    await db.insert(s.clients).values(
      Array.from({ length: 101 }, (_, index) => ({
        username: `bulk-${index}`,
        email: `bulk-${index}@example.com`,
        name: `Bulk ${index}`,
        groupId: group,
        referralCode: `BULK${index}`,
        referredById: agent.id,
        status: 'active' as const,
      })),
    );
    const body = json(await (await portalFor(t, agent.id)).get('/client/referrals'));
    expect(body.referredCount).toBe(102);
    expect(body.referred).toHaveLength(100);
  });

  it('refuses a merchant waiting for approval and a call without a session', async () => {
    const pendingId = await insertMerchant((await testDb()).db, { status: 'pending' });
    const pending = await (await portalFor(t, pendingId)).get('/client/referrals');
    expect(pending.statusCode).toBe(403);
    expect(json(pending).code).toBe('ACCOUNT_PENDING_APPROVAL');
    expect((await t.app.inject({ method: 'GET', url: '/client/referrals' })).statusCode).toBe(401);
  });
});

describe('GET /client/commissions', () => {
  async function seed() {
    const { db, agent, partner, plans, merchant, other } = world;
    const o1 = await insertOrderRow(db, {
      clientId: merchant.id,
      serviceId: world.auto.serviceId,
      status: 'completed',
    });
    const o2 = await insertOrderRow(db, {
      clientId: merchant.id,
      serviceId: world.auto.serviceId,
      status: 'completed',
    });
    const o3 = await insertOrderRow(db, { clientId: other.id, serviceId: world.auto.serviceId, status: 'completed' });
    const ready = await insertAccrual(db, {
      beneficiaryId: agent.id,
      planId: plans.referral,
      orderId: o1.id,
      amount: '0.4900',
      basisAmount: '16.2600',
      createdAt: day('2026-11-03'),
    });
    const paid = await insertAccrual(db, {
      beneficiaryId: agent.id,
      planId: plans.referral,
      orderId: o2.id,
      amount: '0.1700',
      basisAmount: '5.6400',
      status: 'approved',
      createdAt: day('2026-10-02'),
      approvedAt: day('2026-10-10'),
    });
    const theirs = await insertAccrual(db, {
      beneficiaryId: partner.id,
      planId: plans.partner,
      orderId: o3.id,
      amount: '0.3500',
      percent: '5.0000',
    });
    return { ready, paid, theirs };
  }

  it("lists the merchant's own accruals newest first as period, referred merchant, basis, rate, amount, status and dates", async () => {
    const { ready, paid } = await seed();
    const res = await (await portalFor(t, world.agent.id)).get('/client/commissions');
    expect(res.statusCode).toBe(200);
    expect(res.headers['x-total-count']).toBe('2');
    expect(json(res)).toEqual([
      {
        id: ready.id,
        period: '2026-11',
        merchant: { name: 'Cairo GSM Lab' },
        basisAmount: '16.2600',
        percent: '3.0000',
        amount: '0.4900',
        status: 'accrued',
        approvedAt: null,
        createdAt: '2026-11-03T12:00:00.000Z',
      },
      {
        id: paid.id,
        period: '2026-10',
        merchant: { name: 'Cairo GSM Lab' },
        basisAmount: '5.6400',
        percent: '3.0000',
        amount: '0.1700',
        status: 'approved',
        approvedAt: '2026-10-10T12:00:00.000Z',
        createdAt: '2026-10-02T12:00:00.000Z',
      },
    ]);
  });

  it("never shows another merchant's commissions, nor the order id or the plan id", async () => {
    const { theirs } = await seed();
    const rows = json(await (await portalFor(t, world.agent.id)).get('/client/commissions'));
    expect(rows.map((row: { id: number }) => row.id)).not.toContain(theirs.id);
    for (const row of rows) {
      expect(Object.keys(row)).not.toContain('orderId');
      expect(Object.keys(row)).not.toContain('planId');
      expect(Object.keys(row)).not.toContain('beneficiaryId');
      expect(Object.keys(row.merchant)).toEqual(['name']);
    }
    const mine = json(await (await portalFor(t, world.partner.id)).get('/client/commissions'));
    expect(mine.map((row: { id: number }) => row.id)).toEqual([theirs.id]);
  });

  it('names the merchant itself on a rebate', async () => {
    const { db, merchant, plans } = world;
    const order = await insertOrderRow(db, {
      clientId: merchant.id,
      serviceId: world.auto.serviceId,
      status: 'completed',
    });
    await insertAccrual(db, {
      beneficiaryId: merchant.id,
      planId: plans.rebate,
      orderId: order.id,
      percent: '1.5000',
      amount: '0.2592',
    });
    const rows = json(await (await portalFor(t, merchant.id)).get('/client/commissions'));
    expect(rows[0].merchant).toEqual({ name: 'Cairo GSM Lab' });
  });

  it('filters by status and period, sorts by period or amount, and pages', async () => {
    const { ready, paid } = await seed();
    const portal = await portalFor(t, world.agent.id);
    const ids = async (query: string) =>
      json(await portal.get(`/client/commissions?${query}`)).map((row: { id: number }) => row.id);
    expect(await ids('status=approved')).toEqual([paid.id]);
    expect(await ids('status=accrued')).toEqual([ready.id]);
    expect(await ids('period=2026-10')).toEqual([paid.id]);
    expect(await ids('_sort=amount&_order=asc')).toEqual([paid.id, ready.id]);
    expect(await ids('_sort=period&_order=asc')).toEqual([paid.id, ready.id]);
    expect(await ids('_start=1&_end=2')).toEqual([paid.id]);
    expect((await portal.get('/client/commissions?status=bogus')).statusCode).toBe(422);
    expect((await portal.get('/client/commissions?_sort=planId')).statusCode).toBe(422);
  });

  it('answers an empty list for a merchant with no commission, and refuses a pending merchant and a call without a session', async () => {
    const empty = await (await portalFor(t, world.other.id)).get('/client/commissions');
    expect(json(empty)).toEqual([]);
    expect(empty.headers['x-total-count']).toBe('0');
    const pendingId = await insertMerchant((await testDb()).db, { status: 'pending' });
    const pending = await (await portalFor(t, pendingId)).get('/client/commissions');
    expect(pending.statusCode).toBe(403);
    expect(json(pending).code).toBe('ACCOUNT_PENDING_APPROVAL');
    expect((await t.app.inject({ method: 'GET', url: '/client/commissions' })).statusCode).toBe(401);
  });
});
