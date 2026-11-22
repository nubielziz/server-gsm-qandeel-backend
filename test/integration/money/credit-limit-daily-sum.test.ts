// Integration tests of the 24-hour sum of what one staff member makes spendable on merchant wallets (decision 049): the part by which a
// credit limit is raised, on the credit-limit route and at an invitation, counts in the same sum as the staff member's credit adjustments;
// a lowering counts nothing; an Owner is not limited; the requests of one staff member are judged one after the other.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import { eq } from 'drizzle-orm';
import { Money } from '@src/common/money';
import { schema as s } from '@src/infra/db';
import { type AdminApi, adminFor, adminWith } from '../../support/admin-api';
import { type TestApp, createTestApp } from '../../support/app';
import { clearIdentityCaches } from '../../support/auth';
import { DAY, TestClock } from '../../support/clock';
import { closeTestDb, resetDb, testDb } from '../../support/db';
import { insertUsd } from '../../support/fixtures';
import { accountFigures, insertWalletMerchant } from '../../support/money';

const clock = new TestClock('2026-11-01T10:00:00.000Z');
let t: TestApp;

beforeAll(async () => {
  t = await createTestApp({ clock });
});
afterAll(async () => {
  await resetDb();
  await t.close();
  await closeTestDb();
});
beforeEach(async () => {
  clock.set('2026-11-01T10:00:00.000Z');
  await resetDb();
  await clearIdentityCaches(t);
});

const SUM_DETAIL =
  'Credits and credit-limit raises over $10,000 in 24 hours need an owner: yours would come to $10,000.0001.';

const raise = (staff: AdminApi, clientId: number, creditLimit: string) =>
  staff.patch(`/admin/clients/${clientId}/credit-limit`, { creditLimit });
const credit = (staff: AdminApi, clientId: number, amount: string) =>
  staff.post(
    `/admin/clients/${clientId}/wallet/adjust`,
    { amount, direction: 'credit', reason: 'Goodwill credit for a failed order' },
    { 'idempotency-key': crypto.randomUUID() },
  );
const limitOf = async (clientId: number) => {
  const { db } = await testDb();
  return (await accountFigures(db, 'client_wallet', { type: 'client', id: clientId }))?.overdraftLimit;
};
const merchants = async (count: number) => {
  const { db } = await testDb();
  const made = [];
  for (let i = 0; i < count; i++)
    made.push(await insertWalletMerchant(db, { name: `Merchant ${i}`, overdraftAllowed: true }));
  return made;
};

describe('PATCH /admin/clients/:id/credit-limit in the 24-hour sum of a staff member', () => {
  it('counts a raise on one merchant against a raise on another', async () => {
    const [a, b] = await merchants(2);
    const staff = await adminWith(t, ['wallet:credit_limit']);
    expect((await raise(staff, a!.id, '10000.0000')).status).toBe(200);
    const refused = await raise(staff, b!.id, '0.0001');
    expect(refused.status).toBe(403);
    expect(refused.body).toMatchObject({ code: 'FORBIDDEN', detail: SUM_DETAIL });
    expect(await limitOf(b!.id)).toBe('0.0000');
    // Another staff member has a sum of their own.
    const other = await adminWith(t, ['wallet:credit_limit']);
    expect((await raise(other, b!.id, '10000.0000')).status).toBe(200);
  });

  it('counts raises and credit adjustments together, in either order', async () => {
    const [a, b] = await merchants(2);
    const staff = await adminWith(t, ['wallet:credit_limit', 'wallet:adjust']);
    expect((await raise(staff, a!.id, '6000.0000')).status).toBe(200);
    expect((await credit(staff, b!.id, '4000.0000')).status).toBe(200);
    const more = await credit(staff, b!.id, '0.0001');
    expect(more.status).toBe(409);
    expect(more.body.code).toBe('APPROVAL_REQUIRED');
    const higher = await raise(staff, b!.id, '0.0001');
    expect(higher.status).toBe(403);
    expect(higher.body).toMatchObject({ code: 'FORBIDDEN', detail: SUM_DETAIL });
    expect(await limitOf(b!.id)).toBe('0.0000');
  });

  it('counts only the raised part; a lowering or an unchanged limit counts nothing and is always allowed', async () => {
    const [a, b] = await merchants(2);
    const staff = await adminWith(t, ['wallet:credit_limit']);
    expect((await raise(staff, a!.id, '4000.0000')).status).toBe(200);
    expect((await raise(staff, a!.id, '1000.0000')).status).toBe(200);
    // 4,000 and then 2,000 more: 6,000 counted, the lowering in between gives nothing back.
    expect((await raise(staff, a!.id, '3000.0000')).status).toBe(200);
    expect((await raise(staff, a!.id, '3000.0000')).status).toBe(200);
    expect((await raise(staff, b!.id, '4000.0000')).status).toBe(200);
    const refused = await raise(staff, b!.id, '4000.0001');
    expect(refused.status).toBe(403);
    expect(refused.body.detail).toBe(SUM_DETAIL);
    expect((await raise(staff, b!.id, '0.0000')).status).toBe(200);
    expect((await raise(staff, a!.id, '2500.0000')).status).toBe(200);
  });

  it('forgets raises after 24 hours', async () => {
    const [a, b] = await merchants(2);
    const staff = await adminWith(t, ['wallet:credit_limit']);
    expect((await raise(staff, a!.id, '10000.0000')).status).toBe(200);
    expect((await raise(staff, b!.id, '1.0000')).status).toBe(403);
    clock.advance(DAY + 1);
    // A new session of the same staff member (the first one has timed out by now).
    const later = await adminFor(t, staff.staffId, staff.roleId);
    expect((await raise(later, b!.id, '10000.0000')).status).toBe(200);
  });

  it('does not limit an owner', async () => {
    const [a, b] = await merchants(2);
    const owner = await adminWith(t, ['*']);
    expect((await raise(owner, a!.id, '10000.0000')).status).toBe(200);
    expect((await raise(owner, b!.id, '10000.0000')).status).toBe(200);
    expect((await credit(owner, b!.id, '10000.0000')).status).toBe(200);
    expect((await raise(owner, a!.id, '25000.0000')).status).toBe(200);
  });

  it('keeps what one staff member makes spendable on several merchants within the approval limit', async () => {
    const made = await merchants(5);
    const staff = await adminWith(t, ['wallet:credit_limit', 'wallet:adjust', 'wallet:read']);
    const answers = [];
    for (const merchant of made) answers.push((await raise(staff, merchant.id, '10000.0000')).status);
    answers.push((await credit(staff, made[0]!.id, '10000.0000')).status);
    expect(answers).toEqual([200, 403, 403, 403, 403, 409]);
    let available = Money.zero();
    for (const merchant of made) {
      available = available.add(Money.of((await staff.get(`/admin/clients/${merchant.id}/wallet`)).body.available));
    }
    expect(available.toWire()).toBe('10000.0000');
  });

  it('judges two raises of one staff member at once one after the other', async () => {
    const [a, b] = await merchants(2);
    const staff = await adminWith(t, ['wallet:credit_limit']);
    const answers = await Promise.all([raise(staff, a!.id, '6000.0000'), raise(staff, b!.id, '6000.0000')]);
    expect(answers.map((res) => res.status).sort()).toEqual([200, 403]);
    const limits = [await limitOf(a!.id), await limitOf(b!.id)].sort();
    expect(limits).toEqual(['0.0000', '6000.0000']);
  });

  it('judges a raise and a credit adjustment of one staff member at once one after the other', async () => {
    const [a, b] = await merchants(2);
    const staff = await adminWith(t, ['wallet:credit_limit', 'wallet:adjust']);
    const [raised, credited] = await Promise.all([raise(staff, a!.id, '6000.0000'), credit(staff, b!.id, '6000.0000')]);
    expect([raised.status, credited.status].filter((status) => status === 200)).toHaveLength(1);
    expect(raised.status === 200 ? credited.body.code : raised.body.code).toBe(
      raised.status === 200 ? 'APPROVAL_REQUIRED' : 'FORBIDDEN',
    );
  });
});

describe('POST /admin/clients: a credit limit at an invitation in the same sum', () => {
  async function creditGroups() {
    const { db } = await testDb();
    await insertUsd(db);
    const [standard, vip] = await db
      .insert(s.clientGroups)
      .values([
        { name: 'Standard', isDefault: true },
        { name: 'VIP', overdraftAllowed: true },
      ])
      .returning({ id: s.clientGroups.id });
    return { standard: standard!.id, vip: vip!.id };
  }
  const invite = (
    staff: AdminApi,
    groupId: number,
    creditLimit: string,
    email = `${crypto.randomUUID()}@example.com`,
  ) =>
    staff.post('/admin/clients', { name: 'Zain Mobile Hub', email, country: 'JO', invite: true, groupId, creditLimit });
  const invited = async (email: string) => {
    const { db } = await testDb();
    return db.select().from(s.clients).where(eq(s.clients.email, email));
  };

  it('counts the limit of a new merchant with later raises, invitations and credits', async () => {
    const { vip } = await creditGroups();
    const [existing] = await merchants(1);
    const staff = await adminWith(t, ['clients:create', 'wallet:credit_limit', 'wallet:adjust', 'groups:update']);
    expect((await invite(staff, vip, '6000.0000')).status).toBe(201);
    expect((await raise(staff, existing!.id, '4000.0000')).status).toBe(200);
    const refused = await invite(staff, vip, '0.0001', 'second@example.com');
    expect(refused.status).toBe(403);
    expect(refused.body).toMatchObject({ code: 'FORBIDDEN', detail: SUM_DETAIL });
    expect(await invited('second@example.com')).toHaveLength(0);
    expect((await credit(staff, existing!.id, '0.0001')).body.code).toBe('APPROVAL_REQUIRED');
    // An invitation without credit is not judged.
    expect((await invite(staff, vip, '0.0000')).status).toBe(201);
  });

  it('judges two invitations of one staff member at once one after the other', async () => {
    const { vip } = await creditGroups();
    const staff = await adminWith(t, ['clients:create', 'wallet:credit_limit', 'groups:update']);
    const answers = await Promise.all([invite(staff, vip, '6000.0000'), invite(staff, vip, '6000.0000')]);
    expect(answers.map((res) => res.status).sort()).toEqual([201, 403]);
  });

  it('does not limit an owner', async () => {
    const { vip } = await creditGroups();
    const owner = await adminWith(t, ['*']);
    expect((await invite(owner, vip, '10000.0000')).status).toBe(201);
    expect((await invite(owner, vip, '10000.0000')).status).toBe(201);
  });
});
