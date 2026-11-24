// Helpers of the storefront search suites (feature 29): a test app with search on and its own Typesense prefix (a sub-prefix of the
// worktree's `<test database>_`), a client on the node's bootstrap key for checks and clean-up, and "run the search jobs of the pending
// outbox events as the worker would". Every suite drops its prefix in afterAll; nothing outside it is ever touched.
import { randomBytes } from 'node:crypto';
import { asc, gt, inArray } from 'drizzle-orm';
import { DEV_DEFAULTS, parseEnv, searchPrefixOf } from '@src/config';
import { schema as s } from '@src/infra/db';
import { httpRequest } from '@src/infra/http/http-request';
import { TypesenseClient } from '@src/infra/search';
import { CATALOG_CATEGORY_CHANGED_EVENT, CATALOG_SERVICES_CHANGED_EVENT } from '@src/modules/catalog';
import type { OutboxJobData } from '@src/modules/platform';
import { LISTING_CHANGED_EVENT, SERVICES_SCHEMA_VERSION, SearchWorkerModule } from '@src/modules/storefront';
import { SearchSyncProcessor } from '@src/modules/storefront/search/jobs/search-index.processor';
import { type TestApp, type TestAppOptions, createTestApp } from './app';
import { TEST_DATABASE_URL, testDb } from './db';
import { testInstanceEnv } from './env';
import { testBullPrefix } from './queues';

/** The Typesense node of the tests (`TYPESENSE_URL_TEST`, default the compose node). */
export const SEARCH_TEST_URL = parseEnv({ NODE_ENV: 'test', ...testInstanceEnv() }).search.url;
/** The worktree's prefix (`gsm_29_test_` here): every suite works under a sub-prefix of it. */
export const SEARCH_TEST_BASE = searchPrefixOf(TEST_DATABASE_URL);

/**
 * A fresh sub-prefix of the worktree's prefix for one suite.
 *
 * @returns `<base><6 hex>_`, for example `gsm_29_test_3fa2c1_`
 */
export function searchTestPrefix(): string {
  return `${SEARCH_TEST_BASE}${randomBytes(3).toString('hex')}_`;
}

/**
 * A client on the node's development (bootstrap) key, for the tests' own checks and clean-up; never used by the app.
 *
 * @param apiKey another key to talk with (the keys made by `scripts/search-keys.ts`)
 * @returns the client
 */
export function engineClient(apiKey: string = DEV_DEFAULTS.typesenseKey): TypesenseClient {
  return new TypesenseClient(
    { request: (options) => httpRequest(options) },
    { url: SEARCH_TEST_URL, apiKey, searchTimeoutMs: 5_000 },
  );
}

/**
 * Drops every collection, alias and set whose name starts with a prefix (and the keys described for it).
 *
 * @param prefix the suite's sub-prefix (never the bare worktree prefix)
 */
export async function dropSearchPrefix(prefix: string): Promise<void> {
  if (!prefix.startsWith(SEARCH_TEST_BASE) || prefix === SEARCH_TEST_BASE) {
    throw new Error(`Refusing to clean "${prefix}": a suite cleans only its own sub-prefix of ${SEARCH_TEST_BASE}.`);
  }
  const client = engineClient();
  for (const alias of await client.listAliases(prefix)) await client.deleteAlias(alias.name);
  for (const collection of await client.listCollections(prefix)) await client.dropCollection(collection.name);
  await client.deleteSynonymSet(`${prefix}synonyms`);
  // A suite that builds an index of schema version 1 (the upgrade test) leaves its curation set behind if the rebuild failed.
  await client.deleteCurationSet(`${prefix}curations`);
  for (const key of await client.listKeys()) {
    if (key.description.startsWith(`gsm:${prefix}:`)) await client.deleteKey(key.id);
  }
}

/** A test app with search on, its prefix and its BullMQ prefix. */
export interface SearchTestApp extends TestApp {
  readonly prefix: string;
  readonly bullPrefix: string;
}

/**
 * Builds the API with search on (`SEARCH_ENABLED_TEST=true`), a fresh Typesense sub-prefix and BullMQ prefix, and the worker's search
 * module (its jobs are run by hand: the test app has no queue workers).
 *
 * @param options the usual test-app options (env on top of the search settings)
 * @returns the app; call `dropSearchPrefix(app.prefix)` and `close()` in afterAll
 */
export async function createSearchTestApp(
  options: TestAppOptions & { readonly prefix?: string } = {},
): Promise<SearchTestApp> {
  const prefix = options.prefix ?? searchTestPrefix();
  const bullPrefix = testBullPrefix();
  const t = await createTestApp({
    ...options,
    env: { SEARCH_ENABLED_TEST: 'true', TYPESENSE_PREFIX_TEST: prefix, BULL_PREFIX: bullPrefix, ...options.env },
    imports: [SearchWorkerModule, ...(options.imports ?? [])],
  });
  return { ...t, prefix, bullPrefix };
}

const SYNC_EVENTS = [CATALOG_SERVICES_CHANGED_EVENT, CATALOG_CATEGORY_CHANGED_EVENT, LISTING_CHANGED_EVENT];
const handled = new WeakMap<TestApp, number>();

/**
 * Runs the search jobs of the outbox events written since the last call, in order, as the worker's relay and processors would.
 *
 * @param t the running search test app
 * @returns how many events were handled
 */
export async function runSearchOutbox(t: TestApp): Promise<number> {
  const { db } = await testDb();
  const after = handled.get(t) ?? 0;
  const events = await db
    .select()
    .from(s.outboxEvents)
    .where(inArray(s.outboxEvents.type, SYNC_EVENTS))
    .orderBy(asc(s.outboxEvents.id));
  const pending = events.filter((event) => event.id > after);
  const sync = t.app.get(SearchSyncProcessor, { strict: false });
  for (const event of pending) {
    const { meta: _meta, ...payload } = event.payload;
    const data: OutboxJobData = {
      eventId: event.id,
      type: event.type,
      aggregateType: event.aggregateType,
      aggregateId: event.aggregateId,
      payload: payload as OutboxJobData['payload'],
      requestId: `test-${event.id}`,
    };
    const job = { name: event.type, data, timestamp: event.createdAt.getTime() } as never;
    await sync.process(job);
    handled.set(t, event.id);
  }
  return pending.length;
}

/**
 * Forgets the outbox events handled so far (after `resetDb`, ids start again at 1).
 *
 * @param t the running search test app
 */
export function resetSearchOutbox(t: TestApp): void {
  handled.delete(t);
}

/**
 * Lists the outbox events of the search written after an id.
 *
 * @param afterId the last id seen (0 for all)
 * @returns type, aggregate and payload (without the request-id bookkeeping) of each event, in order
 */
export async function searchEvents(
  afterId = 0,
): Promise<
  Array<{ id: number; type: string; aggregateType: string; aggregateId: number; payload: Record<string, unknown> }>
> {
  const { db } = await testDb();
  const rows = await db
    .select()
    .from(s.outboxEvents)
    .where(gt(s.outboxEvents.id, afterId))
    .orderBy(asc(s.outboxEvents.id));
  return rows
    .filter((row) => SYNC_EVENTS.includes(row.type))
    .map((row) => {
      const { meta: _meta, ...payload } = row.payload;
      return { id: row.id, type: row.type, aggregateType: row.aggregateType, aggregateId: row.aggregateId, payload };
    });
}

/**
 * Searches the services alias of a prefix directly (the tests' own view of the index).
 *
 * @param prefix the suite's prefix
 * @param q the query
 * @param params more parameters
 * @returns the ids of the hits, in order
 */
export async function indexedIds(prefix: string, q = '*', params: Record<string, string> = {}): Promise<string[]> {
  const result = await engineClient().search(`${prefix}services_v${SERVICES_SCHEMA_VERSION}`, {
    q,
    query_by: 'title,title_words,codes,joins,models,brand,carrier,networks,country_names,category,summary',
    per_page: 250,
    ...params,
  });
  return result.hits.map((hit) => String((hit.document as { id: unknown }).id)).sort((a, b) => Number(a) - Number(b));
}
