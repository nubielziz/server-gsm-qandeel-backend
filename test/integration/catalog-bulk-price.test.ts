// Integration tests of the bulk price change (feature 4b): preview saves nothing, apply recomputes inside its transaction,
// saves prices under the floor and counts them, clears cost_was, audits once, and refuses a bad scope or amount.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import { eq } from 'drizzle-orm';
import { schema as s } from '../../src/infra/db';
import { type AdminApi, adminWith } from '../support/admin-api';
import { type TestApp, createTestApp } from '../support/app';
import { clearIdentityCaches } from '../support/auth';
import { insertCategory, insertService } from '../support/catalog';
import { closeTestDb, resetDb, testDb } from '../support/db';
import { catalogVersionOf, insertRule } from '../support/pricing';

let t: TestApp;
let admin: AdminApi;

beforeAll(async () => {
  t = await createTestApp();
});
beforeEach(async () => {
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
const priceOf = async (id: number) =>
  (await (await testDb()).db.select().from(s.services).where(eq(s.services.id, id)))[0]!;

/** The demo's Credits category: three services (Z3X 9.35, NCK 15.37, Miracle Box 7.69) plus one in another category. */
async function world() {
  const { db } = await testDb();
  const credits = await insertCategory(db, { name: 'Credits', type: 'server' });
  const other = await insertCategory(db, { name: 'Licenses', type: 'server' });
  const make = (
    categoryId: number,
    code: string,
    cost: string,
    price: string,
    values: Partial<typeof s.services.$inferInsert> = {},
  ) =>
    insertService(db, categoryId, {
      type: 'server',
      name: `Service ${code}`,
      code,
      cost,
      effectiveCost: cost,
      basePrice: price,
      minProfit: null,
      ...values,
    });
  const z3x = await make(credits, 'SRV-Z3X-10', '8.5000', '9.3500');
  const nck = await make(credits, 'SRV-NCK-50', '12.6000', '15.3700', { costWas: '12.0000' });
  const mbx = await make(credits, 'SRV-MBX-20', '6.1000', '7.6900');
  const license = await make(other, 'SRV-UT-1D', '3.2000', '4.0000');
  return { db, credits, other, z3x, nck, mbx, license };
}

const preview = (body: Record<string, unknown>) => admin.post('/admin/services/bulk-price/preview', body);
const apply = (body: Record<string, unknown>) => admin.post('/admin/services/bulk-price/apply', body);

describe('POST /admin/services/bulk-price/preview', () => {
  it('shows the old and new price, the floor and below-floor of every service of a category, and saves nothing', async () => {
    const { credits, z3x, nck, mbx } = await world();
    const res = await preview({ categoryId: credits, change: { type: 'fixed', value: '1' } });
    expect(res.status).toBe(200);
    expect(res.body.belowFloor).toBe(0);
    expect(res.body.lines).toEqual([
      {
        serviceId: z3x,
        name: 'Service SRV-Z3X-10',
        code: 'SRV-Z3X-10',
        oldPrice: '9.3500',
        newPrice: '10.3500',
        floorPrice: '9.0100',
        belowFloor: false,
      },
      {
        serviceId: nck,
        name: 'Service SRV-NCK-50',
        code: 'SRV-NCK-50',
        oldPrice: '15.3700',
        newPrice: '16.3700',
        floorPrice: '13.3600',
        belowFloor: false,
      },
      {
        serviceId: mbx,
        name: 'Service SRV-MBX-20',
        code: 'SRV-MBX-20',
        oldPrice: '7.6900',
        newPrice: '8.6900',
        floorPrice: '6.4700',
        belowFloor: false,
      },
    ]);
    expect((await priceOf(z3x)).basePrice).toBe('9.3500');
    expect((await priceOf(nck)).costWas).toBe('12.0000');
    expect(await auditRows()).toHaveLength(0);
  });

  it('reads a percent as a share of the current price, rounded half-up to cents, and flags new prices under the floor', async () => {
    const { z3x, nck } = await world();
    const res = await preview({ serviceIds: [z3x, nck], change: { type: 'percent', value: '-30' } });
    expect(res.status).toBe(200);
    // 9.35 x 0.70 = 6.545 -> 6.55 (floor 9.01), 15.37 x 0.70 = 10.759 -> 10.76 (floor 13.36)
    expect(
      res.body.lines.map((line: { newPrice: string; belowFloor: boolean }) => [line.newPrice, line.belowFloor]),
    ).toEqual([
      ['6.5500', true],
      ['10.7600', true],
    ]);
    expect(res.body.belowFloor).toBe(2);
  });

  it('takes the floor of the rules that apply to every group and leaves group rules out', async () => {
    const { db, credits, z3x } = await world();
    await insertRule(db, { scope: 'service', targetId: z3x, kind: 'margin', minProfit: '3' });
    const res = await preview({ categoryId: credits, change: { type: 'fixed', value: '0.5' } });
    expect(res.body.lines[0]).toMatchObject({ serviceId: z3x, floorPrice: '11.5000', belowFloor: true });
  });

  it('lets ticked services win over a category, skips archived and unknown services, and answers an empty plan', async () => {
    const { db, credits, other, license } = await world();
    const archived = await insertService(db, other, {
      type: 'server',
      status: 'disabled',
      archivedAt: new Date(),
      basePrice: '5.0000',
    });
    const res = await preview({
      categoryId: credits,
      serviceIds: [license, archived, 9999],
      change: { type: 'fixed', value: '1' },
    });
    expect(res.body.lines.map((line: { serviceId: number }) => line.serviceId)).toEqual([license]);
    const empty = await preview({ serviceIds: [archived, 9999], change: { type: 'fixed', value: '1' } });
    expect(empty.status).toBe(200);
    expect(empty.body).toEqual({ lines: [], belowFloor: 0 });
  });

  it('refuses a missing scope, an unknown category and each bad amount with the field the console shows', async () => {
    const { credits, z3x } = await world();
    const refusal = async (body: Record<string, unknown>) => {
      const res = await preview(body);
      expect(res.status).toBe(422);
      return res.body.errors[0] as { field: string; code: string; message: string };
    };
    expect((await refusal({ change: { type: 'fixed', value: '1' } })).field).toBe('scope');
    expect((await refusal({ serviceIds: [], change: { type: 'fixed', value: '1' } })).field).toBe('scope');
    expect((await refusal({ categoryId: 9999, change: { type: 'fixed', value: '1' } })).field).toBe('scope');
    for (const value of ['0', '0.0000', 'abc', '', '1.23456', '5%']) {
      expect((await refusal({ categoryId: credits, change: { type: 'percent', value } })).field, value).toBe('amount');
    }
    expect(await refusal({ serviceIds: [z3x], change: { type: 'fixed', value: '-9.35' } })).toEqual({
      field: 'amount',
      code: 'invalid',
      message: 'The change would make Service SRV-Z3X-10 free.',
    });
    expect((await refusal({ serviceIds: [z3x], change: { type: 'percent', value: '-100' } })).field).toBe('amount');
    expect((await preview({ categoryId: credits, change: { type: 'sideways', value: '1' } })).status).toBe(422);
  });

  it('needs pricing:update', async () => {
    const { credits } = await world();
    const reader = await adminWith(t, ['pricing:read', 'pricing:create']);
    expect(
      (
        await reader.post('/admin/services/bulk-price/preview', {
          categoryId: credits,
          change: { type: 'fixed', value: '1' },
        })
      ).status,
    ).toBe(403);
  });
});

describe('POST /admin/services/bulk-price/apply', () => {
  it('saves every new price, clears costChangedFrom, writes one audit entry and moves the price version', async () => {
    const { credits, z3x, nck, mbx, license } = await world();
    const before = await catalogVersionOf(t);
    const res = await apply({ categoryId: credits, change: { type: 'percent', value: '10' } });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ updated: 3, belowFloor: 0 });
    expect((await priceOf(z3x)).basePrice).toBe('10.2900'); // 9.35 x 1.10 = 10.285
    expect((await priceOf(nck)).basePrice).toBe('16.9100'); // 15.37 x 1.10 = 16.907
    expect((await priceOf(mbx)).basePrice).toBe('8.4600'); // 7.69 x 1.10 = 8.459
    expect((await priceOf(nck)).costWas).toBeNull();
    expect((await priceOf(license)).basePrice).toBe('4.0000');
    expect(await catalogVersionOf(t)).not.toBe(before);

    const audits = await auditRows();
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({
      action: 'changed prices of',
      entityType: 'service',
      entityLabel: '3 services in Credits',
      actorName: 'Rami K.',
    });
    expect(audits[0]?.before).toMatchObject({
      change: { type: 'percent', value: '10' },
      services: 3,
      basePrices: { 'SRV-Z3X-10': '9.3500' },
    });
    expect(audits[0]?.after).toMatchObject({ services: 3, belowFloor: 0, basePrices: { 'SRV-Z3X-10': '10.2900' } });
  });

  it('saves prices under the floor and counts them (the accepted exception)', async () => {
    const { z3x, nck } = await world();
    const res = await apply({ serviceIds: [z3x, nck], change: { type: 'percent', value: '-30' } });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ updated: 2, belowFloor: 2 });
    expect((await priceOf(z3x)).basePrice).toBe('6.5500');
    expect((await priceOf(nck)).basePrice).toBe('10.7600');
    // The console now shows them as below floor.
    const row = await admin.get(`/admin/services/${z3x}`);
    expect(row.body).toMatchObject({ basePrice: '6.5500', belowFloor: true, costChangedFrom: null });
  });

  it('recomputes from the current prices, not from the preview', async () => {
    const { credits, z3x, db } = await world();
    const shown = await preview({ categoryId: credits, change: { type: 'fixed', value: '1' } });
    expect(shown.body.lines[0].newPrice).toBe('10.3500');
    await db.update(s.services).set({ basePrice: '20.0000' }).where(eq(s.services.id, z3x));
    await apply({ categoryId: credits, change: { type: 'fixed', value: '1' } });
    expect((await priceOf(z3x)).basePrice).toBe('21.0000');
  });

  it('refuses like the preview and changes nothing when any new price would not be above zero', async () => {
    const { z3x, nck } = await world();
    const res = await apply({ serviceIds: [z3x, nck], change: { type: 'fixed', value: '-9.35' } });
    expect(res.status).toBe(422);
    expect(res.body.errors[0].field).toBe('amount');
    expect((await priceOf(z3x)).basePrice).toBe('9.3500');
    expect((await priceOf(nck)).basePrice).toBe('15.3700');
    expect(await auditRows()).toHaveLength(0);
    expect((await apply({ change: { type: 'fixed', value: '1' } })).body.errors[0].field).toBe('scope');
  });

  it('applies two overlapping changes one after the other (the second works from the first result)', async () => {
    const { credits, z3x } = await world();
    const [a, b] = await Promise.all([
      apply({ categoryId: credits, change: { type: 'fixed', value: '1' } }),
      apply({ categoryId: credits, change: { type: 'fixed', value: '2' } }),
    ]);
    expect([a.status, b.status]).toEqual([200, 200]);
    expect((await priceOf(z3x)).basePrice).toBe('12.3500');
  });

  it('needs pricing:update and a CSRF token', async () => {
    const { credits } = await world();
    const body = { categoryId: credits, change: { type: 'fixed', value: '1' } };
    const reader = await adminWith(t, ['pricing:read']);
    expect((await reader.post('/admin/services/bulk-price/apply', body)).status).toBe(403);
    expect((await admin.withoutCsrf('POST', '/admin/services/bulk-price/apply', body)).status).toBe(403);
  });
});
