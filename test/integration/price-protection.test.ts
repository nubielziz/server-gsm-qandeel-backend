// Price protection of user rule 9 (MISMATCHES B117) as feature 5 and the lists of 7a use it: the setting
// `pricing.price_change_tolerance_percent` (default 10, 0 to 100, changed through PATCH /admin/settings), the listed prices the
// portal catalog records, and the guard `checkPriceChange` over both.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import { Money } from '../../src/common/money';
import { SettingsReader } from '../../src/modules/platform';
import {
  DEFAULT_PRICE_CHANGE_TOLERANCE_PERCENT,
  ListedPrices,
  PRICE_CHANGE_TOLERANCE_BOUNDS,
  PRICE_CHANGE_TOLERANCE_KEY,
  checkPriceChange,
} from '../../src/modules/catalog';
import { PRICE_CHANGE_TOLERANCE_KEY as REGISTRY_KEY } from '../../src/modules/platform/settings/settings-registry';
import { type AdminApi, adminWith } from '../support/admin-api';
import { type TestApp, createTestApp } from '../support/app';
import { clearIdentityCaches, openSession } from '../support/auth';
import { closeTestDb, resetDb, testDb } from '../support/db';
import { insertAtt, insertClientPriceRow, insertDemoGroups, insertMerchantIn } from '../support/pricing';

let t: TestApp;
let admin: AdminApi;

beforeAll(async () => {
  t = await createTestApp();
});
beforeEach(async () => {
  await resetDb();
  await clearIdentityCaches(t);
  admin = await adminWith(t, ['*'], { name: 'Rami K.' });
});
afterAll(async () => {
  await resetDb();
  await clearIdentityCaches(t);
  await t.close();
  await closeTestDb();
});

const tolerance = () =>
  t.app
    .get(SettingsReader)
    .integer(PRICE_CHANGE_TOLERANCE_KEY, DEFAULT_PRICE_CHANGE_TOLERANCE_PERCENT, PRICE_CHANGE_TOLERANCE_BOUNDS);

describe('pricing.price_change_tolerance_percent', () => {
  it('is the same key in the catalog module and in the settings registry, default 10, range 0 to 100', () => {
    expect(PRICE_CHANGE_TOLERANCE_KEY).toBe(REGISTRY_KEY);
    expect(PRICE_CHANGE_TOLERANCE_KEY).toBe('pricing.price_change_tolerance_percent');
    expect(DEFAULT_PRICE_CHANGE_TOLERANCE_PERCENT).toBe(10);
    expect(PRICE_CHANGE_TOLERANCE_BOUNDS).toEqual({ min: 0, max: 100 });
  });

  it('is 10 until it is saved, then follows PATCH /admin/settings', async () => {
    expect(await tolerance()).toBe(10);
    const saved = await admin.patch('/admin/settings', { [PRICE_CHANGE_TOLERANCE_KEY]: 25 });
    expect(saved.status).toBe(200);
    expect(saved.body[PRICE_CHANGE_TOLERANCE_KEY]).toBe(25);
    expect(await tolerance()).toBe(25);
    expect((await admin.get('/admin/settings')).body[PRICE_CHANGE_TOLERANCE_KEY]).toBe(25);
    expect((await admin.patch('/admin/settings', { [PRICE_CHANGE_TOLERANCE_KEY]: 0 })).status).toBe(200);
    expect(await tolerance()).toBe(0);
  });

  it('refuses a value outside 0 to 100 or not a whole number, with the key as the field', async () => {
    for (const value of [-1, 101, 2.5, '10', null]) {
      const res = await admin.patch('/admin/settings', { [PRICE_CHANGE_TOLERANCE_KEY]: value });
      expect(res.status, String(value)).toBe(422);
      expect(res.body.errors[0].field).toBe(PRICE_CHANGE_TOLERANCE_KEY);
    }
    expect(await tolerance()).toBe(10);
  });
});

describe('the guard over the listed price a merchant was shown', () => {
  it('refuses an order that costs more than the tolerance above what the portal listed, and accepts a smaller raise', async () => {
    const { db } = await testDb();
    const groups = await insertDemoGroups(db);
    const { serviceId } = await insertAtt(db);
    const merchant = await insertMerchantIn(db, groups.standard);
    const session = await openSession(t, { type: 'client', id: merchant });
    const listed = t.app.get(ListedPrices);

    // No listing yet: nothing to compare.
    expect(checkPriceChange(null, Money.of('30'), await tolerance())).toEqual({ outcome: 'ok', raised: false });

    await t.app.inject({ method: 'GET', url: '/client/services', headers: session.headers });
    const shown = (await listed.find(db, merchant, serviceId))!;
    expect(shown.price.toWire()).toBe('17.2800');

    // The supplier cost rises and a fixed client price follows the floor: the charge is now higher than what was listed.
    await insertClientPriceRow(db, serviceId, merchant, '17.5000');
    const small = checkPriceChange(shown.price, Money.of('17.5000'), await tolerance());
    expect(small).toMatchObject({ outcome: 'raised', raised: true, reason: 'price_change' });

    const large = checkPriceChange(shown.price, Money.of('19.0100'), await tolerance());
    expect(large.outcome).toBe('refuse');
    if (large.outcome !== 'refuse') throw new Error('expected a refusal');
    expect([large.listedPrice.toWire(), large.currentPrice.toWire()]).toEqual(['17.2800', '19.0100']);

    // Staff lower the tolerance to 0: any raise is refused.
    await admin.patch('/admin/settings', { [PRICE_CHANGE_TOLERANCE_KEY]: 0 });
    expect(checkPriceChange(shown.price, Money.of('17.2801'), await tolerance()).outcome).toBe('refuse');
  });
});
