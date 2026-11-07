// Integration tests of the staff order export (feature 5): GET /admin/orders/export streams a CSV of every order that matches the list
// filters, counts first (more than 100,000 rows is 422), writes an audit row and pages by keyset so no row repeats or is skipped.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import { eq, sql } from 'drizzle-orm';
import { schema as s } from '../../src/infra/db';
import { EXPORT_BATCH_SIZE, MAX_EXPORT_ROWS } from '../../src/modules/orders/application/order-export.service';
import { type AdminApi, adminWith } from '../support/admin-api';
import { type TestApp, createTestApp } from '../support/app';
import { clearIdentityCaches } from '../support/auth';
import { closeTestDb, resetDb, testDb } from '../support/db';
import { IMEIS, insertOrderRow, type OrdersWorld, ordersWorld } from '../support/orders';

let t: TestApp;
let world: OrdersWorld;
let staff: AdminApi;

beforeAll(async () => {
  t = await createTestApp();
});
beforeEach(async () => {
  await resetDb();
  await clearIdentityCaches(t);
  world = await ordersWorld((await testDb()).db);
  staff = await adminWith(t, ['orders:read']);
});
afterAll(async () => {
  await resetDb();
  await clearIdentityCaches(t);
  await t.close();
  await closeTestDb();
});

/** The CSV lines of an export answer, without the header. */
const rowsOf = (body: string): string[] => body.split('\r\n').slice(1, -1);

/** Calls an export route as the signed-in staff member (the shared client parses JSON, an export answers text). */
async function csv(url: string) {
  const res = await t.app.inject({ method: 'GET', url, headers: staff.session.headers });
  return { status: res.statusCode, res, body: res.body, json: () => res.json() };
}

describe('GET /admin/orders/export', () => {
  it('answers a CSV attachment with the console columns, one line per matching order', async () => {
    const { db, merchant, other, auto } = world;
    const [customer] = await db
      .insert(s.customers)
      .values({ email: 'a@example.com', name: 'Jack Turner' })
      .returning({ id: s.customers.id });
    const a = await insertOrderRow(db, {
      clientId: merchant.id,
      serviceId: auto.serviceId,
      imei: IMEIS[0],
      status: 'completed',
      dispatchState: 'done',
      supplierId: auto.supplierId,
      unitPrice: '16.2600',
      totalPrice: '16.2600',
      unitCost: '13.5000',
      totalCost: '13.5000',
    });
    const b = await insertOrderRow(db, {
      customerId: customer!.id,
      serviceId: auto.serviceId,
      imei: IMEIS[1],
      source: 'store',
    });
    await insertOrderRow(db, {
      clientId: other.id,
      serviceId: auto.serviceId,
      imei: IMEIS[2],
      status: 'rejected',
      dispatchState: 'done',
    });
    const res = await csv('/admin/orders/export?_sort=id&_order=asc&status=completed&status=pending');
    expect(res.status).toBe(200);
    expect(res.res.headers['content-type']).toBe('text/csv; charset=utf-8');
    expect(res.res.headers['content-disposition']).toBe('attachment; filename="orders-export.csv"');
    expect(res.res.headers['cache-control']).toBe('no-store');
    const lines = res.body.split('\r\n');
    expect(lines[0]).toBe('id,created,channel,buyer,service,input,status,supplier,price,cost');
    expect(rowsOf(res.body)).toEqual([
      `${a.id},${a.createdAt.toISOString()},b2b,Cairo GSM Lab,AT&T USA Premier Unlock,${IMEIS[0]},completed,${(await db.select({ name: s.suppliers.name }).from(s.suppliers).where(eq(s.suppliers.id, auto.supplierId)))[0]!.name},16.2600,13.5000`,
      `${b.id},${b.createdAt.toISOString()},b2c,Jack Turner,AT&T USA Premier Unlock,${IMEIS[1]},pending,,10.0000,0.0000`,
    ]);
    expect(lines.at(-1)).toBe('');
  });

  it('honours the same search and sort as the list, and ignores the range', async () => {
    const { db, merchant, auto } = world;
    for (const [index, price] of ['30.0000', '10.0000', '20.0000'].entries()) {
      await insertOrderRow(db, {
        clientId: merchant.id,
        serviceId: auto.serviceId,
        imei: IMEIS[index],
        totalPrice: price,
        unitPrice: price,
      });
    }
    const sorted = await csv('/admin/orders/export?_sort=totalPrice&_order=asc&_start=0&_end=1');
    expect(rowsOf(sorted.body).map((line) => line.split(',').at(-2))).toEqual(['10.0000', '20.0000', '30.0000']);
    const searched = await csv(`/admin/orders/export?q=${IMEIS[1]}`);
    expect(rowsOf(searched.body)).toHaveLength(1);
    const none = await csv('/admin/orders/export?status=rejected');
    expect(none.body).toBe('id,created,channel,buyer,service,input,status,supplier,price,cost\r\n');
  });

  it('writes the cells that start like a formula as text, and quotes commas and quotes', async () => {
    const { db, merchant, auto } = world;
    await insertOrderRow(db, { clientId: merchant.id, serviceId: auto.serviceId, imei: '=SUM(A1:A9)' });
    await insertOrderRow(db, { clientId: merchant.id, serviceId: auto.serviceId, imei: 'say "hi", please' });
    const body = (await csv('/admin/orders/export?_sort=id&_order=asc')).body;
    expect(body).toContain(",'=SUM(A1:A9),");
    expect(body).toContain(',"say ""hi"", please",');
  });

  it('writes one audit row per export with the number of rows', async () => {
    const { db, merchant, auto } = world;
    await insertOrderRow(db, { clientId: merchant.id, serviceId: auto.serviceId });
    await insertOrderRow(db, { clientId: merchant.id, serviceId: auto.serviceId, imei: IMEIS[1] });
    await csv('/admin/orders/export?status=pending');
    const rows = await db.select().from(s.auditLogs);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      action: 'exported',
      entityType: 'order',
      entityLabel: '2 orders',
      actorId: staff.staffId,
    });
    expect(rows[0]!.after).toMatchObject({ rows: 2, filters: ['status'] });
  });

  it('pages by keyset: more rows than one batch come out once each, in order', async () => {
    const { db, merchant, auto } = world;
    const total = EXPORT_BATCH_SIZE * 2 + 345;
    // Many orders share the same creation time, so the id has to break the ties between batches.
    await db.execute(sql`
      insert into orders (client_id, service_id, type, source, imei, unit_price, total_price, currency, created_at, placed_at)
      select ${merchant.id}, ${auto.serviceId}, 'imei', 'portal', 'bulk-' || n, 1, 1, 'USD',
             timestamptz '2026-01-01 00:00:00+00' + ((n / 100) * interval '1 second'),
             timestamptz '2026-01-01 00:00:00+00' + ((n / 100) * interval '1 second')
      from generate_series(1, ${total}) as n`);
    for (const order of ['asc', 'desc'] as const) {
      const body = (await csv(`/admin/orders/export?_sort=createdAt&_order=${order}`)).res.body;
      const ids = rowsOf(body).map((line) => Number(line.split(',')[0]));
      expect(ids).toHaveLength(total);
      expect(new Set(ids).size).toBe(total);
      const sorted = [...ids].sort((a, b) => a - b);
      expect(ids).toEqual(order === 'asc' ? sorted : sorted.reverse());
    }
  }, 60_000);

  it('refuses more than 100,000 matching rows with 422 and a count in the message, and audits nothing', async () => {
    const { db, merchant, auto } = world;
    const total = MAX_EXPORT_ROWS + 1;
    await db.execute(sql`
      insert into orders (client_id, service_id, type, source, imei, unit_price, total_price, currency)
      select ${merchant.id}, ${auto.serviceId}, 'imei', 'portal', 'n' || n, 1, 1, 'USD' from generate_series(1, ${total}) as n`);
    const res = await csv('/admin/orders/export');
    expect(res.status).toBe(422);
    expect(res.json()).toMatchObject({
      code: 'VALIDATION_FAILED',
      detail: `Too many rows (${total}); narrow the filters (max 100000).`,
    });
    expect(await db.select().from(s.auditLogs)).toHaveLength(0);
    // A narrower export of the same table still works.
    const narrow = await csv('/admin/orders/export?q=n5000000');
    expect(narrow.status).toBe(200);
  }, 120_000);

  it('refuses a bad filter with 422 and needs orders:read', async () => {
    expect((await csv('/admin/orders/export?queue=bogus')).status).toBe(422);
    const nobody = await adminWith(t, ['staff:read']);
    expect((await nobody.get('/admin/orders/export')).status).toBe(403);
    expect((await staff.anonymous('GET', '/admin/orders/export')).status).toBe(401);
  });
});
