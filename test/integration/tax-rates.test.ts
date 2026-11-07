// Integration tests of the tax rate routes (map stage 14, built ahead of feature 14b): list, read, add and change under the
// tax permissions, the one-window-at-a-time rule per country and region (also under parallel requests), and the audit rows.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import { eq } from 'drizzle-orm';
import { schema as s } from '../../src/infra/db';
import { type TestApp, createTestApp } from '../support/app';
import { clearIdentityCaches, signInStaff } from '../support/auth';
import { TestClock } from '../support/clock';
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
type Row = Record<string, unknown> & { id: number };
const get = (staff: Staff, url: string) => t.app.inject({ method: 'GET', url, headers: staff.session.headers });
const send = (staff: Staff, method: 'POST' | 'PATCH', url: string, payload: unknown) =>
  t.app.inject({ method, url, headers: staff.session.mutationHeaders, payload: payload as never });
const editor = () => signInStaff(t, ['tax:read', 'tax:create', 'tax:update']);

const FRANCE = {
  country: 'fr',
  region: '',
  ratePercent: '20',
  taxType: 'vat',
  appliesTo: 'digital_services',
  validFrom: '2026-04-15T00:00:00.000Z',
  validTo: null,
  label: 'France VAT',
  ossScheme: 'EU OSS',
};

async function create(staff: Staff, body: Record<string, unknown>): Promise<Row> {
  const res = await send(staff, 'POST', '/admin/tax-rates', body);
  expect(res.statusCode).toBe(201);
  return res.json<Row>();
}

describe('POST /admin/tax-rates', () => {
  it('adds a window: country upper-cased, rate with four decimals, times from the clock, audited', async () => {
    const staff = await editor();
    const row = await create(staff, FRANCE);
    expect(row).toEqual({
      id: row.id,
      country: 'FR',
      region: '',
      ratePercent: '20.0000',
      taxType: 'vat',
      appliesTo: 'digital_services',
      validFrom: '2026-04-15T00:00:00.000Z',
      validTo: null,
      label: 'France VAT',
      ossScheme: 'EU OSS',
      createdAt: '2026-11-01T10:00:00.000Z',
      updatedAt: '2026-11-01T10:00:00.000Z',
    });
    const { db } = await testDb();
    const [audit] = await db.select().from(s.auditLogs).where(eq(s.auditLogs.entityType, 'tax_rate'));
    expect(audit).toMatchObject({ action: 'added tax rate', entityId: row.id, entityLabel: 'France VAT' });
  });

  it('refuses bad fields with one error per field', async () => {
    const staff = await editor();
    const res = await send(staff, 'POST', '/admin/tax-rates', {
      ...FRANCE,
      country: 'FRA',
      ratePercent: '120',
      taxType: 'VAT',
      validFrom: null,
      label: 'x'.repeat(81),
    });
    expect(res.statusCode).toBe(422);
    const fields = res.json<{ errors: { field: string }[] }>().errors.map((error) => error.field);
    expect(fields.sort()).toEqual(['country', 'label', 'ratePercent', 'taxType', 'validFrom']);
  });

  it('wants the end after the start', async () => {
    const staff = await editor();
    const res = await send(staff, 'POST', '/admin/tax-rates', { ...FRANCE, validTo: '2026-04-15T00:00:00.000Z' });
    expect(res.statusCode).toBe(422);
    expect(res.json<{ errors: { field: string }[] }>().errors[0]?.field).toBe('validTo');
  });

  it('refuses a window that overlaps another of the same country and region, and lets the next one follow', async () => {
    const staff = await editor();
    const first = await create(staff, { ...FRANCE, validTo: '2027-01-01T00:00:00.000Z' });
    const clash = await send(staff, 'POST', '/admin/tax-rates', { ...FRANCE, validFrom: '2026-12-01T00:00:00.000Z' });
    expect(clash.statusCode).toBe(422);
    expect(clash.json<{ errors: { field: string; message: string }[] }>().errors[0]).toMatchObject({
      field: 'validFrom',
      message: expect.stringContaining('2026-04-15 to 2027-01-01'),
    });
    // The end is exclusive: the next rate may start on the day the first one ends.
    const next = await create(staff, { ...FRANCE, ratePercent: '21', validFrom: '2027-01-01T00:00:00.000Z' });
    expect(next.id).not.toBe(first.id);
    // Another region of the same country is a separate window.
    await create(staff, { ...FRANCE, region: 'Corsica', ratePercent: '10' });
  });

  it('never stores two overlapping windows, even when two requests arrive together', async () => {
    const staff = await editor();
    const results = await Promise.all(
      Array.from({ length: 4 }, (_, index) =>
        send(staff, 'POST', '/admin/tax-rates', { ...FRANCE, ratePercent: String(20 + index) }),
      ),
    );
    expect(results.map((res) => res.statusCode).sort()).toEqual([201, 422, 422, 422]);
    const { db } = await testDb();
    expect(await db.select().from(s.taxRates)).toHaveLength(1);
  });

  it('needs tax:create', async () => {
    const reader = await signInStaff(t, ['tax:read']);
    const res = await send(reader, 'POST', '/admin/tax-rates', FRANCE);
    expect(res.statusCode).toBe(403);
    expect(res.json<{ code: string }>().code).toBe('FORBIDDEN');
  });
});

describe('GET /admin/tax-rates and /admin/tax-rates/:id', () => {
  it('lists every window with the total, sorted by country, and searches country and label', async () => {
    const staff = await editor();
    await create(staff, { ...FRANCE, validTo: '2027-01-01T00:00:00.000Z' });
    await create(staff, { ...FRANCE, ratePercent: '21', validFrom: '2027-01-01T00:00:00.000Z' });
    await create(staff, { ...FRANCE, country: 'DE', ratePercent: '19', label: 'Germany VAT' });
    const all = await get(staff, '/admin/tax-rates?_start=0&_end=200&_sort=country&_order=asc');
    expect(all.statusCode).toBe(200);
    expect(all.headers['x-total-count']).toBe('3');
    expect(all.json<Row[]>().map((row) => row.country)).toEqual(['DE', 'FR', 'FR']);
    const found = await get(staff, '/admin/tax-rates?q=germany');
    expect(found.json<Row[]>().map((row) => row.label)).toEqual(['Germany VAT']);
    expect((await get(staff, '/admin/tax-rates?_sort=label')).statusCode).toBe(422);
  });

  it('reads one row, 404 for an unknown id, 403 without tax:read', async () => {
    const staff = await editor();
    const row = await create(staff, FRANCE);
    expect((await get(staff, `/admin/tax-rates/${row.id}`)).json<Row>()).toMatchObject({ id: row.id, country: 'FR' });
    const missing = await get(staff, '/admin/tax-rates/999999');
    expect(missing.statusCode).toBe(404);
    expect(missing.json<{ code: string }>().code).toBe('NOT_FOUND');
    const outsider = await signInStaff(t, ['orders:read']);
    expect((await get(outsider, '/admin/tax-rates')).statusCode).toBe(403);
  });
});

describe('PATCH /admin/tax-rates/:id', () => {
  it('changes the fields sent, ends a window, clears the end again, and audits before and after', async () => {
    const staff = await editor();
    const row = await create(staff, FRANCE);
    clock.advance(60_000);
    const ended = await send(staff, 'PATCH', `/admin/tax-rates/${row.id}`, {
      ratePercent: '20.5',
      validTo: '2027-01-01T00:00:00.000Z',
    });
    expect(ended.statusCode).toBe(200);
    expect(ended.json<Row>()).toMatchObject({
      ratePercent: '20.5000',
      validTo: '2027-01-01T00:00:00.000Z',
      updatedAt: '2026-11-01T10:01:00.000Z',
    });
    const reopened = await send(staff, 'PATCH', `/admin/tax-rates/${row.id}`, { validTo: null });
    expect(reopened.json<Row>().validTo).toBeNull();
    const { db } = await testDb();
    const audits = await db.select().from(s.auditLogs).where(eq(s.auditLogs.action, 'changed tax rate'));
    expect(audits).toHaveLength(2);
    expect(audits[0]).toMatchObject({
      entityId: row.id,
      before: { ratePercent: '20.0000' },
      after: { ratePercent: '20.5000' },
    });
  });

  it('refuses a country change, a missing start, an end before the start and an overlap with another window', async () => {
    const staff = await editor();
    const early = await create(staff, { ...FRANCE, validTo: '2026-06-01T00:00:00.000Z' });
    await create(staff, { ...FRANCE, validFrom: '2026-06-01T00:00:00.000Z' });
    const country = await send(staff, 'PATCH', `/admin/tax-rates/${early.id}`, { country: 'DE' });
    expect(country.json<{ errors: { field: string }[] }>().errors[0]?.field).toBe('country');
    const start = await send(staff, 'PATCH', `/admin/tax-rates/${early.id}`, { validFrom: null });
    expect(start.json<{ errors: { field: string }[] }>().errors[0]?.field).toBe('validFrom');
    const order = await send(staff, 'PATCH', `/admin/tax-rates/${early.id}`, { validTo: '2026-01-01T00:00:00.000Z' });
    expect(order.json<{ errors: { field: string }[] }>().errors[0]?.field).toBe('validTo');
    // Clearing the end of the first window would run into the second one.
    const overlap = await send(staff, 'PATCH', `/admin/tax-rates/${early.id}`, { validTo: null });
    expect(overlap.statusCode).toBe(422);
    expect(overlap.json<{ errors: { field: string }[] }>().errors[0]?.field).toBe('validFrom');
  });

  it('answers 404 for an unknown id and 403 without tax:update', async () => {
    const staff = await editor();
    const row = await create(staff, FRANCE);
    expect((await send(staff, 'PATCH', '/admin/tax-rates/999999', { label: 'x' })).statusCode).toBe(404);
    const reader = await signInStaff(t, ['tax:read']);
    expect((await send(reader, 'PATCH', `/admin/tax-rates/${row.id}`, { label: 'x' })).statusCode).toBe(403);
  });
});
