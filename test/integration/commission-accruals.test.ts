// The commission accrual routes of feature 11 (RULES commissions 1 to 3, resolutions health-commissions-3, -4 and -11, ANSWERS commissions
// Q1, Q2, Q4 and Q7): the list with its filters and sorts, one accrual, and the bulk approval that pays each agent with one `commission`
// posting, skips what cannot be paid with the reasons of the console, and audits what it did.
import { afterAll, beforeAll, beforeEach, describe, expect, it, spyOn } from 'bun:test';
import { eq } from 'drizzle-orm';
import { schema as s } from '../../src/infra/db';
import { LedgerPoster } from '../../src/modules/money';
import { type AdminApi, adminWith } from '../support/admin-api';
import { type TestApp, createTestApp } from '../support/app';
import { clearIdentityCaches } from '../support/auth';
import { TestClock } from '../support/clock';
import { type CommissionsWorld, commissionsWorld, insertAccrual, ledgerRowsOf } from '../support/commissions';
import { closeTestDb, resetDb, testDb } from '../support/db';
import { ledgerTotals } from '../support/money';
import { insertOrderRow, systemBalance, walletOf } from '../support/orders';

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
  staff = await adminWith(t, ['commissions:*'], { name: 'Omar T.' });
});
afterAll(async () => {
  await resetDb();
  await clearIdentityCaches(t);
  await t.close();
  await closeTestDb();
});

const day = (iso: string) => new Date(`${iso}T12:00:00.000Z`);

/** An order of the merchant (or the other one) to hang an accrual on. */
const orderFor = (clientId: number) =>
  insertOrderRow(world.db, { clientId, serviceId: world.auto.serviceId, status: 'completed' });

/** Three accruals of the agent (accrued, approved, reversed), one of the partner, in October. */
async function seedAccruals() {
  const { db, agent, partner, plans, merchant, other } = world;
  const o1 = await orderFor(merchant.id);
  const o2 = await orderFor(merchant.id);
  const o3 = await orderFor(merchant.id);
  const o4 = await orderFor(other.id);
  const ready = await insertAccrual(db, {
    beneficiaryId: agent.id,
    planId: plans.referral,
    orderId: o1.id,
    amount: '0.4900',
    basisAmount: '16.2600',
    createdAt: day('2026-10-03'),
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
  const reversed = await insertAccrual(db, {
    beneficiaryId: agent.id,
    planId: plans.referral,
    orderId: o3.id,
    amount: '0.9000',
    basisAmount: '30.0000',
    status: 'reversed',
    createdAt: day('2026-09-28'),
  });
  const theirs = await insertAccrual(db, {
    beneficiaryId: partner.id,
    planId: plans.partner,
    orderId: o4.id,
    amount: '0.3500',
    basisAmount: '6.9600',
    percent: '5.0000',
    createdAt: day('2026-10-05'),
  });
  return { ready, paid, reversed, theirs, orders: { o1, o2, o3, o4 } };
}

describe('GET /admin/commission-accruals', () => {
  it('lists newest first with the agent and the referred merchant joined, and counts with x-total-count', async () => {
    const { ready, paid, reversed, theirs } = await seedAccruals();
    const res = await staff.get('/admin/commission-accruals?_start=0&_end=25&_sort=createdAt&_order=desc');
    expect(res.status).toBe(200);
    expect(res.total).toBe(4);
    expect(res.body.map((row: { id: number }) => row.id)).toEqual([theirs.id, ready.id, paid.id, reversed.id]);
    expect(res.body[1]).toMatchObject({
      id: ready.id,
      planId: world.plans.referral,
      beneficiaryId: world.agent.id,
      period: '2026-10',
      basisAmount: '16.2600',
      percent: '3.0000',
      amount: '0.4900',
      status: 'accrued',
      ledgerTxId: null,
      approvedAt: null,
      reversedAt: null,
      beneficiary: { id: world.agent.id, name: 'Zain Mobile Hub' },
      merchant: { id: world.merchant.id, name: 'Cairo GSM Lab' },
    });
    expect(res.body[1].orderId).toBeGreaterThan(0);
    expect(res.body[2]).toMatchObject({ status: 'approved', approvedAt: '2026-10-10T12:00:00.000Z' });
    expect(res.body[3]).toMatchObject({ status: 'reversed', reversedAt: '2026-09-28T12:00:00.000Z' });
    expect(res.body[0].merchant).toEqual({ id: world.other.id, name: 'Erbil Mobile Parts' });
  });

  it('filters by status (the tab opens on accrued), by agent and by the 30-day window of the strip', async () => {
    const { ready, paid, theirs } = await seedAccruals();
    const ids = async (query: string) =>
      (await staff.get(`/admin/commission-accruals?${query}&_sort=id&_order=asc`)).body.map(
        (row: { id: number }) => row.id,
      );
    expect(await ids('status=accrued')).toEqual([ready.id, theirs.id]);
    expect(await ids('status=approved')).toEqual([paid.id]);
    expect(await ids('status=reversed')).toHaveLength(1);
    expect(await ids('status_ne=accrued')).toHaveLength(2);
    expect(await ids(`status=accrued&beneficiaryId=${world.agent.id}`)).toEqual([ready.id]);
    expect(await ids('createdAt_gte=2026-10-04T00:00:00.000Z')).toEqual([theirs.id]);
    expect(await ids('createdAt_gte=2026-10-02T00:00:00.000Z&createdAt_lte=2026-10-03T23:59:59.999Z')).toEqual([
      ready.id,
      paid.id,
    ]);
    expect(await ids('period=2026-09')).toHaveLength(1);
  });

  it('filters and counts approvals by approvedAt, which the header strip reads', async () => {
    const { paid } = await seedAccruals();
    const count = (query: string) => staff.get(`/admin/commission-accruals?${query}&_start=0&_end=1`);
    expect((await count('status=approved&approvedAt_gte=2026-10-09T00:00:00.000Z')).total).toBe(1);
    expect((await count('status=approved&approvedAt_gte=2026-10-11T00:00:00.000Z')).total).toBe(0);
    expect(
      (await count('approvedAt_lte=2026-10-10T23:59:59.999Z&approvedAt_gte=2026-10-10T00:00:00.000Z')).body[0].id,
    ).toBe(paid.id);
  });

  it('sorts by amount, basis, rate, status and approval time (nulls last), and refuses a sort that is not whitelisted', async () => {
    const { ready, paid, reversed, theirs } = await seedAccruals();
    const order = async (sort: string, dir = 'asc') =>
      (await staff.get(`/admin/commission-accruals?_sort=${sort}&_order=${dir}`)).body.map(
        (row: { id: number }) => row.id,
      );
    expect(await order('amount')).toEqual([paid.id, theirs.id, ready.id, reversed.id]);
    expect(await order('basisAmount', 'desc')).toEqual([reversed.id, ready.id, theirs.id, paid.id]);
    expect((await order('percent', 'desc'))[0]).toBe(theirs.id);
    const byApproval = await order('approvedAt', 'desc');
    // Approved first; the accruals that were never approved come last, in either direction.
    expect(byApproval[0]).toBe(paid.id);
    expect(new Set(byApproval.slice(1))).toEqual(new Set([ready.id, reversed.id, theirs.id]));
    expect((await order('approvedAt', 'asc')).at(0)).toBe(paid.id);
    expect((await staff.get('/admin/commission-accruals?_sort=beneficiary')).status).toBe(422);
  });

  it('pages and is refused without commissions:read', async () => {
    await seedAccruals();
    const page = await staff.get('/admin/commission-accruals?_start=2&_end=4');
    expect(page.body).toHaveLength(2);
    expect(page.total).toBe(4);
    const other = await adminWith(t, ['orders:read']);
    expect((await other.get('/admin/commission-accruals')).status).toBe(403);
  });
});

describe('GET /admin/commission-accruals/:id', () => {
  it('shows one accrual with its order, merchant and approval time, and answers 404 for an unknown one', async () => {
    const { paid, orders } = await seedAccruals();
    const res = await staff.get(`/admin/commission-accruals/${paid.id}`);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      id: paid.id,
      orderId: orders.o2.id,
      status: 'approved',
      approvedAt: '2026-10-10T12:00:00.000Z',
      merchant: { name: 'Cairo GSM Lab' },
    });
    expect((await staff.get('/admin/commission-accruals/99999')).status).toBe(404);
  });
});

describe('POST /admin/commission-accruals/approve', () => {
  /** Two accrued accruals of the agent and one of the partner. */
  async function readyAccruals() {
    const { db, agent, partner, plans, merchant, other } = world;
    const a = await insertAccrual(db, {
      beneficiaryId: agent.id,
      planId: plans.referral,
      orderId: (await orderFor(merchant.id)).id,
      amount: '0.4900',
      createdAt: day('2026-10-03'),
    });
    const b = await insertAccrual(db, {
      beneficiaryId: agent.id,
      planId: plans.referral,
      orderId: (await orderFor(merchant.id)).id,
      amount: '0.1700',
      createdAt: day('2026-10-04'),
    });
    const c = await insertAccrual(db, {
      beneficiaryId: partner.id,
      planId: plans.partner,
      orderId: (await orderFor(other.id)).id,
      amount: '0.3500',
      createdAt: day('2026-10-05'),
    });
    return { a, b, c };
  }

  it('pays each agent with one commission posting for the sum, marks the accruals approved and answers the count and the money posted', async () => {
    const { db, agent, partner } = world;
    const { a, b, c } = await readyAccruals();
    clock.set('2026-11-05T10:00:00.000Z');
    // Two hours later the first session has expired: sign in again.
    staff = await adminWith(t, ['commissions:*'], { name: 'Omar T.' });
    const res = await staff.post('/admin/commission-accruals/approve', { ids: [c.id, b.id, a.id] });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ approved: 3, total: '1.0100', skipped: [] });

    const postings = await ledgerRowsOf(db, 'commission', 'accrual');
    expect(postings).toHaveLength(2);
    expect(postings).toMatchObject([
      {
        key: `commission:${agent.id}:${a.id}`,
        refId: a.id,
        memo: 'Commission batch, 2 accruals to Zain Mobile Hub',
        createdByType: 'staff',
        createdById: staff.staffId,
      },
      { key: `commission:${partner.id}:${c.id}`, refId: c.id, memo: 'Commission batch, 1 accrual to Atlas Partners' },
    ]);
    expect(await walletOf(db, agent.id)).toEqual({ wallet: '0.6600', hold: '0.0000' });
    expect(await walletOf(db, partner.id)).toEqual({ wallet: '0.3500', hold: '0.0000' });
    expect(await systemBalance(db, 'commission_expense')).toBe('1.0100');
    expect((await ledgerTotals(db)).sum).toBe('0.0000');

    const rows = await db.select().from(s.commissionAccruals).orderBy(s.commissionAccruals.id);
    expect(rows.map((row) => [row.status, row.ledgerTxId, row.approvedAt?.toISOString()])).toEqual([
      ['approved', postings[0]!.id, '2026-11-05T10:00:00.000Z'],
      ['approved', postings[0]!.id, '2026-11-05T10:00:00.000Z'],
      ['approved', postings[1]!.id, '2026-11-05T10:00:00.000Z'],
    ]);
  });

  it('audits each agent paid with the demo phrase and the count and amount', async () => {
    const { db } = world;
    const { a, b, c } = await readyAccruals();
    await staff.post('/admin/commission-accruals/approve', { ids: [a.id, b.id, c.id] });
    const rows = (await db.select().from(s.auditLogs).orderBy(s.auditLogs.id)).filter(
      (row) => row.action === 'approved commissions for',
    );
    expect(rows.map((row) => [row.entityType, row.entityLabel, row.actorName])).toEqual([
      ['merchant', 'Zain Mobile Hub, 2 accruals, $0.66', 'Omar T.'],
      ['merchant', 'Atlas Partners, 1 accrual, $0.35', 'Omar T.'],
    ]);
    expect(rows[0]).toMatchObject({ entityId: world.agent.id, before: { status: 'accrued' } });
    expect(rows[0]!.after).toMatchObject({ status: 'approved', amount: '0.6600', accrualIds: [a.id, b.id] });
  });

  it('skips, with the reasons of the console, an unknown id, an approved accrual and a reversed one, and pays the rest', async () => {
    const { db, agent, plans, merchant } = world;
    const { a } = await readyAccruals();
    const paid = await insertAccrual(db, {
      beneficiaryId: agent.id,
      planId: plans.referral,
      orderId: (await orderFor(merchant.id)).id,
      status: 'approved',
    });
    const reversed = await insertAccrual(db, {
      beneficiaryId: agent.id,
      planId: plans.referral,
      orderId: (await orderFor(merchant.id)).id,
      status: 'reversed',
    });
    const res = await staff.post('/admin/commission-accruals/approve', { ids: [reversed.id, 99999, paid.id, a.id] });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      approved: 1,
      total: '0.4900',
      skipped: [
        { id: reversed.id, reason: 'Reversed: the order was refunded or reopened.' },
        { id: 99999, reason: 'This accrual does not exist.' },
        { id: paid.id, reason: 'Already approved.' },
      ],
    });
    expect(await walletOf(db, agent.id)).toEqual({ wallet: '0.4900', hold: '0.0000' });
  });

  it('is audited even when nothing was paid, and posts nothing', async () => {
    const { db } = world;
    const res = await staff.post('/admin/commission-accruals/approve', { ids: [99998, 99999] });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      approved: 0,
      total: '0.0000',
      skipped: [
        { id: 99998, reason: 'This accrual does not exist.' },
        { id: 99999, reason: 'This accrual does not exist.' },
      ],
    });
    expect(await ledgerRowsOf(db, 'commission', 'accrual')).toEqual([]);
    const audit = (await db.select().from(s.auditLogs)).find((row) => row.action === 'approved commissions for');
    expect(audit).toMatchObject({ entityLabel: 'no agents (2 accruals skipped)', actorType: 'staff' });
  });

  it('answers 422 on ids when the list is empty, too long, not an array or holds a bad id', async () => {
    const field = async (ids: unknown) => {
      const res = await staff.post('/admin/commission-accruals/approve', { ids });
      expect(res.status).toBe(422);
      return res.body.errors.map((error: { field: string }) => error.field.split('.')[0]);
    };
    expect(await field([])).toContain('ids');
    expect(await field(Array.from({ length: 1001 }, (_, index) => index + 1))).toContain('ids');
    expect(await field('1,2')).toContain('ids');
    expect(await field([0])).toContain('ids');
    expect(await field([1, 'x'])).toContain('ids');
    expect((await staff.post('/admin/commission-accruals/approve', {})).status).toBe(422);
  });

  it('takes 1000 ids at most and counts a repeated id once', async () => {
    const { db } = world;
    const { a } = await readyAccruals();
    const res = await staff.post('/admin/commission-accruals/approve', { ids: [a.id, a.id, a.id] });
    expect(res.body).toEqual({ approved: 1, total: '0.4900', skipped: [] });
    expect(await ledgerRowsOf(db, 'commission', 'accrual')).toHaveLength(1);
  });

  it('pays an accrual once: asking again skips it as already approved and posts nothing more', async () => {
    const { db, agent } = world;
    const { a, b } = await readyAccruals();
    await staff.post('/admin/commission-accruals/approve', { ids: [a.id, b.id] });
    const again = await staff.post('/admin/commission-accruals/approve', { ids: [a.id, b.id] });
    expect(again.body).toEqual({
      approved: 0,
      total: '0.0000',
      skipped: [
        { id: a.id, reason: 'Already approved.' },
        { id: b.id, reason: 'Already approved.' },
      ],
    });
    expect(await ledgerRowsOf(db, 'commission', 'accrual')).toHaveLength(1);
    expect(await walletOf(db, agent.id)).toEqual({ wallet: '0.6600', hold: '0.0000' });
  });

  it('never pays twice when two approvals of the same accruals race', async () => {
    const { db, agent } = world;
    const { a, b } = await readyAccruals();
    const [first, second] = await Promise.all([
      staff.post('/admin/commission-accruals/approve', { ids: [a.id, b.id] }),
      staff.post('/admin/commission-accruals/approve', { ids: [b.id, a.id] }),
    ]);
    expect([first.body.approved, second.body.approved].sort()).toEqual([0, 2]);
    expect(await ledgerRowsOf(db, 'commission', 'accrual')).toHaveLength(1);
    expect(await walletOf(db, agent.id)).toEqual({ wallet: '0.6600', hold: '0.0000' });
    expect((await ledgerTotals(db)).sum).toBe('0.0000');
  });

  it('is refused without commissions:approve, and a role that only reads or edits cannot pay', async () => {
    const { a } = await readyAccruals();
    const reader = await adminWith(t, ['commissions:read', 'commissions:update']);
    expect((await reader.post('/admin/commission-accruals/approve', { ids: [a.id] })).status).toBe(403);
    const approver = await adminWith(t, ['commissions:approve']);
    expect((await approver.post('/admin/commission-accruals/approve', { ids: [a.id] })).status).toBe(200);
  });

  it('skips an accrual of 0 with a reason, leaves it accrued, and still pays the rest of the agent (a zero row never blocks an approval)', async () => {
    const { db, agent } = world;
    const { a, b } = await readyAccruals();
    const zero = await insertAccrual(db, {
      beneficiaryId: agent.id,
      planId: world.plans.referral,
      orderId: (await orderFor(world.merchant.id)).id,
      amount: '0.0000',
    });
    const other = await insertAccrual(db, {
      beneficiaryId: world.partner.id,
      planId: world.plans.partner,
      orderId: (await orderFor(world.other.id)).id,
      amount: '0.0000',
    });
    const res = await staff.post('/admin/commission-accruals/approve', { ids: [a.id, zero.id, b.id, other.id] });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      approved: 2,
      total: '0.6600',
      skipped: [
        { id: zero.id, reason: 'Nothing to pay: the amount is 0.' },
        { id: other.id, reason: 'Nothing to pay: the amount is 0.' },
      ],
    });
    expect(await walletOf(db, agent.id)).toEqual({ wallet: '0.6600', hold: '0.0000' });
    // One posting for the agent; the partner has only a zero row, so nothing is posted for it.
    expect(await ledgerRowsOf(db, 'commission', 'accrual')).toHaveLength(1);
    for (const row of [zero, other]) {
      const [stored] = await db.select().from(s.commissionAccruals).where(eq(s.commissionAccruals.id, row.id));
      expect(stored).toMatchObject({ status: 'accrued', ledgerTxId: null, approvedAt: null, amount: '0.0000' });
    }
    expect((await ledgerTotals(db)).sum).toBe('0.0000');
    // Asked again, the zero rows are still skipped with the same reason and nothing else happens.
    const again = await staff.post('/admin/commission-accruals/approve', { ids: [zero.id] });
    expect(again.body).toEqual({
      approved: 0,
      total: '0.0000',
      skipped: [{ id: zero.id, reason: 'Nothing to pay: the amount is 0.' }],
    });
  });

  it('leaves everything as it was when a posting fails (one transaction)', async () => {
    const { db } = world;
    const { a } = await readyAccruals();
    const partnerAccrual = await insertAccrual(db, {
      beneficiaryId: world.partner.id,
      planId: world.plans.partner,
      orderId: (await orderFor(world.other.id)).id,
      amount: '0.3500',
    });
    // The agent is posted first and the partner second; the second posting fails, after the first one was already written.
    const post = LedgerPoster.prototype.post;
    let calls = 0;
    const spy = spyOn(LedgerPoster.prototype, 'post').mockImplementation(async function (
      this: LedgerPoster,
      ...args: Parameters<LedgerPoster['post']>
    ) {
      calls += 1;
      if (calls === 2) throw new Error('the ledger is down');
      return post.apply(this, args);
    });
    try {
      const res = await staff.post('/admin/commission-accruals/approve', { ids: [a.id, partnerAccrual.id] });
      expect(res.status).toBe(500);
    } finally {
      spy.mockRestore();
    }
    expect(calls).toBe(2);
    for (const id of [a.id, partnerAccrual.id]) {
      const [row] = await db.select().from(s.commissionAccruals).where(eq(s.commissionAccruals.id, id));
      expect(row).toMatchObject({ status: 'accrued', ledgerTxId: null, approvedAt: null });
    }
    expect(await ledgerRowsOf(db, 'commission', 'accrual')).toEqual([]);
    expect(await walletOf(db, world.agent.id)).toEqual({ wallet: '0.0000', hold: '0.0000' });
  });
});
