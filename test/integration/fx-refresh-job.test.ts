// Integration tests of the hourly fx_refresh maintenance job (feature 14b, decision 029): the processor on the real database with the
// manual driver (nothing asked, nothing changed, a succeeded run that says why) and with a stand-in provider (the same refresh as the admin
// route, written by the system actor and recorded in job_runs; no audit row when there is no currency to refresh), and its hourly schedule.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, mock, spyOn } from 'bun:test';
import { eq } from 'drizzle-orm';
import { schema as s } from '../../src/infra/db';
import { JobSchedulerRegistry } from '../../src/infra/queues';
import { JobRunsService } from '../../src/modules/health';
import { FX_REFRESH_JOB, FX_REFRESH_SCHEDULER, FxRefreshJobModule } from '../../src/modules/money';
import { FxRefreshProcessor } from '../../src/modules/money/jobs/fx-refresh.processor';
import { FX_PROVIDER, FxProviderUnavailableError, type FxProvider } from '../../src/modules/money/domain/fx-provider';
import { type TestApp, createTestApp } from '../support/app';
import { TestClock } from '../support/clock';
import { closeTestDb, resetDb, testDb } from '../support/db';
import { rejectionOf } from '../support/rejection';

const clock = new TestClock('2026-11-07T10:00:00.000Z');
/** An app whose driver is `openexchangerates` with a key, and one whose driver is `manual` (the default of tests). */
let configured: TestApp;
let manual: TestApp;

beforeAll(async () => {
  configured = await createTestApp({
    clock,
    imports: [FxRefreshJobModule],
    env: { FX_PROVIDER: 'openexchangerates', FX_API_KEY: 'test-app-id' },
  });
  manual = await createTestApp({ clock, imports: [FxRefreshJobModule] });
});
afterAll(async () => {
  await resetDb();
  await configured.close();
  await manual.close();
  await closeTestDb();
});
beforeEach(async () => {
  clock.set('2026-11-07T10:00:00.000Z');
  await resetDb();
});
afterEach(() => mock.restore());

/** The job's own provider (the module builds its own, apart from the API's). */
const providerOf = (app: TestApp) => app.app.select(FxRefreshJobModule).get<FxProvider>(FX_PROVIDER);
const processorOf = (app: TestApp) => app.app.select(FxRefreshJobModule).get(FxRefreshProcessor);
const tick = (app: TestApp, data: { runId?: number } = {}) =>
  processorOf(app).process({ data } as Parameters<FxRefreshProcessor['process']>[0]);

const OLD = new Date('2026-11-01T00:00:00.000Z');
/** USD (base), GBP, EUR and AED (active), SEK (switched off); rates written long ago. */
async function insertCurrencies(): Promise<void> {
  const { db } = await testDb();
  await db.insert(s.currencies).values([
    { code: 'USD', name: 'US dollar', rateToBase: '1', rateUpdatedAt: OLD },
    { code: 'GBP', name: 'Pound sterling', rateToBase: '0.79', rateUpdatedAt: OLD },
    { code: 'EUR', name: 'Euro', rateToBase: '0.92', rateUpdatedAt: OLD },
    { code: 'AED', name: 'UAE dirham', rateToBase: '3.67', rateUpdatedAt: OLD },
    { code: 'SEK', name: 'Swedish krona', rateToBase: '10.6', rateUpdatedAt: OLD, isActive: false },
  ]);
}
const ratesNow = async () => {
  const { db } = await testDb();
  return Object.fromEntries(
    (await db.select().from(s.currencies)).map((row) => [row.code, [row.rateToBase, row.rateUpdatedAt.toISOString()]]),
  );
};

describe('the fx_refresh job with the manual provider', () => {
  it('asks nothing, changes nothing, writes no audit row and ends as a succeeded run with the reason (no warning every hour, no retry)', async () => {
    await insertCurrencies();
    const before = await ratesNow();
    const fetchRates = spyOn(providerOf(manual), 'fetchRates');

    expect(await tick(manual)).toEqual({ skipped: true, refreshed: 0, failed: 0 });
    expect(fetchRates).not.toHaveBeenCalled();
    expect(await ratesNow()).toEqual(before);
    const { db } = await testDb();
    expect(await db.select().from(s.auditLogs)).toHaveLength(0);
    const [run] = await db.select().from(s.jobRuns);
    expect(run).toMatchObject({ job: 'fx_refresh', trigger: 'schedule', status: 'succeeded', processed: 0 });
    expect(run!.result).toEqual({ reason: 'no provider configured' });
  });

  it('closes the run a staff member started from the Jobs tab, also as succeeded', async () => {
    const started = await manual.app
      .get(JobRunsService, { strict: false })
      .start({ job: FX_REFRESH_JOB, trigger: 'manual', overlap: 'refuse' });
    await tick(manual, { runId: started.id });
    const { db } = await testDb();
    const [run] = await db.select().from(s.jobRuns).where(eq(s.jobRuns.id, started.id));
    expect(run).toMatchObject({ trigger: 'manual', status: 'succeeded', processed: 0 });
  });

  it('does the same for openexchangerates without a key', async () => {
    const keyless = await createTestApp({
      clock,
      imports: [FxRefreshJobModule],
      env: { FX_PROVIDER: 'openexchangerates' },
    });
    try {
      await insertCurrencies();
      const before = await ratesNow();
      expect(providerOf(keyless).configured).toBe(false);
      expect(await tick(keyless)).toEqual({ skipped: true, refreshed: 0, failed: 0 });
      expect(await ratesNow()).toEqual(before);
      const { db } = await testDb();
      expect(await db.select().from(s.jobRuns)).toMatchObject([{ status: 'succeeded' }]);
    } finally {
      await keyless.close();
    }
  });
});

describe('the fx_refresh job with a provider that returns rates', () => {
  it('refreshes like the admin route: the rates, the clock time, one audit row by the system, and a succeeded run', async () => {
    await insertCurrencies();
    clock.advance(60 * 60 * 1000);
    const fetchRates = spyOn(providerOf(configured), 'fetchRates').mockResolvedValue({
      rates: new Map([
        ['GBP', '0.79120000'],
        ['EUR', '0.91500000'],
      ]),
    });

    expect(await tick(configured)).toEqual({ skipped: false, refreshed: 2, failed: 1 });
    // The base currency and a switched-off currency are never asked for.
    expect(fetchRates).toHaveBeenCalledWith(['AED', 'EUR', 'GBP']);
    expect(await ratesNow()).toMatchObject({
      GBP: ['0.79120000', '2026-11-07T11:00:00.000Z'],
      EUR: ['0.91500000', '2026-11-07T11:00:00.000Z'],
      AED: ['3.67000000', '2026-11-01T00:00:00.000Z'],
      USD: ['1.00000000', '2026-11-01T00:00:00.000Z'],
      SEK: ['10.60000000', '2026-11-01T00:00:00.000Z'],
    });

    const { db } = await testDb();
    const audits = await db.select().from(s.auditLogs);
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({
      action: 'refreshed exchange rate',
      entityType: 'currency',
      entityLabel: 'EUR, GBP',
      actorType: 'system',
      actorId: null,
      before: { EUR: '0.9200', GBP: '0.7900' },
      after: { EUR: '0.9150', GBP: '0.7912' },
    });
    const [run] = await db.select().from(s.jobRuns);
    expect(run).toMatchObject({ job: 'fx_refresh', trigger: 'schedule', status: 'succeeded', processed: 2 });
    expect(run!.result).toEqual({ source: 'openexchangerates', refreshed: 2, failed: 1 });
  });

  it('ends without a call and without an audit row when no active non-base currency exists, and the run succeeded', async () => {
    const { db } = await testDb();
    // Only the base currency, and one that is switched off: there is nothing to refresh.
    await db.insert(s.currencies).values([
      { code: 'USD', name: 'US dollar', rateToBase: '1', rateUpdatedAt: OLD },
      { code: 'SEK', name: 'Swedish krona', rateToBase: '10.6', rateUpdatedAt: OLD, isActive: false },
    ]);
    const before = await ratesNow();
    const fetchRates = spyOn(providerOf(configured), 'fetchRates');

    expect(await tick(configured)).toEqual({ skipped: false, refreshed: 0, failed: 0 });
    expect(fetchRates).not.toHaveBeenCalled();
    expect(await ratesNow()).toEqual(before);
    expect(await db.select().from(s.auditLogs)).toHaveLength(0);
    const [run] = await db.select().from(s.jobRuns);
    expect(run).toMatchObject({ job: 'fx_refresh', status: 'succeeded', processed: 0 });
    expect(run!.result).toEqual({ source: 'openexchangerates', refreshed: 0, failed: 0 });
  });

  it('fails the run and keeps the old rates when the configured provider cannot answer', async () => {
    await insertCurrencies();
    const before = await ratesNow();
    spyOn(providerOf(configured), 'fetchRates').mockRejectedValue(
      new FxProviderUnavailableError('The exchange-rate provider did not answer in time.'),
    );

    expect(await rejectionOf(tick(configured))).toMatchObject({ code: 'FX_PROVIDER_DOWN' });
    expect(await ratesNow()).toEqual(before);
    const { db } = await testDb();
    expect(await db.select().from(s.auditLogs)).toHaveLength(0);
    const [run] = await db.select().from(s.jobRuns);
    expect(run).toMatchObject({ job: 'fx_refresh', status: 'failed', processed: 0 });
    expect(run!.error).toContain('did not answer in time');
  });
});

describe('the fx_refresh schedule', () => {
  it('is registered every hour on the maintenance queue', () => {
    expect(configured.app.get(JobSchedulerRegistry, { strict: false }).list()).toContainEqual(
      expect.objectContaining({
        id: FX_REFRESH_SCHEDULER,
        queue: 'maintenance',
        jobName: FX_REFRESH_JOB,
        pattern: '0 * * * *',
      }),
    );
  });
});
