// Integration tests of the price grid (decision 063): GET /admin/services/price-grid answers the cost, the base and shop prices and the
// price of every merchant group with their margins, the group prices are the ones merchants read, and the route needs pricing:read too.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import { eq } from 'drizzle-orm';
import { type Database, schema as s } from '@src/infra/db';
import { type AdminApi, adminWith } from '../../support/admin-api';
import { type TestApp, createTestApp } from '../../support/app';
import { clearIdentityCaches, openSession } from '../../support/auth';
import { insertCategory, insertService, insertSupplierLink } from '../../support/catalog';
import { TestClock } from '../../support/clock';
import { closeTestDb, resetDb, testDb } from '../../support/db';
import { insertAtt, insertDemoGroups, insertGroupPrice, insertMerchantIn, insertRule } from '../../support/pricing';
import { insertRetailPrice } from '../../support/storefront';

const clock = new TestClock('2026-11-23T12:00:00.000Z');
let t: TestApp;
/** An Owner, a reader of the catalog and the prices, and two readers who miss one of the two permissions. */
let owner: AdminApi;
let reader: AdminApi;
let catalogOnly: AdminApi;
let pricingOnly: AdminApi;

beforeAll(async () => {
  t = await createTestApp({ clock });
});
beforeEach(async () => {
  clock.set('2026-11-23T12:00:00.000Z');
  await resetDb();
  await clearIdentityCaches(t);
  owner = await adminWith(t, ['*']);
  reader = await adminWith(t, ['catalog:read', 'pricing:read']);
  catalogOnly = await adminWith(t, ['catalog:*', 'pricing:update']);
  pricingOnly = await adminWith(t, ['pricing:read']);
});
afterAll(async () => {
  await resetDb();
  await clearIdentityCaches(t);
  await t.close();
  await closeTestDb();
});

interface Cell {
  readonly groupId: number;
  readonly fixedPrice: string | null;
  readonly price: string;
  readonly margin: string | null;
}
interface GridRow extends Record<string, unknown> {
  readonly id: number;
  readonly name: string;
  readonly sort: number;
  readonly cost: string | null;
  readonly baseMargin: string | null;
  readonly retailPrice: string | null;
  readonly retailPriceSource: string | null;
  readonly retailMargin: string | null;
  readonly groupPrices: Cell[];
}

const GRID = '/admin/services/price-grid';
const grid = async (api: AdminApi, query = ''): Promise<{ rows: GridRow[]; total: number }> => {
  const res = await api.get(`${GRID}?_start=0&_end=1000${query}`);
  expect(res.status, query).toBe(200);
  return { rows: res.body as GridRow[], total: res.total };
};

/** The demo: the AT&T unlock (cost 13.50, price 17.28, the 2 % Carrier unlock promo, a VIP price of 15.90) and the iCloud check. */
async function world() {
  const { db } = await testDb();
  const groups = await insertDemoGroups(db);
  const { categoryId, serviceId } = await insertAtt(db);
  await insertGroupPrice(db, serviceId, groups.vip, '15.9000');
  await insertRule(db, { scope: 'category', targetId: categoryId, kind: 'discount', percent: '2', priority: 100 });
  const link = await insertSupplierLink(db, serviceId, { supplier: 'DHRU Pro', credit: '13.5' });
  const apple = await insertCategory(db, { name: 'Apple' });
  const icloud = await insertService(db, apple, {
    name: 'iCloud Clean / Lost Check',
    code: 'IMEI-ICL-CHK',
    cost: '0.0800',
    effectiveCost: '0.0800',
    basePrice: '0.1300',
    minProfit: null,
    slaMinutes: 2,
  });
  return { db, groups, categoryId, serviceId, link, apple, icloud };
}

/** A service priced above its floor, in a category; `values` override any column. */
const serviceIn = (
  db: Database,
  category: number,
  name: string,
  values: Partial<typeof s.services.$inferInsert> = {},
) => insertService(db, category, { name, cost: '1.0000', effectiveCost: '1.0000', basePrice: '5.0000', ...values });

describe('GET /admin/services/price-grid: the row', () => {
  it('gives the cost, the base and shop prices with their margins and the price of every merchant group', async () => {
    const { db, groups, categoryId, serviceId, link } = await world();
    await insertRetailPrice(db, serviceId, groups.retail, '25.9900');
    const { rows, total } = await grid(reader, `&categoryId=${categoryId}`);
    expect(total).toBe(1);
    expect(rows).toEqual([
      {
        id: serviceId,
        name: 'AT&T USA Premier Unlock',
        code: 'IMEI-ATT-USA',
        status: 'active',
        sort: 0,
        categoryId,
        supplier: { id: link.supplierId, name: 'DHRU Pro' },
        cost: '13.5000',
        costChangedFrom: null,
        basePrice: '17.2800',
        baseMargin: '3.7800',
        floorPrice: '14.3100',
        belowFloor: false,
        retailPrice: '25.9900',
        retailPriceSource: 'manual',
        retailMargin: '12.4900',
        groupPrices: [
          // No fixed price: the base price after the 2 % promo (17.28 x 0.98).
          { groupId: groups.standard, fixedPrice: null, price: '16.9300', margin: '3.4300' },
          // ... and the group's own 4 % discount on top (16.9344 x 0.96).
          { groupId: groups.wholesale, fixedPrice: null, price: '16.2600', margin: '2.7600' },
          // A fixed price is what staff typed: no promo, no discount.
          { groupId: groups.vip, fixedPrice: '15.9000', price: '15.9000', margin: '2.4000' },
        ],
      },
    ]);
  });

  it('shows the same price as the merchants of each group read in their catalog', async () => {
    const { db, groups } = await world();
    const { rows } = await grid(reader);
    expect(rows).toHaveLength(2);
    const catalogOf = async (groupId: number) => {
      const merchant = await insertMerchantIn(db, groupId);
      const session = await openSession(t, { type: 'client', id: merchant });
      const res = await t.app.inject({ method: 'GET', url: '/client/services', headers: session.headers });
      expect(res.statusCode).toBe(200);
      return new Map(res.json<Array<{ id: number; price: string }>>().map((row) => [row.id, row.price]));
    };
    for (const groupId of [groups.standard, groups.wholesale, groups.vip]) {
      const seen = await catalogOf(groupId);
      expect(seen.size).toBe(2);
      for (const row of rows) {
        const cell = row.groupPrices.find((entry) => entry.groupId === groupId)!;
        expect(cell.price, `service ${row.id}, group ${groupId}`).toBe(seen.get(row.id)!);
      }
    }
  });

  it('shows the price a merchant is charged when the floor lifts a fixed price, next to the price as typed', async () => {
    const { db, groups, serviceId } = await world();
    // The cost moved after the price was fixed: 14.00 is under the floor of 14.31.
    await db
      .update(s.serviceGroupPrices)
      .set({ price: '14.0000' })
      .where(eq(s.serviceGroupPrices.serviceId, serviceId));
    const row = (await grid(reader)).rows.find((entry) => entry.id === serviceId)!;
    expect(row.groupPrices.find((cell) => cell.groupId === groups.vip)).toEqual({
      groupId: groups.vip,
      fixedPrice: '14.0000',
      price: '14.3100',
      margin: '0.8100',
    });
  });

  it('puts the groups in the order of the groups page, the shop group left out', async () => {
    const { db, groups } = await world();
    await db.update(s.clientGroups).set({ sort: 9 }).where(eq(s.clientGroups.id, groups.standard));
    const { rows } = await grid(reader);
    for (const row of rows) {
      expect(row.groupPrices.map((cell) => cell.groupId)).toEqual([groups.wholesale, groups.vip, groups.standard]);
    }
  });

  it('says null for the cost and every margin while no cost is on record, and still gives the prices', async () => {
    const { db, groups, apple } = await world();
    const fresh = await serviceIn(db, apple, 'Fresh', { cost: '0.0000', effectiveCost: '0.0000' });
    await insertRetailPrice(db, fresh, groups.retail, '9.0000');
    // The Apple category has no pricing rule: the groups pay the base price less their own discount (0 %, 4 % and 8 %).
    const row = (await grid(reader, '&q=Fresh')).rows[0]!;
    expect(row).toMatchObject({
      name: 'Fresh',
      cost: null,
      costChangedFrom: null,
      baseMargin: null,
      basePrice: '5.0000',
      retailPrice: '9.0000',
      retailMargin: null,
    });
    expect(row.groupPrices.map((cell) => [cell.price, cell.margin])).toEqual([
      ['5.0000', null],
      ['4.8000', null],
      ['4.6000', null],
    ]);
  });

  it('gives the older cost when it rose since the base price was set, and a negative margin under the cost', async () => {
    const { db, apple } = await world();
    await serviceIn(db, apple, 'Moved', {
      cost: '6.0000',
      effectiveCost: '6.0000',
      costWas: '4.0000',
      minProfit: '0.0000',
    });
    const row = (await grid(reader, '&q=Moved')).rows[0]!;
    expect(row).toMatchObject({ cost: '6.0000', costChangedFrom: '4.0000', baseMargin: '-1.0000', belowFloor: true });
    // The floor lifts every merchant price to the cost: no group pays less than it costs.
    expect(row.groupPrices.map((cell) => [cell.price, cell.margin])).toEqual([
      ['6.0000', '0.0000'],
      ['6.0000', '0.0000'],
      ['6.0000', '0.0000'],
    ]);
  });

  it('tells a typed shop price from one that follows a rule, and a service without one', async () => {
    const { db, groups, apple } = await world();
    const typed = await serviceIn(db, apple, 'B typed');
    const following = await serviceIn(db, apple, 'C following');
    await serviceIn(db, apple, 'A none');
    await insertRetailPrice(db, typed, groups.retail, '12.5000');
    await insertRetailPrice(db, following, groups.retail, '14.0000');
    const [rule] = await db
      .insert(s.retailPriceRules)
      .values({ scope: 'global', percent: '30.0000', rounding: 'cent', changedAt: clock.now() })
      .returning({ id: s.retailPriceRules.id });
    await db.insert(s.retailPriceFollows).values({
      serviceId: following,
      ruleId: rule!.id,
      appliedPrice: '14.0000',
      appliedCost: '1.0000',
      appliedAt: clock.now(),
    });
    const { rows } = await grid(reader, `&categoryId=${apple}&_sort=name`);
    const mine = rows.filter((row) => ['A none', 'B typed', 'C following'].includes(row.name));
    expect(mine.map((row) => [row.name, row.retailPrice, row.retailPriceSource, row.retailMargin])).toEqual([
      ['A none', null, null, null],
      ['B typed', '12.5000', 'manual', '11.5000'],
      ['C following', '14.0000', 'rule', '13.0000'],
    ]);
  });

  it('leaves out archived services and shows a disabled one with its status', async () => {
    const { db, categoryId } = await world();
    await serviceIn(db, categoryId, 'Gone', { status: 'disabled', archivedAt: clock.now() });
    await serviceIn(db, categoryId, 'Off', { status: 'disabled' });
    const names = (await grid(reader, `&categoryId=${categoryId}`)).rows.map((row) => row.name);
    expect(names).toContain('Off');
    expect(names).not.toContain('Gone');
    expect((await grid(reader, '&q=Off')).rows[0]).toMatchObject({ name: 'Off', status: 'disabled' });
  });

  it('answers a page without a merchant group as an empty list of group prices', async () => {
    const { db } = await testDb();
    const category = await insertCategory(db, { name: 'Alone' });
    await serviceIn(db, category, 'Alone service');
    const { rows } = await grid(reader);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.groupPrices).toEqual([]);
  });
});

describe('GET /admin/services/price-grid: the list dialect', () => {
  /** Two categories (the server one first in the merchants' order) and five services. */
  async function listWorld() {
    const { db } = await testDb();
    await insertDemoGroups(db);
    const servers = await insertCategory(db, { name: 'Servers', type: 'server', sort: 1 });
    const imei = await insertCategory(db, { name: 'IMEI', type: 'imei', sort: 2 });
    const make = (
      category: number,
      type: 'imei' | 'server',
      name: string,
      values: Partial<typeof s.services.$inferInsert> = {},
    ) => serviceIn(db, category, name, { type, ...values });
    const ids = {
      alpha: await make(imei, 'imei', 'Alpha', { sort: 2 }),
      bravo: await make(imei, 'imei', 'Bravo', { sort: 1 }),
      charlie: await make(imei, 'imei', 'Charlie'),
      delta: await make(servers, 'server', 'Delta', { sort: 5 }),
      echo: await make(servers, 'server', 'Echo', { status: 'disabled' }),
    };
    return { ids, servers, imei };
  }

  it('pages with _start and _end and says the total in x-total-count', async () => {
    await listWorld();
    const first = await reader.get(`${GRID}?_start=0&_end=2&_sort=name&_order=asc`);
    expect(first.status).toBe(200);
    expect(first.total).toBe(5);
    expect((first.body as GridRow[]).map((row) => row.name)).toEqual(['Alpha', 'Bravo']);
    const last = await reader.get(`${GRID}?_start=4&_end=6&_sort=name&_order=asc`);
    expect((last.body as GridRow[]).map((row) => row.name)).toEqual(['Echo']);
    expect(last.total).toBe(5);
    // The default page is 25 rows, the default order the name.
    const plain = await reader.get(GRID);
    expect((plain.body as GridRow[]).map((row) => row.name)).toEqual(['Alpha', 'Bravo', 'Charlie', 'Delta', 'Echo']);
  });

  it('filters by type, status and category, and searches the name, the code and the category name', async () => {
    const { servers } = await listWorld();
    const names = async (query: string) => (await grid(reader, query)).rows.map((row) => row.name);
    expect(await names('&type=server')).toEqual(['Delta', 'Echo']);
    expect(await names('&type_ne=server')).toEqual(['Alpha', 'Bravo', 'Charlie']);
    expect(await names('&status=disabled')).toEqual(['Echo']);
    expect(await names(`&categoryId=${servers}`)).toEqual(['Delta', 'Echo']);
    expect(await names('&q=charl')).toEqual(['Charlie']);
    expect(await names('&q=servers')).toEqual(['Delta', 'Echo']);
    expect((await grid(reader, '&type=server&status=active')).total).toBe(1);
    expect((await grid(reader, '&categoryId=999999')).total).toBe(0);
  });

  it('sorts by sort the way merchants see the services: category position, then sort, then name', async () => {
    await listWorld();
    const names = async (order: string) =>
      (await grid(reader, `&_sort=sort&_order=${order}`)).rows.map((row) => row.name);
    // Servers first (category sort 1), Delta (5) after Echo (0): Echo, Delta; then IMEI: Charlie (0), Bravo (1), Alpha (2).
    expect(await names('asc')).toEqual(['Echo', 'Delta', 'Charlie', 'Bravo', 'Alpha']);
    expect(await names('desc')).toEqual(['Alpha', 'Bravo', 'Charlie', 'Delta', 'Echo']);
  });

  it('sorts by id, and refuses a sort or a filter the grid does not offer', async () => {
    const { ids } = await listWorld();
    const byId = await grid(reader, '&_sort=id&_order=desc');
    expect(byId.rows.map((row) => row.id)).toEqual(Object.values(ids).sort((a, b) => b - a));
    for (const query of ['_sort=cost', '_sort=retailPrice', 'belowFloor=true', 'needsAttention=true', 'supplierId=1']) {
      const res = await reader.get(`${GRID}?${query}`);
      expect(res.status, query).toBe(422);
      expect(res.body).toMatchObject({ code: 'VALIDATION_FAILED' });
    }
  });
});

describe('GET /admin/services/price-grid: who may read it', () => {
  it('needs catalog:read and pricing:read, and names pricing:read when it is the one missing', async () => {
    await world();
    expect((await owner.get(GRID)).status).toBe(200);
    expect((await reader.get(GRID)).status).toBe(200);
    // The catalog alone (also with pricing:update) is refused before anything is read.
    const noPricing = await catalogOnly.get(GRID);
    expect(noPricing.status).toBe(403);
    expect(noPricing.body).toMatchObject({
      code: 'FORBIDDEN',
      detail: 'You need the pricing:read permission to do this.',
    });
    // The prices alone do not open the catalog.
    expect((await pricingOnly.get(GRID)).status).toBe(403);
  });

  it('refuses a request without a session', async () => {
    expect((await reader.anonymous('GET', GRID)).status).toBe(401);
  });

  it('writes nothing: no audit row, no change to a service', async () => {
    const { db, serviceId } = await world();
    const before = await db.select().from(s.services).where(eq(s.services.id, serviceId));
    await grid(reader);
    expect(await db.select().from(s.auditLogs)).toHaveLength(0);
    expect(await db.select().from(s.services).where(eq(s.services.id, serviceId))).toEqual(before);
  });
});
