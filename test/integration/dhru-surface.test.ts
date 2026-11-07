// Integration tests of the Dhru Fusion surface (feature 7a, decision 026) on the real application: the eight actions with their wire, the
// refusals in the envelope, the price guard, multipart calls, the duplicate rule and concurrency on one wallet.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import { eq } from 'drizzle-orm';
import { schema as s } from '../../src/infra/db';
import { DbService } from '../../src/infra/db';
import { OrderTransitions } from '../../src/modules/orders';
import { MaintenanceService } from '../../src/modules/platform';
import { type TestApp, createTestApp } from '../support/app';
import { clearIdentityCaches } from '../support/auth';
import { insertCategory, insertService } from '../support/catalog';
import { TestClock } from '../support/clock';
import { closeTestDb, resetDb, testDb } from '../support/db';
import {
  type MachineCredentials,
  body,
  clearApiKeyCaches,
  credentialsFor,
  dhruClient,
} from '../support/machine-orders';
import {
  IMEIS,
  type OrdersWorld,
  eventsOf,
  ledgerOf,
  orderRow,
  ordersWorld,
  outboxOf,
  walletOf,
} from '../support/orders';

const clock = new TestClock();
let t: TestApp;
let world: OrdersWorld;
let creds: MachineCredentials;
let dhru: ReturnType<typeof dhruClient>;

beforeAll(async () => {
  t = await createTestApp({ clock });
});
afterAll(async () => {
  await resetDb();
  await t.close();
  await closeTestDb();
});
beforeEach(async () => {
  clock.reset();
  await resetDb();
  await clearIdentityCaches(t);
  await clearApiKeyCaches(t);
  await t.app.get(MaintenanceService).invalidate();
  const { db } = await testDb();
  world = await ordersWorld(db);
  creds = await credentialsFor(t, db, world.merchant.id);
  dhru = dhruClient(t, creds);
});

const ENVELOPE_KEYS = ['SUCCESS', 'apiversion'];

/** The message of an ERROR answer. */
const messageOf = (answer: { ERROR?: Array<{ MESSAGE: string }> }) => answer.ERROR?.[0]?.MESSAGE;

/** Lists the services (so the merchant has seen the prices) and places one IMEI order; returns the answer. */
async function place(serviceId: number, imei: string = IMEIS[0], extra: Record<string, unknown> = {}) {
  return dhru.call('placeimeiorder', { ID: serviceId, IMEI: imei, ...extra });
}

/** Moves an order the way staff or the supplier jobs do. */
async function move(
  orderId: number,
  action: { kind: 'accept' } | { kind: 'reply' } | { kind: 'reject' },
  text = 'done',
) {
  const db = t.app.get(DbService, { strict: false });
  await db.runInTransaction(({ tx }) =>
    t.app.get(OrderTransitions).apply(tx, {
      orderId,
      action,
      actor: { type: 'staff', id: 1 },
      ...(action.kind === 'reply' ? { code: text } : action.kind === 'reject' ? { reason: text } : {}),
    }),
  );
}

describe('every answer on the surface', () => {
  it('is HTTP 200 JSON with the Dhru headers and the SUCCESS list, form encoded or JSON', async () => {
    for (const as of ['form', 'json'] as const) {
      const res = await dhru.raw('accountinfo', undefined, { as });
      expect(res.statusCode, as).toBe(200);
      expect(res.headers['content-type'], as).toBe('application/json; charset=utf-8');
      expect(res.headers['x-powered-by'], as).toBe('DHRU-FUSION');
      expect(res.headers['dhru-fusion-api-version'], as).toBe('6.1');
      expect(Object.keys(body(res)).sort(), as).toEqual([...ENVELOPE_KEYS].sort());
      expect(body(res).apiversion).toBe('6.1');
    }
  });

  it('answers an unknown or missing action "Invalid Action", and parameters that cannot be read "Invalid parameters"', async () => {
    for (const action of ['nope', '', 'PLACEIMEIORDERS']) {
      expect(messageOf(await dhru.call(action)), action).toBe('Invalid Action');
    }
    const bad = await dhru.raw('getimeiorder', undefined, { as: 'json' });
    expect(messageOf(body(bad))).toBe('ID: Must be a number.');
    const notBase64 = await t.app.inject({
      method: 'POST',
      url: '/api/index.php',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      payload: new URLSearchParams({
        username: creds.username,
        apiaccesskey: creds.key,
        action: 'getimeiorder',
        parameters: '%%%not base64%%%',
      }).toString(),
    });
    expect(notBase64.statusCode).toBe(200);
    expect(messageOf(body(notBase64))).toBe('Invalid parameters');
    const notAnObject = await t.app.inject({
      method: 'POST',
      url: '/api/index.php',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      payload: new URLSearchParams({
        username: creds.username,
        apiaccesskey: creds.key,
        action: 'getimeiorder',
        parameters: Buffer.from('[1,2]').toString('base64'),
      }).toString(),
    });
    expect(messageOf(body(notAnObject))).toBe('Invalid parameters');
  });

  it('reads a base64 text whose + signs arrived as spaces (an unescaped form)', async () => {
    // `{"ID":"?>>"}` encodes with + and / in base64; a client that did not escape the plus sends a space.
    const parameters = Buffer.from('{"ID":"?>>"}').toString('base64').replace(/\+/g, ' ');
    const res = await t.app.inject({
      method: 'POST',
      url: '/api/index.php',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      payload: `username=${creds.username}&apiaccesskey=${creds.key}&action=getimeiorder&parameters=${parameters}`,
    });
    // The text was read as base64 of an object: the problem is the id, not the encoding.
    expect(messageOf(body(res))).toContain('ID:');
  });
});

describe('accountinfo', () => {
  it('answers the available balance (balance plus credit limit), the email and the currency with the spelling of the standard', async () => {
    const { db } = await testDb();
    await db
      .update(s.ledgerAccounts)
      .set({ overdraftLimit: '25.0000' })
      .where(eq(s.ledgerAccounts.ownerId, world.merchant.id));
    const answer = await dhru.call('accountinfo');
    const [client] = await db
      .select({ email: s.clients.email })
      .from(s.clients)
      .where(eq(s.clients.id, world.merchant.id));
    expect(answer.SUCCESS).toHaveLength(1);
    expect(answer.SUCCESS[0]).toEqual({
      message: 'Your Accout Info',
      AccoutInfo: { credit: '125.0000', mail: client!.email, currency: 'USD' },
    });
  });

  it('follows the wallet: an order lowers the credit by its price', async () => {
    const placed = await place(world.auto.serviceId);
    expect(placed.SUCCESS).toBeDefined();
    expect((await dhru.call('accountinfo')).SUCCESS[0].AccoutInfo.credit).toBe('82.7200');
  });
});

describe('imeiservicelist', () => {
  it('groups the merchant services by category with the merchant price, the quantity rules and the custom fields', async () => {
    const answer = await dhru.call('imeiservicelist');
    const entry = answer.SUCCESS[0];
    expect(entry.MESSAGE).toBe('IMEI Service List');
    expect(Object.keys(entry.LIST).sort()).toEqual(['Carrier unlock', 'Server credits']);
    const unlock = entry.LIST['Carrier unlock'];
    expect(unlock).toMatchObject({ GROUPNAME: 'Carrier unlock', GROUPTYPE: 'IMEI' });
    const auto = unlock.SERVICES[String(world.auto.serviceId)];
    expect(auto).toMatchObject({
      SERVICEID: String(world.auto.serviceId),
      SERVICETYPE: 'IMEI',
      SERVICENAME: 'AT&T USA Premier Unlock',
      CREDIT: '17.2800',
      INFO: '',
      QNT: '0',
      QNTOPTIONS: '',
      MINQNT: '1',
      MAXQNT: '1',
      'Requires.Network': 'None',
      'Requires.Custom': [],
    });
    const server = entry.LIST['Server credits'];
    expect(server.GROUPTYPE).toBe('SERVER');
    expect(server.SERVICES[String(world.server.serviceId)]['Requires.Custom']).toEqual([
      {
        type: 'serviceserver',
        fieldname: 'username',
        fieldtype: 'text',
        description: 'Username',
        fieldoptions: '',
        required: 1,
      },
    ]);
  });

  it('never lists a disabled or archived service, a File service or a category the merchant group may not see', async () => {
    const { db } = await testDb();
    await db.update(s.services).set({ status: 'disabled' }).where(eq(s.services.id, world.manual.serviceId));
    await db
      .update(s.services)
      .set({ status: 'disabled', archivedAt: new Date() })
      .where(eq(s.services.id, world.server.serviceId));
    const fileCategory = await insertCategory(db, { name: 'Files', type: 'file' });
    await insertService(db, fileCategory, { type: 'file', name: 'Firmware file', code: 'FILE-1' });
    const [client] = await db
      .select({ groupId: s.clients.groupId })
      .from(s.clients)
      .where(eq(s.clients.id, world.merchant.id));
    const hidden = await insertCategory(db, { name: 'Staff only', allowedGroupIds: [client!.groupId + 1000] });
    await insertService(db, hidden, { name: 'Hidden service', code: 'HID-1' });
    const list = (await dhru.call('imeiservicelist')).SUCCESS[0].LIST;
    expect(Object.keys(list)).toEqual(['Carrier unlock']);
    expect(Object.keys(list['Carrier unlock'].SERVICES)).toEqual([String(world.auto.serviceId)]);
  });

  it('remembers the prices it showed (user rule 9) and gives the quantity packs of a service', async () => {
    const { db } = await testDb();
    await db
      .update(s.services)
      .set({ qtyOptions: [5, 10], minQty: 5, maxQty: 10 })
      .where(eq(s.services.id, world.auto.serviceId));
    const service = (await dhru.call('imeiservicelist')).SUCCESS[0].LIST['Carrier unlock'].SERVICES[
      String(world.auto.serviceId)
    ];
    expect(service).toMatchObject({ QNT: '1', QNTOPTIONS: '5,10', MINQNT: '5', MAXQNT: '10' });
    const listed = await db.select().from(s.listedPrices).where(eq(s.listedPrices.clientId, world.merchant.id));
    expect(listed.map((row) => [row.serviceId, row.price]).sort()).toContainEqual([world.auto.serviceId, '17.2800']);
  });
});

describe('placeimeiorder', () => {
  it('answers the order id at once and holds the price (scenario success, merchant steps 1 and 2)', async () => {
    const { db } = await testDb();
    const answer = await place(world.auto.serviceId);
    expect(answer.SUCCESS).toHaveLength(1);
    const entry = answer.SUCCESS[0];
    expect(Object.keys(entry).sort()).toEqual(['MESSAGE', 'REFERENCEID']);
    expect(entry.MESSAGE).toBe('Order received');
    expect(typeof entry.REFERENCEID).toBe('string');
    const orderId = Number(entry.REFERENCEID);
    const row = await orderRow(db, orderId);
    expect(row).toMatchObject({
      clientId: world.merchant.id,
      serviceId: world.auto.serviceId,
      source: 'dhru',
      apiKeyId: creds.keyId,
      status: 'pending',
      dispatchState: 'pending',
      imei: IMEIS[0],
      totalPrice: '17.2800',
    });
    expect((await eventsOf(db, orderId)).map((event) => [event.type, event.actorType])).toEqual([
      ['created', 'client'],
      ['hold', 'system'],
    ]);
    expect((await eventsOf(db, orderId))[0]!.data).toMatchObject({ message: 'Order received via Dhru API' });
    expect(await ledgerOf(db, orderId)).toEqual([{ kind: 'order_hold', key: `order:${orderId}:hold` }]);
    expect(await walletOf(db, world.merchant.id)).toEqual({ wallet: '82.7200', hold: '17.2800' });
    expect(await outboxOf(db, 'order.dispatch_requested', orderId)).toHaveLength(1);
    // The merchant's status call reads STATUS 0 (new) with an empty CODE.
    expect((await dhru.call('getimeiorder', { ID: entry.REFERENCEID })).SUCCESS[0]).toEqual({ STATUS: 0, CODE: '' });
  });

  it('places a server service with its custom fields (CUSTOMFIELD as base64 JSON, or as an object)', async () => {
    const { db } = await testDb();
    const field = Buffer.from(JSON.stringify({ username: 'ahmad77' })).toString('base64');
    const first = await dhru.call('placeimeiorder', { ID: world.server.serviceId, CUSTOMFIELD: field });
    expect(first.SUCCESS).toBeDefined();
    expect(await orderRow(db, Number(first.SUCCESS[0].REFERENCEID))).toMatchObject({
      type: 'server',
      imei: 'ahmad77',
      inputs: { username: 'ahmad77' },
    });
    const second = await dhru.call('placeimeiorder', {
      ID: world.server.serviceId,
      CUSTOMFIELD: { username: 'sami88' },
    });
    expect((await orderRow(db, Number(second.SUCCESS[0].REFERENCEID))).imei).toBe('sami88');
    const missing = await dhru.call('placeimeiorder', { ID: world.server.serviceId });
    expect(messageOf(missing)).toBe('Username is required.');
    const typo = await dhru.call('placeimeiorder', { ID: world.server.serviceId, CUSTOMFIELD: { usrname: 'x' } });
    expect(messageOf(typo)).toBe('This service has no such field.');
  });

  it('refuses in the envelope: an invalid IMEI, an unknown or a disabled service, a missing parameter', async () => {
    const { db } = await testDb();
    expect(messageOf(await place(world.auto.serviceId, '123456789012345'))).toContain('IMEI is not valid');
    expect(messageOf(await place(world.auto.serviceId, ''))).toBe('Enter the IMEI.');
    expect(messageOf(await place(999_999))).toBe('No service with this id is available to you.');
    await db.update(s.services).set({ status: 'disabled' }).where(eq(s.services.id, world.auto.serviceId));
    expect(messageOf(await place(world.auto.serviceId))).toBe('This service is turned off. Choose another service.');
    expect(messageOf(await dhru.call('placeimeiorder', { IMEI: IMEIS[0] }))).toContain('ID:');
    expect(await db.select().from(s.orders)).toHaveLength(0);
    expect(await walletOf(db, world.merchant.id)).toEqual({ wallet: '100.0000', hold: '0.0000' });
  });

  it('refuses a File service here and an IMEI service in placefileorder, naming the right action', async () => {
    const { db } = await testDb();
    const category = await insertCategory(db, { name: 'Files', type: 'file' });
    const fileService = await insertService(db, category, {
      type: 'file',
      name: 'Firmware',
      code: 'FILE-2',
      basePrice: '3.0000',
    });
    expect(messageOf(await place(fileService))).toBe('This service takes a file: place it with placefileorder.');
    const wrong = await dhru.call('placefileorder', { ID: world.auto.serviceId, FILENAME: 'a.bin', FILEDATA: 'AAEC' });
    expect(messageOf(wrong)).toBe('This service does not take a file: place it with placeimeiorder.');
  });

  it('answers a service hidden from the merchant group exactly like an unknown one, whatever its type', async () => {
    const { db } = await testDb();
    const [client] = await db
      .select({ groupId: s.clients.groupId })
      .from(s.clients)
      .where(eq(s.clients.id, world.merchant.id));
    const otherGroups = [client!.groupId + 1000];
    const hiddenFiles = await insertCategory(db, { name: 'Staff files', type: 'file', allowedGroupIds: otherGroups });
    const hiddenFile = await insertService(db, hiddenFiles, {
      type: 'file',
      name: 'Hidden firmware',
      code: 'HID-FILE',
    });
    const hiddenUnlocks = await insertCategory(db, { name: 'Staff unlocks', allowedGroupIds: otherGroups });
    const hiddenImei = await insertService(db, hiddenUnlocks, { name: 'Hidden unlock', code: 'HID-IMEI' });
    const unknown = messageOf(await place(999_999));
    // Neither action may reveal that the service exists or which kind it is.
    expect(messageOf(await place(hiddenFile))).toBe(unknown);
    const file = await dhru.call('placefileorder', { ID: hiddenImei, FILENAME: 'a.bin', FILEDATA: 'AAEC' });
    expect(messageOf(file)).toBe(unknown);
  });

  it('says "Not enough credits" when the balance cannot cover the price, and holds nothing', async () => {
    const { db } = await testDb();
    const poor = await credentialsFor(t, db, (await ordersWorldMerchant(db, 'Poor Co', '10')).id);
    const answer = await dhruClient(t, poor).call('placeimeiorder', { ID: world.auto.serviceId, IMEI: IMEIS[0] });
    expect(answer).toEqual({ ERROR: [{ MESSAGE: 'Not enough credits' }], apiversion: '6.1' });
    expect(await walletOf(db, poor.clientId)).toEqual({ wallet: '10.0000', hold: '0.0000' });
    expect(await db.select().from(s.orders).where(eq(s.orders.clientId, poor.clientId))).toHaveLength(0);
  });

  it('refuses a second open order for the same service and IMEI (the duplicate rule), and allows it once the first is closed', async () => {
    const { db } = await testDb();
    const first = await place(world.auto.serviceId);
    const again = await place(world.auto.serviceId);
    expect(messageOf(again)).toBe(
      `You already have an open order for this service and input (order ${first.SUCCESS[0].REFERENCEID}).`,
    );
    expect(await db.select().from(s.orders)).toHaveLength(1);
    await move(Number(first.SUCCESS[0].REFERENCEID), { kind: 'reject' }, 'Wrong IMEI');
    expect((await place(world.auto.serviceId)).SUCCESS).toBeDefined();
  });

  it('never lets parallel placements on one wallet overspend, and places each IMEI once under the duplicate rule', async () => {
    const { db } = await testDb();
    // 100 USD at 17.28: five orders fit (86.40), the sixth would take the balance to -3.20.
    const imeis = [...IMEIS, '352099001761481', '490154203237518', '356938035643809'];
    const answers = await Promise.all(imeis.map((imei) => place(world.auto.serviceId, imei)));
    const placed = answers.filter((answer) => answer.SUCCESS);
    const refused = answers.filter((answer) => answer.ERROR);
    expect(placed).toHaveLength(5);
    expect(refused.map(messageOf)).toEqual(Array(3).fill('Not enough credits'));
    expect(await walletOf(db, world.merchant.id)).toEqual({ wallet: '13.6000', hold: '86.4000' });
    // The same IMEI four times at once: one order, three refusals.
    const merchant = await credentialsFor(t, db, (await ordersWorldMerchant(db, 'Rich Co', '500')).id);
    const rich = dhruClient(t, merchant);
    const race = await Promise.all(
      Array.from({ length: 4 }, () => rich.call('placeimeiorder', { ID: world.auto.serviceId, IMEI: IMEIS[0] })),
    );
    expect(race.filter((answer) => answer.SUCCESS)).toHaveLength(1);
    expect(race.filter((answer) => answer.ERROR)).toHaveLength(3);
    expect(await walletOf(db, merchant.clientId)).toEqual({ wallet: '482.7200', hold: '17.2800' });
  });
});

describe('the price guard (user rule 9)', () => {
  it('refuses an order more than the tolerance above the listed price, with the exact message, until the list is read again', async () => {
    const { db } = await testDb();
    await dhru.call('imeiservicelist');
    await db.update(s.services).set({ basePrice: '25.0000' }).where(eq(s.services.id, world.auto.serviceId));
    const refused = await place(world.auto.serviceId);
    expect(refused).toEqual({
      ERROR: [{ MESSAGE: 'Price changed. Please refresh the service list and order again.' }],
      apiversion: '6.1',
    });
    expect(await db.select().from(s.orders)).toHaveLength(0);
    // The merchant reads the list again (the new price is listed) and orders at it.
    const list = (await dhru.call('imeiservicelist')).SUCCESS[0].LIST['Carrier unlock'].SERVICES[
      String(world.auto.serviceId)
    ];
    expect(list.CREDIT).toBe('25.0000');
    const placed = await place(world.auto.serviceId);
    expect(await orderRow(db, Number(placed.SUCCESS[0].REFERENCEID))).toMatchObject({ totalPrice: '25.0000' });
  });

  it('charges a small raise and records it in the pricing snapshot', async () => {
    const { db } = await testDb();
    await dhru.call('imeiservicelist');
    await db.update(s.services).set({ basePrice: '18.0000' }).where(eq(s.services.id, world.auto.serviceId));
    const placed = await place(world.auto.serviceId);
    const row = await orderRow(db, Number(placed.SUCCESS[0].REFERENCEID));
    expect(row.totalPrice).toBe('18.0000');
    expect(row.pricingSnapshot).toMatchObject({ raised: true, listedPrice: '17.2800' });
  });
});

describe('placeimeiorderbulk', () => {
  it('answers each request id on its own: placed orders and refusals side by side', async () => {
    const { db } = await testDb();
    const answer = await dhru.call('placeimeiorderbulk', {
      a1: { ID: world.auto.serviceId, IMEI: IMEIS[0] },
      b2: { ID: world.auto.serviceId, IMEI: '123' },
      c3: { ID: world.manual.serviceId, IMEI: IMEIS[1] },
      d4: { ID: world.auto.serviceId, IMEI: IMEIS[0] },
    });
    expect(Object.keys(answer).sort()).toEqual(['a1', 'apiversion', 'b2', 'c3', 'd4']);
    expect(answer.apiversion).toBe('6.1');
    expect(answer.a1.SUCCESS[0]).toMatchObject({ MESSAGE: 'Order received' });
    expect(messageOf(answer.b2)).toContain('IMEI is not valid');
    expect(answer.c3.SUCCESS[0].MESSAGE).toBe('Order received');
    // The fourth item repeats the first IMEI of the same call: the first order is open.
    expect(messageOf(answer.d4)).toContain('You already have an open order');
    expect(await db.select().from(s.orders)).toHaveLength(2);
    expect(await walletOf(db, world.merchant.id)).toEqual({ wallet: '77.7200', hold: '22.2800' });
  });

  it('refuses a call with no items, more than 100 items and the reserved id apiversion', async () => {
    expect(messageOf(await dhru.call('placeimeiorderbulk', {}))).toBe('Send at least one item.');
    const many = Object.fromEntries(
      Array.from({ length: 101 }, (_, index) => [`r${index}`, { ID: 1, IMEI: IMEIS[0] }]),
    );
    expect(messageOf(await dhru.call('placeimeiorderbulk', many))).toBe('At most 100 items per call.');
    expect(messageOf(await dhru.call('placeimeiorderbulk', { apiversion: { ID: 1 } }))).toBe(
      'apiversion is not a valid item id.',
    );
  });

  it('counts a refused item under its error code and still answers 200', async () => {
    const res = await dhru.raw('placeimeiorderbulk', { a: { ID: world.auto.serviceId, IMEI: '1' } });
    expect(res.statusCode).toBe(200);
    expect(messageOf(body(res).a)).toContain('IMEI is not valid');
  });
});

describe('getimeiorder and getimeiorderbulk', () => {
  it('reads STATUS 0, 1, 4 and 3 with the CODE (scenarios success, reject and manual, merchant step: getimeiorder)', async () => {
    const { db } = await testDb();
    const completed = Number((await place(world.auto.serviceId, IMEIS[0])).SUCCESS[0].REFERENCEID);
    const rejected = Number((await place(world.auto.serviceId, IMEIS[1])).SUCCESS[0].REFERENCEID);
    const manual = Number((await place(world.manual.serviceId, IMEIS[2])).SUCCESS[0].REFERENCEID);
    expect((await dhru.call('getimeiorder', { ID: manual })).SUCCESS[0]).toEqual({ STATUS: 0, CODE: '' });
    await move(manual, { kind: 'accept' });
    expect((await dhru.call('getimeiorder', { ID: manual })).SUCCESS[0]).toEqual({ STATUS: 1, CODE: '' });
    await move(completed, { kind: 'reply' }, 'Unlocked: code 8842 1113');
    await move(rejected, { kind: 'reject' }, 'Not supported');
    expect((await dhru.call('getimeiorder', { ID: String(completed) })).SUCCESS[0]).toEqual({
      STATUS: 4,
      CODE: 'Unlocked: code 8842 1113',
    });
    expect((await dhru.call('getimeiorder', { ID: rejected })).SUCCESS[0]).toEqual({
      STATUS: 3,
      CODE: 'Not supported',
    });
    expect(await walletOf(db, world.merchant.id)).toMatchObject({ hold: '5.0000' });
    const bulk = await dhru.call('getimeiorderbulk', {
      x: { ID: completed },
      y: { ID: rejected },
      z: { ID: 999_999 },
      w: { ID: manual },
    });
    expect(bulk.x.SUCCESS[0]).toEqual({ STATUS: 4, CODE: 'Unlocked: code 8842 1113' });
    expect(bulk.y.SUCCESS[0]).toEqual({ STATUS: 3, CODE: 'Not supported' });
    expect(messageOf(bulk.z)).toBe('Order not found');
    expect(bulk.w.SUCCESS[0]).toEqual({ STATUS: 1, CODE: '' });
    expect(bulk.apiversion).toBe('6.1');
  });

  it("never shows another merchant's order, and answers an unknown id the same way", async () => {
    const { db } = await testDb();
    const other = await credentialsFor(t, db, world.other.id);
    const theirs = Number(
      (await dhruClient(t, other).call('placeimeiorder', { ID: world.auto.serviceId, IMEI: IMEIS[3] })).SUCCESS[0]
        .REFERENCEID,
    );
    expect(messageOf(await dhru.call('getimeiorder', { ID: theirs }))).toBe('Order not found');
    expect(messageOf(await dhru.call('getimeiorder', { ID: 999_999 }))).toBe('Order not found');
  });
});

describe('file orders', () => {
  async function fileService() {
    const { db } = await testDb();
    const category = await insertCategory(db, { name: 'Files', type: 'file' });
    return insertService(db, category, { type: 'file', name: 'Firmware flash', code: 'FILE-3', basePrice: '3.0000' });
  }

  it('places a file order with FILEDATA, stores the file for the merchant and reads the result with getfileorder', async () => {
    const { db } = await testDb();
    const serviceId = await fileService();
    const answer = await dhru.call('placefileorder', {
      ID: serviceId,
      FILENAME: '../../etc/firmware.bin',
      FILEDATA: Buffer.from('firmware bytes').toString('base64'),
    });
    expect(answer.SUCCESS[0].MESSAGE).toBe('Order received');
    const orderId = Number(answer.SUCCESS[0].REFERENCEID);
    const row = await orderRow(db, orderId);
    expect(row).toMatchObject({ type: 'file', source: 'dhru', imei: 'firmware.bin' });
    expect(row.inputFileId).not.toBeNull();
    const [file] = await db.select().from(s.files).where(eq(s.files.id, row.inputFileId!));
    expect(file).toMatchObject({ filename: 'firmware.bin', size: 14, ownerType: 'client', ownerId: world.merchant.id });
    // A result file: staff attach it, the merchant reads its id.
    const [result] = await db
      .insert(s.files)
      .values({
        bucket: file!.bucket,
        key: 'files/test/result',
        filename: 'result.zip',
        mime: 'application/zip',
        size: 3,
        sha256: 'aa',
        ownerType: 'staff',
        ownerId: 1,
      })
      .returning({ id: s.files.id });
    await db.update(s.orders).set({ resultFileId: result!.id }).where(eq(s.orders.id, orderId));
    await move(orderId, { kind: 'reply' }, 'Done');
    expect((await dhru.call('getfileorder', { ID: orderId })).SUCCESS[0]).toEqual({
      STATUS: 4,
      CODE: 'Done',
      FILEID: result!.id,
    });
    // Without a result file the key is left out.
    const plain = await dhru.call('getfileorder', { ID: orderId + 1000 });
    expect(messageOf(plain)).toBe('Order not found');
  });

  it('accepts the file as a part of a multipart call, with the credentials in the same body', async () => {
    const { db } = await testDb();
    const serviceId = await fileService();
    const res = await dhru.multipart(
      'placefileorder',
      { ID: serviceId },
      { name: 'flash.bin', type: 'application/octet-stream', data: new Uint8Array([1, 2, 3, 4]) },
    );
    expect(res.statusCode).toBe(200);
    const orderId = Number(body(res).SUCCESS[0].REFERENCEID);
    const row = await orderRow(db, orderId);
    const [file] = await db.select().from(s.files).where(eq(s.files.id, row.inputFileId!));
    expect(file).toMatchObject({ filename: 'flash.bin', size: 4, mime: 'application/octet-stream' });
  });

  it('refuses a file order without a file, and a file over 25 MiB', async () => {
    const serviceId = await fileService();
    expect(messageOf(await dhru.call('placefileorder', { ID: serviceId }))).toBe(
      'Send the file as FILEDATA (base64) or as a file part.',
    );
    const big = await dhru.multipart(
      'placefileorder',
      { ID: serviceId },
      { name: 'big.bin', type: 'application/octet-stream', data: new Uint8Array(25 * 1024 * 1024 + 1) },
    );
    expect(big.statusCode).toBe(200);
    expect(messageOf(body(big))).toBe('The file is larger than 25 MiB.');
  });

  it('places an IMEI order through a multipart call too (credentials in the form)', async () => {
    const res = await dhru.multipart('placeimeiorder', { ID: world.auto.serviceId, IMEI: IMEIS[0] }, undefined);
    expect(body(res).SUCCESS[0].MESSAGE).toBe('Order received');
  });
});

describe('credentials and maintenance', () => {
  it('answers a wrong key or username "Authentication Failed" in the envelope for every action', async () => {
    for (const action of ['accountinfo', 'imeiservicelist', 'placeimeiorder', 'getimeiorder', 'placefileorder']) {
      const wrong = await dhru.raw(action, {}, { apiaccesskey: 'gsm_wrongwrongwrongwrongwrong' });
      expect(wrong.statusCode, action).toBe(200);
      expect(body(wrong), action).toEqual({ ERROR: [{ MESSAGE: 'Authentication Failed' }], apiversion: '6.1' });
    }
    expect(messageOf(await dhru.call('accountinfo', undefined, { username: 'someone-else' }))).toBe(
      'Authentication Failed',
    );
  });

  it('refuses a key without the dhru scope and a key of a merchant waiting for approval, in the envelope', async () => {
    const { db } = await testDb();
    const noDhru = await credentialsFor(t, db, world.other.id, { scopes: ['orders:read', 'orders:write'] });
    expect(messageOf(await dhruClient(t, noDhru).call('accountinfo'))).toBe(
      'This API key cannot be used with the Dhru API.',
    );
    await db.update(s.clients).set({ status: 'pending' }).where(eq(s.clients.id, world.merchant.id));
    await clearApiKeyCaches(t);
    expect(messageOf(await dhru.call('accountinfo'))).toBe('This merchant account has not been approved yet.');
  });

  it('refuses a placement during api_orders maintenance in the envelope, form, JSON or multipart, and lets the reads through', async () => {
    const { db } = await testDb();
    await db.insert(s.settings).values({
      key: 'maintenance',
      value: {
        enabled: true,
        scope: 'api_orders',
        message: 'Orders are paused while we check the ledger.',
        expectedEndAt: null,
        startedAt: '2026-03-01T11:00:00.000Z',
        startedBy: { id: 1, name: 'Rami K.' },
      },
    });
    await t.app.get(MaintenanceService).invalidate();
    const paused = { ERROR: [{ MESSAGE: 'Orders are paused while we check the ledger.' }], apiversion: '6.1' };
    const parameters = { ID: world.auto.serviceId, IMEI: IMEIS[0] };
    expect(await dhru.call('placeimeiorder', parameters)).toEqual(paused);
    expect(body(await dhru.raw('placeimeiorder', parameters, { as: 'json' }))).toEqual(paused);
    expect(body(await dhru.multipart('placeimeiorder', parameters, undefined))).toEqual(paused);
    expect(body(await dhru.multipart('placefileorder', parameters, undefined))).toEqual(paused);
    expect(await dhru.call('placeimeiorderbulk', { a: parameters })).toEqual(paused);
    expect((await dhru.call('accountinfo')).SUCCESS).toBeDefined();
    expect((await dhru.call('getimeiorder', { ID: 1 })).ERROR).toBeDefined();
    expect(await db.select().from(s.orders)).toHaveLength(0);
  });

  it('refuses a key from an address its list does not allow, and answers the per-key limit, in the envelope', async () => {
    const { db } = await testDb();
    const limited = await credentialsFor(t, db, world.other.id, { allowedIps: ['203.0.113.0/24'], rateLimitPerMin: 2 });
    const client = dhruClient(t, limited);
    expect(messageOf(await client.call('accountinfo', undefined, { ip: '198.51.100.7' }))).toContain('198.51.100.7');
    const ok = { ip: '203.0.113.7' };
    expect((await client.call('accountinfo', undefined, ok)).SUCCESS).toBeDefined();
    expect((await client.call('accountinfo', undefined, ok)).SUCCESS).toBeDefined();
    expect(messageOf(await client.call('accountinfo', undefined, ok))).toContain('Too many requests');
  });
});

/** A second merchant with a funded wallet. */
async function ordersWorldMerchant(db: Awaited<ReturnType<typeof testDb>>['db'], name: string, funds: string) {
  const { insertWalletMerchant, fundWallet } = await import('../support/money');
  const merchant = await insertWalletMerchant(db, { name });
  await fundWallet(db, merchant.id, funds);
  return merchant;
}
