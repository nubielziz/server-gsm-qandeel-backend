// Route parity (decision 009, docs/contract/TESTS.md § 1): the application defines and serves exactly the routes of the
// map (and of scripts/map-additions, decision 035) that are not listed in pending.ts, with the access and permission of their
// row, and every route the frontend calls is built or pending.
import { describe, expect, it } from 'bun:test';
import { loadFrontendEndpoints, loadManifest, loadMismatchIds } from './lib/inputs';
import {
  ACCESS_EXCEPTIONS,
  accessMismatches,
  difference,
  expectedKeys,
  rowMismatches,
  staleAccessExceptions,
  turnstileMismatches,
} from './lib/manifest-parity';
import { appSnapshot } from './lib/snapshot';
import { PENDING } from './pending';

const snapshot = await appSnapshot();
const manifest = loadManifest();
const pending = new Set(PENDING);
const manifestKeys = new Set(manifest.map((endpoint) => endpoint.key));

/**
 * Outgoing events the backend adds to the map's three (`order.status_changed`, `wallet.low_balance`, `invoice.paid`), each tied
 * to a B-entry: `service.price_changed` is user rule 9 (MISMATCHES B117 (5)). They are built but not in the manifest, so the
 * event test expects them next to the manifest's keys.
 */
const BACKEND_EVENTS: readonly string[] = ['EVENT service.price_changed'];

/**
 * The one HTTP route behind the eight Dhru actions (decision 026). The manifest lists the actions (`DHRU <action>`), not the
 * transport, so the route has a contract and is served but is no `http` key of the manifest.
 */
const DHRU_TRANSPORT = 'POST /api/index.php';

/**
 * What is built, per kind of manifest key. Dhru actions come from the registry of `defineDhruAction`, supplier calls from the one of
 * `defineSupplierCall`, events from `defineEvent`.
 */
const built: Record<string, string[]> = {
  http: snapshot.contracts.map((contract) => contract.key).filter((key) => key !== DHRU_TRANSPORT),
  'dhru-action': [...snapshot.dhruActions],
  'supplier-call': [...snapshot.supplierCalls],
  event: snapshot.events.map((event) => event.key),
};

describe('pending.ts', () => {
  it('lists each key once and only keys of the manifest', () => {
    const repeated = PENDING.filter((key, index) => PENDING.indexOf(key) !== index);
    expect(repeated).toEqual([]);
    expect(PENDING.filter((key) => !manifestKeys.has(key))).toEqual([]);
  });

  it('no longer lists a route that is built (a built route leaves pending.ts)', () => {
    const builtKeys = new Set(Object.values(built).flat());
    expect(PENDING.filter((key) => builtKeys.has(key))).toEqual([]);
  });
});

describe('the registry against the manifest', () => {
  it('HTTP: the contract registry equals the manifest routes minus pending', () => {
    const expected = expectedKeys(manifest, 'http', pending);
    expect(difference('http', built.http ?? [], expected)).toEqual([]);
  });

  it('Dhru actions equal the manifest DHRU keys minus pending', () => {
    const expected = expectedKeys(manifest, 'dhru-action', pending);
    expect(difference('dhru', built['dhru-action'] ?? [], expected)).toEqual([]);
  });

  it('supplier calls equal the manifest SUPPLIER keys minus pending', () => {
    const expected = expectedKeys(manifest, 'supplier-call', pending);
    expect(difference('supplier', built['supplier-call'] ?? [], expected)).toEqual([]);
  });

  it('outgoing event schemas equal the manifest EVENT keys minus pending, plus the backend additions of a B-entry', () => {
    const expected = [...expectedKeys(manifest, 'event', pending), ...BACKEND_EVENTS];
    expect(difference('event', built.event ?? [], expected)).toEqual([]);
  });

  it('every built contract has the method, path and surface of its manifest row', () => {
    expect(rowMismatches(snapshot.contracts, manifest)).toEqual([]);
  });
});

describe('access and permission (decision 035)', () => {
  it('every built contract has the access and the permission of its manifest row', () => {
    expect(accessMismatches(snapshot.contracts, manifest)).toEqual([]);
  });

  it('each access exception cites an existing B-entry and still deviates from its row', () => {
    const ids = loadMismatchIds();
    for (const [key, exception] of Object.entries(ACCESS_EXCEPTIONS))
      expect(ids.has(exception.mismatch), key).toBe(true);
    expect(staleAccessExceptions(snapshot.contracts, manifest)).toEqual([]);
  });

  it('every addition of the manifest names its spec decision: an existing B-entry, or B-TBD and a slug', () => {
    const ids = loadMismatchIds();
    const bad = manifest.filter(
      (endpoint) =>
        endpoint.addition !== undefined &&
        !ids.has(endpoint.addition.spec) &&
        !/^B-TBD [a-z0-9]+(-[a-z0-9]+)*$/.test(endpoint.addition.spec),
    );
    expect(bad.map((endpoint) => `${endpoint.key} (${endpoint.addition?.spec})`)).toEqual([]);
  });
});

describe('the anti-bot check (decision 034)', () => {
  it('a built route has the turnstile flag the map gives it', () => {
    expect(turnstileMismatches(snapshot.contracts, manifest)).toEqual([]);
  });

  it('a turnstile route can answer TURNSTILE_FAILED, and no other route lists it', () => {
    for (const contract of snapshot.contracts) {
      expect(contract.errors.includes('TURNSTILE_FAILED'), contract.key).toBe(contract.turnstile ?? false);
    }
  });
});

describe('the router against the registry', () => {
  it('the Dhru transport is the one contract that is no manifest route, and it is served', () => {
    expect(snapshot.contracts.map((contract) => contract.key)).toContain(DHRU_TRANSPORT);
    expect(manifestKeys.has(DHRU_TRANSPORT)).toBe(false);
    expect(snapshot.served).toContain(DHRU_TRANSPORT);
  });

  it('Fastify serves exactly the contract routes plus the documentation routes', () => {
    const expected = [...snapshot.contracts.map((contract) => contract.key), ...snapshot.documentationRoutes];
    expect(difference('router', snapshot.served, expected)).toEqual([]);
  });

  it('the documentation routes are not map routes and have no contract', () => {
    for (const route of snapshot.documentationRoutes) {
      expect(manifestKeys.has(route), route).toBe(false);
      expect(built.http?.includes(route), route).toBe(false);
    }
  });
});

describe('the frontend against the registry', () => {
  const frontend = loadFrontendEndpoints();

  it('every route the frontend calls is in the manifest', () => {
    expect(frontend.filter((endpoint) => !manifestKeys.has(endpoint.key)).map((endpoint) => endpoint.key)).toEqual([]);
  });

  it('every route the frontend calls is built or pending', () => {
    const builtKeys = new Set(built.http);
    const lost = frontend.filter((endpoint) => !builtKeys.has(endpoint.key) && !pending.has(endpoint.key));
    expect(lost.map((endpoint) => endpoint.key)).toEqual([]);
  });
});
