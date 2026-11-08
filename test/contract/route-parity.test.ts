// Route parity (decision 009, docs/contract/TESTS.md § 1): the application defines and serves exactly the routes of the
// map that are not listed in pending.ts, and every route the frontend calls is built or pending.
import { describe, expect, it } from 'bun:test';
import { loadFrontendEndpoints, loadManifest } from './lib/inputs';
import { appSnapshot } from './lib/snapshot';
import { PENDING } from './pending';

const snapshot = await appSnapshot();
const manifest = loadManifest();
const pending = new Set(PENDING);
const manifestKeys = new Set(manifest.map((endpoint) => endpoint.key));
const keysOfKind = (kind: string): string[] =>
  manifest.filter((endpoint) => endpoint.kind === kind).map((endpoint) => endpoint.key);

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

/** Lists a symmetric difference as readable text, so a failure names the keys. */
function difference(label: string, actual: Iterable<string>, expected: Iterable<string>): string[] {
  const have = new Set(actual);
  const want = new Set(expected);
  return [
    ...[...have].filter((key) => !want.has(key)).map((key) => `${label}: ${key} is built but not expected`),
    ...[...want].filter((key) => !have.has(key)).map((key) => `${label}: ${key} is expected but not built`),
  ].sort();
}

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
    const expected = keysOfKind('http').filter((key) => !pending.has(key));
    expect(difference('http', built.http ?? [], expected)).toEqual([]);
  });

  it('Dhru actions equal the manifest DHRU keys minus pending', () => {
    const expected = keysOfKind('dhru-action').filter((key) => !pending.has(key));
    expect(difference('dhru', built['dhru-action'] ?? [], expected)).toEqual([]);
  });

  it('supplier calls equal the manifest SUPPLIER keys minus pending', () => {
    const expected = keysOfKind('supplier-call').filter((key) => !pending.has(key));
    expect(difference('supplier', built['supplier-call'] ?? [], expected)).toEqual([]);
  });

  it('outgoing event schemas equal the manifest EVENT keys minus pending, plus the backend additions of a B-entry', () => {
    const expected = [...keysOfKind('event').filter((key) => !pending.has(key)), ...BACKEND_EVENTS];
    expect(difference('event', built.event ?? [], expected)).toEqual([]);
  });

  it('every built contract has the method and path of its manifest row', () => {
    const rows = new Map(manifest.map((endpoint) => [endpoint.key, endpoint]));
    const wrong = snapshot.contracts.filter((contract) => {
      const row = rows.get(contract.key);
      return (
        row !== undefined &&
        (row.method !== contract.method || row.path !== contract.path || row.surface !== contract.surface)
      );
    });
    expect(wrong.map((contract) => contract.key)).toEqual([]);
  });
});

describe('the anti-bot check (decision 034)', () => {
  it('a built route has the turnstile flag the map gives it', () => {
    const rows = new Map(manifest.map((endpoint) => [endpoint.key, endpoint]));
    const wrong = snapshot.contracts.filter((contract) => {
      const row = rows.get(contract.key);
      return row !== undefined && (row.turnstile ?? false) !== (contract.turnstile ?? false);
    });
    expect(wrong.map((contract) => `${contract.key} (contract ${contract.turnstile ?? false})`)).toEqual([]);
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
