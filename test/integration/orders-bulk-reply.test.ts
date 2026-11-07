// Integration tests of the bulk reply (feature 5): POST /admin/orders/bulk-reply/preview matches pasted `IMEI CODE` lines to orders
// (whitespace-insensitive, non-empty inputs only) and POST /admin/orders/bulk-reply/apply completes up to 500 orders, each through the
// same reply transition, reporting a refused item instead of failing the call.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import { eq } from 'drizzle-orm';
import { schema as s } from '../../src/infra/db';
import { type AdminApi, adminWith } from '../support/admin-api';
import { type TestApp, createTestApp } from '../support/app';
import { clearIdentityCaches } from '../support/auth';
import { TestClock } from '../support/clock';
import { closeTestDb, resetDb, testDb } from '../support/db';
import { ledgerTotals } from '../support/money';
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
} from '../support/orders';

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
    const { db, auto, manual } = world;
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
    expect(res.body.lines).toEqual([
      {
        line: 1,
        raw: `${IMEIS[0]} Unlocked: code 1`,
        imei: IMEIS[0],
        code: 'Unlocked: code 1',
        orderId: open,
        status: 'matched',
      },
      { line: 3, raw: `${IMEIS[1]},Unlocked 2`, imei: IMEIS[1], code: 'Unlocked 2', orderId: null, status: 'not_open' },
      { line: 4, raw: `${IMEIS[2]};code 3`, imei: IMEIS[2], code: 'code 3', orderId: null, status: 'ambiguous' },
      { line: 5, raw: '352905112490861', imei: '352905112490861', code: null, orderId: null, status: 'invalid' },
      {
        line: 6,
        raw: '999999999999991 code 4',
        imei: '999999999999991',
        code: 'code 4',
        orderId: null,
        status: 'not_found',
      },
      {
        line: 7,
        raw: `  ${IMEIS[0]}\t  trimmed code  `,
        imei: IMEIS[0],
        code: 'trimmed code',
        orderId: open,
        status: 'matched',
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
      clientId: merchant.id,
      serviceId: manual.serviceId,
      imei: 'SN 566A 15082',
      dispatchState: 'manual',
    });
    const blank = await insertOrderRow(db, {
      clientId: merchant.id,
      serviceId: manual.serviceId,
      imei: null,
      dispatchState: 'manual',
    });
    await insertOrderRow(db, { clientId: merchant.id, serviceId: manual.serviceId, imei: '', dispatchState: 'manual' });
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
    const held = await insertOrderRow(db, { clientId: merchant.id, serviceId: auto.serviceId, dispatchState: 'held' });
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
