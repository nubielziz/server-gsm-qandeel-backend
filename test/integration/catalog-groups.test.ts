// Integration tests of the merchant group routes (feature 4a): list, show, create, change and delete with the default-group
// invariant, the retail group protection, user rule 2 (overdraft) and the cleanup of prices, rules and category visibility.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import { eq } from 'drizzle-orm';
import { schema as s } from '../../src/infra/db';
import { MerchantAccounts } from '../../src/modules/money';
import { type AdminApi, adminWith } from '../support/admin-api';
import { type TestApp, createTestApp } from '../support/app';
import { clearIdentityCaches, insertMerchant } from '../support/auth';
import { insertGateway } from '../support/billing';
import { closeTestDb, resetDb, testDb } from '../support/db';
import { insertUsd } from '../support/fixtures';

let t: TestApp;
let admin: AdminApi;

beforeAll(async () => {
  t = await createTestApp();
});
beforeEach(async () => {
  await resetDb();
  await clearIdentityCaches(t);
  admin = await adminWith(t, ['groups:*', 'catalog:*', 'clients:*', 'wallet:*'], { name: 'Rami K.' });
});
afterAll(async () => {
  await resetDb();
  await clearIdentityCaches(t);
  await t.close();
  await closeTestDb();
});

const auditRows = async () => (await testDb()).db.select().from(s.auditLogs).orderBy(s.auditLogs.id);
const groupRows = async () => (await testDb()).db.select().from(s.clientGroups).orderBy(s.clientGroups.id);

/** The demo's four groups: Standard (default), Wholesale, VIP and the storefront retail group. */
async function demoGroups(): Promise<{ standard: number; wholesale: number; vip: number; retail: number }> {
  const { db } = await testDb();
  const [standard, wholesale, vip, retail] = await db
    .insert(s.clientGroups)
    .values([
      { name: 'Standard', isDefault: true, discountPercent: '0', depositLimit: '5000', sort: 1 },
      {
        name: 'Wholesale',
        discountPercent: '4',
        earnThreshold: '5000',
        depositLimit: '20000',
        overdraftAllowed: true,
        sort: 2,
      },
      {
        name: 'VIP',
        discountPercent: '8',
        earnThreshold: '25000',
        depositLimit: '100000',
        overdraftAllowed: true,
        sort: 3,
      },
      { name: 'Storefront retail', kind: 'b2c_retail', depositLimit: '1000', sort: 4 },
    ])
    .returning({ id: s.clientGroups.id });
  return { standard: standard!.id, wholesale: wholesale!.id, vip: vip!.id, retail: retail!.id };
}

describe('GET /admin/client-groups', () => {
  it('lists every group by sort with merchant counts (not for the retail group)', async () => {
    const groups = await demoGroups();
    const { db } = await testDb();
    await insertMerchant(db, { groupId: groups.wholesale });
    await insertMerchant(db, { groupId: groups.wholesale });
    await insertMerchant(db, { groupId: groups.standard });

    const res = await admin.get('/admin/client-groups?_start=0&_end=200&_sort=sort&_order=asc');
    expect(res.status).toBe(200);
    expect(res.total).toBe(4);
    expect(res.body.map((g: { name: string }) => g.name)).toEqual([
      'Standard',
      'Wholesale',
      'VIP',
      'Storefront retail',
    ]);
    const [standard, wholesale, vip, retail] = res.body;
    expect(standard).toMatchObject({
      id: groups.standard,
      kind: 'b2b',
      discountPercent: '0.0000',
      isDefault: true,
      earnThreshold: '0.0000',
      depositLimit: '5000.0000',
      overdraftAllowed: false,
      sort: 1,
      merchantCount: 1,
    });
    expect(typeof standard.createdAt).toBe('string');
    expect(wholesale).toMatchObject({
      discountPercent: '4.0000',
      earnThreshold: '5000.0000',
      overdraftAllowed: true,
      merchantCount: 2,
    });
    expect(vip.merchantCount).toBe(0);
    expect(retail.kind).toBe('b2c_retail');
    expect('merchantCount' in retail).toBe(false);
  });

  it('answers count-only calls, searches by name and sorts', async () => {
    await demoGroups();
    const one = await admin.get('/admin/client-groups?_start=0&_end=1');
    expect(one.body.length).toBe(1);
    expect(one.total).toBe(4);
    const found = await admin.get('/admin/client-groups?q=whole');
    expect(found.total).toBe(1);
    const byName = await admin.get('/admin/client-groups?_sort=name&_order=desc');
    expect(byName.body[0].name).toBe('Wholesale');
    expect((await admin.get('/admin/client-groups?_sort=depositLimit')).status).toBe(422);
  });

  it('needs groups:read', async () => {
    const other = await adminWith(t, ['catalog:read']);
    const res = await other.get('/admin/client-groups');
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('FORBIDDEN');
  });
});

describe('GET /admin/client-groups/:id', () => {
  it('shows one group and answers 404 for an unknown id', async () => {
    const groups = await demoGroups();
    const res = await admin.get(`/admin/client-groups/${groups.vip}`);
    expect(res.body).toMatchObject({ id: groups.vip, name: 'VIP', earnThreshold: '25000.0000', merchantCount: 0 });
    const missing = await admin.get('/admin/client-groups/999999');
    expect(missing.status).toBe(404);
    expect(missing.body.code).toBe('NOT_FOUND');
  });
});

describe('POST /admin/client-groups', () => {
  it('creates a b2b group last in the order, normalises decimals and audits it', async () => {
    await demoGroups();
    const res = await admin.post('/admin/client-groups', {
      name: '  Platinum ',
      discountPercent: '2.5',
      earnThreshold: '50000.0000',
      depositLimit: '250000.0000',
      overdraftAllowed: true,
      isDefault: false,
    });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({
      name: 'Platinum',
      kind: 'b2b',
      discountPercent: '2.5000',
      isDefault: false,
      earnThreshold: '50000.0000',
      depositLimit: '250000.0000',
      overdraftAllowed: true,
      sort: 5,
      merchantCount: 0,
    });
    const [audit] = (await auditRows()).slice(-1);
    expect(audit).toMatchObject({
      actorType: 'staff',
      actorId: admin.staffId,
      actorName: 'Rami K.',
      action: 'created client group',
      entityType: 'client_group',
      entityId: res.body.id,
      entityLabel: 'Platinum',
    });
    expect(audit!.after).toMatchObject({ name: 'Platinum', discountPercent: '2.5000' });
  });

  it('defaults the fields left out to zero and false', async () => {
    const res = await admin.post('/admin/client-groups', { name: 'Basic' });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({
      discountPercent: '0.0000',
      earnThreshold: '0.0000',
      depositLimit: '0.0000',
      overdraftAllowed: false,
      isDefault: false,
      sort: 1,
    });
  });

  it('moves the default mark when the new group is the default', async () => {
    const groups = await demoGroups();
    const res = await admin.post('/admin/client-groups', { name: 'New default', isDefault: true });
    expect(res.status).toBe(201);
    expect(res.body.isDefault).toBe(true);
    const rows = await groupRows();
    expect(rows.filter((g) => g.isDefault).map((g) => g.id)).toEqual([res.body.id]);
    expect(rows.find((g) => g.id === groups.standard)!.isDefault).toBe(false);
  });

  it('refuses a repeated name (any case), bad numbers and a missing name, on the field', async () => {
    await demoGroups();
    const duplicate = await admin.post('/admin/client-groups', { name: 'wholesale' });
    expect(duplicate.status).toBe(422);
    expect(duplicate.body.errors).toEqual([
      expect.objectContaining({ field: 'name', message: 'A group with this name already exists.' }),
    ]);

    const bad = await admin.post('/admin/client-groups', {
      name: 'Odd',
      discountPercent: '101',
      earnThreshold: '-1.0000',
      depositLimit: '12',
    });
    expect(bad.status).toBe(422);
    expect(bad.body.errors.map((e: { field: string }) => e.field).sort()).toEqual([
      'depositLimit',
      'discountPercent',
      'earnThreshold',
    ]);

    const threeDecimals = await admin.post('/admin/client-groups', { name: 'Odd', discountPercent: '2.555' });
    expect(threeDecimals.body.errors[0].field).toBe('discountPercent');
    const blank = await admin.post('/admin/client-groups', { name: '   ' });
    expect(blank.body.errors[0].field).toBe('name');
    expect((await groupRows()).length).toBe(4);
  });

  it('needs groups:create', async () => {
    const other = await adminWith(t, ['groups:read']);
    expect((await other.post('/admin/client-groups', { name: 'X' })).status).toBe(403);
  });
});

describe('PATCH /admin/client-groups/:id', () => {
  it('changes only the keys sent and audits the before and after', async () => {
    const groups = await demoGroups();
    const res = await admin.patch(`/admin/client-groups/${groups.wholesale}`, {
      discountPercent: '5',
      depositLimit: '0.0000',
    });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      name: 'Wholesale',
      discountPercent: '5.0000',
      depositLimit: '0.0000',
      earnThreshold: '5000.0000',
      overdraftAllowed: true,
    });
    const [audit] = (await auditRows()).slice(-1);
    expect(audit).toMatchObject({
      action: 'edited client group',
      entityType: 'client_group',
      entityId: groups.wholesale,
    });
    expect(audit!.before).toMatchObject({ discountPercent: '4.0000', depositLimit: '20000.0000' });
    expect(audit!.after).toMatchObject({ discountPercent: '5.0000', depositLimit: '0.0000' });
  });

  it('refuses an empty body, a repeated name and answers 404', async () => {
    const groups = await demoGroups();
    expect((await admin.patch(`/admin/client-groups/${groups.vip}`, {})).status).toBe(422);
    const clash = await admin.patch(`/admin/client-groups/${groups.vip}`, { name: 'WHOLESALE' });
    expect(clash.status).toBe(422);
    expect(clash.body.errors[0].field).toBe('name');
    // Renaming a group to its own name in another case is fine.
    expect((await admin.patch(`/admin/client-groups/${groups.vip}`, { name: 'vip' })).status).toBe(200);
    expect((await admin.patch('/admin/client-groups/999999', { name: 'X' })).status).toBe(404);
  });

  it('moves the default mark to this group, and keeps the old group when the mark is refused for the retail group', async () => {
    const groups = await demoGroups();
    const moved = await admin.patch(`/admin/client-groups/${groups.vip}`, { isDefault: true });
    expect(moved.status).toBe(200);
    expect(moved.body.isDefault).toBe(true);
    const rows = await groupRows();
    expect(rows.filter((g) => g.isDefault).map((g) => g.id)).toEqual([groups.vip]);

    const retail = await admin.patch(`/admin/client-groups/${groups.retail}`, { isDefault: true });
    expect(retail.status).toBe(422);
    expect(retail.body.errors[0].field).toBe('isDefault');
    expect((await groupRows()).filter((g) => g.isDefault).map((g) => g.id)).toEqual([groups.vip]);
  });

  it('refuses to unmark the default group (409 DEFAULT_GROUP_REQUIRED), and unmarking another group changes nothing', async () => {
    const groups = await demoGroups();
    const refused = await admin.patch(`/admin/client-groups/${groups.standard}`, { isDefault: false });
    expect(refused.status).toBe(409);
    expect(refused.body.code).toBe('DEFAULT_GROUP_REQUIRED');
    expect((await groupRows()).find((g) => g.id === groups.standard)!.isDefault).toBe(true);
    expect((await admin.patch(`/admin/client-groups/${groups.vip}`, { isDefault: false })).status).toBe(200);
  });

  it('refuses to switch overdraft off while a merchant of the group has a credit limit (user rule 2)', async () => {
    const groups = await demoGroups();
    const { db } = await testDb();
    await insertUsd(db);
    const holder = await insertMerchant(db, { groupId: groups.wholesale });
    await new MerchantAccounts().open(db, {
      clientId: holder,
      currency: 'USD',
      creditLimit: '500.0000',
      overdraftAllowed: true,
    });
    const other = await insertMerchant(db, { groupId: groups.wholesale });
    await new MerchantAccounts().open(db, {
      clientId: other,
      currency: 'USD',
      creditLimit: '0.0000',
      overdraftAllowed: true,
    });

    const refused = await admin.patch(`/admin/client-groups/${groups.wholesale}`, { overdraftAllowed: false });
    expect(refused.status).toBe(422);
    expect(refused.body.errors).toEqual([expect.objectContaining({ field: 'overdraftAllowed' })]);
    expect(refused.body.errors[0].message).toContain('1 merchant in Wholesale has a credit limit');
    expect((await groupRows()).find((g) => g.id === groups.wholesale)!.overdraftAllowed).toBe(true);

    // A credit holder in another group does not count; once the limit is zero the switch goes through.
    const vipOff = await admin.patch(`/admin/client-groups/${groups.vip}`, { overdraftAllowed: false });
    expect(vipOff.status).toBe(200);
    expect((await admin.patch(`/admin/clients/${holder}/credit-limit`, { creditLimit: '0.0000' })).status).toBe(200);
    const allowed = await admin.patch(`/admin/client-groups/${groups.wholesale}`, { overdraftAllowed: false });
    expect(allowed.status).toBe(200);
    expect(allowed.body.overdraftAllowed).toBe(false);
  });

  it('never leaves a credit limit in a group without overdraft when the two changes race', async () => {
    const groups = await demoGroups();
    const { db } = await testDb();
    await insertUsd(db);
    const merchant = await insertMerchant(db, { groupId: groups.wholesale });
    await new MerchantAccounts().open(db, {
      clientId: merchant,
      currency: 'USD',
      creditLimit: '0.0000',
      overdraftAllowed: true,
    });

    const [off, credit] = await Promise.all([
      admin.patch(`/admin/client-groups/${groups.wholesale}`, { overdraftAllowed: false }),
      admin.patch(`/admin/clients/${merchant}/credit-limit`, { creditLimit: '300.0000' }),
    ]);
    const group = (await groupRows()).find((g) => g.id === groups.wholesale)!;
    const [wallet] = await db.select().from(s.ledgerAccounts).where(eq(s.ledgerAccounts.ownerId, merchant));
    const limit = await db
      .select({ limit: s.ledgerAccounts.overdraftLimit })
      .from(s.ledgerAccounts)
      .where(eq(s.ledgerAccounts.kind, 'client_wallet'));
    expect(wallet).toBeDefined();
    const hasCredit = Number(limit.find(() => true)!.limit) > 0;
    // Exactly one of the two lost the race; the rule holds either way.
    expect([off.status, credit.status].sort()).toEqual([200, 422]);
    expect(!group.overdraftAllowed && hasCredit).toBe(false);
  });
});

describe('DELETE /admin/client-groups/:id', () => {
  it('refuses the default group, the retail group and a group with merchants (409 GROUP_IN_USE)', async () => {
    const groups = await demoGroups();
    const { db } = await testDb();
    await insertMerchant(db, { groupId: groups.vip });
    await insertMerchant(db, { groupId: groups.vip });

    const standard = await admin.delete(`/admin/client-groups/${groups.standard}`);
    expect(standard.status).toBe(409);
    expect(standard.body.code).toBe('GROUP_IN_USE');
    expect(standard.body.detail).toContain('default group');
    const retail = await admin.delete(`/admin/client-groups/${groups.retail}`);
    expect(retail.body.code).toBe('GROUP_IN_USE');
    const vip = await admin.delete(`/admin/client-groups/${groups.vip}`);
    expect(vip.status).toBe(409);
    expect(vip.body.detail).toBe('Move the 2 merchants in VIP to another group first.');
    expect((await groupRows()).length).toBe(4);
    expect((await admin.delete('/admin/client-groups/999999')).status).toBe(404);
  });

  it('deletes a free group with its group prices, its pricing rules and its place in category visibility', async () => {
    const groups = await demoGroups();
    const { db } = await testDb();
    const [category] = await db
      .insert(s.serviceCategories)
      .values({ name: 'Apple', type: 'imei', allowedGroupIds: [groups.vip, groups.wholesale] })
      .returning();
    const [service] = await db
      .insert(s.services)
      .values({
        categoryId: category!.id,
        type: 'imei',
        name: 'Check',
        fulfillment: 'auto',
        basePrice: '5',
        code: 'CHK-1',
        slaMinutes: 5,
      })
      .returning();
    await db.insert(s.serviceGroupPrices).values([
      { serviceId: service!.id, groupId: groups.vip, price: '4' },
      { serviceId: service!.id, groupId: groups.wholesale, price: '4.5' },
    ]);
    const rules = await db
      .insert(s.pricingRules)
      .values([
        { scope: 'global', groupId: groups.vip, kind: 'discount', percent: '2' },
        { scope: 'global', kind: 'margin', percent: '10' },
        { scope: 'service', targetId: service!.id, groupId: groups.vip, kind: 'promo', percent: '1' },
      ])
      .returning({ id: s.pricingRules.id });

    const res = await admin.delete(`/admin/client-groups/${groups.vip}`);
    expect(res.status).toBe(204);
    expect((await groupRows()).map((g) => g.name)).toEqual(['Standard', 'Wholesale', 'Storefront retail']);
    expect(await db.select().from(s.serviceGroupPrices)).toEqual([
      expect.objectContaining({ groupId: groups.wholesale }),
    ]);
    expect((await db.select().from(s.pricingRules)).map((r) => r.id)).toEqual([rules[1]!.id]);
    const [after] = await db.select().from(s.serviceCategories);
    expect(after!.allowedGroupIds).toEqual([groups.wholesale]);

    const [audit] = (await auditRows()).slice(-1);
    expect(audit).toMatchObject({
      action: 'deleted client group',
      entityType: 'client_group',
      entityId: groups.vip,
      entityLabel: 'VIP',
    });
    expect(audit!.before).toMatchObject({
      removedGroupPrices: 1,
      removedPricingRuleIds: [rules[0]!.id, rules[2]!.id],
      removedFromCategoryIds: [category!.id],
    });
    expect(audit!.after).toBeNull();
  });

  it('takes the deleted group out of every payment method that listed it, in the same transaction', async () => {
    const groups = await demoGroups();
    const { db } = await testDb();
    const listed = await insertGateway(t, db, { code: 'card', allowedGroupIds: [groups.vip, groups.wholesale] });
    const other = await insertGateway(t, db, { code: 'wise', allowedGroupIds: [groups.wholesale] });
    const open = await insertGateway(t, db, { code: 'bank', allowedGroupIds: [] });

    expect((await admin.delete(`/admin/client-groups/${groups.vip}`)).status).toBe(204);

    const rows = await db.select().from(s.paymentGateways);
    const idsOf = (id: number) => rows.find((row) => row.id === id)!.allowedGroupIds;
    expect(idsOf(listed)).toEqual([groups.wholesale]);
    expect(idsOf(other)).toEqual([groups.wholesale]);
    expect(idsOf(open)).toEqual([]);
    const [audit] = (await auditRows()).slice(-1);
    expect(audit!.before).toMatchObject({ removedFromPaymentGatewayCount: 1 });
  });

  it('leaves the payment methods alone when the delete is refused', async () => {
    const groups = await demoGroups();
    const { db } = await testDb();
    await insertMerchant(db, { groupId: groups.vip });
    const gateway = await insertGateway(t, db, { code: 'card', allowedGroupIds: [groups.vip] });

    expect((await admin.delete(`/admin/client-groups/${groups.vip}`)).status).toBe(409);

    const [row] = await db.select().from(s.paymentGateways).where(eq(s.paymentGateways.id, gateway));
    expect(row!.allowedGroupIds).toEqual([groups.vip]);
  });

  it('needs groups:delete', async () => {
    const groups = await demoGroups();
    const other = await adminWith(t, ['groups:read', 'groups:update']);
    expect((await other.delete(`/admin/client-groups/${groups.vip}`)).status).toBe(403);
  });

  it('never leaves a merchant in a deleted group when a move races the delete', async () => {
    const groups = await demoGroups();
    const { db } = await testDb();
    const merchant = await insertMerchant(db, { groupId: groups.standard });
    const [deleted, moved] = await Promise.all([
      admin.delete(`/admin/client-groups/${groups.vip}`),
      admin.patch(`/admin/clients/${merchant}`, { groupId: groups.vip }),
    ]);
    const [row] = await db.select().from(s.clients).where(eq(s.clients.id, merchant));
    const group = (await groupRows()).find((g) => g.id === groups.vip);
    if (deleted.status === 204) {
      expect(group).toBeUndefined();
      expect(moved.status).toBe(422);
      expect(row!.groupId).toBe(groups.standard);
    } else {
      expect(deleted.status).toBe(409);
      expect(moved.status).toBe(200);
      expect(row!.groupId).toBe(groups.vip);
    }
  });
});
