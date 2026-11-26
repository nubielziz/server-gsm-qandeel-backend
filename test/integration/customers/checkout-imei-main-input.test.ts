// Decision 070 at the storefront checkout: the shop's order form draws only the custom fields, so the IMEI of an IMEI service is typed into
// the field flagged as the main input (decision 065) and sent under its key in `inputs`. Decision 073: the field is judged by its own type:
// one of type `imei` is checked as an IMEI (15 digits, Luhn) with every problem on `inputs.<key>`, an optional one may be left empty, a
// text one takes letters (an ECID), and an IMEI service without fields takes `imei` as typed. The session and the paid order are exactly
// those of an IMEI sent as `imei` (the encrypted main input, the blocklist match, `orders.imei`, the stored inputs). `imei` still works and
// wins when both are sent. Real application, Postgres and Redis.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import { eq } from 'drizzle-orm';
import { schema as s, type Database } from '@src/infra/db';
import { type TestApp, createTestApp } from '../../support/app';
import { B2cGateway, type B2cWorld, b2cWorld, json, paidOrder } from '../../support/b2c';
import { GatewayTestModule } from '../../support/billing';
import { TestClock } from '../../support/clock';
import { closeTestDb, resetDb, testDb } from '../../support/db';
import { seedDefaultTemplates } from '../../support/notifications';
import { IMEIS, orderRow } from '../../support/orders';
import { freshClientIp } from '../../support/pipeline-routes';
import { insertBlock } from '../../support/risk';
import { clearStoreRateLimits } from '../../support/store';
import { APPLE_IMEI, TURNSTILE_HEADERS } from '../../support/storefront';

const clock = new TestClock('2026-11-10T12:00:00.000Z');
const fake = new B2cGateway();
let t: TestApp;
let db: Database;
let world: B2cWorld;

/** The pattern of the main-input field in the pattern case: 15 digits that start with 35. */
const PATTERN = '^35[0-9]{13}$';
/** A valid IMEI the pattern accepts. */
const ACCEPTED = APPLE_IMEI;
/** Another valid IMEI the pattern accepts. */
const ACCEPTED_TOO = IMEIS[1];
/** A valid IMEI the pattern refuses (it starts with 86). */
const REFUSED = IMEIS[4];
/** {@link ACCEPTED} with a wrong check digit. */
const BAD_CHECK_DIGIT = '353890110000005';

beforeAll(async () => {
  ({ db } = await testDb());
  t = await createTestApp({ clock, imports: [GatewayTestModule] });
});
afterAll(async () => {
  await fake.stop();
  await resetDb();
  await t.close();
  await closeTestDb();
});
beforeEach(async () => {
  clock.set('2026-11-10T12:00:00.000Z');
  fake.reset();
  await resetDb();
  await clearStoreRateLimits(t);
  world = await b2cWorld(t, db, fake);
  await seedDefaultTemplates(db);
  // The key and the Name say nothing: the flag makes the field the IMEI's box, and its type `imei` makes it check an IMEI (decision 073).
  await db.insert(s.serviceFields).values({
    serviceId: world.icloud.serviceId,
    key: 'serial',
    label: 'Serial',
    supplierKey: 'Serial number',
    fieldType: 'imei',
    isMainInput: true,
    required: true,
    sort: 1,
  });
});

/** `POST /store/v1/checkout-sessions` of the iCloud service with the given payload (no `imei` unless it names one). */
const open = (payload: Record<string, unknown>) =>
  t.app.inject({
    method: 'POST',
    url: '/store/v1/checkout-sessions',
    headers: { 'user-agent': 'Mozilla/5.0 (test)', ...TURNSTILE_HEADERS },
    remoteAddress: freshClientIp(),
    payload: {
      serviceId: world.icloud.serviceId,
      email: 'sam@mail.example',
      country: 'GB',
      currency: 'GBP',
      ...payload,
    } as never,
  });

/** Asserts that nothing was opened. */
async function expectNothingOpened(): Promise<void> {
  expect(await db.select().from(s.checkoutSessions)).toHaveLength(0);
  // No guest row was made for the typed address either (a guest is an account row without a login).
  expect(await db.select().from(s.clients).where(eq(s.clients.hasAccount, false))).toHaveLength(0);
}

describe('POST /store/v1/checkout-sessions: the IMEI typed into the main-input field (decision 070)', () => {
  it('opens the checkout with that IMEI, and the paid order is the order of an IMEI sent as imei', async () => {
    const opened = await open({ inputs: { serial: '3538 9011-0000004' } });
    expect(opened.statusCode).toBe(201);
    expect(json(opened).imei).toBe('•••••••••••0004');

    const typed = await paidOrder(t, clock, world, {
      email: 'ann@mail.example',
      imei: null,
      inputs: { serial: ACCEPTED },
    });
    const order = await orderRow(db, typed.orderId);
    expect(order.imei).toBe(ACCEPTED);
    expect(order.inputs).toEqual({ serial: ACCEPTED });

    const sent = await paidOrder(t, clock, world, { email: 'bob@mail.example', inputs: { serial: ACCEPTED } });
    const same = await orderRow(db, sent.orderId);
    expect(same.imei).toBe(order.imei);
    expect(same.inputs).toEqual(order.inputs);
  });

  it('pays an IMEI typed with spaces and dashes into the field as its normalised digits', async () => {
    const paid = await paidOrder(t, clock, world, { imei: null, inputs: { serial: ' 3538 9011-0000-004 ' } });
    const order = await orderRow(db, paid.orderId);
    expect(order.imei).toBe(ACCEPTED);
    expect(order.inputs).toEqual({ serial: ACCEPTED });
  });

  it('refuses a wrong check digit with INVALID_IMEI on inputs.<key>', async () => {
    const bad = await open({ inputs: { serial: BAD_CHECK_DIGIT } });
    expect(bad.statusCode).toBe(422);
    expect(json(bad).code).toBe('INVALID_IMEI');
    expect(json(bad).errors).toEqual([expect.objectContaining({ field: 'inputs.serial', code: 'invalid_imei' })]);
    await expectNothingOpened();
  });

  it('asks for a missing value once, on inputs.<key>, while the field is required; an optional main input may be left empty', async () => {
    for (const payload of [{}, { inputs: { serial: '  ' } }]) {
      const missing = await open(payload);
      expect(missing.statusCode).toBe(422);
      expect(json(missing).code).toBe('VALIDATION_FAILED');
      expect(json(missing).errors).toEqual([
        expect.objectContaining({ field: 'inputs.serial', code: 'required', message: 'Serial is required.' }),
      ]);
    }
    await expectNothingOpened();
    // Decision 073: staff made the main input optional, so the checkout opens without one and keeps no main input.
    await db
      .update(s.serviceFields)
      .set({ required: false })
      .where(eq(s.serviceFields.serviceId, world.icloud.serviceId));
    const optional = await open({});
    expect(optional.statusCode).toBe(201);
    expect(json(optional).imei).toBeNull();
    const [session] = await db.select().from(s.checkoutSessions);
    expect(session).toMatchObject({ imeiEnc: null, inputs: {} });
  });

  it("judges the field's pattern on the IMEI typed there, on inputs.<key>", async () => {
    await db
      .update(s.serviceFields)
      .set({ regex: PATTERN })
      .where(eq(s.serviceFields.serviceId, world.icloud.serviceId));
    const refused = await open({ inputs: { serial: REFUSED } });
    expect(refused.statusCode).toBe(422);
    expect(json(refused).errors).toEqual([expect.objectContaining({ field: 'inputs.serial', code: 'invalid_format' })]);
    await expectNothingOpened();
    expect((await open({ inputs: { serial: ACCEPTED } })).statusCode).toBe(201);
  });

  it('keeps imei working, and imei wins when both are sent, with its problems on imei', async () => {
    expect((await open({ imei: ACCEPTED })).statusCode).toBe(201);
    const badImei = await open({ imei: BAD_CHECK_DIGIT, inputs: { serial: ACCEPTED_TOO }, email: 'ann@mail.example' });
    expect(json(badImei).code).toBe('INVALID_IMEI');
    expect(json(badImei).errors).toEqual([expect.objectContaining({ field: 'imei', code: 'invalid_imei' })]);
    const both = await paidOrder(t, clock, world, { email: 'bob@mail.example', inputs: { serial: ACCEPTED_TOO } });
    const order = await orderRow(db, both.orderId);
    expect(order.imei).toBe(ACCEPTED);
    expect(order.inputs).toEqual({ serial: ACCEPTED });
  });

  it('refuses a blocklisted IMEI typed into the field like one sent as imei', async () => {
    await insertBlock(t, db, 'imei', ACCEPTED);
    const typed = await open({ inputs: { serial: ACCEPTED } });
    expect(typed.statusCode).toBe(403);
    expect(json(typed).code).toBe('ACCOUNT_SUSPENDED');
    const sent = await open({ imei: ACCEPTED });
    const { requestId: _typedId, ...typedAnswer } = json(typed);
    const { requestId: _sentId, ...sentAnswer } = json(sent);
    expect(sentAnswer).toEqual(typedAnswer);
    await expectNothingOpened();
  });

  it('opens the checkout of an IMEI service with no fields: nothing is asked, and an imei sent is taken as typed (decision 073)', async () => {
    await db.delete(s.serviceFields).where(eq(s.serviceFields.serviceId, world.icloud.serviceId));
    const bare = await open({});
    expect(bare.statusCode).toBe(201);
    expect(json(bare).imei).toBeNull();
    const typed = await paidOrder(t, clock, world, { email: 'ann@mail.example', imei: ' F2LXK0ABCD12 ' });
    expect(await orderRow(db, typed.orderId)).toMatchObject({ imei: 'F2LXK0ABCD12', inputs: {} });
  });
});

describe('POST /store/v1/checkout-sessions: an IMEI service whose main input is a text field (decision 073)', () => {
  beforeEach(async () => {
    await db
      .update(s.serviceFields)
      .set({ fieldType: 'text', supplierKey: 'ECID', label: 'ECID' })
      .where(eq(s.serviceFields.serviceId, world.icloud.serviceId));
  });

  it('takes letters typed into the field as the main input: the masked line, the encrypted copy and the paid order', async () => {
    const opened = await open({ inputs: { serial: ' 0x1A2B3C4D5E6F ' } });
    expect(opened.statusCode).toBe(201);
    expect(json(opened).imei).toBe('••••••••••5E6F');
    const paid = await paidOrder(t, clock, world, {
      email: 'ann@mail.example',
      imei: null,
      inputs: { serial: '0x1A2B3C4D5E6F' },
    });
    expect(await orderRow(db, paid.orderId)).toMatchObject({
      imei: '0x1A2B3C4D5E6F',
      inputs: { serial: '0x1A2B3C4D5E6F' },
    });
    const sent = await paidOrder(t, clock, world, { email: 'bob@mail.example', imei: 'F2LXK0ABCD12' });
    expect((await orderRow(db, sent.orderId)).imei).toBe('F2LXK0ABCD12');
  });

  it('still refuses a blocklisted IMEI typed with spaces into the text field', async () => {
    await insertBlock(t, db, 'imei', ACCEPTED);
    const typed = await open({ inputs: { serial: ' 3538 9011-0000004 ' } });
    expect(typed.statusCode).toBe(403);
    expect(json(typed).code).toBe('ACCOUNT_SUSPENDED');
    await expectNothingOpened();
    // A value that is no IMEI is not matched against the IMEI entries.
    expect((await open({ inputs: { serial: 'F2LXK0ABCD12' } })).statusCode).toBe(201);
  });

  it('refuses a blocklisted IMEI typed into a field of type imei that is not the main input', async () => {
    await db.insert(s.serviceFields).values({
      serviceId: world.icloud.serviceId,
      key: 'device',
      label: 'Device IMEI',
      supplierKey: 'Device',
      fieldType: 'imei',
      sort: 2,
    });
    await insertBlock(t, db, 'imei', ACCEPTED);
    const typed = await open({ inputs: { serial: 'F2LXK0ABCD12', device: '3538 9011-0000004' } });
    expect(typed.statusCode).toBe(403);
    expect(json(typed).code).toBe('ACCOUNT_SUSPENDED');
    await expectNothingOpened();
    expect((await open({ inputs: { serial: 'F2LXK0ABCD12', device: ACCEPTED_TOO } })).statusCode).toBe(201);
  });
});
