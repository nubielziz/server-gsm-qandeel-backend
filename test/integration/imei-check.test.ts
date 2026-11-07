// Integration tests of the storefront IMEI check (feature 14a): POST /store/v1/imei/check against the real API: the checksum, the TAC
// lookup, the encrypted and hashed record of every check (no reuse across visitors), the pre-order source, the country header and
// the anti-bot check (decision 034).
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import { eq } from 'drizzle-orm';
import { schema as s } from '../../src/infra/db';
import { EncryptionService, TokenService } from '../../src/infra/crypto';
import { IMEI_CHECK_AAD, imeiHashInput } from '../../src/modules/risk';
import { type TestApp, createTestApp } from '../support/app';
import { MINUTE, TestClock } from '../support/clock';
import { closeTestDb, resetDb, testDb } from '../support/db';
import { logSink } from '../support/log-sink';
import { insertCategory, insertService } from '../support/catalog';
import {
  APPLE_IMEI,
  TURNSTILE_HEADERS,
  UNKNOWN_TAC_IMEI,
  insertListing,
  storefrontWorld,
  withTurnstile,
} from '../support/storefront';

const clock = new TestClock('2026-11-07T12:00:00.000Z');
let t: TestApp;
let withCountry: TestApp;

beforeAll(async () => {
  t = await createTestApp({ clock });
  withCountry = await createTestApp({ clock, env: { GEOIP_COUNTRY_HEADER: 'CF-IPCountry' } });
});
beforeEach(async () => {
  clock.set('2026-11-07T12:00:00.000Z');
  logSink.clear();
  await resetDb();
  const { db } = await testDb();
  await db.insert(s.tacCatalog).values([
    {
      tac: '35389011',
      brand: 'Apple',
      model: 'iPhone 13',
      marketingName: 'iPhone 13',
      releaseYear: 2021,
      source: 'demo',
    },
  ]);
});
afterAll(async () => {
  await resetDb();
  await withCountry.close();
  await t.close();
  await closeTestDb();
});

const check = (payload: unknown, headers: Record<string, string> = TURNSTILE_HEADERS, app: TestApp = t) =>
  app.app.inject({ method: 'POST', url: '/store/v1/imei/check', headers, payload: payload as never });
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- test bodies are untyped JSON
const body = (res: { json: () => any }): any => res.json();
const rows = async () => (await testDb()).db.select().from(s.imeiChecks).orderBy(s.imeiChecks.id);

describe('POST /store/v1/imei/check', () => {
  it('checks the digits, names the device by its TAC and stores the IMEI only encrypted and hashed', async () => {
    const res = await check({ imei: APPLE_IMEI });
    expect(res.statusCode).toBe(200);
    expect(body(res)).toEqual({
      imei: APPLE_IMEI,
      status: 'unknown',
      checks: { checksum: 'valid', tac: 'known' },
      device: { tac: '35389011', brand: 'Apple', model: 'iPhone 13', marketingName: 'iPhone 13', releaseYear: 2021 },
      cached: false,
      checkedAt: '2026-11-07T12:00:00.000Z',
    });
    const [row, ...rest] = await rows();
    expect(rest).toEqual([]);
    expect(row).toMatchObject({
      tac: '35389011',
      brand: 'Apple',
      model: 'iPhone 13',
      checkType: 'basic',
      status: 'unknown',
      source: 'storefront_free',
      serviceId: null,
      customerId: null,
      checkoutSessionId: null,
      country: null,
      cost: '0.0000',
      price: '0.0000',
      result: { stage: 'basic', checksum: 'valid', tac: 'known' },
    });
    expect(row?.cachedUntil).toBeNull();
    expect(row?.createdAt.toISOString()).toBe('2026-11-07T12:00:00.000Z');
    expect(row?.ip).toBeTruthy();
    // Encrypted at rest with the column's context, hashed with the keyed hash of decision 019.
    expect(row?.imeiEnc).not.toContain(APPLE_IMEI);
    expect(t.app.get(EncryptionService).decrypt(row!.imeiEnc!, IMEI_CHECK_AAD)).toBe(APPLE_IMEI);
    expect(row?.imeiHash).toBe(t.app.get(TokenService).hash(imeiHashInput(APPLE_IMEI)));
  });

  it('accepts a TAC the catalogue does not know and says so', async () => {
    const res = await check({ imei: UNKNOWN_TAC_IMEI });
    expect(res.statusCode).toBe(200);
    expect(body(res)).toMatchObject({ checks: { checksum: 'valid', tac: 'unknown' }, device: null, status: 'unknown' });
    const [row] = await rows();
    expect(row).toMatchObject({
      tac: null,
      brand: '',
      model: '',
      result: { stage: 'basic', checksum: 'valid', tac: 'unknown' },
    });
  });

  it('ignores spaces and dashes the buyer typed', async () => {
    const res = await check({ imei: ' 35 389011-0000004 ' });
    expect(res.statusCode).toBe(200);
    expect(body(res).imei).toBe(APPLE_IMEI);
  });

  it('refuses a wrong check digit, a wrong length and letters with INVALID_IMEI and stores nothing', async () => {
    for (const imei of ['353890110000005', '35389011000000', '3538901100000044', '35389011000000a', '---']) {
      const res = await check({ imei });
      expect(res.statusCode, imei).toBe(422);
      expect(body(res).code).toBe('INVALID_IMEI');
      expect(body(res).errors).toEqual([
        { field: 'imei', code: 'invalid_imei', message: 'Enter a valid 15-digit IMEI.' },
      ]);
    }
    expect(await rows()).toEqual([]);
  });

  it('refuses a missing, empty or oversized IMEI and a service id that is not a number as a validation error', async () => {
    for (const payload of [{}, { imei: '' }, { imei: 'x'.repeat(65) }, { imei: APPLE_IMEI, serviceId: 'a' }]) {
      const res = await check(payload);
      expect(res.statusCode, JSON.stringify(payload)).toBe(422);
    }
    expect(await rows()).toEqual([]);
  });

  it("records every check of the same IMEI and never answers from another visitor's check", async () => {
    const first = await check({ imei: APPLE_IMEI });
    clock.advance(MINUTE);
    const again = await check({ imei: APPLE_IMEI });
    expect(again.statusCode).toBe(200);
    // Nothing tells the second visitor that, or when, the IMEI was checked before.
    expect(body(again)).toEqual({ ...body(first), cached: false, checkedAt: '2026-11-07T12:01:00.000Z' });
    const stored = await rows();
    expect(stored).toHaveLength(2);
    expect(stored.map((row) => row.cachedUntil)).toEqual([null, null]);
  });

  it('counts a check with a service the shop sells as a check before an order', async () => {
    const { db } = await testDb();
    const world = await storefrontWorld(db);
    const res = await check({ imei: APPLE_IMEI, serviceId: world.icloud.serviceId });
    expect(res.statusCode).toBe(200);
    const [row] = await rows();
    expect(row).toMatchObject({ source: 'pre_order', serviceId: world.icloud.serviceId });
  });

  it('refuses a service the shop cannot sell', async () => {
    const { db } = await testDb();
    const world = await storefrontWorld(db);
    await db.update(s.services).set({ status: 'disabled' }).where(eq(s.services.id, world.att.serviceId));
    // catalog-3: a live, priced service with no switched-on listing is not sold either (no row, or the row switched off).
    const category = await insertCategory(db, { name: 'Unlisted' });
    const unlisted: number[] = [];
    for (const listing of ['none', 'off'] as const) {
      const id = await insertService(db, category, { basePrice: '1.0000', cost: '0.1000', effectiveCost: '0.1000' });
      await db.insert(s.serviceGroupPrices).values({ serviceId: id, groupId: world.groups.retail, price: '5.0000' });
      if (listing === 'off') await insertListing(db, id, { isListed: false });
      unlisted.push(id);
    }
    for (const serviceId of [world.att.serviceId, 999_999, ...unlisted]) {
      const res = await check({ imei: APPLE_IMEI, serviceId });
      expect(res.statusCode, String(serviceId)).toBe(422);
      expect(body(res).errors[0]).toMatchObject({ field: 'serviceId', code: 'not_available' });
    }
    expect(await rows()).toEqual([]);
  });

  it('stores the country a trusted proxy reports when the header is configured, and ignores it otherwise', async () => {
    const headers = withTurnstile({ 'cf-ipcountry': 'gb' });
    expect((await check({ imei: APPLE_IMEI }, headers, withCountry)).statusCode).toBe(200);
    expect((await check({ imei: UNKNOWN_TAC_IMEI }, headers, t)).statusCode).toBe(200);
    expect(
      (await check({ imei: withCountryImei }, withTurnstile({ 'cf-ipcountry': 'XX' }), withCountry)).statusCode,
    ).toBe(200);
    const stored = await rows();
    expect(stored.map((row) => row.country)).toEqual(['GB', null, null]);
  });

  it('never writes the IMEI into a log line', async () => {
    await check({ imei: APPLE_IMEI });
    await check({ imei: '353890110000005' });
    const text = JSON.stringify(logSink.lines);
    expect(text).not.toContain(APPLE_IMEI);
    expect(text).not.toContain('353890110000005');
  });
});

/** A third valid IMEI, so the country test makes three distinct rows. */
const withCountryImei = '352905119999997';

describe('POST /store/v1/imei/check: the anti-bot check (decision 034)', () => {
  it('refuses a request without the token, with an empty token and with a wrong token, and stores nothing', async () => {
    const bad: Array<Record<string, string>> = [
      {},
      { 'x-turnstile-token': '' },
      { 'x-turnstile-token': 'not-the-dummy-token' },
    ];
    for (const headers of bad) {
      const res = await check({ imei: APPLE_IMEI }, headers);
      expect(res.statusCode, JSON.stringify(headers)).toBe(403);
      expect(body(res).code).toBe('TURNSTILE_FAILED');
      expect(body(res).detail).toBe('The anti-bot check failed. Refresh the page and try again.');
    }
    expect(await rows()).toEqual([]);
  });

  it('checks the token before the body: a bad token wins over an invalid IMEI', async () => {
    const res = await check({ imei: 'nonsense' }, {});
    expect(res.statusCode).toBe(403);
  });

  it('is documented on the route with its header and its error', async () => {
    const doc = body(await t.app.inject({ method: 'GET', url: '/reference/openapi.json' }));
    const operation = doc.paths['/store/v1/imei/check'].post;
    expect(operation['x-gsm-turnstile']).toBe(true);
    expect(operation.parameters.map((parameter: { name: string }) => parameter.name)).toContain('x-turnstile-token');
    expect(Object.keys(operation.responses)).toContain('403');
  });
});
