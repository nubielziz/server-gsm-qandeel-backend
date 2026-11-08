// Integration tests of the storefront policies route (feature 16, `PATCH /admin/storefront/settings`, ANSWERS settings Q1, B68, M169): the eight keys,
// the value rules, the answer, the audit rows in the demo's words, all-or-nothing, and the policies reaching the checkout that reads them.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import { type Database, schema as s } from '../../src/infra/db';
import { type AdminApi, adminWith } from '../support/admin-api';
import { type TestApp, createTestApp } from '../support/app';
import { clearIdentityCaches } from '../support/auth';
import { GatewayTestModule } from '../support/billing';
import { B2cGateway, b2cWorld, openCheckout, pay } from '../support/b2c';
import { TestClock } from '../support/clock';
import { closeTestDb, resetDb, testDb } from '../support/db';
import { freshClientIp } from '../support/pipeline-routes';

const clock = new TestClock('2026-11-07T12:00:00.000Z');
const fake = new B2cGateway();
let t: TestApp;
let db: Database;
let staff: AdminApi;

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
  clock.set('2026-11-07T12:00:00.000Z');
  fake.reset();
  await resetDb();
  await clearIdentityCaches(t);
  staff = await adminWith(t, ['settings:storefront', 'settings:read'], { name: 'Layla Haddad' });
});

const patch = (body: unknown) => staff.patch('/admin/storefront/settings', body);
const audit = () => db.select().from(s.auditLogs).orderBy(s.auditLogs.id);

describe('PATCH /admin/storefront/settings', () => {
  it('writes one switch and answers the policies that have a value, the same ones GET /admin/settings shows', async () => {
    const res = await patch({ guestCheckout: false });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ guestCheckout: false });
    expect((await staff.get('/admin/settings')).body).toMatchObject({ guestCheckout: false });

    // One key per call, like the Policies tab: the answer grows with what has a value.
    const second = await patch({ refundHoursBeforeDispatch: 24 });
    expect(second.body).toEqual({ guestCheckout: false, refundHoursBeforeDispatch: 24 });
    const all = await patch({
      require3ds: true,
      withdrawalWaiver: true,
      autoRefundFailed: false,
      imeiPrecheck: true,
      abandonedMinutes: 60,
      imeiRetentionDays: 90,
    });
    expect(all.body).toEqual({
      guestCheckout: false,
      require3ds: true,
      withdrawalWaiver: true,
      autoRefundFailed: false,
      imeiPrecheck: true,
      refundHoursBeforeDispatch: 24,
      abandonedMinutes: 60,
      imeiRetentionDays: 90,
    });
    expect((await staff.get('/admin/settings')).body).toMatchObject(all.body);
  });

  it('accepts the edges of each number and refuses a value outside them, naming the key', async () => {
    for (const [key, ok, bad] of [
      ['refundHoursBeforeDispatch', [0, 72], [-1, 73]],
      ['abandonedMinutes', [5, 1440], [4, 1441]],
      ['imeiRetentionDays', [0, 3650], [-1, 3651]],
    ] as const) {
      for (const value of ok) expect((await patch({ [key]: value })).body[key]).toBe(value);
      for (const value of bad) {
        const res = await patch({ [key]: value });
        expect(res.status, `${key} ${value}`).toBe(422);
        expect(res.body.errors[0]).toMatchObject({ field: key });
      }
      for (const value of [1.5, '24', null, true, [1]]) {
        const res = await patch({ [key]: value });
        expect(res.status, `${key} ${JSON.stringify(value)}`).toBe(422);
        expect(res.body.errors[0]).toMatchObject({ field: key });
      }
    }
    const range = await patch({ refundHoursBeforeDispatch: 100 });
    expect(range.body.errors[0].message).toBe('Use a number from 0 to 72.');
    const whole = await patch({ refundHoursBeforeDispatch: 1.5 });
    expect(whole.body.errors[0].message).toBe('Use a whole number.');
  });

  it('wants a JSON boolean for each switch and refuses any other key', async () => {
    for (const key of ['guestCheckout', 'require3ds', 'withdrawalWaiver', 'autoRefundFailed', 'imeiPrecheck']) {
      for (const value of ['true', 1, 0, null, 'on', {}]) {
        const res = await patch({ [key]: value });
        expect(res.status, `${key} ${JSON.stringify(value)}`).toBe(422);
        expect(res.body.errors[0]).toMatchObject({ field: key, message: 'Use true or false.' });
      }
    }
    const unknown = await patch({ maintenance: true });
    expect(unknown.status).toBe(422);
    expect(unknown.body.errors[0]).toMatchObject({
      field: 'maintenance',
      message: 'This is not a storefront setting.',
    });
    expect((await patch({ 'payments.auto_credit_delay_minutes': 5 })).status).toBe(422);
    expect((await patch({})).status).toBe(422);
    expect((await patch({})).body.errors[0]).toMatchObject({ field: 'body' });
    expect((await patch([])).status).toBe(422);
    expect(await db.select().from(s.settings)).toHaveLength(0);
  });

  it('is all or nothing: a call with one bad key writes none of its keys', async () => {
    const res = await patch({ guestCheckout: false, abandonedMinutes: 2, maintenance: true });
    expect(res.status).toBe(422);
    expect(res.body.errors.map((error: { field: string }) => error.field).sort()).toEqual([
      'abandonedMinutes',
      'maintenance',
    ]);
    expect(await db.select().from(s.settings)).toHaveLength(0);
    expect(await audit()).toHaveLength(0);
  });

  it('writes one audit row per changed key in the demo words, and one with the same before and after when nothing changed', async () => {
    await patch({ guestCheckout: false });
    // The same save twice answers 200 (the audit enforcement needs a row for every staff write): one row, before equal to after.
    expect((await patch({ guestCheckout: false })).status).toBe(200);
    await patch({ require3ds: true, abandonedMinutes: 60 });
    await patch({ require3ds: false });
    await patch({ abandonedMinutes: 30 });
    const rows = (await audit()).filter((row) => row.entityType === 'setting');
    expect(rows.map((row) => [row.action, row.entityLabel, row.before, row.after])).toEqual([
      ['turned off policy', 'Guest checkout', { guestCheckout: null }, { guestCheckout: false }],
      ['turned off policy', 'Guest checkout', { guestCheckout: false }, { guestCheckout: false }],
      ['turned on policy', 'Require 3D Secure', { require3ds: null }, { require3ds: true }],
      ['changed policy', 'Abandoned checkout reminder', { abandonedMinutes: null }, { abandonedMinutes: 60 }],
      ['turned off policy', 'Require 3D Secure', { require3ds: true }, { require3ds: false }],
      ['changed policy', 'Abandoned checkout reminder', { abandonedMinutes: 60 }, { abandonedMinutes: 30 }],
    ]);
    expect(rows.every((row) => row.actorId === staff.staffId)).toBe(true);
  });

  it('needs settings:storefront, a signed-in session and the CSRF token', async () => {
    const reader = await adminWith(t, ['settings:read']);
    expect((await reader.patch('/admin/storefront/settings', { guestCheckout: false })).status).toBe(403);
    const other = await adminWith(t, ['payments:gateways']);
    expect((await other.patch('/admin/storefront/settings', { guestCheckout: false })).status).toBe(403);
    expect((await staff.anonymous('PATCH', '/admin/storefront/settings', { guestCheckout: false })).status).toBe(401);
    expect((await staff.withoutCsrf('PATCH', '/admin/storefront/settings', { guestCheckout: false })).status).toBe(403);
    expect(await db.select().from(s.settings)).toHaveLength(0);
  });

  it('reaches the checkout at once: the withdrawal waiver off drops its consent, 3-D Secure off drops the gateway request', async () => {
    const world = await b2cWorld(t, db, fake);
    const shown = async (token: string) =>
      (
        await t.app.inject({
          method: 'GET',
          url: `/store/v1/checkout-sessions/${token}`,
          remoteAddress: freshClientIp(),
        })
      ).json();
    const before = await openCheckout(t, world, { email: 'a@mail.example', consent: false });
    expect((await shown(before.token)).consent.required).toContain('withdrawal_waiver');

    expect((await patch({ withdrawalWaiver: false })).status).toBe(200);
    const after = await openCheckout(t, world, { email: 'b@mail.example', consent: false });
    expect((await shown(after.token)).consent.required).not.toContain('withdrawal_waiver');

    // 3-D Secure is on by default: the card gateway is asked for it; switched off, it is not.
    const ready = await openCheckout(t, world, { email: 'c@mail.example' });
    expect((await pay(t, ready.token, undefined)).statusCode).toBe(201);
    expect(
      new URLSearchParams(fake.calls('/v1/checkout/sessions')[0]!.body).get(
        'payment_method_options[card][request_three_d_secure]',
      ),
    ).toBe('any');
    expect((await patch({ require3ds: false })).status).toBe(200);
    const later = await openCheckout(t, world, { email: 'd@mail.example' });
    expect((await pay(t, later.token, undefined)).statusCode).toBe(201);
    expect(
      new URLSearchParams(fake.calls('/v1/checkout/sessions')[1]!.body).has(
        'payment_method_options[card][request_three_d_secure]',
      ),
    ).toBe(false);
  });
});
