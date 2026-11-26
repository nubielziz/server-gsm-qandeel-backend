// The retired-routes list (decision 061, test/contract/retired.ts): the rules that keep it honest and the way it leaves the counts.
// A retired key must be a row of the map (the map is read-only and still has it) and must not be built; the coverage document counts
// it apart from "built of". Pure functions and the real list against the committed manifest: no database, no Nest application
// (route-parity.test.ts proves the other half, that nothing is built for a retired key, against the real application).
import { describe, expect, it } from 'bun:test';
import { type ManifestEndpoint, loadDecisionTexts, loadManifest } from '../contract/lib/inputs';
import {
  difference,
  expectedKeys,
  retiredDecisionProblems,
  retiredProblems,
  unbuiltKeys,
} from '../contract/lib/manifest-parity';
import { PENDING } from '../contract/pending';
import { RETIRED, type RetiredRoute } from '../contract/retired';

/** What the coverage report reads of a manifest row. */
interface CoverageRow {
  key: string;
  module: string;
  surface: string;
  stage: number;
  frontend: { file: string; line: number; fn: string } | null;
}
interface CoverageModule {
  coverageText(input: {
    rows: CoverageRow[];
    pending: Set<string>;
    retired: Record<string, RetiredRoute>;
    scenarioRows: { id: string; file: string | null }[];
  }): string;
}
// Plain JavaScript, loaded at run time like the other tooling tests load scripts (importing it runs nothing: it is no entry point here).
const coveragePath = '../../scripts/build-coverage.mjs';
const { coverageText } = (await import(coveragePath)) as CoverageModule;

/** A manifest row with the fields the retired rules read. */
function row(key: string, extra: Partial<ManifestEndpoint> = {}): ManifestEndpoint {
  const [method = 'GET', path = '/'] = key.split(' ');
  return {
    key,
    kind: 'http',
    method,
    path,
    op: 'action',
    surface: 'admin',
    module: 'identity',
    access: 'staff-permission',
    permission: null,
    ...extra,
  };
}

const ENTRY: RetiredRoute = { decision: '061', reason: 'Retired for a test.' };
const NOTHING = new Set<string>();

describe('retiredProblems: a retired key must be a map row and must not be built', () => {
  const manifest = [
    row('GET /a'),
    row('GET /b'),
    row('POST /added', { addition: { file: 'scripts/map-additions/99.mjs', spec: 'B1' } }),
  ];

  it('accepts a row of the map that nothing builds', () => {
    expect(retiredProblems({ 'GET /a': ENTRY }, manifest, NOTHING, NOTHING)).toEqual([]);
  });

  it('refuses a key that is no row of the manifest (a typo would hide a route that is really missing)', () => {
    expect(retiredProblems({ 'GET /typo': ENTRY }, manifest, NOTHING, NOTHING)).toEqual([
      'GET /typo: retired, but the manifest has no row with this key',
    ]);
  });

  it('refuses a row of scripts/map-additions: that row is deleted, not listed', () => {
    expect(retiredProblems({ 'POST /added': ENTRY }, manifest, NOTHING, NOTHING)).toEqual([
      'POST /added: retired, but it is a row of scripts/map-additions/99.mjs: delete that row instead',
    ]);
  });

  it('refuses a key that is built', () => {
    expect(retiredProblems({ 'GET /a': ENTRY }, manifest, new Set(['GET /a']), NOTHING)).toEqual([
      'GET /a: retired, but a contract is built for it',
    ]);
  });

  it('refuses a key that is also pending (a retired route is never owed)', () => {
    expect(retiredProblems({ 'GET /a': ENTRY }, manifest, NOTHING, new Set(['GET /a']))).toEqual([
      'GET /a: retired and pending at once',
    ]);
  });

  it('refuses an entry without a decision number or a reason', () => {
    expect(
      retiredProblems(
        { 'GET /a': { decision: '61', reason: '  ' }, 'GET /b': { decision: 'B1', reason: 'x' } },
        manifest,
        NOTHING,
        NOTHING,
      ),
    ).toEqual([
      'GET /a: no reason',
      'GET /a: the decision must be the three digits of a file of docs/decisions, got "61"',
      'GET /b: the decision must be the three digits of a file of docs/decisions, got "B1"',
    ]);
  });
});

describe('retiredDecisionProblems: the cited decision must exist and must name the route', () => {
  const decisions = new Map([['061', 'Retired: `GET /a`, `GET /b/:id` and `POST /c`.']]);

  it('accepts a decision that names each route in backticks', () => {
    const retired = { 'GET /a': ENTRY, 'GET /b/:id': ENTRY, 'POST /c': ENTRY };
    expect(retiredDecisionProblems(retired, decisions)).toEqual([]);
  });

  it('refuses a decision number that has no file in docs/decisions', () => {
    expect(retiredDecisionProblems({ 'GET /a': { ...ENTRY, decision: '999' } }, decisions)).toEqual([
      'GET /a: decision 999 has no file in docs/decisions',
    ]);
  });

  it('refuses a route that its decision does not name (an owed route cannot hide under any existing decision)', () => {
    expect(retiredDecisionProblems({ 'POST /client/orders': ENTRY, 'GET /a': ENTRY }, decisions)).toEqual([
      'POST /client/orders: docs/decisions/061-*.md does not name this route (write it as `POST /client/orders`)',
    ]);
  });

  it('does not take the key of a shorter route for a longer one named in the decision', () => {
    expect(retiredDecisionProblems({ 'GET /b': ENTRY }, decisions)).toEqual([
      'GET /b: docs/decisions/061-*.md does not name this route (write it as `GET /b`)',
    ]);
  });
});

describe('the registry is compared with the manifest minus pending and retired', () => {
  const manifest = [row('GET /a'), row('GET /b'), row('GET /c'), row('DHRU x', { kind: 'dhru-action' })];

  it('a retired key leaves the expected keys, and a pending one does too', () => {
    const unbuilt = unbuiltKeys(['GET /a'], { 'GET /b': ENTRY });
    expect([...unbuilt].sort()).toEqual(['GET /a', 'GET /b']);
    expect(expectedKeys(manifest, 'http', unbuilt)).toEqual(['GET /c']);
    expect(difference('http', ['GET /c'], expectedKeys(manifest, 'http', unbuilt))).toEqual([]);
  });

  it('a route that is built although it is retired shows as built but not expected', () => {
    const unbuilt = unbuiltKeys([], { 'GET /b': ENTRY });
    expect(difference('http', ['GET /a', 'GET /b', 'GET /c'], expectedKeys(manifest, 'http', unbuilt))).toEqual([
      'http: GET /b is built but not expected',
    ]);
  });

  it('an empty list changes nothing', () => {
    expect(expectedKeys(manifest, 'http', unbuiltKeys([], {}))).toEqual(['GET /a', 'GET /b', 'GET /c']);
  });
});

describe('the coverage document leaves a retired row out of "built of"', () => {
  const rows: CoverageRow[] = [
    { key: 'GET /a', module: 'identity', surface: 'admin', stage: 1, frontend: { file: 'a.ts', line: 1, fn: 'a' } },
    { key: 'GET /b', module: 'identity', surface: 'admin', stage: 1, frontend: { file: 'b.ts', line: 1, fn: 'b' } },
    { key: 'GET /c', module: 'money', surface: 'client', stage: 2, frontend: null },
    { key: 'GET /d', module: 'money', surface: 'client', stage: 2, frontend: null },
  ];
  const input = { rows, pending: new Set<string>(), scenarioRows: [] };

  it('counts every row and prints no section while nothing is retired', () => {
    const text = coverageText({ ...input, retired: {} });
    expect(text).toContain('**4 of 4 endpoints built (100 %); the console calls 2, of which 2 are built (100 %).**');
    expect(text).not.toContain('Retired');
  });

  it('counts 3 of 3 with one row retired, lists it apart with its decision and reason, and keeps it out of every table', () => {
    const text = coverageText({ ...input, retired: { 'GET /b': ENTRY } });
    expect(text).toContain('**3 of 3 endpoints built (100 %); the console calls 1, of which 1 are built (100 %).**');
    expect(text).toContain('1 more row of the map is retired on purpose');
    expect(text).toContain('### Retired');
    expect(text).toContain('| `GET /b` | 061 | Retired for a test. |');
    expect(text).toContain('| identity | 1 | 1 | 0 | 100 % | 1 of 1 |');
    expect(text).toContain('| admin | 1 | 1 | 0 | 100 % | 1 of 1 |');
    expect(text).toContain('| money | 2 | 2 | 0 | 100 % | 0 of 0 |');
    expect(text.split('### Retired')[0]).not.toContain('GET /b');
  });

  it('a retired row is not "pending" either: pending counts only the rows that are owed', () => {
    const text = coverageText({ ...input, pending: new Set(['GET /c']), retired: { 'GET /b': ENTRY } });
    expect(text).toContain('**2 of 3 endpoints built (67 %); the console calls 1, of which 1 are built (100 %).**');
    expect(text).toContain('| money | 2 | 1 | 1 | 50 % | 0 of 0 |');
  });
});

describe('the real list', () => {
  const manifest = loadManifest();

  it('holds the five routes of merchant verification by documents', () => {
    expect(Object.keys(RETIRED)).toEqual(
      expect.arrayContaining([
        'GET /client/kyc',
        'POST /client/kyc',
        'GET /admin/kyc-submissions',
        'GET /admin/kyc-submissions/:id',
        'POST /admin/kyc-submissions/:id/decide',
      ]),
    );
  });

  it('holds the routes of the features retired together by decision 062, each citing that decision', () => {
    const of062 = Object.entries(RETIRED)
      .filter(([, entry]) => entry.decision === '062')
      .map(([key]) => key);
    expect(of062).toHaveLength(50);
    expect(of062).toEqual(
      expect.arrayContaining([
        'POST /client/auth/register',
        'POST /admin/commission-accruals/approve',
        'POST /v1/orders',
        'EVENT order.status_changed',
        'GET /admin/checkouts/abandoned',
        'POST /store/v1/imei/check',
        'POST /webhooks/telegram/:secret',
        'POST /store/v1/tickets/:token/csat',
        'DELETE /client/sessions/:id',
      ]),
    );
  });

  it('holds the write route of the option lists of a service, retired by decision 072', () => {
    expect(RETIRED['PUT /admin/services/:id/options']).toMatchObject({ decision: '072' });
    expect(RETIRED['PUT /admin/services/:id/options']?.reason).toContain('Options section');
  });

  it('names only rows of the committed manifest that are rows of the map, not owed, each with a decision and a reason', () => {
    expect(retiredProblems(RETIRED, manifest, NOTHING, new Set(PENDING))).toEqual([]);
  });

  it('cites a decision file that exists and names the route in backticks', () => {
    expect(retiredDecisionProblems(RETIRED, loadDecisionTexts())).toEqual([]);
  });
});
