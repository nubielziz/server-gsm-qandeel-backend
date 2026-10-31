// The harvested fixtures (docs/contract/TESTS.md "Fixture harvest"): the harvest covered every console GET route, each
// file belongs to one route, and what the console's mock layer answered obeys the console's own types. This is what
// the shape-parity test later holds the real backend answers against.
import { describe, expect, it } from 'bun:test';
import knownGaps from './harvest/known-gaps.json';
import {
  fixtureFileName,
  loadFixtures,
  loadFrontendEndpoints,
  loadSuccessStatuses,
  type FrontendEndpoint,
} from './lib/inputs';
import { shapeToSchema } from './lib/shape-to-schema';
import { createValidator } from './lib/validate';

const endpoints = loadFrontendEndpoints();
const fixtures = loadFixtures();
const byFile = new Map(endpoints.map((endpoint) => [fixtureFileName(endpoint.key), endpoint]));
const statuses = loadSuccessStatuses();
const gaps: Record<string, string> = knownGaps;

/** Routes whose mock answer is not of the type the `@route` function resolves to, and why (kept short, see the notes). */
const NOT_THE_RETURN_TYPE: Readonly<Record<string, string>> = {
  'GET /admin/permissions':
    'the console accepts string[] or Permission[] and normalises (features/access/lib/permissions.ts); the wire form is string[] (ALIGNMENT § 4)',
};

const isList = (endpoint: FrontendEndpoint): boolean => endpoint.returnsText.startsWith('ListResult<');

describe('the fixture folder', () => {
  it('gives every console route its own file name', () => {
    expect(byFile.size).toBe(endpoints.length);
  });

  it('has no file that belongs to no console route', () => {
    expect(fixtures.filter((fixture) => !byFile.has(fixture.file)).map((fixture) => fixture.file)).toEqual([]);
  });

  it('has a fixture for every console GET route, except the ones the mock layer cannot answer', () => {
    const have = new Set(fixtures.map((fixture) => fixture.file));
    const missing = endpoints
      .filter(
        (endpoint) =>
          endpoint.key.startsWith('GET ') && !have.has(fixtureFileName(endpoint.key)) && !(endpoint.key in gaps),
      )
      .map((endpoint) => endpoint.key);
    expect(missing).toEqual([]);
  });

  it('lists a known gap only while the route has no fixture (the list cannot rot)', () => {
    const have = new Set(fixtures.map((fixture) => fixture.file));
    const stale = Object.keys(gaps).filter(
      (key) => have.has(fixtureFileName(key)) || !endpoints.some((e) => e.key === key),
    );
    expect(stale).toEqual([]);
  });
});

describe('each fixture', () => {
  it('is a 2xx answer with the documented status (a documented redirect is served as 200 by the mock)', () => {
    const wrong: string[] = [];
    for (const fixture of fixtures) {
      const endpoint = byFile.get(fixture.file);
      if (!endpoint) continue;
      const documented = statuses.get(endpoint.key);
      const expected = documented === 302 ? 200 : documented;
      if (fixture.status !== expected)
        wrong.push(`${endpoint.key}: fixture ${fixture.status}, documented ${documented}`);
    }
    expect(wrong).toEqual([]);
  });

  it('carries x-total-count when the console reads a ListResult', () => {
    const wrong: string[] = [];
    for (const fixture of fixtures) {
      const endpoint = byFile.get(fixture.file);
      if (!endpoint || !isList(endpoint)) continue;
      const total = Number(fixture.headers['x-total-count']);
      if (!Array.isArray(fixture.body)) wrong.push(`${endpoint.key}: the body is not an array`);
      else if (!Number.isInteger(total) || total < fixture.body.length)
        wrong.push(`${endpoint.key}: x-total-count ${fixture.headers['x-total-count']}`);
    }
    expect(wrong).toEqual([]);
  });

  it('has no body for a route the console reads as void', () => {
    const wrong = fixtures.filter((fixture) => {
      const endpoint = byFile.get(fixture.file);
      return endpoint?.returnsText === 'void' && fixture.body !== null;
    });
    expect(wrong.map((fixture) => fixture.file)).toEqual([]);
  });

  it('obeys the response type the console declares for its route', () => {
    const ajv = createValidator();
    const wrong: string[] = [];
    for (const fixture of fixtures) {
      const endpoint = byFile.get(fixture.file);
      const returns = endpoint?.returns;
      // Text and file answers have no JSON shape to check.
      if (
        !endpoint ||
        !returns ||
        returns.type === 'undefined' ||
        returns.type === 'string' ||
        endpoint.key in NOT_THE_RETURN_TYPE
      )
        continue;
      const rows = isList(endpoint) ? returns.object?.data?.array : undefined;
      const schema = rows ? { type: 'array', items: shapeToSchema(rows) } : shapeToSchema(returns);
      const validate = ajv.compile(schema);
      if (!validate(fixture.body)) {
        const first = (validate.errors ?? [])[0];
        wrong.push(`${endpoint.key}: ${first?.instancePath || '(root)'} ${first?.message ?? 'is not valid'}`);
      }
    }
    expect(wrong).toEqual([]);
  });

  it('lists the routes whose answer is not of the declared type (a note, not a failure)', () => {
    for (const [key, why] of Object.entries(NOT_THE_RETURN_TYPE)) {
      expect(
        endpoints.some((endpoint) => endpoint.key === key),
        key,
      ).toBe(true);
      expect(why.length).toBeGreaterThan(10);
    }
  });
});
