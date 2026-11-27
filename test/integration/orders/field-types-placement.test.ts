// Decision 076: ten more custom field types. Staff choose the type of a field and the server reads and judges the value by it on the
// portal's POST /client/orders and on Dhru (placeimeiorder, its IMEI parameter and CUSTOMFIELD): a good value is stored in its type's form
// (orders.inputs and orders.imei), a bad one is refused with its code on inputs.<key> (or IMEI): INVALID_IMEI for a bad line of an
// imei_bulk list, VALIDATION_FAILED for every other code. An imei_bulk list is one order at one price, its list the main input. Real
// application, Postgres and Redis.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import { eq } from 'drizzle-orm';
import { schema as s } from '@src/infra/db';
import { MAX_FIELD_IMEIS, isValidImei } from '@src/modules/orders';
import { type TestApp, createTestApp } from '../../support/app';
import { clearIdentityCaches } from '../../support/auth';
import { TestClock } from '../../support/clock';
import { closeTestDb, resetDb, testDb } from '../../support/db';
import { type MachineCredentials, clearApiKeyCaches, credentialsFor, dhruClient } from '../../support/machine-orders';
import { IMEIS, json, orderRow, ordersWorld, portalFor, walletOf, type OrdersWorld } from '../../support/orders';

const clock = new TestClock();
let t: TestApp;
let world: OrdersWorld;
let creds: MachineCredentials;

beforeAll(async () => {
  t = await createTestApp({ clock });
});
afterAll(async () => {
  await resetDb();
  await clearIdentityCaches(t);
  await t.close();
  await closeTestDb();
});
beforeEach(async () => {
  clock.reset();
  await resetDb();
  await clearIdentityCaches(t);
  await clearApiKeyCaches(t);
  const { db } = await testDb();
  world = await ordersWorld(db);
  creds = await credentialsFor(t, db, world.merchant.id);
});

/** `count` distinct valid IMEIs (a 14-digit body and its Luhn check digit). */
function distinctImeis(count: number): string[] {
  return Array.from({ length: count }, (_, index) => {
    const body = `35460711${String(index).padStart(6, '0')}`;
    for (let digit = 0; digit <= 9; digit += 1) if (isValidImei(`${body}${digit}`)) return `${body}${digit}`;
    throw new Error(`No check digit for ${body}.`);
  });
}

/** Makes the server service ask for one required field of a type, keyed `value` (its main input: the first required field). */
async function serverFieldOf(fieldType: (typeof s.serviceFields.$inferInsert)['fieldType']): Promise<void> {
  await world.db.delete(s.serviceFields).where(eq(s.serviceFields.serviceId, world.server.serviceId));
  await world.db.insert(s.serviceFields).values({
    serviceId: world.server.serviceId,
    key: 'value',
    label: 'Value',
    supplierKey: 'Value',
    fieldType,
    required: true,
    sort: 0,
  });
}

/** Each check type: a good value as typed, its stored form, a bad value, the field code and the answer's code. */
const CASES = [
  [
    'imei_bulk',
    `${IMEIS[0]}, ${IMEIS[1]}`,
    `${IMEIS[0]}\n${IMEIS[1]}`,
    `${IMEIS[0]}\n352905112490860`,
    'invalid_imei',
    'INVALID_IMEI',
  ],
  ['imeisv', '3529 0511 2490 8612', '3529051124908612', '35290511249086', 'invalid_imeisv', 'VALIDATION_FAILED'],
  ['serial', ' f2lx k0ab cd12 ', 'F2LXK0ABCD12', 'ABC', 'invalid_serial', 'VALIDATION_FAILED'],
  [
    'iccid',
    '8944 1234 5678 9012 3456',
    '89441234567890123456',
    '99441234567890123456',
    'invalid_iccid',
    'VALIDATION_FAILED',
  ],
  [
    'eid',
    '8904 9032 0000 0000 0000 0000 0000 0001',
    '89049032000000000000000000000001',
    '1234',
    'invalid_eid',
    'VALIDATION_FAILED',
  ],
  ['meid', 'a0 0000 1234 5678', 'A0000012345678', 'G0000012345678', 'invalid_meid', 'VALIDATION_FAILED'],
  ['ecid', '0X1a2b3c4d5e6f', '0x1A2B3C4D5E6F', '0x12', 'invalid_ecid', 'VALIDATION_FAILED'],
  ['mac_address', 'aabb.ccdd.eeff', 'AA:BB:CC:DD:EE:FF', 'AA:BB:CC', 'invalid_mac_address', 'VALIDATION_FAILED'],
  ['mi_lock_code', ' Ab12-cd34 ', 'Ab12-cd34', 'ab', 'invalid_mi_lock_code', 'VALIDATION_FAILED'],
  ['box_sn', 'bx-12 34', 'BX-1234', 'B', 'invalid_box_sn', 'VALIDATION_FAILED'],
] as const;

describe('POST /client/orders: a field of each check type (decision 076)', () => {
  for (const [fieldType, good, stored, bad, code, answer] of CASES) {
    it(`${fieldType}: stores a good value in its form and refuses a bad one with ${code}`, async () => {
      await serverFieldOf(fieldType);
      const portal = await portalFor(t, world.merchant.id);
      const refused = await portal.post('/client/orders', {
        serviceId: world.server.serviceId,
        inputs: { value: bad },
      });
      expect(refused.statusCode).toBe(422);
      expect(json(refused).code).toBe(answer);
      expect(json(refused).errors).toEqual([expect.objectContaining({ field: 'inputs.value', code })]);
      expect(await world.db.select().from(s.orders)).toHaveLength(0);

      const placed = await portal.post('/client/orders', {
        serviceId: world.server.serviceId,
        inputs: { value: good },
      });
      expect(placed.statusCode).toBe(201);
      expect(await orderRow(world.db, json(placed).orders[0].id)).toMatchObject({
        imei: stored,
        inputs: { value: stored },
      });
    });
  }
});

describe('a field of type imei_bulk as the main input of an IMEI service (decision 076)', () => {
  beforeEach(async () => {
    await world.db.insert(s.serviceFields).values({
      serviceId: world.auto.serviceId,
      key: 'imeis',
      label: 'IMEIs',
      supplierKey: 'IMEIs',
      fieldType: 'imei_bulk',
      isMainInput: true,
      required: true,
      sort: 0,
    });
  });

  it('is one order at one price: the list, one IMEI per line, is its main input; the same list again is a duplicate', async () => {
    const portal = await portalFor(t, world.merchant.id);
    const list = `${IMEIS[0]}\n${IMEIS[1]}; ${IMEIS[2]}`;
    const placed = await portal.post('/client/orders', { serviceId: world.auto.serviceId, inputs: { imeis: list } });
    expect(placed.statusCode).toBe(201);
    expect(json(placed).orders).toHaveLength(1);
    const joined = `${IMEIS[0]}\n${IMEIS[1]}\n${IMEIS[2]}`;
    expect(json(placed).orders[0].imei).toBe(joined);
    expect(await orderRow(world.db, json(placed).orders[0].id)).toMatchObject({
      imei: joined,
      quantity: 1,
      inputs: { imeis: joined },
    });
    expect(await walletOf(world.db, world.merchant.id)).toEqual({ wallet: '82.7200', hold: '17.2800' });
    // The duplicate rule block_open reads the whole list, as it reads any main input.
    const again = await portal.post('/client/orders', { serviceId: world.auto.serviceId, inputs: { imeis: joined } });
    expect(again.statusCode).toBe(409);
    expect(json(again).code).toBe('DUPLICATE_ORDER');
  });

  it(`takes ${MAX_FIELD_IMEIS} IMEIs and refuses one more, a repeat and a bad line, each once`, async () => {
    const portal = await portalFor(t, world.merchant.id);
    const many = distinctImeis(MAX_FIELD_IMEIS + 1);
    const tooMany = await portal.post('/client/orders', {
      serviceId: world.auto.serviceId,
      inputs: { imeis: many.join('\n') },
    });
    expect(tooMany.statusCode).toBe(422);
    expect(json(tooMany).code).toBe('VALIDATION_FAILED');
    expect(json(tooMany).errors).toEqual([
      { field: 'inputs.imeis', code: 'too_many_imeis', message: 'Enter at most 30 IMEIs.' },
    ]);
    const repeat = await portal.post('/client/orders', {
      serviceId: world.auto.serviceId,
      inputs: { imeis: `${IMEIS[0]}\n${IMEIS[1]}\n${IMEIS[0]}` },
    });
    expect(json(repeat).code).toBe('VALIDATION_FAILED');
    expect(json(repeat).errors).toEqual([
      { field: 'inputs.imeis', code: 'duplicate_imei', message: 'Line 3 repeats an IMEI of this list.' },
    ]);
    const badLine = await portal.post('/client/orders', {
      serviceId: world.auto.serviceId,
      inputs: { imeis: `${IMEIS[0]}\n\n352905112490860` },
    });
    expect(json(badLine).code).toBe('INVALID_IMEI');
    expect(json(badLine).errors).toEqual([
      {
        field: 'inputs.imeis',
        code: 'invalid_imei',
        message: 'Line 2 is not a valid IMEI: each line must be 15 digits with a correct check digit.',
      },
    ]);
    expect(await world.db.select().from(s.orders)).toHaveLength(0);
    const thirty = await portal.post('/client/orders', {
      serviceId: world.auto.serviceId,
      inputs: { imeis: many.slice(0, MAX_FIELD_IMEIS).join('\n') },
    });
    expect(thirty.statusCode).toBe(201);
    expect((await orderRow(world.db, json(thirty).orders[0].id)).imei).toBe(many.slice(0, MAX_FIELD_IMEIS).join('\n'));
  });

  it('takes 30 IMEIs however they are typed (CRLF, ", ", spaces and dashes): longer than 500 characters as sent, 479 stored', async () => {
    const portal = await portalFor(t, world.merchant.id);
    // Three different lists of 30, so the duplicate rule never meets the same list twice.
    const all = distinctImeis(3 * MAX_FIELD_IMEIS);
    const lists = [0, 1, 2].map((n) => all.slice(n * MAX_FIELD_IMEIS, (n + 1) * MAX_FIELD_IMEIS));
    const dashed = (imei: string) => `${imei.slice(0, 2)}-${imei.slice(2, 8)} ${imei.slice(8, 14)}-${imei.slice(14)}`;
    const typed = [lists[0]!.join('\r\n'), lists[1]!.join(', '), lists[2]!.map(dashed).join('\n')];
    for (const [index, value] of typed.entries()) {
      expect(value.length).toBeGreaterThan(500);
      const placed = await portal.post('/client/orders', { serviceId: world.auto.serviceId, inputs: { imeis: value } });
      expect(placed.statusCode).toBe(201);
      const stored = lists[index]!.join('\n');
      expect(stored).toHaveLength(479);
      expect(await orderRow(world.db, json(placed).orders[0].id)).toMatchObject({
        imei: stored,
        inputs: { imeis: stored },
      });
    }
  });

  it('counts a list before it measures it: 40 IMEIs are too_many_imeis, not too_long', async () => {
    const portal = await portalFor(t, world.merchant.id);
    const forty = await portal.post('/client/orders', {
      serviceId: world.auto.serviceId,
      inputs: { imeis: distinctImeis(40).join('\n') },
    });
    expect(forty.statusCode).toBe(422);
    expect(json(forty).code).toBe('VALIDATION_FAILED');
    expect(json(forty).errors).toEqual([
      { field: 'inputs.imeis', code: 'too_many_imeis', message: 'Enter at most 30 IMEIs.' },
    ]);
    const dhru = dhruClient(t, creds);
    const viaDhru = await dhru.call('placeimeiorder', {
      ID: world.auto.serviceId,
      IMEI: distinctImeis(40).join('\r\n'),
    });
    expect(viaDhru.ERROR?.[0]?.MESSAGE).toBe('Enter at most 30 IMEIs.');
    expect(await world.db.select().from(s.orders)).toHaveLength(0);
  });

  it("takes the list as Dhru's IMEI parameter: one order; a bad line is refused with its message", async () => {
    const dhru = dhruClient(t, creds);
    const placed = await dhru.call('placeimeiorder', { ID: world.auto.serviceId, IMEI: `${IMEIS[0]},${IMEIS[1]}` });
    expect(placed.SUCCESS).toBeDefined();
    expect((await orderRow(world.db, Number(placed.SUCCESS[0].REFERENCEID))).imei).toBe(`${IMEIS[0]}\n${IMEIS[1]}`);
    const bad = await dhru.call('placeimeiorder', { ID: world.auto.serviceId, IMEI: `${IMEIS[2]}\n123` });
    expect(bad.ERROR?.[0]?.MESSAGE).toBe(
      'Line 2 is not a valid IMEI: each line must be 15 digits with a correct check digit.',
    );
    expect(await world.db.select().from(s.orders)).toHaveLength(1);
  });
});

describe('POST /client/orders: the caps of a custom field value (decision 076)', () => {
  it('takes 2000 characters as sent and holds the stored form of every type to 500 (too_long)', async () => {
    await serverFieldOf('text');
    const portal = await portalFor(t, world.merchant.id);
    const long = await portal.post('/client/orders', {
      serviceId: world.server.serviceId,
      inputs: { value: 'x'.repeat(600) },
    });
    expect(long.statusCode).toBe(422);
    expect(json(long).code).toBe('VALIDATION_FAILED');
    expect(json(long).errors).toEqual([{ field: 'inputs.value', code: 'too_long', message: 'Value is too long.' }]);
    const tooMuch = await portal.post('/client/orders', {
      serviceId: world.server.serviceId,
      inputs: { value: 'x'.repeat(2001) },
    });
    expect(tooMuch.statusCode).toBe(422);
    expect(json(tooMuch).code).toBe('VALIDATION_FAILED');
    expect(json(tooMuch).errors[0].field).toBe('inputs.value');
    expect(await world.db.select().from(s.orders)).toHaveLength(0);
  });
});

describe('Dhru CUSTOMFIELD: a field of a check type (decision 076)', () => {
  it('stores a good value in its form and refuses a bad one with its message', async () => {
    await serverFieldOf('mac_address');
    const dhru = dhruClient(t, creds);
    const bad = await dhru.call('placeimeiorder', { ID: world.server.serviceId, CUSTOMFIELD: { Value: 'AA:BB' } });
    expect(bad.ERROR?.[0]?.MESSAGE).toBe(
      'This MAC address is not valid: 12 hexadecimal characters, like AA:BB:CC:DD:EE:FF.',
    );
    const placed = await dhru.call('placeimeiorder', {
      ID: world.server.serviceId,
      CUSTOMFIELD: { Value: 'aa-bb-cc-dd-ee-ff' },
    });
    expect(placed.SUCCESS).toBeDefined();
    expect(await orderRow(world.db, Number(placed.SUCCESS[0].REFERENCEID))).toMatchObject({
      imei: 'AA:BB:CC:DD:EE:FF',
      inputs: { value: 'AA:BB:CC:DD:EE:FF' },
    });
  });
});
