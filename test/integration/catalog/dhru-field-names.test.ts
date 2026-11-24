// Integration test of the field names in the Dhru service list (decision 065): `fieldname` is the field's Name and `description` its
// label, and an IMEI service leaves its flagged main-input field out.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import { eq } from 'drizzle-orm';
import { schema as s } from '@src/infra/db';
import { type TestApp, createTestApp } from '../../support/app';
import { clearIdentityCaches } from '../../support/auth';
import { closeTestDb, resetDb, testDb } from '../../support/db';
import { type MachineCredentials, clearApiKeyCaches, credentialsFor, dhruClient } from '../../support/machine-orders';
import { type OrdersWorld, ordersWorld } from '../../support/orders';

let t: TestApp;
let world: OrdersWorld;
let dhru: ReturnType<typeof dhruClient>;
let creds: MachineCredentials;

beforeAll(async () => {
  t = await createTestApp();
});
afterAll(async () => {
  await resetDb();
  await t.close();
  await closeTestDb();
});
beforeEach(async () => {
  await resetDb();
  await clearIdentityCaches(t);
  await clearApiKeyCaches(t);
  const { db } = await testDb();
  world = await ordersWorld(db);
  creds = await credentialsFor(t, db, world.merchant.id);
  dhru = dhruClient(t, creds);
});

type Custom = { fieldname: string; description: string; type: string; required: number };

/** The `Requires.Custom` list of a service as the merchant's Dhru client reads it. */
async function customOf(serviceId: number, group: 'Carrier unlock' | 'Server credits'): Promise<Custom[]> {
  const answer = await dhru.call('imeiservicelist');
  return answer.SUCCESS[0].LIST[group].SERVICES[String(serviceId)]['Requires.Custom'];
}

describe('imeiservicelist field names', () => {
  it('publishes the Name as fieldname and the label as description, not the hidden key', async () => {
    const { db } = await testDb();
    await db
      .update(s.serviceFields)
      .set({ supplierKey: 'Account User', label: 'Your account name' })
      .where(eq(s.serviceFields.serviceId, world.server.serviceId));
    const custom = await customOf(world.server.serviceId, 'Server credits');
    expect(custom).toEqual([
      expect.objectContaining({
        type: 'serviceserver',
        fieldname: 'Account User',
        description: 'Your account name',
        required: 1,
      }),
    ]);
    expect(JSON.stringify(custom)).not.toContain('"username"');
  });

  it('leaves the main-input field of an IMEI service out, whatever its key and Name, and keeps the others', async () => {
    const { db } = await testDb();
    await db.insert(s.serviceFields).values([
      {
        serviceId: world.auto.serviceId,
        key: 'serial',
        label: 'Device',
        supplierKey: 'Device',
        isMainInput: true,
        sort: 0,
      },
      { serviceId: world.auto.serviceId, key: 'carrier', label: 'Carrier', supplierKey: 'Carrier Name', sort: 1 },
    ]);
    const custom = await customOf(world.auto.serviceId, 'Carrier unlock');
    expect(custom.map((field) => [field.fieldname, field.description])).toEqual([['Carrier Name', 'Carrier']]);
  });

  it('does not decide by the key: an IMEI service keeps an unflagged field keyed imei', async () => {
    const { db } = await testDb();
    await db.insert(s.serviceFields).values({
      serviceId: world.auto.serviceId,
      key: 'imei',
      label: 'Second IMEI',
      supplierKey: 'IMEI 2',
    });
    const custom = await customOf(world.auto.serviceId, 'Carrier unlock');
    expect(custom.map((field) => field.fieldname)).toEqual(['IMEI 2']);
  });

  it('keeps the main-input field of a server service, which has no IMEI box', async () => {
    const { db } = await testDb();
    await db.insert(s.serviceFields).values({
      serviceId: world.server.serviceId,
      key: 'device',
      label: 'Device',
      supplierKey: 'Device',
      isMainInput: true,
      sort: 0,
    });
    const custom = await customOf(world.server.serviceId, 'Server credits');
    expect(custom.map((field) => field.fieldname)).toEqual(['Device', 'username']);
  });
});
