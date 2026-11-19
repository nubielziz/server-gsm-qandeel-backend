// A buyer reads the title the shop published, not the supplier's name (feature 31, the final review): the checkout session, the order
// tracking page, the orders of the store account and the facts the receipts and the customer's mails are written from. Real Postgres and
// Redis, through the routes where a route shows the name.
import { afterAll, beforeAll, beforeEach, describe, expect, it, setDefaultTimeout } from 'bun:test';
import { eq } from 'drizzle-orm';
import { DbService, schema as s } from '../../src/infra/db';
import { StorefrontServices } from '../../src/modules/catalog';
import { loadOrderFacts } from '../../src/modules/money/infra/b2c-reads.repository';
import { type TestApp, createTestApp } from '../support/app';
import { clearIdentityCaches } from '../support/auth';
import { type B2cWorld, json, openCheckout } from '../support/b2c';
import { closeTestDb, resetDb, testDb } from '../support/db';
import { insertOrderRow } from '../support/orders';
import { freshClientIp } from '../support/pipeline-routes';
import { StoreClient, clearStoreRateLimits, makeCustomer } from '../support/store';
import { APPLE_IMEI, type StorefrontWorld, storefrontWorld } from '../support/storefront';

setDefaultTimeout(60_000);

/** What the shop calls the iCloud service; the catalog still calls it `iCloud Clean / Lost Check`. */
const TITLE = 'iCloud Clean Report';
/** The catalog name of the AT&T service, which loses its listing below. */
const CATALOG_NAME = 'AT&T USA Premier Unlock';

let t: TestApp;
let db: Awaited<ReturnType<typeof testDb>>['db'];
let world: StorefrontWorld;

beforeAll(async () => {
  t = await createTestApp();
  ({ db } = await testDb());
});
beforeEach(async () => {
  await resetDb();
  await clearIdentityCaches(t);
  await clearStoreRateLimits(t);
  world = await storefrontWorld(db);
  await db
    .update(s.serviceListings)
    .set({ publicTitle: TITLE })
    .where(eq(s.serviceListings.id, world.icloud.listingId));
  await db.delete(s.serviceListings).where(eq(s.serviceListings.id, world.att.listingId));
});
afterAll(async () => {
  await resetDb();
  await clearIdentityCaches(t);
  await t.close();
  await closeTestDb();
});

const storeOrder = (serviceId: number, customerId: number, token: string) =>
  insertOrderRow(db, {
    serviceId,
    customerId,
    source: 'store',
    imei: APPLE_IMEI,
    publicToken: token,
    status: 'pending',
    currency: 'GBP',
  });

describe('the name a buyer reads', () => {
  it('is the listing title in a checkout session, when it opens and when it is read again', async () => {
    const { token, session } = await openCheckout(t, world as unknown as B2cWorld, { consent: false });

    expect(session.service.name).toBe(TITLE);
    const again = await t.app.inject({
      method: 'GET',
      url: `/store/v1/checkout-sessions/${token}`,
      remoteAddress: freshClientIp(),
    });
    expect(again.statusCode).toBe(200);
    expect(json(again).service.name).toBe(TITLE);
  });

  it('is the listing title on the tracking page, and the catalog name of a service with no listing', async () => {
    const customer = await makeCustomer(t);
    await storeOrder(world.icloud.serviceId, customer.id, 'TrackedWithListing00001');
    await storeOrder(world.att.serviceId, customer.id, 'TrackedNoListing0000002');

    const track = (token: string) =>
      t.app.inject({ method: 'GET', url: `/store/v1/orders/${token}`, remoteAddress: freshClientIp() });

    expect(json(await track('TrackedWithListing00001')).service).toMatchObject({ name: TITLE, type: 'imei' });
    expect(json(await track('TrackedNoListing0000002')).service.name).toBe(CATALOG_NAME);
  });

  it('is the listing title in the orders of the store account, and the catalog name without a listing', async () => {
    const customer = await makeCustomer(t);
    const listed = await storeOrder(world.icloud.serviceId, customer.id, 'AccountWithListing00001');
    const unlisted = await storeOrder(world.att.serviceId, customer.id, 'AccountNoListing0000002');
    const client = new StoreClient(t, freshClientIp());
    expect((await client.login(customer.email)).statusCode).toBe(200);

    const res = await client.orders();

    expect(res.statusCode).toBe(200);
    const rows = res.json<Array<{ id: number; service: { id: number; name: string } }>>();
    expect(rows.find((row) => row.id === listed.id)?.service).toEqual({
      id: world.icloud.serviceId,
      name: TITLE,
    });
    expect(rows.find((row) => row.id === unlisted.id)?.service.name).toBe(CATALOG_NAME);
  });

  it('is the listing title in the facts the receipts and the mails are written from', async () => {
    const customer = await makeCustomer(t);
    const listed = await storeOrder(world.icloud.serviceId, customer.id, 'FactsWithListing0000001');
    const unlisted = await storeOrder(world.att.serviceId, customer.id, 'FactsNoListing000000002');

    const facts = await loadOrderFacts(db, [listed.id, unlisted.id]);

    expect(facts.get(listed.id)?.serviceName).toBe(TITLE);
    expect(facts.get(unlisted.id)?.serviceName).toBe(CATALOG_NAME);
  });

  it('is what the catalog hands the checkout: the title, else the name, with the rest of the service', async () => {
    const names = await t.app
      .get(StorefrontServices, { strict: false })
      .names(t.app.get(DbService, { strict: false }).db, [world.icloud.serviceId, world.att.serviceId]);

    expect(names.get(world.icloud.serviceId)).toMatchObject({ name: TITLE, type: 'imei', deliveryTime: '2 minutes' });
    expect(names.get(world.att.serviceId)?.name).toBe(CATALOG_NAME);
  });
});
