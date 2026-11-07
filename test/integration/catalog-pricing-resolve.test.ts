// Integration tests of GET /admin/pricing/resolve and the resolver's loader (feature 4b): the demo's examples against real
// rows, the rule window on the clock's time, the floor with rules and groups, otherGroups, 404s and permissions.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import { PriceResolver } from '../../src/modules/catalog';
import { type AdminApi, adminWith } from '../support/admin-api';
import { type TestApp, createTestApp } from '../support/app';
import { clearIdentityCaches } from '../support/auth';
import { insertCategory, insertService } from '../support/catalog';
import { MINUTE, TestClock } from '../support/clock';
import { closeTestDb, resetDb, testDb } from '../support/db';
import {
  insertAtt,
  insertClientPriceRow,
  insertDemoGroups,
  insertGroupPrice,
  insertMerchantIn,
  insertRule,
} from '../support/pricing';

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

const resolve = (serviceId: number, clientId: number) =>
  admin.get(`/admin/pricing/resolve?serviceId=${serviceId}&clientId=${clientId}`);

describe('GET /admin/pricing/resolve', () => {
  it('walks the demo: group price for VIP, client price for Cairo, base price and the 2 % category rule for Standard', async () => {
    const { db } = await testDb();
    const groups = await insertDemoGroups(db);
    const { categoryId, serviceId } = await insertAtt(db);
    await insertGroupPrice(db, serviceId, groups.vip, '15.9000');
    await insertRule(db, { scope: 'category', targetId: categoryId, kind: 'discount', percent: '2' });
    const cairo = await insertMerchantIn(db, groups.vip, { name: 'Cairo' });
    const erbil = await insertMerchantIn(db, groups.standard, { name: 'Erbil' });
    const dubai = await insertMerchantIn(db, groups.wholesale, { name: 'Dubai' });
    await insertClientPriceRow(db, serviceId, cairo, '15.2000');

    const forCairo = await resolve(serviceId, cairo);
    expect(forCairo.status).toBe(200);
    expect(forCairo.body).toMatchObject({
      price: '15.2000',
      rawPrice: '15.2000',
      floor: '14.3100',
      clamped: false,
      source: 'client',
      cost: '13.5000',
      minProfit: '0.8100',
      margin: '1.7000',
      marginPct: '11.1842',
    });
    expect(forCairo.body.steps.map((step: { id: string; state: string }) => `${step.id}:${step.state}`)).toEqual([
      'client:win',
      'group:skip',
      'base:skip',
      'category:skip',
      'discount:skip',
    ]);

    const forErbil = await resolve(serviceId, erbil);
    expect(forErbil.body).toMatchObject({ price: '16.9300', source: 'base', clamped: false });
    expect(forErbil.body.steps[3]).toEqual({
      id: 'category',
      label: 'Category rule',
      state: 'apply',
      value: -0.02,
      after: '16.9300',
      note: 'Carrier unlock discount -2%',
    });
    expect(forErbil.body.otherGroups).toEqual([
      { group: { id: groups.standard, name: 'Standard' }, price: '16.9300', clamped: false },
      { group: { id: groups.wholesale, name: 'Wholesale' }, price: '16.2600', clamped: false },
      { group: { id: groups.vip, name: 'VIP' }, price: '15.9000', clamped: false },
    ]);

    const forDubai = await resolve(serviceId, dubai);
    expect(forDubai.body.price).toBe('16.2600');
    expect(forDubai.body.steps[4]).toMatchObject({ id: 'discount', state: 'apply', value: 0.04, after: '16.2600' });
  });

  it('applies a rule only inside its window, judged on the clock', async () => {
    const { db } = await testDb();
    const groups = await insertDemoGroups(db);
    const { categoryId, serviceId } = await insertAtt(db);
    const merchant = await insertMerchantIn(db, groups.standard);
    await insertRule(db, {
      scope: 'category',
      targetId: categoryId,
      kind: 'promo',
      percent: '10',
      startsAt: new Date(clock.now().getTime() + MINUTE),
      endsAt: new Date(clock.now().getTime() + 2 * MINUTE),
    });

    expect((await resolve(serviceId, merchant)).body.price).toBe('17.2800');
    clock.advance(MINUTE);
    const inside = await resolve(serviceId, merchant);
    expect(inside.body.price).toBe('15.5500');
    expect(inside.body.steps[3]).toMatchObject({ state: 'apply', note: 'Carrier unlock promo -10%' });
    clock.advance(MINUTE);
    expect((await resolve(serviceId, merchant)).body.price).toBe('17.2800');
  });

  it('adds the rounding step and takes the minimum profit of the first matching rule', async () => {
    const { db } = await testDb();
    const groups = await insertDemoGroups(db);
    const { categoryId, serviceId } = await insertAtt(db, { minProfit: null });
    const merchant = await insertMerchantIn(db, groups.standard);
    await insertRule(db, {
      scope: 'category',
      targetId: categoryId,
      kind: 'margin',
      percent: '0',
      fixed: '0.5',
      rounding: 'ends_99',
      minProfit: '2.5',
    });

    const res = await resolve(serviceId, merchant);
    // 17.28 + 0.50 = 17.78, ends in .99 gives 17.99; floor = 13.50 + 2.50 = 16.00
    expect(res.body).toMatchObject({ price: '17.9900', rawPrice: '17.9900', floor: '16.0000', minProfit: '2.5000' });
    expect(res.body.steps.at(-1)).toEqual({
      id: 'rounding',
      label: 'Rounding',
      state: 'apply',
      value: '17.9900',
      after: '17.9900',
      note: 'Prices end in .99',
    });
  });

  it('clamps to the floor with the cost raised by a supplier (effective cost, not services.cost)', async () => {
    const { db } = await testDb();
    const groups = await insertDemoGroups(db);
    const { serviceId } = await insertAtt(db, { effectiveCost: '17.0000', minProfit: '0.5000' });
    const merchant = await insertMerchantIn(db, groups.standard);
    await insertGroupPrice(db, serviceId, groups.standard, '15.0000');

    const res = await resolve(serviceId, merchant);
    expect(res.body).toMatchObject({
      price: '17.5000',
      rawPrice: '15.0000',
      floor: '17.5000',
      clamped: true,
      cost: '17.0000',
      source: 'group',
    });
  });

  it('prices every merchant group except the storefront one in otherGroups', async () => {
    const { db } = await testDb();
    const groups = await insertDemoGroups(db);
    const { serviceId } = await insertAtt(db);
    const merchant = await insertMerchantIn(db, groups.standard);
    const res = await resolve(serviceId, merchant);
    expect(res.body.otherGroups.map((entry: { group: { name: string } }) => entry.group.name)).toEqual([
      'Standard',
      'Wholesale',
      'VIP',
    ]);
  });

  it('answers 404 for an unknown or archived service and an unknown merchant, 422 for a missing id, 403 without pricing:read', async () => {
    const { db } = await testDb();
    const groups = await insertDemoGroups(db);
    const { categoryId, serviceId } = await insertAtt(db);
    const merchant = await insertMerchantIn(db, groups.standard);
    const archived = await insertService(db, categoryId, { archivedAt: new Date(), status: 'disabled' });

    expect((await resolve(9999, merchant)).status).toBe(404);
    expect((await resolve(archived, merchant)).status).toBe(404);
    expect((await resolve(serviceId, 9999)).status).toBe(404);
    const missing = await admin.get(`/admin/pricing/resolve?serviceId=${serviceId}`);
    expect(missing.status).toBe(422);
    expect(missing.body.errors[0].field).toBe('clientId');
    const limited = await adminWith(t, ['catalog:read']);
    expect((await limited.get(`/admin/pricing/resolve?serviceId=${serviceId}&clientId=${merchant}`)).status).toBe(403);
    expect(
      (await admin.anonymous('GET', `/admin/pricing/resolve?serviceId=${serviceId}&clientId=${merchant}`)).status,
    ).toBe(401);
  });
});

describe('the SQL figures of the service list and the resolver agree', () => {
  it('gives the same minimum profit and floor for every mix of own value, rules and default policy', async () => {
    const { db } = await testDb();
    const groups = await insertDemoGroups(db);
    const categoryId = await insertCategory(db, { name: 'Mixed' });
    const merchant = await insertMerchantIn(db, groups.standard);
    const make = (code: string, cost: string, minProfit: string | null) =>
      insertService(db, categoryId, { name: code, code, cost, effectiveCost: cost, basePrice: '50.0000', minProfit });
    const own = await make('OWN', '10.0000', '1.2500');
    const byDefault = await make('DEFAULT', '9.8000', null);
    const byRule = await make('RULE', '10.0000', null);
    const bySpecific = await make('SPECIFIC', '10.0000', null);
    const elsewhere = await insertCategory(db, { name: 'Elsewhere' });
    const byGlobal = await insertService(db, elsewhere, {
      name: 'GLOBAL',
      code: 'GLOBAL',
      cost: '0.5000',
      effectiveCost: '0.5000',
      basePrice: '50.0000',
      minProfit: null,
    });
    await insertRule(db, { scope: 'category', targetId: categoryId, minProfit: '0.7500', priority: 5 });
    await insertRule(db, { scope: 'service', targetId: bySpecific, minProfit: '1.5000', priority: 90 });
    await insertRule(db, { scope: 'service', targetId: bySpecific, minProfit: '0.0000', priority: 1 });
    await insertRule(db, { scope: 'global', targetId: null, minProfit: '9.0000', priority: 0 });
    await insertRule(db, {
      scope: 'category',
      targetId: categoryId,
      groupId: groups.vip,
      minProfit: '6.0000',
      priority: 0,
    });
    await insertRule(db, {
      scope: 'category',
      targetId: categoryId,
      minProfit: '3.0000',
      priority: 0,
      isActive: false,
    });
    await insertRule(db, {
      scope: 'category',
      targetId: categoryId,
      minProfit: '4.0000',
      priority: 0,
      endsAt: new Date(clock.now().getTime() - 1),
    });

    for (const id of [own, byDefault, byRule, bySpecific, byGlobal]) {
      const listed = (await admin.get(`/admin/services/${id}`)).body;
      const resolved = (await resolve(id, merchant)).body;
      expect(listed.minProfit, listed.name).toBe(resolved.minProfit);
      expect(listed.floorPrice, listed.name).toBe(resolved.floor);
    }
    // Scope order decides, not size: the category rule (0.75) beats the bigger global one (9.00), the service rule beats both,
    // and a service outside the category falls to the global rule.
    expect((await admin.get(`/admin/services/${byRule}`)).body.minProfit).toBe('0.7500');
    expect((await admin.get(`/admin/services/${byGlobal}`)).body.minProfit).toBe('9.0000');
    expect((await admin.get(`/admin/services/${bySpecific}`)).body.minProfit).toBe('1.5000');
    expect((await admin.get(`/admin/services/${byDefault}`)).body.minProfit).toBe('0.7500');
  });
});

describe('PriceResolver', () => {
  it('resolves many requests with one load and answers undefined for an archived service', async () => {
    const { db } = await testDb();
    const groups = await insertDemoGroups(db);
    const { categoryId, serviceId } = await insertAtt(db);
    const archived = await insertService(db, categoryId, { archivedAt: new Date(), status: 'disabled' });
    const merchant = await insertMerchantIn(db, groups.wholesale);
    await insertClientPriceRow(db, serviceId, merchant, '15.5000');

    const resolver = t.app.get(PriceResolver);
    const [withClient, withoutClient, gone, noGroup] = await resolver.resolveMany(db, [
      { serviceId, groupId: groups.wholesale, clientId: merchant },
      { serviceId, groupId: groups.wholesale },
      { serviceId: archived, groupId: groups.wholesale },
      { serviceId, groupId: null },
    ]);
    expect(withClient?.price.toWire()).toBe('15.5000');
    expect(withoutClient?.price.toWire()).toBe('16.5900');
    expect(gone).toBeUndefined();
    // No merchant group: no discount and no group price.
    expect(noGroup?.price.toWire()).toBe('17.2800');
    expect(await resolver.floor(db, serviceId, groups.standard)).toMatchObject({ cost: expect.anything() });
    expect(await resolver.floor(db, 424242, groups.standard)).toBeUndefined();
  });

  it('judges rule windows at the time it is given', async () => {
    const { db } = await testDb();
    const groups = await insertDemoGroups(db);
    const { categoryId, serviceId } = await insertAtt(db);
    await insertRule(db, {
      scope: 'category',
      targetId: categoryId,
      startsAt: new Date('2027-01-01T00:00:00.000Z'),
      percent: '50',
    });
    const resolver = t.app.get(PriceResolver);
    const now = await resolver.resolve(db, { serviceId, groupId: groups.standard });
    const later = await resolver.resolve(
      db,
      { serviceId, groupId: groups.standard },
      new Date('2027-02-01T00:00:00.000Z'),
    );
    expect(now?.price.toWire()).toBe('17.2800');
    expect(later?.price.toWire()).toBe('14.3100');
    expect(later?.clamped).toBe(true);
  });
});
