// Integration tests of who may give or change a rank (decision 064): a merchant rank is the Owner's on the create and on the rank
// change, whatever else the role holds; a retail create needs no Owner; the rank never travels in a details edit.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, mock } from 'bun:test';
import { eq } from 'drizzle-orm';
import { schema as s } from '@src/infra/db';
import { MerchantAccounts } from '@src/modules/money';
import { adminWith } from '../../support/admin-api';
import { captureAccountLinks } from '../../support/account-links';
import { accountRow, ensureRetailGroup, makeAccount } from '../../support/accounts';
import { type TestApp, createTestApp } from '../../support/app';
import { clearIdentityCaches } from '../../support/auth';
import { TestClock } from '../../support/clock';
import { insertTaxRates } from '../../support/customers';
import { closeTestDb, resetDb, testDb } from '../../support/db';
import { insertUsd } from '../../support/fixtures';
import { clearAccountMailLimits } from '../../support/identity-mail';

const clock = new TestClock();
let t: TestApp;
const OWNER_REFUSAL = 'Only the Owner gives or changes a rank.';
/** Everything the console grants an Admin that concerns accounts, ranks and money: the Owner's `*` is the only thing it lacks. */
const ADMIN = ['clients:*', 'groups:*', 'wallet:*', 'api_keys:*', 'customers:privacy'];

beforeAll(async () => {
  t = await createTestApp({ clock });
});
beforeEach(async () => {
  clock.reset();
  await resetDb();
  await clearIdentityCaches(t);
  await clearAccountMailLimits(t);
  captureAccountLinks(t);
});
afterEach(() => mock.restore());
afterAll(async () => {
  await resetDb();
  await clearIdentityCaches(t);
  await t.close();
  await closeTestDb();
});

async function ranks() {
  const { db } = await testDb();
  await insertUsd(db);
  const [standard, vip] = await db
    .insert(s.clientGroups)
    .values([
      { name: 'Standard', isDefault: true, discountPercent: '0' },
      { name: 'VIP', discountPercent: '8', overdraftAllowed: true },
    ])
    .returning({ id: s.clientGroups.id });
  const retail = await ensureRetailGroup(db);
  await insertTaxRates(db, ['GB']);
  return { standard: standard!.id, vip: vip!.id, retail };
}
const accountRows = async () => (await testDb()).db.select().from(s.clients).orderBy(s.clients.id);
const auditRows = async () => (await testDb()).db.select().from(s.auditLogs).orderBy(s.auditLogs.id);
const body = (extra: Record<string, unknown> = {}) => ({
  name: 'Zain Mobile Hub',
  email: 'ops@zainmobilehub.example',
  country: 'GB',
  ...extra,
});

describe('creating an account with a rank', () => {
  it('refuses a merchant rank to an Admin who holds clients:* and groups:*, writes nothing, and says why', async () => {
    const { standard, vip } = await ranks();
    const admin = await adminWith(t, ADMIN);
    for (const groupId of [standard, vip]) {
      const res = await admin.post('/admin/clients', body({ groupId }));
      expect(res.status, String(groupId)).toBe(403);
      expect(res.body.code).toBe('FORBIDDEN');
      expect(res.body.detail).toBe(OWNER_REFUSAL);
    }
    expect(await accountRows()).toHaveLength(0);
    expect(await auditRows()).toHaveLength(0);
  });

  it('lets the Owner create a merchant account with a merchant rank', async () => {
    const { vip } = await ranks();
    const owner = await adminWith(t, ['*']);
    const res = await owner.post('/admin/clients', body({ groupId: vip }));
    expect(res.status).toBe(201);
    expect(await accountRow(res.body.id)).toMatchObject({ groupId: vip, hasAccount: true, createdBy: owner.staffId });
    expect((await accountRow(res.body.id)).username).not.toBeNull();
  });

  it('makes a retail account when no rank is sent, for the Admin and for the Owner alike, never in the default merchant rank', async () => {
    const { retail, standard } = await ranks();
    const admin = await adminWith(t, ADMIN);
    const owner = await adminWith(t, ['*']);
    const byAdmin = await admin.post('/admin/clients', body());
    const byOwner = await owner.post('/admin/clients', body({ email: 'second@zainmobilehub.example' }));
    expect([byAdmin.status, byOwner.status]).toEqual([201, 201]);
    for (const res of [byAdmin, byOwner]) {
      const row = await accountRow(res.body.id);
      expect(row.groupId).toBe(retail);
      expect(row.groupId).not.toBe(standard);
      expect(row.username).toBeNull();
    }
  });

  it('lets an Admin name the retail rank itself: a retail create needs no Owner', async () => {
    const { retail } = await ranks();
    const admin = await adminWith(t, ADMIN);
    const res = await admin.post('/admin/clients', body({ groupId: retail }));
    expect(res.status).toBe(201);
    expect((await accountRow(res.body.id)).groupId).toBe(retail);
  });
});

describe('changing the rank of an account', () => {
  const change = (api: Awaited<ReturnType<typeof adminWith>>, id: number, groupId: number, key = 'rank-key-1') =>
    api.post(`/admin/clients/${id}/rank`, { groupId }, { 'idempotency-key': key });

  it('refuses an Admin, with the Owner sentence, and the account keeps its rank', async () => {
    const { standard, vip } = await ranks();
    const merchant = await makeAccount(t, { rank: 'merchant', groupId: standard });
    const admin = await adminWith(t, ADMIN);
    const res = await change(admin, merchant.id, vip);
    expect(res.status).toBe(403);
    expect(res.body.detail).toBe(OWNER_REFUSAL);
    expect((await accountRow(merchant.id)).groupId).toBe(standard);
    expect(await auditRows()).toHaveLength(0);
  });

  it('lets the Owner change it, with an Idempotency-Key', async () => {
    const { standard, vip } = await ranks();
    const merchant = await makeAccount(t, { rank: 'merchant', groupId: standard });
    // A merchant rank holds a wallet and a hold; the rank change reads them.
    await t.app.get(MerchantAccounts).open((await testDb()).db, {
      clientId: merchant.id,
      currency: 'USD',
      creditLimit: '0.0000',
      overdraftAllowed: false,
    });
    const owner = await adminWith(t, ['*']);
    const res = await change(owner, merchant.id, vip);
    expect(res.status).toBe(200);
    expect((await accountRow(merchant.id)).groupId).toBe(vip);
    expect((await auditRows()).at(-1)!.entityType).toBe('account');
  });

  it('never moves a rank through PATCH /admin/clients/:id: groupId is 422 use_rank_route for the Admin and for the Owner', async () => {
    const { standard, vip } = await ranks();
    const merchant = await makeAccount(t, { rank: 'merchant', groupId: standard });
    for (const api of [await adminWith(t, ADMIN), await adminWith(t, ['*'])]) {
      const res = await api.patch(`/admin/clients/${merchant.id}`, { groupId: vip });
      expect(res.status).toBe(422);
      expect(res.body.errors[0]).toMatchObject({ field: 'groupId', code: 'use_rank_route' });
    }
    expect((await accountRow(merchant.id)).groupId).toBe(standard);
    const { db } = await testDb();
    expect(await db.select().from(s.clients).where(eq(s.clients.groupId, vip))).toHaveLength(0);
  });
});
