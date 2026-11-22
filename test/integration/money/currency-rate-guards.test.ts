// Integration tests of the guards on typed currency values: a typed exchange rate is judged against the bound of the hourly refresh
// (`fx.max_refresh_move_percent`, decision 049): a move that large from the stored rate, or from the provider's rate when the provider
// offers one, is an Owner's decision; and a change of decimals, which sets what the shop charges, needs `currencies:update` like the
// rate and the markup (decision 046). The provider of this file cannot answer unless a test says otherwise, so no call leaves the test.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, mock, spyOn } from 'bun:test';
import { eq } from 'drizzle-orm';
import { schema as s } from '@src/infra/db';
import { FX_PROVIDER, FxProviderUnavailableError, type FxProvider } from '@src/modules/money/domain/fx-provider';
import { type TestApp, createTestApp } from '../../support/app';
import { clearIdentityCaches, signInStaff } from '../../support/auth';
import { TestClock } from '../../support/clock';
import { closeTestDb, resetDb, testDb } from '../../support/db';

const clock = new TestClock('2026-11-07T10:00:00.000Z');
/** An app whose driver is `openexchangerates` (with a key): the provider's rate of a new currency can be known. */
let t: TestApp;

beforeAll(async () => {
  t = await createTestApp({ clock, env: { FX_PROVIDER: 'openexchangerates', FX_API_KEY: 'test-app-id' } });
});
afterAll(async () => {
  await resetDb();
  await t.close();
  await closeTestDb();
});
beforeEach(async () => {
  clock.set('2026-11-07T10:00:00.000Z');
  await resetDb();
  await clearIdentityCaches(t);
  spyOn(providerOf(), 'fetchRates').mockRejectedValue(
    new FxProviderUnavailableError('The exchange-rate provider could not be reached.'),
  );
});
afterEach(() => mock.restore());

type Staff = Awaited<ReturnType<typeof signInStaff>>;
const send = (staff: Staff, method: 'POST' | 'PATCH', url: string, payload: unknown) =>
  t.app.inject({ method, url, headers: staff.session.mutationHeaders, payload: payload as never });
const providerOf = () => t.app.get<FxProvider>(FX_PROVIDER);
const OLD = new Date('2026-11-06T00:00:00.000Z');
// Less than the idle time of a staff session (one hour by default).
const HALF_HOUR = 30 * 60_000;

/** USD (base), GBP at 0.79 and EUR at 0.92, rates set a day before. */
async function insertCurrencies() {
  const { db } = await testDb();
  const rows = await db
    .insert(s.currencies)
    .values([
      { code: 'USD', name: 'US dollar', rateToBase: '1', rateUpdatedAt: OLD },
      { code: 'GBP', name: 'Pound sterling', rateToBase: '0.79', rateUpdatedAt: OLD, isStorefront: true },
      { code: 'EUR', name: 'Euro', rateToBase: '0.92', rateUpdatedAt: OLD, isStorefront: true },
    ])
    .returning();
  return Object.fromEntries(rows.map((row) => [row.code, row.id])) as Record<'USD' | 'GBP' | 'EUR', number>;
}
const rowOf = async (id: number) => {
  const { db } = await testDb();
  return (await db.select().from(s.currencies).where(eq(s.currencies.id, id)))[0]!;
};
const changeAudits = async () => {
  const { db } = await testDb();
  return (await db.select().from(s.auditLogs)).filter((row) => row.action === 'changed currency');
};

describe('PATCH /admin/currencies/:id: a typed rate and the refresh bound (decision 049)', () => {
  it('a rate more than fx.max_refresh_move_percent from the stored one needs an Owner; nothing is stored for anyone else', async () => {
    const ids = await insertCurrencies();
    const staff = await signInStaff(t, ['settings:update', 'currencies:update']);
    const url = `/admin/currencies/${ids.GBP}`;
    for (const rateToBase of ['0.0079', '7.9', '0.65', '1.0']) {
      const refused = await send(staff, 'PATCH', url, { rateToBase, name: 'Sterling' });
      expect(refused.statusCode).toBe(403);
      expect(refused.json()).toMatchObject({
        code: 'FORBIDDEN',
        detail: 'Only an owner can set a rate of GBP more than 20 % away from the stored 0.7900.',
      });
    }
    expect(await rowOf(ids.GBP)).toMatchObject({
      name: 'Pound sterling',
      rateToBase: '0.79000000',
      rateUpdatedAt: OLD,
      rateHeldAt: null,
    });
    expect(await changeAudits()).toHaveLength(0);

    const owner = await signInStaff(t, ['*']);
    const typed = await send(owner, 'PATCH', url, { rateToBase: '0.0079' });
    expect(typed.statusCode).toBe(200);
    expect(typed.json()).toMatchObject({ rateToBase: '0.0079', isStale: false });
  });

  it('a move within the bound, the bound itself and the same number are accepted, and each restarts the age', async () => {
    const ids = await insertCurrencies();
    const staff = await signInStaff(t, ['settings:update', 'currencies:update']);
    const url = `/admin/currencies/${ids.GBP}`;
    // 0.79 / 0.66 is 19.7 % apart.
    expect((await send(staff, 'PATCH', url, { rateToBase: '0.66' })).json()).toMatchObject({
      rateToBase: '0.6600',
      rateUpdatedAt: clock.now().toISOString(),
    });
    clock.advance(HALF_HOUR);
    const again = await send(staff, 'PATCH', url, { rateToBase: '0.66' });
    expect(again.json()).toMatchObject({ rateToBase: '0.6600', rateUpdatedAt: clock.now().toISOString() });
    // Exactly the bound passes: 0.66 x 1.2.
    expect((await send(staff, 'PATCH', url, { rateToBase: '0.792' })).statusCode).toBe(200);
  });

  it('the bound is the setting fx.max_refresh_move_percent', async () => {
    const ids = await insertCurrencies();
    const { db } = await testDb();
    await db.insert(s.settings).values({ key: 'fx.max_refresh_move_percent', value: 100 });
    await clearIdentityCaches(t);
    const staff = await signInStaff(t, ['settings:update', 'currencies:update']);
    const url = `/admin/currencies/${ids.GBP}`;
    expect((await send(staff, 'PATCH', url, { rateToBase: '1.58' })).statusCode).toBe(200);
    const refused = await send(staff, 'PATCH', url, { rateToBase: '3.17' });
    expect(refused.statusCode).toBe(403);
    expect(refused.json().detail).toBe(
      'Only an owner can set a rate of GBP more than 100 % away from the stored 1.5800.',
    );
  });

  it('a held currency: confirming a rate within the bound ends the hold; the far rate needs an Owner', async () => {
    const ids = await insertCurrencies();
    const { db } = await testDb();
    const hold = () => db.update(s.currencies).set({ rateHeldAt: clock.now() }).where(eq(s.currencies.id, ids.EUR));
    await hold();
    // The provider now offers 0.93, within the bound of the stored 0.92.
    spyOn(providerOf(), 'fetchRates').mockResolvedValue({ rates: new Map([['EUR', '0.93000000']]) });
    const staff = await signInStaff(t, ['settings:update', 'currencies:update']);
    const url = `/admin/currencies/${ids.EUR}`;
    // 1.20 against the stored 0.92 is 30.4 %.
    expect((await send(staff, 'PATCH', url, { rateToBase: '1.2' })).statusCode).toBe(403);
    expect(await rowOf(ids.EUR)).toMatchObject({ rateToBase: '0.92000000', rateHeldAt: clock.now() });
    const confirmed = await send(staff, 'PATCH', url, { rateToBase: '0.92' });
    expect(confirmed.statusCode).toBe(200);
    expect(confirmed.json().isStale).toBe(false);
    expect(await rowOf(ids.EUR)).toMatchObject({ rateHeldAt: null, rateUpdatedAt: clock.now() });

    await hold();
    const owner = await signInStaff(t, ['*']);
    expect((await send(owner, 'PATCH', url, { rateToBase: '1.2' })).statusCode).toBe(200);
    expect(await rowOf(ids.EUR)).toMatchObject({ rateToBase: '1.20000000', rateHeldAt: null });
  });

  it("rates typed one after another, each within the bound of the stored one, stay within the bound of the provider's", async () => {
    const ids = await insertCurrencies();
    const fetchRates = spyOn(providerOf(), 'fetchRates').mockResolvedValue({
      rates: new Map([['GBP', '0.79000000']]),
    });
    const staff = await signInStaff(t, ['settings:update', 'currencies:update']);
    const url = `/admin/currencies/${ids.GBP}`;
    // 19 % below the stored 0.79, which is also the provider's rate.
    const first = await send(staff, 'PATCH', url, { rateToBase: '0.66386555' });
    expect(first.statusCode).toBe(200);
    const firstAt = clock.now();
    clock.advance(1000);
    // 19 % below the stored 0.66386555, but 41.6 % below the provider's 0.79.
    const second = await send(staff, 'PATCH', url, { rateToBase: '0.55787022', name: 'Sterling' });
    expect(second.statusCode).toBe(403);
    expect(second.json()).toMatchObject({
      code: 'FORBIDDEN',
      detail: "Only an owner can set a rate of GBP more than 20 % away from the provider's 0.7900.",
    });
    expect(fetchRates).toHaveBeenCalledWith(['GBP']);
    expect(await rowOf(ids.GBP)).toMatchObject({
      name: 'Pound sterling',
      rateToBase: '0.66386555',
      rateUpdatedAt: firstAt,
      rateHeldAt: null,
    });
    expect(await changeAudits()).toHaveLength(1);

    const owner = await signInStaff(t, ['*']);
    const calls = fetchRates.mock.calls.length;
    expect((await send(owner, 'PATCH', url, { rateToBase: '0.55787022' })).statusCode).toBe(200);
    // An Owner is never refused, so the provider is not asked.
    expect(fetchRates.mock.calls.length).toBe(calls);
    expect((await rowOf(ids.GBP)).rateToBase).toBe('0.55787022');
  });

  it("a hold of the refresh on a rate far from the provider's: the stored rate typed again needs an Owner, and the hold is kept", async () => {
    const ids = await insertCurrencies();
    const { db } = await testDb();
    await db.update(s.currencies).set({ rateToBase: '0.0079' }).where(eq(s.currencies.id, ids.GBP));
    spyOn(providerOf(), 'fetchRates').mockResolvedValue({
      rates: new Map([
        ['GBP', '0.79000000'],
        ['EUR', '0.92000000'],
      ]),
    });
    const staff = await signInStaff(t, ['settings:update', 'currencies:update']);
    const refreshed = await send(staff, 'POST', '/admin/currencies/refresh-fx', {});
    expect(refreshed.statusCode).toBe(200);
    expect(refreshed.json().failed.map((row: { code: string }) => row.code)).toEqual(['GBP']);
    const heldAt = (await rowOf(ids.GBP)).rateHeldAt;
    expect(heldAt).not.toBeNull();

    clock.advance(1000);
    const url = `/admin/currencies/${ids.GBP}`;
    const again = await send(staff, 'PATCH', url, { rateToBase: '0.0079' });
    expect(again.statusCode).toBe(403);
    expect(again.json()).toMatchObject({
      code: 'FORBIDDEN',
      detail: "Only an owner can set a rate of GBP more than 20 % away from the provider's 0.7900.",
    });
    // The provider's rate is that far from the stored one too: the move is an Owner's decision either way.
    expect((await send(staff, 'PATCH', url, { rateToBase: '0.79' })).statusCode).toBe(403);
    expect(await rowOf(ids.GBP)).toMatchObject({ rateToBase: '0.00790000', rateUpdatedAt: OLD, rateHeldAt: heldAt });

    const owner = await signInStaff(t, ['*']);
    const confirmed = await send(owner, 'PATCH', url, { rateToBase: '0.0079' });
    expect(confirmed.statusCode).toBe(200);
    expect(confirmed.json().isStale).toBe(false);
    expect(await rowOf(ids.GBP)).toMatchObject({ rateHeldAt: null, rateUpdatedAt: clock.now() });
  });

  it('a rate that is not valid is still 422', async () => {
    const ids = await insertCurrencies();
    const staff = await signInStaff(t, ['settings:update', 'currencies:update']);
    const res = await send(staff, 'PATCH', `/admin/currencies/${ids.GBP}`, { rateToBase: '0' });
    expect(res.statusCode).toBe(422);
  });
});

describe('POST /admin/currencies: the first rate and the provider (decision 049)', () => {
  const GBP = { code: 'GBP', name: 'Pound sterling', rateToBase: '0.79', isStorefront: true };

  it("is judged against the provider's rate when the provider offers one", async () => {
    const fetchRates = spyOn(providerOf(), 'fetchRates').mockResolvedValue({
      rates: new Map([
        ['GBP', '0.79120000'],
        ['EUR', '0.92000000'],
      ]),
    });
    const staff = await signInStaff(t, ['settings:update', 'currencies:update']);
    const refused = await send(staff, 'POST', '/admin/currencies', { ...GBP, rateToBase: '0.0079' });
    expect(refused.statusCode).toBe(403);
    expect(refused.json()).toMatchObject({
      code: 'FORBIDDEN',
      detail: "Only an owner can add GBP at a rate more than 20 % away from the provider's 0.7912.",
    });
    expect(fetchRates).toHaveBeenCalledWith(['GBP']);
    const { db } = await testDb();
    expect(await db.select().from(s.currencies)).toHaveLength(0);
    expect(await db.select().from(s.auditLogs)).toHaveLength(0);

    const added = await send(staff, 'POST', '/admin/currencies', { ...GBP, rateToBase: '0.8' });
    expect(added.statusCode).toBe(201);
    const owner = await signInStaff(t, ['*']);
    const far = await send(owner, 'POST', '/admin/currencies', { code: 'EUR', name: 'Euro', rateToBase: '9.2' });
    expect(far.statusCode).toBe(201);
  });

  it("is accepted as typed when the provider's rate is not known", async () => {
    const fetchRates = spyOn(providerOf(), 'fetchRates').mockRejectedValue(
      new FxProviderUnavailableError('The exchange-rate provider did not answer in time.'),
    );
    const staff = await signInStaff(t, ['settings:update', 'currencies:update']);
    expect((await send(staff, 'POST', '/admin/currencies', { ...GBP, rateToBase: '0.0079' })).statusCode).toBe(201);
    fetchRates.mockResolvedValue({ rates: new Map() });
    expect(
      (await send(staff, 'POST', '/admin/currencies', { code: 'EUR', name: 'Euro', rateToBase: '9.2' })).statusCode,
    ).toBe(201);
  });
});

describe('PATCH /admin/currencies/:id: decimals (decision 046)', () => {
  it('a change of decimals also needs currencies:update; nothing is stored without it', async () => {
    const ids = await insertCurrencies();
    const settingsOnly = await signInStaff(t, ['settings:update']);
    const url = `/admin/currencies/${ids.GBP}`;
    const refused = await send(settingsOnly, 'PATCH', url, { decimals: 0 });
    expect(refused.statusCode).toBe(403);
    expect(refused.json().detail).toBe('You need the currencies:update permission to do this.');
    expect((await rowOf(ids.GBP)).decimals).toBe(2);
    expect((await send(settingsOnly, 'PATCH', url, { isStorefront: false })).statusCode).toBe(200);

    const rated = await signInStaff(t, ['settings:update', 'currencies:update']);
    const changed = await send(rated, 'PATCH', url, { decimals: 0 });
    expect(changed.statusCode).toBe(200);
    expect(changed.json().decimals).toBe(0);
  });
});
