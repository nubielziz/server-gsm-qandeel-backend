// Integration tests of the exchange-rate refresh (feature 14b, POST /admin/currencies/refresh-fx; decision 029, RESOLUTIONS money-9):
// the route with a stand-in provider (what was refreshed, what failed, the 502 cases, the stale rule, the audit trail) and the
// openexchangerates driver against a local server (the request it sends, the answers it reads, how it fails).
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, mock, spyOn } from 'bun:test';
import { eq } from 'drizzle-orm';
import { schema as s } from '../../src/infra/db';
import { OutboundHttp } from '../../src/infra/http';
import { FX_PROVIDER, FxProviderUnavailableError, type FxProvider } from '../../src/modules/money/domain/fx-provider';
import { OpenExchangeRatesProvider } from '../../src/modules/money/infra/open-exchange-rates.provider';
import { type TestApp, createTestApp } from '../support/app';
import { clearIdentityCaches, signInStaff } from '../support/auth';
import { HOUR, TestClock } from '../support/clock';
import { closeTestDb, resetDb, testDb } from '../support/db';

const clock = new TestClock('2026-11-07T10:00:00.000Z');
/** An app whose driver is `openexchangerates` (with a key); the default test app uses `manual`. */
let configured: TestApp;
let manual: TestApp;

beforeAll(async () => {
  configured = await createTestApp({ clock, env: { FX_PROVIDER: 'openexchangerates', FX_API_KEY: 'test-app-id' } });
  manual = await createTestApp({ clock });
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
  await clearIdentityCaches(configured);
  await clearIdentityCaches(manual);
});
afterEach(() => mock.restore());

const problem = (res: { json: () => unknown }) => res.json() as { code: string; detail: string };

/** USD (base), GBP, EUR and AED (active), SEK (switched off); rates written long ago so they are stale. */
async function insertCurrencies(): Promise<void> {
  const { db } = await testDb();
  const old = new Date('2026-11-01T00:00:00.000Z');
  await db.insert(s.currencies).values([
    { code: 'USD', name: 'US dollar', rateToBase: '1', rateUpdatedAt: old },
    { code: 'GBP', name: 'Pound sterling', rateToBase: '0.79', rateUpdatedAt: old },
    { code: 'EUR', name: 'Euro', rateToBase: '0.92', rateUpdatedAt: old },
    { code: 'AED', name: 'UAE dirham', rateToBase: '3.67', rateUpdatedAt: old },
    { code: 'SEK', name: 'Swedish krona', rateToBase: '10.6', rateUpdatedAt: old, isActive: false },
  ]);
}

async function refresh(app: TestApp, staff: Awaited<ReturnType<typeof signInStaff>>) {
  return app.app.inject({
    method: 'POST',
    url: '/admin/currencies/refresh-fx',
    headers: staff.session.mutationHeaders,
  });
}
const providerOf = (app: TestApp) => app.app.get<FxProvider>(FX_PROVIDER);

describe('POST /admin/currencies/refresh-fx', () => {
  it('refreshes every active non-base currency, reports what the provider did not offer, and stamps the clock', async () => {
    await insertCurrencies();
    const fetchRates = spyOn(providerOf(configured), 'fetchRates').mockResolvedValue({
      rates: new Map([
        ['GBP', '0.79120000'],
        ['EUR', '0.91500000'],
      ]),
    });
    const staff = await signInStaff(configured, ['currencies:update']);
    const res = await refresh(configured, staff);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      refreshed: [
        { code: 'EUR', rateToBase: '0.9150', rateUpdatedAt: '2026-11-07T10:00:00.000Z' },
        { code: 'GBP', rateToBase: '0.7912', rateUpdatedAt: '2026-11-07T10:00:00.000Z' },
      ],
      failed: [{ code: 'AED', message: 'Not offered by the provider' }],
      source: 'openexchangerates',
    });
    // The base currency and a switched-off currency are never asked for.
    expect(fetchRates).toHaveBeenCalledWith(['AED', 'EUR', 'GBP']);

    const { db } = await testDb();
    const rows = Object.fromEntries((await db.select().from(s.currencies)).map((row) => [row.code, row]));
    expect(rows.GBP).toMatchObject({ rateToBase: '0.79120000', rateUpdatedAt: new Date('2026-11-07T10:00:00.000Z') });
    expect(rows.AED).toMatchObject({ rateToBase: '3.67000000', rateUpdatedAt: new Date('2026-11-01T00:00:00.000Z') });
    expect(rows.USD).toMatchObject({ rateToBase: '1.00000000', rateUpdatedAt: new Date('2026-11-01T00:00:00.000Z') });
    expect(rows.SEK).toMatchObject({ rateToBase: '10.60000000' });
  });

  it('makes the currencies stop being stale: the list says isStale false for a refreshed rate and true for the others', async () => {
    await insertCurrencies();
    clock.advance(HOUR);
    spyOn(providerOf(configured), 'fetchRates').mockResolvedValue({ rates: new Map([['GBP', '0.79120000']]) });
    const staff = await signInStaff(configured, ['currencies:update', 'settings:update']);
    await refresh(configured, staff);
    // The list needs settings:update; the old rates are 6 days old, only GBP was refreshed.
    const list = await configured.app.inject({
      method: 'GET',
      url: '/admin/currencies',
      headers: staff.session.headers,
    });
    const byCode = Object.fromEntries(
      list.json<Array<{ code: string; isStale: boolean }>>().map((row) => [row.code, row.isStale]),
    );
    expect(byCode).toMatchObject({ USD: false, GBP: false, EUR: true, AED: true });
  });

  it('audits one row with the old and new rates and the codes refreshed', async () => {
    await insertCurrencies();
    spyOn(providerOf(configured), 'fetchRates').mockResolvedValue({
      rates: new Map([
        ['GBP', '0.80000000'],
        ['EUR', '0.93000000'],
        ['AED', '3.67250000'],
      ]),
    });
    const staff = await signInStaff(configured, ['currencies:update']);
    await refresh(configured, staff);
    const { db } = await testDb();
    const [audit] = await db.select().from(s.auditLogs);
    expect(audit).toMatchObject({
      action: 'refreshed exchange rate',
      entityType: 'currency',
      entityLabel: 'AED, EUR, GBP',
      actorId: staff.staffId,
      before: { AED: '3.6700', EUR: '0.9200', GBP: '0.7900' },
      after: { AED: '3.6725', EUR: '0.9300', GBP: '0.8000' },
    });
  });

  it('answers 502 FX_PROVIDER_DOWN with the provider’s message when nothing could be fetched, and leaves the old rates', async () => {
    await insertCurrencies();
    spyOn(providerOf(configured), 'fetchRates').mockRejectedValue(
      new FxProviderUnavailableError('The exchange-rate provider did not answer in time.'),
    );
    const staff = await signInStaff(configured, ['currencies:update']);
    const res = await refresh(configured, staff);
    expect(res.statusCode).toBe(502);
    expect(problem(res)).toMatchObject({
      code: 'FX_PROVIDER_DOWN',
      detail: 'The exchange-rate provider did not answer in time.',
    });
    const { db } = await testDb();
    expect((await db.select().from(s.currencies).where(eq(s.currencies.code, 'GBP')))[0]).toMatchObject({
      rateToBase: '0.79000000',
    });
    // A failed refresh changed nothing, so it wrote nothing to the audit log either.
    expect(await db.select().from(s.auditLogs)).toHaveLength(0);
  });

  it('answers 502 when the provider offers none of our currencies, and fails the unusable rates one by one', async () => {
    await insertCurrencies();
    const fetchRates = spyOn(providerOf(configured), 'fetchRates');
    const staff = await signInStaff(configured, ['currencies:update']);
    fetchRates.mockResolvedValueOnce({ rates: new Map([['JOD', '0.71000000']]) });
    const none = await refresh(configured, staff);
    expect(none.statusCode).toBe(502);
    expect(problem(none)).toMatchObject({
      code: 'FX_PROVIDER_DOWN',
      detail: 'The exchange-rate provider offered none of our currencies.',
    });

    fetchRates.mockResolvedValueOnce({
      rates: new Map([
        ['GBP', '0.79120000'],
        ['EUR', '0'],
        ['AED', '-3'],
      ]),
    });
    const partial = await refresh(configured, staff);
    expect(partial.statusCode).toBe(200);
    expect(partial.json()).toMatchObject({
      refreshed: [{ code: 'GBP' }],
      failed: [
        { code: 'AED', message: 'The provider sent a rate that cannot be used' },
        { code: 'EUR', message: 'The provider sent a rate that cannot be used' },
      ],
    });
  });

  it('answers 502 "No exchange-rate provider is configured." with the manual driver and with a missing key', async () => {
    await insertCurrencies();
    const staff = await signInStaff(manual, ['currencies:update']);
    const res = await refresh(manual, staff);
    expect(res.statusCode).toBe(502);
    expect(problem(res)).toMatchObject({
      code: 'FX_PROVIDER_DOWN',
      detail: 'No exchange-rate provider is configured.',
    });

    const noKey = await createTestApp({ clock, env: { FX_PROVIDER: 'openexchangerates' } });
    try {
      const other = await signInStaff(noKey, ['currencies:update']);
      const answer = await refresh(noKey, other);
      expect(answer.statusCode).toBe(502);
      expect(problem(answer).detail).toBe('No exchange-rate provider is configured.');
      expect(providerOf(noKey)).toMatchObject({ name: 'openexchangerates', configured: false });
    } finally {
      await noKey.close();
    }
  });

  it('answers an empty list when there is nothing to refresh, and two refreshes at once both succeed in order', async () => {
    const { db } = await testDb();
    await db.insert(s.currencies).values({ code: 'USD', name: 'US dollar', rateToBase: '1' });
    const fetchRates = spyOn(providerOf(configured), 'fetchRates');
    const staff = await signInStaff(configured, ['currencies:update']);
    const empty = await refresh(configured, staff);
    expect(empty.json()).toEqual({ refreshed: [], failed: [], source: 'openexchangerates' });
    expect(fetchRates).not.toHaveBeenCalled();

    // Even an empty refresh is a staff write and is audited; the two parallel ones add two more rows.
    expect(await db.select().from(s.auditLogs)).toHaveLength(1);
    await db.delete(s.currencies);
    await insertCurrencies();
    fetchRates.mockResolvedValue({
      rates: new Map([
        ['GBP', '0.80000000'],
        ['EUR', '0.93000000'],
        ['AED', '3.7'],
      ]),
    });
    const results = await Promise.all([refresh(configured, staff), refresh(configured, staff)]);
    expect(results.map((res) => res.statusCode)).toEqual([200, 200]);
    expect(await db.select().from(s.auditLogs)).toHaveLength(3);
  });

  it('needs currencies:update, and is refused without a session', async () => {
    await insertCurrencies();
    const wrong = await signInStaff(configured, ['settings:update']);
    expect((await refresh(configured, wrong)).statusCode).toBe(403);
    expect((await configured.app.inject({ method: 'POST', url: '/admin/currencies/refresh-fx' })).statusCode).toBe(401);
  });
});

describe('the openexchangerates driver', () => {
  let server: ReturnType<typeof Bun.serve>;
  let seen: Array<{ url: URL; authorization: string | null }>;
  let answer: () => Response | Promise<Response>;

  beforeAll(() => {
    server = Bun.serve({
      port: 0,
      fetch: (request) => {
        seen.push({ url: new URL(request.url), authorization: request.headers.get('authorization') });
        return answer();
      },
    });
  });
  afterAll(() => server.stop(true));
  beforeEach(() => {
    seen = [];
    answer = () => Response.json({ base: 'USD', timestamp: 1, rates: {} });
  });

  const driver = (timeoutMs = 1000) =>
    new OpenExchangeRatesProvider(configured.app.get(OutboundHttp), {
      apiKey: 'secret-app-id',
      timeoutMs,
      baseUrl: `http://localhost:${server.port}/api`,
      allowPrivateNetwork: true,
    });

  it('asks latest.json for the symbols with the key in the Authorization header, and reads the rates as exact text', async () => {
    answer = () =>
      Response.json({
        base: 'USD',
        timestamp: 1,
        rates: { GBP: 0.79, EUR: 0.9150234567, XXX: 'oops', AED: -1, JOD: 0 },
      });
    const quote = await driver().fetchRates(['GBP', 'EUR', 'AED', 'JOD']);
    expect(seen).toHaveLength(1);
    expect(seen[0]!.url.pathname).toBe('/api/latest.json');
    expect(seen[0]!.url.searchParams.get('symbols')).toBe('GBP,EUR,AED,JOD');
    expect(seen[0]!.url.search).not.toContain('secret-app-id');
    expect(seen[0]!.authorization).toBe('Token secret-app-id');
    // Unusable values (text, negative, zero) are left out like a currency the provider does not offer.
    expect([...quote.rates]).toEqual([
      ['GBP', '0.79000000'],
      ['EUR', '0.91502346'],
    ]);
  });

  it('refuses with a message that never holds the key: a refusal, a server error, text that is not JSON, another base', async () => {
    for (const [make, message] of [
      [
        () => Response.json({ error: true, message: 'invalid_app_id' }, { status: 401 }),
        'The exchange-rate provider refused the request (HTTP 401).',
      ],
      [() => new Response('boom', { status: 500 }), 'The exchange-rate provider refused the request (HTTP 500).'],
      [
        () => new Response('<html>not json</html>'),
        'The exchange-rate provider sent an answer that could not be read.',
      ],
      [() => Response.json({ rates: 'nope' }), 'The exchange-rate provider sent an answer that could not be read.'],
      [
        () => Response.json({ base: 'EUR', rates: { GBP: 0.8 } }),
        'The exchange-rate provider sent rates against another base currency.',
      ],
    ] as const) {
      answer = make;
      const error = await driver()
        .fetchRates(['GBP'])
        .catch((e: unknown) => e);
      expect(error).toBeInstanceOf(FxProviderUnavailableError);
      expect((error as Error).message).toBe(message);
      expect((error as Error).message).not.toContain('secret-app-id');
    }
  });

  it('gives up after its own timeout and reports a connection that cannot be made, without retrying', async () => {
    answer = async () => {
      await Bun.sleep(300);
      return Response.json({ base: 'USD', rates: { GBP: 0.8 } });
    };
    const slow = await driver(100)
      .fetchRates(['GBP'])
      .catch((e: unknown) => e);
    expect(slow).toBeInstanceOf(FxProviderUnavailableError);
    expect((slow as Error).message).toBe('The exchange-rate provider did not answer in time.');
    expect(seen).toHaveLength(1);

    const down = new OpenExchangeRatesProvider(configured.app.get(OutboundHttp), {
      apiKey: 'secret-app-id',
      timeoutMs: 500,
      baseUrl: 'http://localhost:1/api',
      allowPrivateNetwork: true,
    });
    const refused = await down.fetchRates(['GBP']).catch((e: unknown) => e);
    expect((refused as Error).message).toBe('The exchange-rate provider could not be reached.');
  });
});
