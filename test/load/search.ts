// Load test of the storefront search (feature 29, plan section 8). Not part of `check`: the lead runs it once before the merge and records
// the table in src/modules/storefront/search/README.md. It builds the test app of this worktree (its own database, Redis DB and Typesense
// prefix), fills Postgres with N synthetic services from the golden generator (`test/fixtures/search/generator.ts`), rebuilds the index from
// them (timing the rebuild and the reconcile), then measures: suggest at the API (p50/p95/p99, errors) at a steady rate from several client
// addresses, the engine's own part, results, price-sorted results, the Postgres queries per suggest, and the apply time of an edit.
//
// Usage: NODE_ENV=test bun test/load/search.ts [--count 10000] [--seconds 60] [--rate 100] [--ips 20] [--edits 20] [--full 0]
//        --full N: also rebuild and reconcile N synthetic services (for example 100000) and print the duration and the peak memory.
import { eq } from 'drizzle-orm';
import { DbService, type Database, schema as s } from '../../src/infra/db';
import { SearchNames } from '../../src/modules/storefront';
import {
  SearchRebuildProcessor,
  SearchReconcileProcessor,
  SearchTermsBuildProcessor,
} from '../../src/modules/storefront/search/jobs/search-maintenance.processors';
import { generateDistractors } from '../fixtures/search/generator';
import { adminWith } from '../support/admin-api';
import { insertCategory } from '../support/catalog';
import { closeTestDb, resetDb, testDb } from '../support/db';
import { deleteBullKeys } from '../support/queues';
import { createSearchTestApp, dropSearchPrefix, engineClient, indexedIds, runSearchOutbox } from '../support/search';
import { insertCurrency } from '../support/storefront';
import { insertDemoGroups } from '../support/pricing';
import { Redis } from 'ioredis';

function argument(name: string, fallback: number): number {
  const index = process.argv.indexOf(`--${name}`);
  const value = index < 0 ? undefined : Number(process.argv[index + 1]);
  return value !== undefined && Number.isInteger(value) && value >= 0 ? value : fallback;
}

function percentile(sorted: readonly number[], p: number): number {
  if (sorted.length === 0) return Number.NaN;
  return sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)]!;
}

const fixed = (value: number) => (Number.isFinite(value) ? value.toFixed(1) : 'n/a');
const mb = (bytes: number) => (bytes / 1024 / 1024).toFixed(0);

/** Words visitors type: prefixes and typos over the generator's vocabulary. */
const QUERIES = [
  'sams',
  'samsung f',
  'samsng',
  'huawei',
  'xiaomi frp',
  'iphon 14',
  'network unlock',
  'verizon',
  'bootloader',
  'imei repair',
  'galaxy a1',
  'oppo frp remove',
  'rogers canada',
  'mdm',
  'z3x box',
  'sm-a13',
  'unlock code',
  'firmware',
  'vivo',
  'tecno infinix',
];

/** Inserts N synthetic services with an English listing and a retail price each (four categories, one per service type). */
async function fill(db: Database, count: number, firstId: number): Promise<{ rows: number }> {
  const categories: Record<string, number> = {};
  for (const type of ['imei', 'server', 'remote', 'file'] as const)
    categories[type] = await insertCategory(db, { name: `Load ${type}`, type });
  const [groups] = await db.select().from(s.clientGroups).where(eq(s.clientGroups.kind, 'b2c_retail')).limit(1);
  const sources = generateDistractors({ count, seed: 11, firstId });
  const slice = 500;
  for (let start = 0; start < sources.length; start += slice) {
    const part = sources.slice(start, start + slice);
    const rows = await db
      .insert(s.services)
      .values(
        part.map((source) => ({
          categoryId: categories[source.type]!,
          type: source.type as 'imei' | 'server' | 'remote' | 'file',
          name: source.title,
          code: `LOAD-${source.serviceId}`,
          fulfillment: 'auto' as const,
          basePrice: '0.1300',
          cost: '0.0800',
          effectiveCost: '0.0800',
          slaMinutes: 60,
        })),
      )
      .returning({ id: s.services.id });
    await db
      .insert(s.serviceGroupPrices)
      .values(rows.map((row) => ({ serviceId: row.id, groupId: groups!.id, price: '4.9900' })));
    await db.insert(s.serviceListings).values(
      rows.map((row, index) => {
        const source = part[index]!;
        return {
          serviceId: row.id,
          slug: `load-${row.id}`,
          publicTitle: source.title,
          summary: source.summary,
          brand: source.brand,
          carrier: source.carrier,
          country: source.country,
          sales30d: source.sales30d,
          isListed: true,
        };
      }),
    );
  }
  return { rows: count };
}

/** Sends `rate` requests a second for `seconds` from `ips` addresses and returns the latencies and the errors. */
async function steady(
  app: Awaited<ReturnType<typeof createSearchTestApp>>,
  url: (n: number) => string,
  seconds: number,
  rate: number,
  ips: number,
): Promise<{ latencies: number[]; errors: number }> {
  const latencies: number[] = [];
  let errors = 0;
  const pending: Promise<void>[] = [];
  const started = performance.now();
  for (let n = 0; ; n += 1) {
    const due = started + (n * 1000) / rate;
    if (due - started > seconds * 1000) break;
    const wait = due - performance.now();
    if (wait > 0) await Bun.sleep(wait);
    const at = performance.now();
    pending.push(
      app.app
        .inject({
          method: 'GET',
          url: url(n),
          remoteAddress: `198.51.100.${(n % ips) + 1}`,
          headers: { 'user-agent': 'Mozilla/5.0 load' },
        })
        .then((res) => {
          latencies.push(performance.now() - at);
          if (res.statusCode !== 200 || res.headers['x-search-engine'] !== 'typesense') errors += 1;
        }),
    );
  }
  await Promise.all(pending);
  return { latencies: latencies.sort((a, b) => a - b), errors };
}

const count = argument('count', 10_000);
const seconds = argument('seconds', 60);
const rate = argument('rate', 100);
const ips = argument('ips', 20);
const edits = argument('edits', 20);
const full = argument('full', 0);

await resetDb();
const app = await createSearchTestApp();
const { db } = await testDb();
const engine = engineClient();
const job = (data: object = {}) => ({ name: 'load', data, timestamp: Date.now() }) as never;
const rows: Array<[string, string]> = [];
try {
  await insertCurrency(db, { code: 'USD', name: 'US dollar', rateToBase: '1' });
  await insertDemoGroups(db);
  let started = performance.now();
  await fill(db, count, 1);
  rows.push([`Postgres fill (${count} services)`, `${fixed((performance.now() - started) / 1000)} s`]);

  started = performance.now();
  await app.app.get(SearchRebuildProcessor, { strict: false }).process(job());
  const rebuildSeconds = (performance.now() - started) / 1000;
  rows.push([`Rebuild (${count} services)`, `${fixed(rebuildSeconds)} s`]);
  started = performance.now();
  await app.app.get(SearchTermsBuildProcessor, { strict: false }).process(job());
  rows.push(['Terms build', `${fixed((performance.now() - started) / 1000)} s`]);
  started = performance.now();
  await app.app.get(SearchReconcileProcessor, { strict: false }).process(job());
  rows.push([`Reconcile (${count} services)`, `${fixed((performance.now() - started) / 1000)} s`]);
  const metrics = await engine.metrics();
  rows.push([
    'Typesense memory allocated / resident',
    `${mb(metrics.memoryAllocatedBytes ?? 0)} / ${mb(metrics.memoryResidentBytes ?? 0)} MB`,
  ]);

  // Warm the caches, then measure.
  const text = (n: number) => encodeURIComponent(QUERIES[n % QUERIES.length]!);
  await steady(app, (n) => `/store/v1/search/suggest?q=${text(n)}`, 2, 50, ips);
  const suggest = await steady(app, (n) => `/store/v1/search/suggest?q=${text(n)}`, seconds, rate, ips);
  rows.push([
    `Suggest at ${rate}/s from ${ips} addresses for ${seconds} s: p50 / p95 / p99`,
    `${fixed(percentile(suggest.latencies, 50))} / ${fixed(percentile(suggest.latencies, 95))} / ${fixed(percentile(suggest.latencies, 99))} ms (target p95 <= 50), ${suggest.errors} errors`,
  ]);
  const results = await steady(app, (n) => `/store/v1/search?q=${text(n)}`, Math.min(seconds, 20), 20, ips);
  rows.push([
    'Results p50 / p95',
    `${fixed(percentile(results.latencies, 50))} / ${fixed(percentile(results.latencies, 95))} ms (target p95 <= 120), ${results.errors} errors`,
  ]);
  const priced = await steady(
    app,
    (n) => `/store/v1/search?q=${text(n)}&sort=price&minPrice=1`,
    Math.min(seconds, 20),
    10,
    ips,
  );
  rows.push([
    'Price-sorted results p50 / p95',
    `${fixed(percentile(priced.latencies, 50))} / ${fixed(percentile(priced.latencies, 95))} ms (target p95 <= 300), ${priced.errors} errors`,
  ]);
  const engineMs: number[] = [];
  const names = new SearchNames(app.prefix);
  const client = engine;
  for (let n = 0; n < 200; n += 1) {
    const at = performance.now();
    await client.search(names.alias('services'), {
      q: QUERIES[n % QUERIES.length]!,
      query_by: 'title,title_words',
      per_page: 6,
      include_fields: 'id',
    });
    engineMs.push(performance.now() - at);
  }
  engineMs.sort((a, b) => a - b);
  rows.push(['Engine part (one plain search) p95', `${fixed(percentile(engineMs, 95))} ms (target <= 15)`]);

  // Postgres queries per warm suggest.
  const pool = app.app.get(DbService).pool;
  await app.app.inject({ method: 'GET', url: '/store/v1/search/suggest?q=samsung', remoteAddress: '198.51.100.250' });
  let queries = 0;
  const original = pool.query.bind(pool) as (...args: unknown[]) => unknown;
  (pool as unknown as { query: unknown }).query = (...args: unknown[]) => {
    queries += 1;
    return original(...args);
  };
  await app.app.inject({ method: 'GET', url: '/store/v1/search/suggest?q=samsung', remoteAddress: '198.51.100.250' });
  (pool as unknown as { query: unknown }).query = original;
  rows.push(['Postgres queries per warm suggest', String(queries)]);

  // The apply time of an edit (engine write after the outbox event; the relay adds up to about a second).
  const owner = await adminWith(app, ['storefront:*']);
  const apply: number[] = [];
  const sample = await db.select().from(s.serviceListings).limit(edits);
  for (const [index, listing] of sample.entries()) {
    const title = `Edited title ${index} for load`;
    const at = performance.now();
    await owner.patch(`/admin/service-listings/${listing.id}`, { publicTitle: title });
    await runSearchOutbox(app);
    for (let tries = 0; tries < 50; tries += 1) {
      if ((await indexedIds(app.prefix, `"Edited title ${index} for load"`)).includes(String(listing.serviceId))) break;
      await Bun.sleep(100);
    }
    apply.push(performance.now() - at);
  }
  apply.sort((a, b) => a - b);
  rows.push([
    `Edit to searchable (${edits} edits, no relay wait) p50 / p95`,
    `${fixed(percentile(apply, 50))} / ${fixed(percentile(apply, 95))} ms (target p95 <= 5000 with the relay)`,
  ]);

  if (full > 0) {
    await resetDb();
    await insertCurrency(db, { code: 'USD', name: 'US dollar', rateToBase: '1' });
    await insertDemoGroups(db);
    started = performance.now();
    await fill(db, full, 1);
    rows.push([`Postgres fill (${full} services)`, `${fixed((performance.now() - started) / 1000)} s`]);
    started = performance.now();
    await app.app.get(SearchRebuildProcessor, { strict: false }).process(job());
    rows.push([
      `Full rebuild (${full} services; target < 300 s)`,
      `${fixed((performance.now() - started) / 1000)} s, process peak ${mb(process.memoryUsage().rss)} MB`,
    ]);
    started = performance.now();
    await app.app.get(SearchReconcileProcessor, { strict: false }).process(job());
    rows.push([
      `Full reconcile (${full} services; target < 120 s)`,
      `${fixed((performance.now() - started) / 1000)} s, process peak ${mb(process.memoryUsage().rss)} MB`,
    ]);
    const after = await engine.metrics();
    rows.push([
      'Typesense memory allocated / resident after the full run',
      `${mb(after.memoryAllocatedBytes ?? 0)} / ${mb(after.memoryResidentBytes ?? 0)} MB`,
    ]);
  }
} finally {
  console.log(
    `\n| Measure | Result |\n| --- | --- |\n${rows.map(([name, value]) => `| ${name} | ${value} |`).join('\n')}\n`,
  );
  await dropSearchPrefix(app.prefix);
  const redis = new Redis(app.config.redis.queueUrl);
  await deleteBullKeys(redis, app.bullPrefix);
  redis.disconnect();
  await resetDb();
  await app.close();
  await closeTestDb();
}
