// The catalog seed (feature 4a): the demo's categories, services, fields, options, group prices and inventory codes appear with
// the ids, codes and prices of the frontend mocks, through the real API, and the seed reconciles with the default groups that
// migration 0005 puts on a fresh database.
import { afterAll, beforeAll, beforeEach, describe, expect, it, setDefaultTimeout } from 'bun:test';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { sql } from 'drizzle-orm';
import { EncryptionService } from '../../src/infra/crypto';
import { schema as s } from '../../src/infra/db';
import { INVENTORY_CODE_AAD } from '../../src/modules/catalog';
import { seedCatalog } from '../../scripts/seed/catalog';
import { demoStatePath, loadDemoState } from '../../scripts/seed/demo-state';
import { seedIdentity } from '../../scripts/seed/identity';
import { adminWith } from '../support/admin-api';
import { type TestApp, createTestApp } from '../support/app';
import { clearIdentityCaches } from '../support/auth';
import { closeTestDb, resetDb, testDb } from '../support/db';

setDefaultTimeout(60_000);

const frontendPresent = existsSync(demoStatePath());
const MIGRATION = readFileSync(join(import.meta.dir, '../../drizzle/0005_default_client_groups.sql'), 'utf8');
let t: TestApp;

/**
 * Runs the seeders this module needs: identity (the merchant groups the group prices point at) and catalog. The money seeder,
 * which replays about 2,000 ledger journals, is left out on purpose: nothing here reads it.
 */
async function seed(now?: number) {
  const { db } = await testDb();
  const demo = await loadDemoState(now === undefined ? {} : { now });
  return db.transaction(async (tx) => ({
    identity: await seedIdentity(tx, demo),
    catalog: await seedCatalog(tx, demo, t.config),
  }));
}

beforeAll(async () => {
  t = await createTestApp();
});
beforeEach(async () => {
  await resetDb();
  await clearIdentityCaches(t);
});
afterAll(async () => {
  await resetDb();
  await clearIdentityCaches(t);
  await t.close();
  await closeTestDb();
});

describe.skipIf(!frontendPresent)('the catalog seed', () => {
  it('writes 9 categories, 27 services and the 30 inventory codes with the mock ids, codes and prices, and the console reads them back', async () => {
    const { db } = await testDb();
    await seed();

    const categories = await db.select().from(s.serviceCategories).orderBy(s.serviceCategories.id);
    expect(categories.map((c) => [c.id, c.name, c.type])).toEqual([
      [1, 'Apple', 'imei'],
      [2, 'Samsung', 'imei'],
      [3, 'Generic', 'imei'],
      [4, 'Carrier unlock', 'imei'],
      [5, 'Xiaomi', 'imei'],
      [6, 'Credits', 'server'],
      [7, 'Licenses', 'server'],
      [8, 'Remote', 'remote'],
      [9, 'Files', 'file'],
    ]);
    const services = await db.select().from(s.services).orderBy(s.services.id);
    expect(services).toHaveLength(27);
    expect(services[4]).toMatchObject({
      id: 5,
      code: 'IMEI-ATT-USA',
      categoryId: 4,
      type: 'imei',
      basePrice: '17.2800',
      cost: '13.5000',
      effectiveCost: '13.5000',
      minProfit: '0.8100',
      status: 'active',
      fulfillment: 'auto',
    });
    expect(services[13]).toMatchObject({ code: 'IMEI-XIA-MI', status: 'disabled' });
    expect(services[16]).toMatchObject({
      code: 'SRV-CHM-1M',
      cost: '19.8000',
      costWas: '17.0000',
      basePrice: '19.5000',
    });

    const admin = await adminWith(t, ['catalog:*', 'inventory:*', 'groups:*'], { name: 'Rami K.' });
    const list = await admin.get('/admin/services?_start=0&_end=200&_sort=name&_order=asc');
    expect(list.total).toBe(27);
    // The one service whose price is under its floor is the Chrome licence (19.50 against 19.80 + 1.19).
    const below = await admin.get('/admin/services?belowFloor=true&status=active');
    expect(below.body.map((row: { code: string }) => row.code)).toEqual(['SRV-CHM-1M']);
    expect(below.body[0]).toMatchObject({ floorPrice: '20.9900', costChangedFrom: '17.0000' });
    const att = await admin.get('/admin/services/5');
    expect(att.body.options).toHaveLength(3);
    expect(att.body.groupPrices).toEqual([{ groupId: 3, price: '15.9000' }]);
    expect((await admin.get('/admin/services/15')).body.fields).toEqual([
      {
        key: 'account',
        label: 'Z3X account',
        fieldType: 'text',
        required: true,
        options: [],
        regex: '',
        supplierKey: 'user',
      },
    ]);
    const categoriesList = await admin.get('/admin/service-categories?_start=0&_end=200&_sort=sort&_order=asc');
    expect(categoriesList.body.find((c: { name: string }) => c.name === 'Apple').serviceCount).toBe(4);

    // The inventory: encrypted at rest, masked on the wire, and the batch sequence continues after the seeded references.
    const codes = await db.select().from(s.inventoryCodes).orderBy(s.inventoryCodes.id);
    expect(codes).toHaveLength(30);
    expect(codes.filter((c) => c.status === 'sold')).toHaveLength(8);
    expect(codes.filter((c) => c.status === 'void')).toHaveLength(2);
    expect(JSON.stringify(codes)).not.toContain('Z3X-1000');
    expect(t.app.get(EncryptionService).decrypt(codes[0]!.codeEnc, INVENTORY_CODE_AAD)).toBe('Z3X-1000-A1B2');

    const stock = await admin.get('/admin/inventory-codes?_start=0&_end=5');
    expect(stock.total).toBe(30);
    expect(stock.body.every((row: { maskedCode: string }) => /^\u2022{8}[A-Z0-9]{4}$/.test(row.maskedCode))).toBe(true);
    const imported = await admin.post('/admin/services/15/inventory/import', { codes: ['Z3X-NEW-0001'] });
    // The sequence is past the seeded B-0002 (a shared sequence is not reset between test files, so only a lower bound holds).
    expect(imported.body.imported).toBe(1);
    expect(imported.body.batchRef).toMatch(/^B-\d{4,}$/);
    expect(Number(String(imported.body.batchRef).slice(2))).toBeGreaterThanOrEqual(3);
  });

  it('is idempotent with the inventory too', async () => {
    await seed();
    const second = await seed(Date.now() + 3_600_000);
    expect([...second.identity, ...second.catalog].filter((report) => report.inserted !== 0)).toEqual([]);
  });

  it('reconciles with the default groups of migration 0005: the demo groups take their ids and values', async () => {
    const { db, pool } = await testDb();
    await pool.query(MIGRATION);
    expect((await db.select().from(s.clientGroups)).map((g) => g.id)).toEqual([1, 2]);
    await seed();
    const groups = await db.select().from(s.clientGroups).orderBy(s.clientGroups.id);
    expect(groups.map((g) => [g.id, g.name, g.kind, g.isDefault, g.depositLimit])).toEqual([
      [1, 'Standard', 'b2b', true, '5000.0000'],
      [2, 'Wholesale', 'b2b', false, '20000.0000'],
      [3, 'VIP', 'b2b', false, '100000.0000'],
      [4, 'Storefront retail', 'b2c_retail', false, '1000.0000'],
    ]);
    // A merchant created next joins the default group.
    const [{ n }] = (await db.execute<{ n: string }>(sql`select count(*)::text as n from client_groups`)).rows as [
      { n: string },
    ];
    expect(n).toBe('4');
  });
});
