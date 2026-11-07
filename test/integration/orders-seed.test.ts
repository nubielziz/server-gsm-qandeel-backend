// The orders seed (feature 5): the demo's merchant orders appear with the ids, states, queues, review reasons and timelines of the frontend
// mock, through the real API, linked to the holds and settlements the money seed already posted (the seed posts nothing for orders).
import { afterAll, beforeAll, describe, expect, it, setDefaultTimeout } from 'bun:test';
import { existsSync } from 'node:fs';
import { and, eq, like, not, sql } from 'drizzle-orm';
import { loadDemoState, demoStatePath } from '../../scripts/seed/demo-state';
import { runSeed } from '../../scripts/seed/run';
import { seedOrders } from '../../scripts/seed/orders';
import { schema as s } from '../../src/infra/db';
import { MerchantSpend } from '../../src/modules/money';
import { type AdminApi, adminWith } from '../support/admin-api';
import { type TestApp, createTestApp } from '../support/app';
import { clearIdentityCaches } from '../support/auth';
import { closeTestDb, resetDb, testDb } from '../support/db';
import { ledgerTotals } from '../support/money';
import { insertOrderRow, ledgerOf, orderRow, walletOf } from '../support/orders';

setDefaultTimeout(180_000);

const frontendPresent = existsSync(demoStatePath());
let t: TestApp;
let staff: AdminApi;

beforeAll(async () => {
  if (!frontendPresent) return;
  t = await createTestApp();
  await resetDb();
  await clearIdentityCaches(t);
  const { db } = await testDb();
  await runSeed(db, await loadDemoState(), t.config);
  staff = await adminWith(t, ['orders:*', 'clients:*', 'wallet:*', 'files:read']);
});
afterAll(async () => {
  if (!frontendPresent) return;
  await resetDb();
  await clearIdentityCaches(t);
  await t.close();
  await closeTestDb();
});

describe.skipIf(!frontendPresent)('the orders seed', () => {
  it("writes the demo's 760 merchant orders by their demo ids and leaves the storefront orders for 14b and 16", async () => {
    const { db } = await testDb();
    const rows = await db.select().from(s.orders).orderBy(s.orders.id);
    expect(rows).toHaveLength(760);
    expect(rows.map((row) => row.id)).toEqual([...new Set(rows.map((row) => row.id))].sort((a, b) => a - b));
    expect(rows.find((row) => row.id === 48100)).toMatchObject({
      clientId: 3,
      serviceId: 25,
      type: 'file',
      source: 'dhru',
      status: 'completed',
      dispatchState: 'done',
      imei: 'SM-S911B',
      unitPrice: '3.3100',
      totalPrice: '3.3100',
      unitCost: '2.4000',
      totalCost: '2.4000',
      currency: 'USD',
      resultCode: 'File delivered: SMS911B.zip (0.9 MB).',
      // The supplier of the demo order (FileForge, seeded by feature 6); the demo has no supplier order number, so these two stay null.
      supplierId: 5,
      supplierServiceId: null,
      supplierRef: null,
    });
    expect(rows.every((row) => row.clientId !== null && row.customerId === null)).toBe(true);
    expect(rows.every((row) => row.placedAt.getTime() === row.createdAt.getTime())).toBe(true);
    const counts = await db.execute<{ status: string; n: number }>(
      sql`select status, count(*)::int as n from orders group by 1 order by 1`,
    );
    expect(counts.rows).toEqual([
      { status: 'completed', n: 680 },
      { status: 'pending', n: 6 },
      { status: 'processing', n: 30 },
      { status: 'rejected', n: 44 },
    ]);
  });

  it('shows the queues of the console: one manual order, two verification requests, the supplier problems, the queued ones', async () => {
    const queue = async (name: string) => (await staff.get(`/admin/orders?queue=${name}&_end=100`)).total;
    expect(await queue('manual')).toBe(1);
    expect(await queue('verification')).toBe(2);
    expect(await queue('needs_attention')).toBe(8);
    expect(await queue('pending')).toBe(5);
    expect(await queue('review')).toBe(0);
    const manual = (await staff.get('/admin/orders?queue=manual')).body[0];
    expect(manual).toMatchObject({
      status: 'pending',
      dispatchState: 'manual',
      reviewReason: 'Manual service: operator dispatch required',
      attempts: 0,
      supplier: null,
    });
    const verifying = (await staff.get('/admin/orders?queue=verification')).body;
    expect(verifying.map((order: { verificationStatus: string }) => order.verificationStatus)).toEqual([
      'requested',
      'requested',
    ]);
    expect(verifying[0].reviewReason).toBe('The merchant asked for the result to be checked');
    const attention = (await staff.get('/admin/orders?queue=needs_attention&_end=100')).body as Array<{
      reviewReason: string;
      attempts: number;
    }>;
    expect(attention.every((order) => order.reviewReason.length > 0 && order.attempts >= 1)).toBe(true);
  });

  it('gives the timeline of an order with its actors, and the pricing snapshot the mock builds', async () => {
    const shown = await staff.get('/admin/orders/48100');
    expect(shown.body).toMatchObject({
      client: { id: 3, name: 'Phone Doctor FZE' },
      service: { id: 25, name: 'Xiaomi EDL Auth File', type: 'file', category: 'Files' },
      attempts: 1,
      pricingSnapshot: { source: 'base', price: '3.3100', floor: '2.5400', fx: 1, taxRate: 0 },
    });
    expect(shown.body.pricingSnapshot.steps.map((step: { id: string }) => step.id)).toEqual([
      'client',
      'group',
      'base',
    ]);
    const events = (await staff.get('/admin/orders/48100/events')).body as Array<{
      type: string;
      actor: { type: string; name: string | null };
      data: { message: string };
    }>;
    expect(events.map((event) => event.type)).toEqual(['created', 'hold', 'dispatch', 'ack', 'completed', 'settle']);
    expect(events[0]).toMatchObject({
      actor: { type: 'client', name: 'Phone Doctor FZE' },
      data: { message: 'Order received via Dhru API' },
    });
    expect(events[1]!.actor.type).toBe('system');
    expect(events[5]!.data).toMatchObject({
      message: 'Settled: revenue $3.31, cost $2.40',
      revenue: '3.3100',
      cost: '2.4000',
    });
  });

  it("links the orders to the ledger the money seed posted: every merchant's hold equals its open orders, and nothing was posted", async () => {
    const { db } = await testDb();
    const holds = await db.execute<{ owner: string; hold: string; open: string }>(sql`
      select a.owner_id as owner, a.balance as hold,
             coalesce((select sum(o.total_price) from orders o where o.client_id = a.owner_id and o.status in ('pending','processing')), 0)::numeric(18,4)::text as open
      from ledger_accounts a where a.kind = 'client_hold'`);
    expect(holds.rows).toHaveLength(20);
    for (const row of holds.rows) expect(row.hold).toBe(row.open);
    // Every ledger transaction came from the demo's journals (`seed:` keys): the orders seed added none.
    const foreign = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(s.ledgerTransactions)
      .where(not(like(s.ledgerTransactions.idempotencyKey, 'seed:%')));
    expect(foreign[0]!.n).toBe(0);
    // A completed order has its settlement under the order reference.
    expect((await ledgerOf(db, 48100)).map((entry) => entry.kind)).toEqual(['order_hold', 'order_settle']);
    expect((await ledgerTotals(db)).sum).toBe('0.0000');
  });

  it('lets staff reopen and refund a seeded order: the reversal finds the demo settlement and the merchant spend follows', async () => {
    const { db } = await testDb();
    const before = await walletOf(db, 3);
    const spend = async () => (await t.app.get(MerchantSpend).completedSpend(db, [3])).get(3)!.toWire();
    const spendBefore = Number(await spend());
    expect((await staff.post('/admin/orders/48100/reopen', { reason: 'Check again' })).status).toBe(204);
    const [settle] = await db
      .select({ id: s.ledgerTransactions.id })
      .from(s.ledgerTransactions)
      .where(
        and(
          eq(s.ledgerTransactions.refType, 'order'),
          eq(s.ledgerTransactions.refId, 48100),
          eq(s.ledgerTransactions.kind, 'order_settle'),
        ),
      );
    expect((await ledgerOf(db, 48100)).at(-1)).toEqual({ kind: 'adjustment', key: `reverse:${settle!.id}` });
    expect(Number(await spend())).toBeCloseTo(spendBefore - 3.31, 4);
    expect((await walletOf(db, 3)).hold).toBe((Number(before.hold) + 3.31).toFixed(4));
    // Completing it again settles under a numbered key; the demo order had one completion already.
    expect((await staff.post('/admin/orders/48100/reply', { code: 'Delivered again' })).status).toBe(204);
    expect((await ledgerOf(db, 48100)).at(-1)).toEqual({ kind: 'order_settle', key: 'order:48100:settle:2' });
    expect(Number(await spend())).toBeCloseTo(spendBefore, 4);
    // A refund of another completed order sends the money back to the wallet.
    expect((await staff.post('/admin/orders/48101/refund', { reason: 'Charged twice' })).status).toBe(204);
    expect((await orderRow(db, 48101)).status).toBe('rejected');
    expect((await ledgerTotals(db)).sum).toBe('0.0000');
  });

  it("feeds the merchant list's 30-day figures from the seeded orders", async () => {
    const { db } = await testDb();
    const list = await staff.get('/admin/clients?_end=100');
    const phoneDoctor = list.body.find((client: { id: number }) => client.id === 3);
    const expected = await db.execute<{ orders: number; spend: string; completed: number; rejected: number }>(sql`
      select count(*)::int as orders,
             coalesce(sum(total_price) filter (where status <> 'rejected'), 0)::numeric(18,4)::text as spend,
             (count(*) filter (where status = 'completed'))::int as completed,
             (count(*) filter (where status = 'rejected'))::int as rejected
      from orders where client_id = 3 and created_at >= now() - interval '30 days'`);
    const row = expected.rows[0]!;
    expect(phoneDoctor.stats.orders).toBe(row.orders);
    expect(phoneDoctor.stats.orders).toBeGreaterThan(0);
    expect(phoneDoctor.stats.spend).toBe(row.spend);
    const finished = row.completed + row.rejected;
    expect(phoneDoctor.stats.successRate).toBeCloseTo((row.completed / finished) * 100, 6);
    expect(phoneDoctor.stats.lastOrderAt).toMatch(/Z$/);
  });

  it('is idempotent, and the next order gets an id after the demo ids', async () => {
    const { db } = await testDb();
    const demo = await loadDemoState();
    const again = await db.transaction((tx) => seedOrders(tx, demo, t.config));
    expect(again).toEqual([
      { table: 'orders', inserted: 0, existing: 760 },
      { table: 'order_events', inserted: 0, existing: 0 },
    ]);
    const [{ n }] = (await db.select({ n: sql<number>`count(*)::int` }).from(s.orderEvents)) as [{ n: number }];
    expect(n).toBeGreaterThan(4000);
    const fresh = await insertOrderRow(db, { clientId: 3, serviceId: 1, imei: '490154203237518' });
    expect(fresh.id).toBeGreaterThan(48859);
  });
});
