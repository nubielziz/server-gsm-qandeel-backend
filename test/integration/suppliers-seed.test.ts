// The suppliers seed (feature 6): the demo's suppliers, the services they offer, the links of the demo's services in priority order and
// the call log appear through the real API with the ids, names and amounts of the frontend mock; API keys are dev-only placeholders,
// stored encrypted. Runs the whole seed once, like the other seed tests.
import { afterAll, beforeAll, describe, expect, it, setDefaultTimeout } from 'bun:test';
import { existsSync } from 'node:fs';
import { eq } from 'drizzle-orm';
import { demoRows, demoStatePath, loadDemoState } from '../../scripts/seed/demo-state';
import { runSeed } from '../../scripts/seed/run';
import { EncryptionService } from '../../src/infra/crypto';
import { schema as s } from '../../src/infra/db';
import { type AdminApi, adminWith } from '../support/admin-api';
import { type TestApp, createTestApp } from '../support/app';
import { clearIdentityCaches } from '../support/auth';
import { closeTestDb, resetDb, testDb } from '../support/db';

setDefaultTimeout(180_000);

const frontendPresent = existsSync(demoStatePath());
let t: TestApp;
let staff: AdminApi;
let demoSuppliers: Array<{ id: string; name: string; enabled: boolean; key: string }> = [];
let demoServices: Array<{ id: string; cost: number; sup: string; fb: string | null }> = [];

beforeAll(async () => {
  if (!frontendPresent) return;
  t = await createTestApp();
  await resetDb();
  await clearIdentityCaches(t);
  const demo = await loadDemoState();
  demoSuppliers = demoRows(demo, 'suppliers');
  demoServices = demoRows(demo, 'services');
  await runSeed((await testDb()).db, demo, t.config);
  staff = await adminWith(t, ['suppliers:*', 'catalog:read', 'orders:read']);
});
afterAll(async () => {
  if (!frontendPresent) return;
  await resetDb();
  await clearIdentityCaches(t);
  await t.close();
  await closeTestDb();
});

describe.skipIf(!frontendPresent)('the suppliers seed', () => {
  it('writes the six demo suppliers with their ids, names, switch, hint and an encrypted dev-only key', async () => {
    const { db } = await testDb();
    const rows = await db.select().from(s.suppliers).orderBy(s.suppliers.id);
    expect(rows.map((row) => [row.id, row.name, row.status])).toEqual(
      demoSuppliers.map((supplier) => [
        Number(/\d+$/.exec(supplier.id)![0]),
        supplier.name,
        supplier.enabled ? 'active' : 'disabled',
      ]),
    );
    const nordic = rows.find((row) => row.name === 'Nordic GSM')!;
    expect(nordic).toMatchObject({
      driver: 'dhru',
      paramFormat: 'dhru_xml',
      baseUrl: 'https://api.nordicgsm.example',
      apiKeyHint: 'sk_57',
    });
    expect(rows.find((row) => row.name === 'Rapid IMEI')).toMatchObject({ driver: 'rest', paramFormat: 'json' });
    const encryption = t.app.get(EncryptionService, { strict: false });
    expect(encryption.decrypt(nordic.apiKeyEnc!, 'suppliers.api_key_enc')).toBe(demoSuppliers[0]!.key);
    expect(nordic.balance).toBe('1850.0000');
    expect(nordic.pricesSyncedAt).not.toBeNull();
  });

  it("links the demo's services to their primary and fallback suppliers in priority order and keeps their effective cost", async () => {
    const { db } = await testDb();
    const links = await db.select().from(s.serviceSupplierLinks);
    const expected = demoServices.reduce((total, service) => total + (service.fb ? 2 : 1), 0);
    expect(links).toHaveLength(expected);
    const first = demoServices[0]!;
    const chain = await staff.get(`/admin/suppliers/${Number(/\d+$/.exec(first.sup)![0])}`);
    expect(chain.body.links.find((link: { serviceId: number }) => link.serviceId === 1)).toMatchObject({
      priority: 1,
      cost: first.cost.toFixed(4),
      chain: [
        { priority: 1, supplierId: Number(/\d+$/.exec(first.sup)![0]) },
        { priority: 2, supplierId: Number(/\d+$/.exec(first.fb!)![0]) },
      ],
    });
    // The primary supplier's price equals the service cost, so linking did not move the cost the catalog seeded.
    const services = await db.select().from(s.services);
    for (const service of services) expect(service.effectiveCost).toBe(service.cost);
  });

  it("lists each supplier's services with three unimported ones, and a fallback that costs 8 % more than the primary", async () => {
    const { db } = await testDb();
    const rows = await db.select().from(s.supplierServices);
    expect(rows).toHaveLength(demoServices.reduce((total, service) => total + (service.fb ? 2 : 1), 0) + 18);
    const catalogue = await staff.get('/admin/suppliers/1/services?_end=100&imported=false');
    expect(catalogue.total).toBe(3);
    expect(catalogue.body.map((row: { name: string }) => row.name).sort()).toEqual([
      'Rogers Canada Unlock',
      'Sprint USA Premium Unlock',
      'Telstra Australia Unlock',
    ]);
    const fallback = demoServices.find((service) => service.fb !== null)!;
    const [fallbackLink] = await db
      .select({ credit: s.supplierServices.credit })
      .from(s.serviceSupplierLinks)
      .innerJoin(s.supplierServices, eq(s.supplierServices.id, s.serviceSupplierLinks.supplierServiceId))
      .where(eq(s.serviceSupplierLinks.serviceId, Number(/\d+$/.exec(fallback.id)![0])))
      .orderBy(s.serviceSupplierLinks.priority)
      .offset(1)
      .limit(1);
    expect(fallbackLink!.credit).toBe((fallback.cost * 1.08).toFixed(4));
  });

  it('links the seeded orders to their suppliers and writes the demo call log with outcomes', async () => {
    const { db } = await testDb();
    const linked = await db.select({ id: s.orders.id }).from(s.orders).where(eq(s.orders.supplierId, 1));
    expect(linked.length).toBeGreaterThan(0);
    const logs = await db.select().from(s.supplierApiLogs);
    expect(logs).toHaveLength(156);
    expect(new Set(logs.map((log) => log.action))).toEqual(new Set(['placeimeiorder', 'getimeiorder', 'accountinfo']));
    expect(logs.every((log) => (log.outcome === 'ok') === (log.error === ''))).toBe(true);
    expect(logs.filter((log) => log.action === 'accountinfo').every((log) => log.orderId === null)).toBe(true);
    const list = await staff.get('/admin/supplier-api-logs?_start=0&_end=25&_sort=createdAt&_order=desc');
    expect(list.total).toBe(156);
    expect(list.body).toHaveLength(25);
  });

  it('the suppliers page reads them: health, counts and the balance verdict', async () => {
    const list = await staff.get('/admin/suppliers?_end=200');
    expect(list.total).toBe(6);
    const gulf = list.body.find((row: { name: string }) => row.name === 'Gulf Server Hub');
    // 38.40 left, alert 150: low.
    expect(gulf).toMatchObject({ lowBalance: true, balance: '38.4000', apiKeyHint: 'sk_91' });
    for (const row of list.body) {
      expect(['up', 'degraded', 'down']).toContain(row.health);
      expect(row.creditRate).toMatch(/^\d+\.\d{8}$/);
    }
    expect(list.body.reduce((total: number, row: { openOrders: number }) => total + row.openOrders, 0)).toBeGreaterThan(
      0,
    );
  });

  it('is idempotent: a second run writes nothing', async () => {
    const { db } = await testDb();
    const reports = await runSeed(db, await loadDemoState(), t.config);
    const mine = reports.filter((report) =>
      ['suppliers', 'supplier_services', 'service_supplier_links', 'supplier_api_logs'].includes(report.table),
    );
    expect(mine).toHaveLength(4);
    for (const report of mine) expect(report.inserted).toBe(0);
  });
});
