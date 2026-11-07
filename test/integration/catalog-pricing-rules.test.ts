// Integration tests of the pricing rule routes (feature 4b): list with filters, sorts and search, show, create and change with
// every field refusal, delete, audit, permissions, the price version, and the effect of a rule on the service list's floor.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import { eq } from 'drizzle-orm';
import { schema as s } from '../../src/infra/db';
import { type AdminApi, adminWith } from '../support/admin-api';
import { type TestApp, createTestApp } from '../support/app';
import { clearIdentityCaches } from '../support/auth';
import { insertService } from '../support/catalog';
import { MINUTE, TestClock } from '../support/clock';
import { closeTestDb, resetDb, testDb } from '../support/db';
import { catalogVersionOf, insertAtt, insertDemoGroups, insertRule } from '../support/pricing';

const clock = new TestClock('2026-11-07T12:00:00.000Z');
let t: TestApp;
let admin: AdminApi;

beforeAll(async () => {
  t = await createTestApp({ clock });
});
beforeEach(async () => {
  clock.set('2026-11-07T12:00:00.000Z');
  await resetDb();
  await clearIdentityCaches(t);
  admin = await adminWith(t, ['pricing:*', 'catalog:read'], { name: 'Rami K.' });
});
afterAll(async () => {
  await resetDb();
  await clearIdentityCaches(t);
  await t.close();
  await closeTestDb();
});

const auditRows = async () => (await testDb()).db.select().from(s.auditLogs).orderBy(s.auditLogs.id);
const ruleRow = async (id: number) =>
  (await (await testDb()).db.select().from(s.pricingRules).where(eq(s.pricingRules.id, id)))[0];

const body = (overrides: Record<string, unknown> = {}) => ({
  scope: 'category',
  targetId: 1,
  groupId: null,
  kind: 'discount',
  percent: '2.0000',
  fixed: '0.0000',
  rounding: 'none',
  minProfit: '0.0000',
  priority: 100,
  startsAt: null,
  endsAt: null,
  ...overrides,
});

async function world() {
  const { db } = await testDb();
  const groups = await insertDemoGroups(db);
  const { categoryId, serviceId } = await insertAtt(db);
  return { db, groups, categoryId, serviceId };
}

describe('GET /admin/pricing-rules', () => {
  it('lists rules by priority with the names of their targets and groups', async () => {
    const { db, groups, categoryId, serviceId } = await world();
    const promo = await insertRule(db, { scope: 'category', targetId: categoryId, priority: 100 });
    const forService = await insertRule(db, {
      scope: 'service',
      targetId: serviceId,
      kind: 'margin',
      percent: '5',
      groupId: groups.vip,
      priority: 10,
    });
    const global = await insertRule(db, {
      scope: 'global',
      targetId: null,
      kind: 'promo',
      percent: '1',
      priority: 50,
      isActive: false,
    });

    const res = await admin.get('/admin/pricing-rules?_start=0&_end=200&_sort=priority&_order=asc');
    expect(res.status).toBe(200);
    expect(res.total).toBe(3);
    expect(res.body.map((row: { id: number }) => row.id)).toEqual([forService, global, promo]);
    expect(res.body[0]).toEqual({
      id: forService,
      scope: 'service',
      targetId: serviceId,
      target: { id: serviceId, name: 'AT&T USA Premier Unlock' },
      groupId: groups.vip,
      group: { id: groups.vip, name: 'VIP' },
      kind: 'margin',
      percent: '5.0000',
      fixed: '0.0000',
      rounding: 'none',
      minProfit: '0.0000',
      priority: 10,
      isActive: true,
      startsAt: null,
      endsAt: null,
    });
    expect(res.body[1]).toMatchObject({ scope: 'global', targetId: null, target: null, group: null, isActive: false });
    expect(res.body[2].target).toEqual({ id: categoryId, name: 'Carrier unlock' });
  });

  it('filters by scope, kind and isActive, and searches the target name and the kind', async () => {
    const { db, categoryId, serviceId } = await world();
    await insertRule(db, { scope: 'category', targetId: categoryId });
    await insertRule(db, { scope: 'service', targetId: serviceId, kind: 'promo' });
    await insertRule(db, { scope: 'global', targetId: null, kind: 'margin', isActive: false });

    expect((await admin.get('/admin/pricing-rules?scope=service')).total).toBe(1);
    expect((await admin.get('/admin/pricing-rules?kind=margin')).total).toBe(1);
    expect((await admin.get('/admin/pricing-rules?isActive=false')).total).toBe(1);
    expect((await admin.get('/admin/pricing-rules?isActive=true&scope_ne=service')).total).toBe(1);
    expect((await admin.get('/admin/pricing-rules?q=carrier')).total).toBe(1);
    expect((await admin.get('/admin/pricing-rules?q=at%26t')).total).toBe(1);
    expect((await admin.get('/admin/pricing-rules?q=promo')).total).toBe(1);
    expect((await admin.get('/admin/pricing-rules?scope=nope')).status).toBe(422);
  });

  it('answers x-total-count before the range', async () => {
    const { db, categoryId } = await world();
    for (let index = 0; index < 3; index++)
      await insertRule(db, { scope: 'category', targetId: categoryId, priority: index });
    const res = await admin.get('/admin/pricing-rules?_start=1&_end=2');
    expect(res.total).toBe(3);
    expect(res.body).toHaveLength(1);
  });
});

describe('GET /admin/pricing-rules/:id', () => {
  it('shows one rule, 404 for an unknown id, and still names the target of an archived service', async () => {
    const { db, categoryId } = await world();
    const archived = await insertService(db, categoryId, {
      name: 'Old service',
      status: 'disabled',
      archivedAt: new Date(),
    });
    const id = await insertRule(db, { scope: 'service', targetId: archived, isActive: false });
    const res = await admin.get(`/admin/pricing-rules/${id}`);
    expect(res.status).toBe(200);
    expect(res.body.target).toEqual({ id: archived, name: 'Old service' });
    expect((await admin.get('/admin/pricing-rules/9999')).status).toBe(404);
  });
});

describe('POST /admin/pricing-rules', () => {
  it('creates a rule, answers 201 in the list-row shape and audits it', async () => {
    const { categoryId } = await world();
    const res = await admin.post('/admin/pricing-rules', body({ targetId: categoryId, percent: '2' }));
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({
      scope: 'category',
      targetId: categoryId,
      target: { name: 'Carrier unlock' },
      kind: 'discount',
      percent: '2.0000',
      isActive: true,
    });
    const [audit] = await auditRows();
    expect(audit).toMatchObject({
      action: 'added pricing rule for',
      entityType: 'pricing_rule',
      entityId: res.body.id,
      entityLabel: 'Carrier unlock',
      actorName: 'Rami K.',
    });
    expect(audit?.before).toBeNull();
    expect(audit?.after).toMatchObject({ scope: 'category', percent: '2.0000', isActive: true });
  });

  it('creates global and service rules with a group and a window, and treats a global target as none', async () => {
    const { groups, serviceId } = await world();
    const global = await admin.post(
      '/admin/pricing-rules',
      body({ scope: 'global', targetId: 77, kind: 'margin', percent: '5' }),
    );
    expect(global.status).toBe(201);
    expect(global.body).toMatchObject({ targetId: null, target: null });
    expect((await auditRows())[0]?.entityLabel).toBe('all services');
    const windowed = await admin.post(
      '/admin/pricing-rules',
      body({
        scope: 'service',
        targetId: serviceId,
        groupId: groups.vip,
        kind: 'promo',
        fixed: '1.5000',
        percent: '0.0000',
        rounding: 'ends_99',
        minProfit: '0.5000',
        startsAt: '2026-03-05T00:00:00.000Z',
        endsAt: '2026-03-20T23:59:59.999Z',
      }),
    );
    expect(windowed.status).toBe(201);
    expect(windowed.body).toMatchObject({
      group: { name: 'VIP' },
      target: { name: 'AT&T USA Premier Unlock' },
      fixed: '1.5000',
      rounding: 'ends_99',
      minProfit: '0.5000',
      startsAt: '2026-03-05T00:00:00.000Z',
      endsAt: '2026-03-20T23:59:59.999Z',
    });
  });

  it('refuses each field problem on its own field', async () => {
    const { categoryId } = await world();
    const fields = async (overrides: Record<string, unknown>) => {
      const res = await admin.post('/admin/pricing-rules', body({ targetId: categoryId, ...overrides }));
      expect(res.status).toBe(422);
      return res.body.errors.map((error: { field: string }) => error.field);
    };
    expect(await fields({ percent: '0.0000', fixed: '0.0000' })).toEqual(['percent']);
    expect(await fields({ percent: '150.0000' })).toEqual(['percent']);
    expect(await fields({ percent: '-1.0000' })).toEqual(['percent']);
    expect(await fields({ fixed: '-1.0000' })).toEqual(['fixed']);
    expect(await fields({ minProfit: '-0.0100' })).toEqual(['minProfit']);
    expect(await fields({ priority: -1 })).toEqual(['priority']);
    expect(await fields({ priority: 1.5 })).toEqual(['priority']);
    expect(await fields({ scope: 'planet' })).toEqual(['scope']);
    expect(await fields({ kind: 'bonus' })).toEqual(['kind']);
    expect(await fields({ rounding: 'whatever' })).toEqual(['rounding']);
    expect(await fields({ targetId: 9999 })).toEqual(['targetId']);
    expect(await fields({ scope: 'service', targetId: categoryId + 1000 })).toEqual(['targetId']);
    expect(await fields({ targetId: null })).toEqual(['targetId']);
    expect(await fields({ groupId: 9999 })).toEqual(['groupId']);
    expect(await fields({ startsAt: '2026-03-20T00:00:00.000Z', endsAt: '2026-03-05T00:00:00.000Z' })).toEqual([
      'endsAt',
    ]);
    expect(await fields({ startsAt: '2026-03-05T00:00:00.000Z', endsAt: '2026-03-05T00:00:00.000Z' })).toEqual([
      'endsAt',
    ]);
    expect(await fields({ kind: 'margin', percent: '1500.0000' })).toEqual(['percent']);
  });

  it('refuses a service target that is archived, and gives a margin more room than a discount', async () => {
    const { db, categoryId } = await world();
    const archived = await insertService(db, categoryId, { status: 'disabled', archivedAt: new Date() });
    const res = await admin.post('/admin/pricing-rules', body({ scope: 'service', targetId: archived }));
    expect(res.status).toBe(422);
    expect(res.body.errors[0]).toMatchObject({ field: 'targetId', message: 'Choose the service.' });
    expect(
      (await admin.post('/admin/pricing-rules', body({ targetId: categoryId, kind: 'margin', percent: '400.0000' })))
        .status,
    ).toBe(201);
  });

  it('needs pricing:create and a CSRF token, and writes nothing on a refusal', async () => {
    const { categoryId } = await world();
    const reader = await adminWith(t, ['pricing:read', 'pricing:update']);
    expect((await reader.post('/admin/pricing-rules', body({ targetId: categoryId }))).status).toBe(403);
    expect((await admin.withoutCsrf('POST', '/admin/pricing-rules', body({ targetId: categoryId }))).status).toBe(403);
    expect((await admin.post('/admin/pricing-rules', body({ targetId: 9999 }))).status).toBe(422);
    expect(await auditRows()).toHaveLength(0);
    expect((await (await testDb()).db.select().from(s.pricingRules)).length).toBe(0);
  });

  it('moves the catalog price version', async () => {
    const { categoryId } = await world();
    const before = await catalogVersionOf(t);
    await admin.post('/admin/pricing-rules', body({ targetId: categoryId }));
    expect(await catalogVersionOf(t)).not.toBe(before);
  });
});

describe('PATCH /admin/pricing-rules/:id', () => {
  it('turns a rule off and on with isActive alone, and changes only the fields sent', async () => {
    const { db, categoryId } = await world();
    const id = await insertRule(db, { scope: 'category', targetId: categoryId, percent: '2', priority: 100 });
    const off = await admin.patch(`/admin/pricing-rules/${id}`, { isActive: false });
    expect(off.status).toBe(200);
    expect(off.body).toMatchObject({ isActive: false, percent: '2.0000', priority: 100 });
    const changed = await admin.patch(`/admin/pricing-rules/${id}`, { percent: '3.5000', priority: 5, isActive: true });
    expect(changed.body).toMatchObject({ isActive: true, percent: '3.5000', priority: 5 });
    expect((await ruleRow(id))?.percent).toBe('3.5000');
    const audits = await auditRows();
    expect(audits.map((audit) => audit.action)).toEqual(['edited pricing rule for', 'edited pricing rule for']);
    expect(audits[1]?.before).toMatchObject({ isActive: false, percent: '2.0000' });
    expect(audits[1]?.after).toMatchObject({ isActive: true, percent: '3.5000' });
  });

  it('judges the merged rule like a new one, including moving it to another scope', async () => {
    const { db, categoryId, serviceId } = await world();
    const id = await insertRule(db, { scope: 'category', targetId: categoryId, percent: '2' });
    const noAmount = await admin.patch(`/admin/pricing-rules/${id}`, { percent: '0.0000' });
    expect(noAmount.status).toBe(422);
    expect(noAmount.body.errors[0].field).toBe('percent');
    const noTarget = await admin.patch(`/admin/pricing-rules/${id}`, { scope: 'service' });
    expect(noTarget.status).toBe(422);
    expect(noTarget.body.errors[0].field).toBe('targetId');
    const toService = await admin.patch(`/admin/pricing-rules/${id}`, { scope: 'service', targetId: serviceId });
    expect(toService.status).toBe(200);
    expect(toService.body).toMatchObject({ scope: 'service', target: { id: serviceId } });
    const global = await admin.patch(`/admin/pricing-rules/${id}`, { scope: 'global' });
    expect(global.body).toMatchObject({ scope: 'global', targetId: null, target: null });
    const discount = await admin.patch(`/admin/pricing-rules/${id}`, { kind: 'margin', percent: '500.0000' });
    expect(discount.status).toBe(200);
    expect((await admin.patch(`/admin/pricing-rules/${id}`, { kind: 'promo' })).body.errors[0].field).toBe('percent');
  });

  it('turns off the rule of an archived service, but does not turn it back on', async () => {
    const { db, categoryId } = await world();
    const archived = await insertService(db, categoryId, { status: 'disabled', archivedAt: new Date() });
    const id = await insertRule(db, { scope: 'service', targetId: archived, isActive: true });
    expect((await admin.patch(`/admin/pricing-rules/${id}`, { isActive: false })).status).toBe(200);
    const again = await admin.patch(`/admin/pricing-rules/${id}`, { isActive: true });
    expect(again.status).toBe(422);
    expect(again.body.errors[0].field).toBe('targetId');
  });

  it('clears a window with null, and 404s an unknown rule; an empty body is 422', async () => {
    const { db, categoryId } = await world();
    const id = await insertRule(db, {
      scope: 'category',
      targetId: categoryId,
      startsAt: new Date('2026-03-05T00:00:00.000Z'),
      endsAt: new Date('2026-03-20T00:00:00.000Z'),
    });
    const res = await admin.patch(`/admin/pricing-rules/${id}`, { startsAt: null, endsAt: null });
    expect(res.body).toMatchObject({ startsAt: null, endsAt: null });
    expect((await admin.patch('/admin/pricing-rules/9999', { isActive: false })).status).toBe(404);
    expect((await admin.patch(`/admin/pricing-rules/${id}`, {})).status).toBe(422);
  });

  it('needs pricing:update', async () => {
    const { db, categoryId } = await world();
    const id = await insertRule(db, { scope: 'category', targetId: categoryId });
    const creator = await adminWith(t, ['pricing:create', 'pricing:read']);
    expect((await creator.patch(`/admin/pricing-rules/${id}`, { isActive: false })).status).toBe(403);
  });
});

describe('DELETE /admin/pricing-rules/:id', () => {
  it('deletes the rule, answers 204, audits it and moves the price version', async () => {
    const { db, categoryId } = await world();
    const id = await insertRule(db, { scope: 'category', targetId: categoryId });
    const before = await catalogVersionOf(t);
    const res = await admin.delete(`/admin/pricing-rules/${id}`);
    expect(res.status).toBe(204);
    expect(await ruleRow(id)).toBeUndefined();
    const [audit] = await auditRows();
    expect(audit).toMatchObject({
      action: 'removed pricing rule for',
      entityType: 'pricing_rule',
      entityId: id,
      entityLabel: 'Carrier unlock',
    });
    expect(audit?.after).toBeNull();
    expect(await catalogVersionOf(t)).not.toBe(before);
  });

  it('answers 404 for an unknown rule, and needs pricing:delete', async () => {
    const { db, categoryId } = await world();
    expect((await admin.delete('/admin/pricing-rules/9999')).status).toBe(404);
    const id = await insertRule(db, { scope: 'category', targetId: categoryId });
    const limited = await adminWith(t, ['pricing:read', 'pricing:update']);
    expect((await limited.delete(`/admin/pricing-rules/${id}`)).status).toBe(403);
  });
});

describe('what a rule changes in the service list', () => {
  it('sets the minimum profit and the floor of a service without its own, only inside the rule window', async () => {
    const { db, categoryId } = await world();
    const service = await insertService(db, categoryId, {
      name: 'Plain service',
      code: 'PLAIN',
      cost: '10.0000',
      effectiveCost: '10.0000',
      basePrice: '10.5000',
      minProfit: null,
    });
    await insertRule(db, {
      scope: 'category',
      targetId: categoryId,
      kind: 'margin',
      minProfit: '2',
      startsAt: new Date(clock.now().getTime() + MINUTE),
    });
    const row = async () => (await admin.get(`/admin/services/${service}`)).body;
    expect(await row()).toMatchObject({ minProfit: '0.6000', floorPrice: '10.6000', belowFloor: true });
    clock.advance(MINUTE);
    expect(await row()).toMatchObject({ minProfit: '2.0000', floorPrice: '12.0000', belowFloor: true });
    const list = await admin.get('/admin/services?belowFloor=true');
    expect(list.body.map((entry: { id: number }) => entry.id)).toContain(service);
  });

  it('does not let a rule for one group change the merchant-less floor of the list', async () => {
    const { db, groups, categoryId } = await world();
    const service = await insertService(db, categoryId, {
      name: 'Plain',
      code: 'PLAIN2',
      cost: '10.0000',
      effectiveCost: '10.0000',
      basePrice: '12.0000',
      minProfit: null,
    });
    await insertRule(db, { scope: 'category', targetId: categoryId, groupId: groups.vip, minProfit: '5' });
    expect((await admin.get(`/admin/services/${service}`)).body).toMatchObject({ minProfit: '0.6000' });
  });

  it('makes PATCH basePrice refuse a price under the rule floor and accept one at it', async () => {
    const { db, categoryId } = await world();
    const service = await insertService(db, categoryId, {
      name: 'Rule floor',
      code: 'RF',
      cost: '10.0000',
      effectiveCost: '10.0000',
      basePrice: '13.0000',
      minProfit: null,
    });
    await insertRule(db, { scope: 'service', targetId: service, minProfit: '2' });
    const refused = await admin.patch(`/admin/services/${service}`, { basePrice: '11.9900' });
    expect(refused.status).toBe(403); // pricing admin has no catalog:update
    const catalogAdmin = await adminWith(t, ['catalog:*']);
    const tooLow = await catalogAdmin.patch(`/admin/services/${service}`, { basePrice: '11.9900' });
    expect(tooLow.status).toBe(422);
    expect(tooLow.body.errors[0]).toMatchObject({
      field: 'basePrice',
      message: 'Below the floor. Cost $10.00 plus minimum profit $2.00 is $12.00.',
    });
    expect((await catalogAdmin.patch(`/admin/services/${service}`, { basePrice: '12.0000' })).status).toBe(200);
    // Resetting the service's own minimum profit to the default policy uses the rule, not the stored own value.
    await catalogAdmin.patch(`/admin/services/${service}`, { minProfit: '0.0500' });
    const reset = await catalogAdmin.patch(`/admin/services/${service}`, { minProfit: null, basePrice: '11.9900' });
    expect(reset.status).toBe(422);
  });
});
