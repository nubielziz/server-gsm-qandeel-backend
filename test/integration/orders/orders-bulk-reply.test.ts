// Integration tests of the bulk reply (feature 5): POST /admin/orders/bulk-reply/preview matches pasted `IMEI CODE` lines to orders
// (whitespace-insensitive, non-empty inputs only) and POST /admin/orders/bulk-reply/apply completes up to 500 orders, each through the
// same reply transition, reporting a refused item instead of failing the call.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import { eq } from 'drizzle-orm';
import { schema as s } from '@src/infra/db';
import { type AdminApi, adminWith } from '../../support/admin-api';
import { type TestApp, createTestApp } from '../../support/app';
import { clearIdentityCaches } from '../../support/auth';
import { insertService } from '../../support/catalog';
import { DAY, TestClock } from '../../support/clock';
import { closeTestDb, resetDb, testDb } from '../../support/db';
import { ledgerTotals } from '../../support/money';
import {
  IMEIS,
  auditOf,
  insertOrderRow,
  json,
  ledgerOf,
  type OrdersWorld,
  orderRow,
  ordersWorld,
  portalFor,
  systemBalance,
  walletOf,
} from '../../support/orders';
import { insertCustomer } from '../../support/support';

const clock = new TestClock();
let t: TestApp;
let world: OrdersWorld;
let staff: AdminApi;

beforeAll(async () => {
  t = await createTestApp({ clock });
});
beforeEach(async () => {
  await resetDb();
  await clearIdentityCaches(t);
  world = await ordersWorld((await testDb()).db);
  staff = await adminWith(t, ['orders:*'], { name: 'Lina S.' });
});
afterAll(async () => {
  await resetDb();
  await clearIdentityCaches(t);
  await t.close();
  await closeTestDb();
});

async function place(serviceId: number, imei: string): Promise<number> {
  const res = await (await portalFor(t, world.merchant.id)).post('/client/orders', { serviceId, imei });
  expect(res.statusCode).toBe(201);
  return json(res).orders[0].id as number;
}

describe('POST /admin/orders/bulk-reply/preview', () => {
  it('matches each line to its order and says why a line does not match', async () => {
    const { db, auto, manual, merchant } = world;
    const open = await place(auto.serviceId, IMEIS[0]);
    const closed = await place(auto.serviceId, IMEIS[1]);
    await staff.post(`/admin/orders/${closed}/reject`, { reason: 'No' });
    // Two open orders with the same input are ambiguous: staff must pick one.
    await db.update(s.services).set({ duplicateRule: 'allow' }).where(eq(s.services.id, manual.serviceId));
    const first = await place(manual.serviceId, IMEIS[2]);
    const second = await place(manual.serviceId, IMEIS[2]);
    const auditBefore = (await db.select().from(s.auditLogs)).length;
    const text = [
      `${IMEIS[0]} Unlocked: code 1`,
      '',
      `${IMEIS[1]},Unlocked 2`,
      `${IMEIS[2]};code 3`,
      '352905112490861',
      '999999999999991 code 4',
      `  ${IMEIS[0]}\t  trimmed code  `,
    ].join('\r\n');
    const res = await staff.post('/admin/orders/bulk-reply/preview', { text });
    expect(res.status).toBe(200);
    // A matched line names the buyer account and the service of the order it completes; other lines name none.
    const target = {
      account: { id: merchant.id, name: 'Cairo GSM Lab' },
      service: { id: auto.serviceId, name: 'AT&T USA Premier Unlock' },
    };
    const none = { account: null, service: null };
    expect(res.body.lines).toEqual([
      {
        line: 1,
        raw: `${IMEIS[0]} Unlocked: code 1`,
        imei: IMEIS[0],
        code: 'Unlocked: code 1',
        orderId: open,
        status: 'matched',
        ...target,
      },
      {
        line: 3,
        raw: `${IMEIS[1]},Unlocked 2`,
        imei: IMEIS[1],
        code: 'Unlocked 2',
        orderId: null,
        status: 'not_open',
        ...none,
      },
      {
        line: 4,
        raw: `${IMEIS[2]};code 3`,
        imei: IMEIS[2],
        code: 'code 3',
        orderId: null,
        status: 'ambiguous',
        ...none,
      },
      {
        line: 5,
        raw: '352905112490861',
        imei: '352905112490861',
        code: null,
        orderId: null,
        status: 'invalid',
        ...none,
      },
      {
        line: 6,
        raw: '999999999999991 code 4',
        imei: '999999999999991',
        code: 'code 4',
        orderId: null,
        status: 'not_found',
        ...none,
      },
      {
        line: 7,
        raw: `  ${IMEIS[0]}\t  trimmed code  `,
        imei: IMEIS[0],
        code: 'trimmed code',
        orderId: open,
        status: 'matched',
        ...target,
      },
    ]);
    expect([first, second]).toHaveLength(2);
    // It changes nothing and writes no audit row.
    expect((await orderRow(db, open)).status).toBe('pending');
    expect(await db.select().from(s.auditLogs)).toHaveLength(auditBefore);
  });

  it('ignores the whitespace inside an input on both sides and never matches an empty input', async () => {
    const { db, merchant, manual } = world;
    await insertOrderRow(db, {
      accountId: merchant.id,
      serviceId: manual.serviceId,
      imei: 'SN 566A 15082',
      dispatchState: 'manual',
    });
    const blank = await insertOrderRow(db, {
      accountId: merchant.id,
      serviceId: manual.serviceId,
      imei: null,
      dispatchState: 'manual',
    });
    await insertOrderRow(db, {
      accountId: merchant.id,
      serviceId: manual.serviceId,
      imei: '',
      dispatchState: 'manual',
    });
    const res = await staff.post('/admin/orders/bulk-reply/preview', { text: 'SN566A15082 done\n   done' });
    expect(res.body.lines.map((line: { status: string }) => line.status)).toEqual(['matched', 'invalid']);
    expect(res.body.lines.map((line: { orderId: number | null }) => line.orderId)[1]).toBeNull();
    expect(blank.id).toBeGreaterThan(0);
  });

  it('refuses an empty paste, more than 500 lines and a missing text with 422 on `text`', async () => {
    const empty = await staff.post('/admin/orders/bulk-reply/preview', { text: ' \n \n' });
    expect(empty.status).toBe(422);
    expect(empty.body.errors).toEqual([expect.objectContaining({ field: 'text' })]);
    const many = await staff.post('/admin/orders/bulk-reply/preview', {
      text: Array.from({ length: 501 }, (_, i) => `${i + 1} code`).join('\n'),
    });
    expect(many.status).toBe(422);
    expect(many.body.errors).toEqual([expect.objectContaining({ field: 'text' })]);
    expect((await staff.post('/admin/orders/bulk-reply/preview', {})).status).toBe(422);
    const reader = await adminWith(t, ['orders:read']);
    expect((await reader.post('/admin/orders/bulk-reply/preview', { text: 'a b' })).status).toBe(403);
  });
});

describe('POST /admin/orders/bulk-reply/preview: a line completes only the order it was meant for', () => {
  /** A manual service the merchant may cancel, priced well above the manual service of the world. */
  async function cancellableService(): Promise<number> {
    return insertService(world.db, world.auto.categoryId, {
      name: 'Premium manual unlock',
      fulfillment: 'manual',
      cost: '40.0000',
      effectiveCost: '40.0000',
      basePrice: '50.0000',
      minProfit: '1.0000',
      allowCancel: true,
    });
  }

  async function lineOf(text: string) {
    const res = await staff.post('/admin/orders/bulk-reply/preview', { text });
    expect(res.status).toBe(200);
    return res.body.lines[0];
  }

  const ambiguous = { status: 'ambiguous', orderId: null, account: null, service: null };

  it('is ambiguous when an order of the same merchant for another service was cancelled', async () => {
    const { db, merchant, manual } = world;
    const premium = await cancellableService();
    const cancelled = await (async () => {
      const res = await (
        await portalFor(t, merchant.id)
      ).post('/client/orders', { serviceId: premium, imei: IMEIS[0] });
      expect(res.statusCode).toBe(201);
      return json(res).orders[0].id as number;
    })();
    const other = await place(manual.serviceId, IMEIS[0]);
    expect((await (await portalFor(t, merchant.id)).post(`/client/orders/${cancelled}/cancel`, {})).statusCode).toBe(
      204,
    );

    expect(await lineOf(`${IMEIS[0]} RESULT-1`)).toMatchObject(ambiguous);
    expect((await orderRow(db, other)).status).toBe('pending');
  });

  it('is ambiguous when an order of another merchant with the same input was cancelled or rejected', async () => {
    const { merchant, other, manual, auto } = world;
    const premium = await cancellableService();
    const portalA = await portalFor(t, merchant.id);
    const ofA = json(await portalA.post('/client/orders', { serviceId: premium, imei: IMEIS[1] })).orders[0]
      .id as number;
    const ofB = json(
      await (await portalFor(t, other.id)).post('/client/orders', { serviceId: manual.serviceId, imei: IMEIS[1] }),
    ).orders[0].id as number;
    expect(ofB).toBeGreaterThan(0);
    expect((await portalA.post(`/client/orders/${ofA}/cancel`, {})).statusCode).toBe(204);
    expect(await lineOf(`${IMEIS[1]} RESULT-A`)).toMatchObject(ambiguous);

    // The same service for both merchants: a staff reject of the first order counts as well.
    const rejected = await place(auto.serviceId, IMEIS[2]);
    expect((await staff.post(`/admin/orders/${rejected}/reject`, { reason: 'No' })).status).toBe(204);
    await (await portalFor(t, other.id)).post('/client/orders', { serviceId: auto.serviceId, imei: IMEIS[2] });
    expect(await lineOf(`${IMEIS[2]} RESULT-B`)).toMatchObject(ambiguous);
  });

  it('counts a cancel or a reject for 7 days, and never a completed order of another buyer', async () => {
    const { db, merchant, other, manual } = world;
    const now = clock.now().getTime();
    const openOf = async (imei: string) =>
      (await insertOrderRow(db, { accountId: other.id, serviceId: manual.serviceId, imei, dispatchState: 'manual' }))
        .id;
    const closed = (imei: string, status: 'rejected' | 'completed', ageMs: number) =>
      insertOrderRow(db, {
        accountId: merchant.id,
        serviceId: manual.serviceId,
        imei,
        status,
        dispatchState: 'done',
        completedAt: new Date(now - ageMs),
      });
    await closed(IMEIS[0], 'rejected', 6 * DAY);
    await openOf(IMEIS[0]);
    await closed(IMEIS[1], 'rejected', 8 * DAY);
    const old = await openOf(IMEIS[1]);
    await closed(IMEIS[2], 'completed', DAY);
    const afterCompleted = await openOf(IMEIS[2]);

    const res = await staff.post('/admin/orders/bulk-reply/preview', {
      text: [`${IMEIS[0]} a`, `${IMEIS[1]} b`, `${IMEIS[2]} c`].join('\n'),
    });
    const target = { account: { id: other.id, name: 'Erbil Mobile Parts' } };
    expect(res.body.lines).toEqual([
      expect.objectContaining(ambiguous),
      expect.objectContaining({ status: 'matched', orderId: old, ...target }),
      expect.objectContaining({ status: 'matched', orderId: afterCompleted, ...target }),
    ]);
  });

  it('treats a storefront order like the order of any other buyer account, and names that account', async () => {
    const { db, merchant, manual } = world;
    const customer = await insertCustomer(db, { name: 'Sam Buyer' });
    const storefront = (imei: string, values: Partial<typeof s.orders.$inferInsert> = {}) =>
      insertOrderRow(db, {
        accountId: customer.id,
        serviceId: manual.serviceId,
        source: 'store',
        imei,
        dispatchState: 'manual',
        ...values,
      });
    const alone = await storefront(IMEIS[3]);
    expect(await lineOf(`${IMEIS[3]} R`)).toMatchObject({
      status: 'matched',
      orderId: alone.id,
      account: { id: customer.id, name: 'Sam Buyer' },
      service: { id: manual.serviceId, name: 'Manual unlock' },
    });

    // A merchant's open order and a storefront order with the same input that was rejected two days ago.
    await storefront(IMEIS[4], {
      status: 'rejected',
      dispatchState: 'done',
      completedAt: new Date(clock.now().getTime() - 2 * DAY),
    });
    await insertOrderRow(db, {
      accountId: merchant.id,
      serviceId: manual.serviceId,
      imei: IMEIS[4],
      dispatchState: 'manual',
    });
    expect(await lineOf(`${IMEIS[4]} R`)).toMatchObject(ambiguous);
  });

  it("still matches when the earlier order of the input was the same merchant's order of the same service", async () => {
    const { merchant, manual } = world;
    const first = await place(manual.serviceId, IMEIS[0]);
    expect((await staff.post(`/admin/orders/${first}/reject`, { reason: 'Wrong IMEI' })).status).toBe(204);
    const again = await place(manual.serviceId, IMEIS[0]);
    expect(await lineOf(`${IMEIS[0]} RESULT`)).toEqual({
      line: 1,
      raw: `${IMEIS[0]} RESULT`,
      imei: IMEIS[0],
      code: 'RESULT',
      orderId: again,
      status: 'matched',
      account: { id: merchant.id, name: 'Cairo GSM Lab' },
      service: { id: manual.serviceId, name: 'Manual unlock' },
    });
  });
});

describe('POST /admin/orders/bulk-reply/apply', () => {
  it('completes every matched order through the reply transition: ledger, timeline and one audit row per order', async () => {
    const { db, merchant, auto } = world;
    const a = await place(auto.serviceId, IMEIS[0]);
    const b = await place(auto.serviceId, IMEIS[1]);
    const res = await staff.post('/admin/orders/bulk-reply/apply', {
      items: [
        { orderId: a, code: 'Unlocked: 1' },
        { orderId: b, code: 'Unlocked: 2' },
      ],
    });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ applied: 2, failed: [] });
    expect(await orderRow(db, a)).toMatchObject({ status: 'completed', resultCode: 'Unlocked: 1' });
    expect(await orderRow(db, b)).toMatchObject({ status: 'completed', resultCode: 'Unlocked: 2' });
    expect(await ledgerOf(db, a)).toHaveLength(2);
    expect(await walletOf(db, merchant.id)).toEqual({ wallet: '65.4400', hold: '0.0000' });
    expect(await systemBalance(db, 'revenue')).toBe('34.5600');
    expect((await auditOf(db, a)).map((row) => row.action)).toEqual(['completed order']);
    const summary = (await db.select().from(s.auditLogs).where(eq(s.auditLogs.action, 'applied bulk reply to')))[0]!;
    expect(summary).toMatchObject({ entityLabel: '2 of 2 orders', entityType: 'order', actorName: 'Lina S.' });
    expect((await ledgerTotals(db)).sum).toBe('0.0000');
  });

  it('reports a refused item with a readable reason and still completes the others', async () => {
    const { db, auto, merchant } = world;
    const open = await place(auto.serviceId, IMEIS[0]);
    const closed = await place(auto.serviceId, IMEIS[1]);
    await staff.post(`/admin/orders/${closed}/reject`, { reason: 'No' });
    const held = await insertOrderRow(db, { accountId: merchant.id, serviceId: auto.serviceId, dispatchState: 'held' });
    const res = await staff.post('/admin/orders/bulk-reply/apply', {
      items: [
        { orderId: closed, code: 'x' },
        { orderId: 999999, code: 'x' },
        { orderId: held.id, code: 'x' },
        { orderId: open, code: 'ok' },
        { orderId: open, code: 'twice' },
      ],
    });
    expect(res.status).toBe(200);
    expect(res.body.applied).toBe(1);
    expect(res.body.failed).toEqual([
      { orderId: closed, title: 'Only an open order can be changed.' },
      { orderId: 999999, title: 'No order with this id.' },
      { orderId: held.id, title: expect.stringContaining('held for risk review') },
      { orderId: open, title: 'Only an open order can be changed.' },
    ]);
    expect((await orderRow(db, open)).resultCode).toBe('ok');
    expect(await ledgerOf(db, open)).toHaveLength(2);
  });

  it('is audited even when every item fails, and answers 200', async () => {
    const res = await staff.post('/admin/orders/bulk-reply/apply', { items: [{ orderId: 999999, code: 'x' }] });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ applied: 0, failed: [{ orderId: 999999, title: 'No order with this id.' }] });
    const rows = await (await testDb()).db.select().from(s.auditLogs);
    expect(rows.map((row) => [row.action, row.entityLabel])).toEqual([['applied bulk reply to', '0 of 1 orders']]);
  });

  it('refuses more than 500 items, an empty list and a malformed item with 422 on `items`', async () => {
    const tooMany = await staff.post('/admin/orders/bulk-reply/apply', {
      items: Array.from({ length: 501 }, (_, i) => ({ orderId: i + 1, code: 'x' })),
    });
    expect(tooMany.status).toBe(422);
    expect(tooMany.body.errors).toEqual([
      expect.objectContaining({ field: 'items', message: 'At most 500 orders per apply' }),
    ]);
    expect((await staff.post('/admin/orders/bulk-reply/apply', { items: [] })).status).toBe(422);
    const bad = await staff.post('/admin/orders/bulk-reply/apply', { items: [{ orderId: 1, code: ' ' }] });
    expect(bad.status).toBe(422);
    expect(bad.body.errors).toEqual([expect.objectContaining({ field: 'items.0.code' })]);
    expect((await staff.post('/admin/orders/bulk-reply/apply', {})).status).toBe(422);
    const reader = await adminWith(t, ['orders:read']);
    expect((await reader.post('/admin/orders/bulk-reply/apply', { items: [{ orderId: 1, code: 'x' }] })).status).toBe(
      403,
    );
  });

  it('applies the 500 limit exactly: 500 items are accepted', async () => {
    const res = await staff.post('/admin/orders/bulk-reply/apply', {
      items: Array.from({ length: 500 }, (_, i) => ({ orderId: 900_000 + i, code: 'x' })),
    });
    expect(res.status).toBe(200);
    expect(res.body.applied).toBe(0);
    expect(res.body.failed).toHaveLength(500);
  }, 60_000);

  it('settles once when the same apply runs twice at the same time', async () => {
    const { db, auto } = world;
    const id = await place(auto.serviceId, IMEIS[0]);
    const body = { items: [{ orderId: id, code: 'Unlocked' }] };
    const results = await Promise.all([
      staff.post('/admin/orders/bulk-reply/apply', body),
      staff.post('/admin/orders/bulk-reply/apply', body),
    ]);
    expect(results.map((res) => res.body.applied).sort()).toEqual([0, 1]);
    expect(await ledgerOf(db, id)).toHaveLength(2);
    expect(await systemBalance(db, 'revenue')).toBe('17.2800');
  });
});
