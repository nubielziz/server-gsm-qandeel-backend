/* global describe, it, expect, beforeAll, afterAll, vi -- Vitest globals: the config sets `globals: true`, and this file cannot import 'vitest' from outside the frontend */
// Fixture harvest (ALIGNMENT § 8, docs/contract/TESTS.md "Fixture harvest"). Run by the FRONTEND's Vitest under Node
// (`bun run contract:harvest`): it signs in against the console's mock API (MSW handlers + demo seed), calls every
// GET route once and every mutation that answers a body, and writes `{ status, headers, body }` per route to
// test/contract/fixtures/frontend/<METHOD>_<path>.json. Nothing is written into the frontend repository.
import { mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import knownGaps from './known-gaps.json';
import { OVERRIDES, fixtureFileName, valueFor } from './plan.mjs';

// The mock layer is imported inside beforeAll, after the clock is frozen: some of its modules read the time when they load.
let mockServer;
let resetMockState;
let resetMockScenario;
let setMockScenario;
let DEMO_CODE;
let DEMO_PASSWORD;

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..', '..', '..');
const OUT = join(ROOT, 'test', 'contract', 'fixtures', 'frontend');
const BASE = 'http://api.test';
/** Response headers worth keeping: the contract is about shapes, so only the headers a client reads. */
const KEPT_HEADERS = ['content-type', 'content-disposition', 'x-total-count', 'location', 'retry-after'];
/** A fixed clock: the mock layer moves its seed timestamps to "now", so a frozen "now" gives the same files every run. */
const NOW = new Date('2026-10-31T12:00:00.000Z');

const endpoints = JSON.parse(readFileSync(join(ROOT, 'docs', 'contract', 'frontend-endpoints.json'), 'utf8')).endpoints;

/** Fixtures collected in memory; the folder is replaced only after the whole run. */
const fixtures = new Map();
/** Calls that did not give a usable answer: reported at the end, never hidden. */
const gaps = [];
/** What the harvest has read so far: first id and first page of each collection, body of each GET by manifest key. */
const world = { ids: {}, rows: {}, docs: {} };
const ids = world.ids;
/** How many other records of a collection a mutation may try when the mock refuses the first one. */
const MAX_RECORDS = 12;
let csrf = '';

async function send(method, path, { query, body } = {}) {
  const url = new URL(path, BASE);
  for (const [name, value] of Object.entries(query ?? {})) {
    for (const item of [value].flat()) url.searchParams.append(name, String(item));
  }
  const headers = { accept: 'application/json' };
  if (body !== undefined) headers['content-type'] = 'application/json';
  if (method !== 'GET' && csrf) headers['x-csrf-token'] = csrf;
  let response;
  try {
    response = await fetch(url, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  } catch (error) {
    return { status: 0, headers: {}, body: null, error: String(error?.message ?? error).slice(0, 200) };
  }
  const kept = {};
  for (const name of KEPT_HEADERS) {
    const value = response.headers.get(name);
    if (value !== null) kept[name] = value;
  }
  const text = await response.text();
  const isJson = (kept['content-type'] ?? '').includes('json');
  let parsed = text === '' ? null : text;
  if (isJson && text !== '') {
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = text;
    }
  }
  const token = response.headers.get('x-csrf-token');
  if (token) csrf = token;
  return { status: response.status, headers: kept, body: parsed };
}

async function signIn(email) {
  const login = await send('POST', '/admin/auth/login', { body: { email, password: DEMO_PASSWORD } });
  if (login.status !== 200) throw new Error(`sign-in as ${email} failed: ${login.status}`);
  return login;
}

async function signInFully(email) {
  const login = await signIn(email);
  const code = await send('POST', '/admin/auth/2fa', { body: { code: DEMO_CODE } });
  if (code.status !== 204) throw new Error(`2FA for ${email} failed: ${code.status}`);
  return login;
}

const collectionOf = (key) => key.split(' ')[1].split('/:')[0];
const paramsOf = (key) => [...key.matchAll(/:(\w+)/g)].map((match) => match[1]);
const fnParam = (endpoint, ...names) => endpoint.params.find((param) => names.includes(param.name));

/** The override of a route, resolved against what the harvest knows. */
function overrideOf(key) {
  const entry = OVERRIDES[key];
  return (typeof entry === 'function' ? entry(world) : entry) ?? {};
}

/** Fills the `:slots` of a path with `values` (path parameter name -> value). */
function fill(template, values) {
  return template.replace(/:(\w+)/g, (_match, name) => encodeURIComponent(String(values[name])));
}

/** Path parameter sets to try: the override's, or the records of the collection in turn (the first one for a read). */
async function pathValueSets(endpoint, tryOthers) {
  const key = endpoint.key;
  const collection = collectionOf(key);
  const override = overrideOf(key);
  const given = override.path ?? {};
  const base = {};
  for (const name of paramsOf(key)) {
    base[name] = given[name] ?? valueFor({ type: 'number', alias: 'Id' }, name, { collection, ids });
  }
  if (!tryOthers || given.id !== undefined || !('id' in base)) return [base];
  // Records in the right state may be anywhere in the collection: a route can ask the list for them (`?status=pending`).
  let rows = world.rows[collection] ?? [];
  if (override.candidates) {
    const found = await send('GET', override.candidates.list, {
      query: { _start: 0, _end: MAX_RECORDS, ...override.candidates.query },
    });
    if (Array.isArray(found.body)) rows = found.body;
  }
  const sets = rows.slice(0, MAX_RECORDS).map((row) => ({ ...base, id: row.id }));
  return sets.length > 0 ? sets : [base];
}

function queryFor(endpoint) {
  const override = overrideOf(endpoint.key).query;
  if (override) return override;
  const param = fnParam(endpoint, 'query', 'params');
  if (!param) return undefined;
  if (param.typeText.startsWith('ListQuery')) return { _start: 0, _end: 25 };
  return valueFor(param.shape, 'query', { collection: collectionOf(endpoint.key), ids });
}

/** Bodies to try for a mutation: the override's list, else the generated body with the override merged in. */
function bodiesFor(endpoint) {
  const override = overrideOf(endpoint.key);
  if (override.bodies) return override.bodies;
  const param = fnParam(endpoint, 'body');
  if (!param && !override.body) return [undefined];
  const generated = param ? valueFor(param.shape, 'body', { collection: collectionOf(endpoint.key), ids }) : {};
  return [{ ...generated, ...override.body }];
}

/** Remembers what a GET taught: the first id and rows of a list, the body of every read. */
function learn(endpoint, path, result) {
  world.docs[endpoint.key] = result.body;
  if (!paramsOf(endpoint.key).length && Array.isArray(result.body) && result.body[0]?.id !== undefined) {
    world.ids[path] = result.body[0].id;
    world.rows[path] = result.body;
  }
}

function record(endpoint, request, result, reasons = '') {
  const usable = result.status >= 200 && result.status <= 299;
  if (!usable) {
    const why = Array.isArray(result.body?.errors)
      ? result.body.errors.map((e) => `${e.field}: ${e.message}`).join('; ')
      : (result.body?.detail ?? '');
    gaps.push(`${endpoint.key} -> ${result.status || 'no answer'} [${request.slice(0, 160)}] ${reasons || why}`);
    return;
  }
  fixtures.set(fixtureFileName(endpoint.key), { status: result.status, headers: result.headers, body: result.body });
}

/** Calls one mutation; when the mock refuses a record in the wrong state (a payment already approved) it tries the next. */
async function mutate(endpoint) {
  const method = endpoint.key.split(' ')[0];
  let last;
  let lastRequest = '';
  const reasons = new Set();
  search: for (const set of await pathValueSets(endpoint, true)) {
    for (const body of bodiesFor(endpoint)) {
      const path = fill(endpoint.key.split(' ')[1], set);
      lastRequest = `${path} ${JSON.stringify(body)?.slice(0, 120) ?? ''}`;
      last = await send(method, path, { body });
      if (last.status >= 200 && last.status <= 299) break search;
      reasons.add(`${last.status} ${last.body?.detail ?? last.error ?? ''}`.slice(0, 90));
    }
  }
  record(endpoint, lastRequest, last, [...reasons].slice(0, 3).join(' | '));
}

/** A small seeded generator (mulberry32): the mock layer draws tokens and passwords from Math.random. */
function seededRandom(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

describe('fixture harvest', () => {
  beforeAll(async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(NOW);
    vi.spyOn(Math, 'random').mockImplementation(seededRandom(20261031));
    ({ mockServer } = await import('@/mocks/node'));
    ({ resetMockState } = await import('@/mocks/handlers'));
    ({ resetMockScenario, setMockScenario } = await import('@/mocks/scenario'));
    ({ DEMO_CODE, DEMO_PASSWORD } = await import('@/mocks/session'));
    // A route the mock layer has no handler for is a finding of the harvest, not a crash: refuse it quietly (the call
    // then fails like a network error and is listed as a gap).
    mockServer.listen({
      onUnhandledRequest: (request) => {
        throw new Error(`no mock handler for ${request.method} ${new URL(request.url).pathname}`);
      },
    });
  });
  afterAll(() => {
    mockServer?.close();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('calls every GET route and every mutation that answers a body', async () => {
    resetMockState();

    // First-time setup: Nadia (invited, no 2FA yet) is the only staff member who may ask for a TOTP secret.
    const nadia = await signIn('nadia@gsm-supply.example');
    expect(nadia.body.next).toBe('totp_setup');
    const setup = endpoints.find((endpoint) => endpoint.key === 'POST /admin/auth/2fa/setup');
    record(setup, '(Nadia, pending session)', await send('POST', '/admin/auth/2fa/setup'));

    // Everything else runs as the Owner.
    resetMockState();
    const login = await signInFully('rami@gsm-supply.example');
    record(
      endpoints.find((endpoint) => endpoint.key === 'POST /admin/auth/login'),
      '(Rami)',
      login,
    );

    const gets = endpoints.filter((endpoint) => endpoint.key.startsWith('GET '));
    // Routes without path parameters first: lists teach the harvest which ids exist.
    const order = [...gets.filter((e) => !e.key.includes(':')), ...gets.filter((e) => e.key.includes(':'))];
    for (const endpoint of order) {
      const [set] = await pathValueSets(endpoint, false);
      const path = fill(endpoint.key.split(' ')[1], set);
      const query = queryFor(endpoint);
      const result = await send('GET', path, { query });
      record(
        endpoint,
        `${path}${query ? `?${new URLSearchParams(Object.entries(query).map(([k, v]) => [k, String(v)]))}` : ''}`,
        result,
      );
      learn(endpoint, path, result);
    }

    // Mutations that answer a body change state, so they run after every read. A route that needs a scenario (an open
    // incident exists only in `degraded`) gets a fresh copy of the seed built under it; the rest share one fresh copy.
    const mutations = endpoints.filter((endpoint) => {
      const method = endpoint.key.split(' ')[0];
      if (method === 'GET' || endpoint.returnsText === 'void') return false;
      return endpoint.key !== 'POST /admin/auth/login' && endpoint.key !== 'POST /admin/auth/2fa/setup';
    });
    const withScenario = mutations.filter((endpoint) => overrideOf(endpoint.key).scenario);
    const plain = mutations.filter((endpoint) => !overrideOf(endpoint.key).scenario);
    for (const group of [...withScenario.map((endpoint) => [endpoint]), plain]) {
      resetMockState();
      const scenario = overrideOf(group[0].key).scenario;
      if (scenario) setMockScenario(scenario);
      await signInFully('rami@gsm-supply.example');
      for (const endpoint of group) await mutate(endpoint);
      resetMockScenario();
    }

    const getKeys = gets.map((endpoint) => endpoint.key);
    const missingGets = getKeys.filter((key) => !fixtures.has(fixtureFileName(key)) && !(key in knownGaps));
    const staleGaps = Object.keys(knownGaps).filter((key) => fixtures.has(fixtureFileName(key)));
    console.log(`harvest: ${fixtures.size} fixtures collected; ${gaps.length} calls without a 2xx answer`);
    for (const gap of gaps) console.log(`  gap: ${gap}`);
    // Check before writing: a run that lost a GET route must not replace the last good set of fixtures.
    expect(
      missingGets,
      'GET routes without a fixture (add a reason to known-gaps.json only if the mock layer has no handler)',
    ).toEqual([]);
    expect(staleGaps, 'known-gaps.json lists routes that now have a fixture').toEqual([]);

    mkdirSync(OUT, { recursive: true });
    for (const name of readdirSync(OUT)) if (name.endsWith('.json')) rmSync(join(OUT, name));
    for (const [name, fixture] of [...fixtures].sort(([a], [b]) => a.localeCompare(b))) {
      writeFileSync(join(OUT, name), `${JSON.stringify(fixture, null, 2)}\n`);
    }
    console.log(`harvest: wrote ${fixtures.size} files to test/contract/fixtures/frontend`);
  });
});
