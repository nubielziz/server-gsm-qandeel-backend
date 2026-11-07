// Integration tests of the currency routes (map stage 3, resolution money-13): list, read, create and change under
// settings:update, the staleness rule on controlled time, the base currency's protection and the audit trail.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import { eq } from 'drizzle-orm';
import { schema as s } from '../../src/infra/db';
import { type TestApp, createTestApp } from '../support/app';
import { clearIdentityCaches, signInStaff } from '../support/auth';
import { DAY, HOUR, TestClock } from '../support/clock';
import { closeTestDb, resetDb, testDb } from '../support/db';

const clock = new TestClock('2026-11-01T10:00:00.000Z');
let t: TestApp;

beforeAll(async () => {
  t = await createTestApp({ clock });
});
afterAll(async () => {
  await resetDb();
  await t.close();
  await closeTestDb();
});
beforeEach(async () => {
  clock.set('2026-11-01T10:00:00.000Z');
  await resetDb();
  await clearIdentityCaches(t);
});

type Staff = Awaited<ReturnType<typeof signInStaff>>;
const get = (staff: Staff, url: string) => t.app.inject({ method: 'GET', url, headers: staff.session.headers });
const send = (staff: Staff, method: 'POST' | 'PATCH', url: string, payload: unknown) =>
  t.app.inject({ method, url, headers: staff.session.mutationHeaders, payload: payload as never });

const USD = {
  code: 'USD',
  name: 'US dollar',
  rateToBase: '1',
  markupPercent: '0',
  charmRounding: false,
  isStorefront: true,
  decimals: 2,
};
const GBP = {
  code: 'GBP',
  name: 'Pound sterling',
  rateToBase: '0.79',
  markupPercent: '2.5',
  charmRounding: true,
  isStorefront: true,
  decimals: 2,
};

/** Creates currencies through the route, as the console does. */
async function create(staff: Staff, body: Record<string, unknown>) {
  const res = await send(staff, 'POST', '/admin/currencies', body);
  expect(res.statusCode).toBe(201);
  return res.json<Record<string, unknown> & { id: number }>();
}

describe('POST /admin/currencies', () => {
  it('adds a currency: code upper-cased, rate and markup normalised, rate stamped now, audited', async () => {
    const staff = await signInStaff(t, ['settings:update']);
    const row = await create(staff, { ...GBP, code: 'gbp', name: '  Pound sterling ' });
    expect(row).toEqual({
      id: row.id,
      code: 'GBP',
      name: 'Pound sterling',
      rateToBase: '0.7900',
      rateUpdatedAt: '2026-11-01T10:00:00.000Z',
      markupPercent: '2.5000',
      charmRounding: true,
      isStorefront: true,
      decimals: 2,
      isActive: true,
      createdAt: '2026-11-01T10:00:00.000Z',
      updatedAt: expect.any(String),
      isStale: false,
    });
    const { db } = await testDb();
    const [audit] = await db.select().from(s.auditLogs);
    expect(audit).toMatchObject({
      action: 'added currency',
      entityType: 'currency',
      entityId: row.id,
      entityLabel: 'GBP',
      before: null,
      after: { code: 'GBP', rateToBase: '0.7900', markupPercent: '2.5000', isActive: true },
    });
  });

  it('applies the defaults of an omitted switch and keeps a long rate exact', async () => {
    const staff = await signInStaff(t, ['settings:update']);
    const row = await create(staff, { code: 'JPY', name: 'Japanese yen', rateToBase: '150.12345678' });
    expect(row).toMatchObject({
      rateToBase: '150.12345678',
      markupPercent: '0.0000',
      charmRounding: false,
      isStorefront: false,
      decimals: 2,
    });
  });

  it('validates every field with 422 and creates nothing', async () => {
    const staff = await signInStaff(t, ['settings:update']);
    const fieldsOf = async (body: Record<string, unknown>) => {
      const res = await send(staff, 'POST', '/admin/currencies', body);
      expect(res.statusCode).toBe(422);
      return (res.json().errors as Array<{ field: string }>).map((error) => error.field).sort();
    };
    expect(await fieldsOf({ ...GBP, code: 'GB' })).toEqual(['code']);
    expect(await fieldsOf({ ...GBP, code: 'GB1' })).toEqual(['code']);
    expect(await fieldsOf({ ...GBP, name: '   ' })).toEqual(['name']);
    expect(await fieldsOf({ ...GBP, rateToBase: '0' })).toEqual(['rateToBase']);
    expect(await fieldsOf({ ...GBP, rateToBase: '-0.5' })).toEqual(['rateToBase']);
    expect(await fieldsOf({ ...GBP, rateToBase: '0.123456789' })).toEqual(['rateToBase']);
    expect(await fieldsOf({ ...GBP, markupPercent: '10.0001' })).toEqual(['markupPercent']);
    expect(await fieldsOf({ ...GBP, decimals: 5 })).toEqual(['decimals']);
    expect(await fieldsOf({ ...GBP, decimals: 1.5 })).toEqual(['decimals']);
    expect(await fieldsOf({ code: 'x', name: '', rateToBase: '0', markupPercent: '11', decimals: -1 })).toEqual([
      'code',
      'decimals',
      'markupPercent',
      'name',
      'rateToBase',
    ]);
    expect(await fieldsOf({ code: 'GBP' })).toEqual(['name', 'rateToBase']);
    const { db } = await testDb();
    expect(await db.select().from(s.currencies)).toHaveLength(0);
  });

  it('refuses a code that is already listed, however it is written, and lets only one of two simultaneous requests win', async () => {
    const staff = await signInStaff(t, ['settings:update']);
    await create(staff, GBP);
    const again = await send(staff, 'POST', '/admin/currencies', { ...GBP, code: 'gbp' });
    expect(again.statusCode).toBe(422);
    expect(again.json().errors).toEqual([
      expect.objectContaining({ field: 'code', message: 'This currency is already in the list.' }),
    ]);
    const race = await Promise.all(
      [1, 2, 3].map(() => send(staff, 'POST', '/admin/currencies', { ...GBP, code: 'SEK', name: 'Krona' })),
    );
    expect(race.map((res) => res.statusCode).sort()).toEqual([201, 422, 422]);
  });

  it('needs settings:update and a CSRF token', async () => {
    const reader = await signInStaff(t, ['wallet:read']);
    expect((await send(reader, 'POST', '/admin/currencies', GBP)).json().code).toBe('FORBIDDEN');
    const staff = await signInStaff(t, ['settings:update']);
    const noToken = await t.app.inject({
      method: 'POST',
      url: '/admin/currencies',
      headers: staff.session.headers,
      payload: GBP,
    });
    expect(noToken.json().code).toBe('CSRF_FAILED');
  });
});

describe('GET /admin/currencies', () => {
  async function seeded() {
    const staff = await signInStaff(t, ['settings:update']);
    await create(staff, USD);
    await create(staff, GBP);
    await create(staff, { ...GBP, code: 'EUR', name: 'Euro', rateToBase: '0.92', isStorefront: false });
    await create(staff, { ...GBP, code: 'SEK', name: 'Swedish krona', rateToBase: '10.5' });
    return staff;
  }

  it('lists by code by default with the exact total and every field of the console type', async () => {
    const staff = await seeded();
    const res = await get(staff, '/admin/currencies?_start=0&_end=200&_sort=code&_order=asc');
    expect(res.headers['x-total-count']).toBe('4');
    const rows = res.json<Array<{ code: string }>>();
    expect(rows.map((row) => row.code)).toEqual(['EUR', 'GBP', 'SEK', 'USD']);
    expect(Object.keys(rows[0]!).sort()).toEqual([
      'charmRounding',
      'code',
      'createdAt',
      'decimals',
      'id',
      'isActive',
      'isStale',
      'isStorefront',
      'markupPercent',
      'name',
      'rateToBase',
      'rateUpdatedAt',
      'updatedAt',
    ]);
    expect((await get(staff, '/admin/currencies')).json<Array<{ code: string }>>().map((row) => row.code)).toEqual([
      'EUR',
      'GBP',
      'SEK',
      'USD',
    ]);
  });

  it('searches code and name, filters the switches, sorts and pages', async () => {
    const staff = await seeded();
    const codes = async (query: string) =>
      (await get(staff, `/admin/currencies?${query}`)).json<Array<{ code: string }>>().map((row) => row.code);
    expect(await codes('q=krona')).toEqual(['SEK']);
    expect(await codes('q=gb')).toEqual(['GBP']);
    expect(await codes('q=%25')).toEqual([]);
    expect(await codes('isStorefront=false')).toEqual(['EUR']);
    expect(await codes('isStorefront=true&_sort=rateToBase&_order=desc')).toEqual(['SEK', 'USD', 'GBP']);
    expect(await codes('_sort=name&_order=asc&_start=1&_end=3')).toEqual(['GBP', 'SEK']);
    const page = await get(staff, '/admin/currencies?_start=3&_end=10');
    expect(page.headers['x-total-count']).toBe('4');
    expect((await get(staff, '/admin/currencies?_sort=markupPercent')).statusCode).toBe(422);
  });

  it('marks a non-base currency stale once its rate is more than 24 hours old, to the millisecond, and never the base', async () => {
    const staff = await signInStaff(t, ['settings:update']);
    await create(staff, USD);
    const gbp = await create(staff, GBP);
    // Sessions follow the same clock: after a jump of days a fresh sign-in reads.
    const reader = () => signInStaff(t, ['settings:update']);
    const stale = async (id: number) =>
      (await get(await reader(), `/admin/currencies/${id}`)).json<{ isStale: boolean }>().isStale;
    clock.advance(DAY);
    expect(await stale(gbp.id)).toBe(false);
    clock.advance(1);
    expect(await stale(gbp.id)).toBe(true);
    const list = (await get(await reader(), '/admin/currencies')).json<Array<{ code: string; isStale: boolean }>>();
    expect(list.map((row) => [row.code, row.isStale])).toEqual([
      ['GBP', true],
      ['USD', false],
    ]);
    clock.advance(365 * DAY);
    const later = (await get(await reader(), '/admin/currencies')).json<Array<{ code: string; isStale: boolean }>>();
    expect(later.find((row) => row.code === 'USD')!.isStale).toBe(false);
  });

  it('needs settings:update even to read, as the map says', async () => {
    const other = await signInStaff(t, ['ledger:read']);
    expect((await get(other, '/admin/currencies')).json().code).toBe('FORBIDDEN');
  });
});

describe('GET /admin/currencies/:id', () => {
  it('answers one currency, 404 for an unknown id and 422 for a bad one', async () => {
    const staff = await signInStaff(t, ['settings:update']);
    const gbp = await create(staff, GBP);
    const one = await get(staff, `/admin/currencies/${gbp.id}`);
    expect(one.json()).toEqual(gbp);
    expect((await get(staff, '/admin/currencies/9999')).json().code).toBe('NOT_FOUND');
    expect((await get(staff, '/admin/currencies/gbp')).statusCode).toBe(422);
  });
});

describe('PATCH /admin/currencies/:id', () => {
  it('changes only the fields sent; a new rate restarts the stale clock, a markup alone does not', async () => {
    const staff = await signInStaff(t, ['settings:update']);
    const gbp = await create(staff, GBP);
    clock.advance(30 * HOUR);
    const url = `/admin/currencies/${gbp.id}`;
    // Thirty hours later the staff session (one hour of idle time by default) is gone; sign in again.
    const staff2 = await signInStaff(t, ['settings:update']);
    expect((await get(staff2, url)).json<{ isStale: boolean }>().isStale).toBe(true);

    const markup = await send(staff2, 'PATCH', url, { markupPercent: '3' });
    expect(markup.json()).toMatchObject({
      markupPercent: '3.0000',
      rateToBase: '0.7900',
      rateUpdatedAt: '2026-11-01T10:00:00.000Z',
      isStale: true,
    });

    const rate = await send(staff2, 'PATCH', url, { rateToBase: '0.8' });
    expect(rate.json()).toMatchObject({
      rateToBase: '0.8000',
      markupPercent: '3.0000',
      rateUpdatedAt: '2026-11-02T16:00:00.000Z',
      isStale: false,
      charmRounding: true,
    });
    expect(rate.json().updatedAt).toBe('2026-11-02T16:00:00.000Z');
  });

  it('switches the storefront and the activity flags and renames', async () => {
    const staff = await signInStaff(t, ['settings:update']);
    const gbp = await create(staff, GBP);
    const res = await send(staff, 'PATCH', `/admin/currencies/${gbp.id}`, {
      isStorefront: false,
      isActive: false,
      charmRounding: false,
      name: 'Sterling',
      decimals: 0,
    });
    expect(res.json()).toMatchObject({
      isStorefront: false,
      isActive: false,
      charmRounding: false,
      name: 'Sterling',
      decimals: 0,
    });
  });

  it('audits before and after, even for a change that alters nothing', async () => {
    const staff = await signInStaff(t, ['settings:update']);
    const gbp = await create(staff, GBP);
    await send(staff, 'PATCH', `/admin/currencies/${gbp.id}`, { markupPercent: '4' });
    await send(staff, 'PATCH', `/admin/currencies/${gbp.id}`, {});
    const { db } = await testDb();
    const audits = await db.select().from(s.auditLogs).orderBy(s.auditLogs.id);
    expect(audits.map((row) => row.action)).toEqual(['added currency', 'changed currency', 'changed currency']);
    expect(audits[1]).toMatchObject({
      entityType: 'currency',
      entityId: gbp.id,
      before: { markupPercent: '2.5000' },
      after: { markupPercent: '4.0000' },
    });
  });

  it('validates the fields it receives with 422 and changes nothing', async () => {
    const staff = await signInStaff(t, ['settings:update']);
    const gbp = await create(staff, GBP);
    const url = `/admin/currencies/${gbp.id}`;
    const fieldsOf = async (body: Record<string, unknown>) => {
      const res = await send(staff, 'PATCH', url, body);
      expect(res.statusCode).toBe(422);
      return (res.json().errors as Array<{ field: string }>).map((error) => error.field).sort();
    };
    expect(await fieldsOf({ rateToBase: '0' })).toEqual(['rateToBase']);
    expect(await fieldsOf({ markupPercent: '10.5' })).toEqual(['markupPercent']);
    expect(await fieldsOf({ decimals: 9 })).toEqual(['decimals']);
    expect(await fieldsOf({ name: ' ' })).toEqual(['name']);
    expect(await fieldsOf({ code: 'EUR' })).toEqual(['code']);
    expect(await fieldsOf({ rateToBase: '0', markupPercent: '99' })).toEqual(['markupPercent', 'rateToBase']);
    expect((await get(staff, url)).json()).toEqual(gbp);
    // Sending the same code (any case) is not a change.
    expect((await send(staff, 'PATCH', url, { code: 'gbp', name: 'Pound sterling' })).statusCode).toBe(200);
  });

  it('refuses a new rate, a markup or switching off on the base currency, but accepts the values it already has', async () => {
    const staff = await signInStaff(t, ['settings:update']);
    const usd = await create(staff, USD);
    const url = `/admin/currencies/${usd.id}`;
    for (const [body, field] of [
      [{ rateToBase: '1.1' }, 'rateToBase'],
      [{ markupPercent: '1' }, 'markupPercent'],
      [{ isActive: false }, 'isActive'],
    ] as const) {
      const res = await send(staff, 'PATCH', url, body);
      expect(res.statusCode).toBe(422);
      expect(res.json().errors[0].field).toBe(field);
    }
    expect(
      (await send(staff, 'PATCH', url, { rateToBase: '1.0000', markupPercent: '0', isStorefront: false })).statusCode,
    ).toBe(200);
  });

  it('answers 404 for an unknown currency and 403 without settings:update', async () => {
    const staff = await signInStaff(t, ['settings:update']);
    expect((await send(staff, 'PATCH', '/admin/currencies/9999', { name: 'x y' })).json().code).toBe('NOT_FOUND');
    const gbp = await create(staff, GBP);
    const other = await signInStaff(t, ['wallet:adjust']);
    expect((await send(other, 'PATCH', `/admin/currencies/${gbp.id}`, { name: 'Other' })).json().code).toBe(
      'FORBIDDEN',
    );
    const { db } = await testDb();
    expect((await db.select().from(s.currencies).where(eq(s.currencies.id, gbp.id)))[0]!.name).toBe('Pound sterling');
  });
});
