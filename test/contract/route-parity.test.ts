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
 * What is built, per kind of manifest key. Dhru actions and supplier calls have no registry yet: the feature that adds
 * one (7a Dhru, 6 suppliers) lists its keys here, otherwise removing them from pending.ts fails the first test below.
 */
const built: Record<string, string[]> = {
  http: snapshot.contracts.map((contract) => contract.key),
  'dhru-action': [],
  'supplier-call': [],
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

  it('outgoing event schemas equal the manifest EVENT keys minus pending', () => {
    const expected = keysOfKind('event').filter((key) => !pending.has(key));
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

describe('the router against the registry', () => {
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
