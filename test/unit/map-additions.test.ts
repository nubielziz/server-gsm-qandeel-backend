// Tests of the map additions (decision 035): the guards of the loader, the surface prefixes, every route tool picking up the
// sample rows of test/unit/fixtures/map-additions (run as child processes against a temporary docs folder and a fake console), and
// the contract comparisons over that generated manifest. No database, no Nest application.
import { expectRejection } from '../support/rejection';
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { surfaceOfPath } from '../../src/common/surface';
import { loadManifest, loadSuccessStatuses } from '../contract/lib/inputs';
import {
  type ContractRow,
  accessMismatches,
  difference,
  expectedKeys,
  turnstileMismatches,
} from '../contract/lib/manifest-parity';

const ROOT = join(import.meta.dir, '../..');
const FIXTURES = 'test/unit/fixtures/map-additions';

interface AdditionFile {
  file: string;
  rows: unknown;
  rowFlags?: unknown;
}
interface AdditionRow {
  s: string;
  g: string | null;
  m: string;
  p: string;
  ops?: string;
  f: string;
  a: string;
  st: number;
  t: string[];
  addition: { file: string; en: string; module: string; spec: string; successStatus?: number | Record<string, number> };
}
interface RowFlag {
  row: string;
  turnstile: true;
  file: string;
  spec: string;
}
interface MapModule {
  EXPECTED: Record<string, number>;
  additions: unknown[];
  rowFlags: RowFlag[];
  mapRoutes: object[];
  expandRow(row: object): { key: string }[];
  checkAdditions(files: AdditionFile[]): AdditionRow[];
  checkRowFlags(files: Array<{ file: string; rowFlags?: unknown }>): RowFlag[];
}
interface AdditionsLib {
  ADDITION_SURFACES: Record<string, string | null>;
  SUCCESS_STATUSES: number[];
  readAdditionFiles(dirs: string[], root: string): Promise<AdditionFile[]>;
  validateRowFlags(
    files: Array<{ file: string; rowFlags?: unknown }>,
    ctx: {
      mapRoutes: object[];
      rowKey(row: object): string;
      normaliseAccess(row: object): { access: string; turnstile: boolean };
    },
  ): RowFlag[];
}
// Plain JavaScript, loaded at run time as test/schema/structure.test.ts loads module-map.mjs.
const mapPath = '../../scripts/lib/map.mjs';
const libPath = '../../scripts/lib/map-additions.mjs';
const samplePath = '../unit/fixtures/map-additions/sample.mjs';
const map = (await import(mapPath)) as MapModule;
const lib = (await import(libPath)) as AdditionsLib;
const sample = (await import(samplePath)) as { rows: unknown[]; rowFlags: unknown[] };

const scratch: string[] = [];
async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'gsm-additions-'));
  scratch.push(dir);
  return dir;
}
afterAll(async () => {
  await Promise.all(scratch.map((dir) => rm(dir, { recursive: true, force: true })));
});

/** A valid row; each case changes one thing. */
const good = (extra: Record<string, unknown> = {}): Record<string, unknown> => ({
  s: 'admin',
  g: 'ops',
  m: 'POST',
  p: '/admin/w0-x/ping',
  f: 'اختبار الأدوات',
  a: 'settings:update',
  st: 99,
  t: ['settings'],
  en: 'Tooling test row.',
  module: 'platform',
  spec: 'B-TBD w0-x',
  ...extra,
});

/** The error message of checking these rows in one file, or '' when they are accepted. */
function message(...rows: unknown[]): string {
  try {
    map.checkAdditions([{ file: 'scripts/map-additions/x.mjs', rows }]);
    return '';
  } catch (error) {
    return (error as Error).message;
  }
}

describe('the guards of the loader', () => {
  it('accepts the sample rows and returns them with their addition block', () => {
    const rows = map.checkAdditions([{ file: `${FIXTURES}/sample.mjs`, rows: sample.rows }]);
    expect(rows).toHaveLength(4);
    expect(rows.map((row) => row.addition.module)).toEqual(['platform', 'catalog', 'platform', 'money']);
    expect(rows[0]?.addition).toEqual({
      file: `${FIXTURES}/sample.mjs`,
      en: 'Tooling sample: ping.',
      module: 'platform',
      spec: 'B-TBD w0-sample-ping',
      successStatus: 204,
    });
    expect(rows[2]?.ops).toBe('LC');
  });

  it('accepts a row of every other surface, and a row equal to an R() call written as a plain object', () => {
    expect(message(good({ s: 'v1', g: null, p: '/v1/w0-x', a: 'orders:read' }))).toBe('');
    expect(message(good({ s: 'hooks', g: null, p: '/webhooks/w0/:gateway', a: 'توقيع البوابة' }))).toBe('');
    expect(message(good({ s: 'system', g: null, m: 'GET', p: '/w0-status', a: 'عام' }))).toBe('');
    expect(
      message(good({ s: 'client', g: 'orders', m: 'GET', p: '/client/w0-x', a: 'جلسة', successStatus: 200 })),
    ).toBe('');
  });

  const refused: Array<[string, Record<string, unknown>, string]> = [
    [
      'a map row',
      good({ g: 'clients', p: '/admin/clients/:id/wallet/adjust', a: 'wallet:adjust', t: ['ledger_accounts'] }),
      'repeats the map row admin POST /admin/clients/:id/wallet/adjust',
    ],
    [
      'an endpoint of a map CRUD row',
      good({ g: 'auth', m: 'PATCH', p: '/admin/staff/:id', a: 'staff:update' }),
      'its endpoint PATCH /admin/staff/:id already exists in the map',
    ],
    [
      'a map route under another parameter name',
      good({ g: 'clients', m: 'GET', p: '/admin/clients/:clientId/api-keys', a: 'clients:read' }),
      'its endpoint GET /admin/clients/:clientId/api-keys already exists in the map (row admin GET /admin/clients/:id/api-keys)',
    ],
    ['the surface dhru', good({ s: 'dhru' }), 'surface "dhru" must be one of'],
    ['the surface events', good({ s: 'events' }), 'surface "events" must be one of'],
    ['an unknown group', good({ g: 'nope' }), 'group "nope" must be one of'],
    ['a group on v1', good({ s: 'v1', g: 'ops', p: '/v1/w0-x', a: 'orders:read' }), 'group must be null on surface v1'],
    ['/client/x on admin', good({ p: '/client/x' }), 'path must start with /admin on surface admin'],
    ['/admin/x on system', good({ s: 'system', g: null, p: '/admin/x', a: 'عام' }), 'belongs to another surface'],
    [
      '/api/index.php on system',
      good({ s: 'system', g: null, p: '/api/index.php', a: 'عام' }),
      'belongs to another surface',
    ],
    ['the method ACTION', good({ m: 'ACTION' }), 'method "ACTION"'],
    ['CRUD without ops', good({ m: 'CRUD', p: '/admin/w0-crud' }), 'CRUD needs ops'],
    ['an unknown CRUD letter', good({ m: 'CRUD', ops: 'LX', p: '/admin/w0-crud' }), 'unknown letter "X"'],
    ['a repeated CRUD letter', good({ m: 'CRUD', ops: 'LL', p: '/admin/w0-crud' }), 'repeats a letter'],
    ['ops on a GET', good({ m: 'GET', ops: 'L' }), 'ops only belongs to a CRUD row'],
    [
      'a CRUD path with :id',
      good({ m: 'CRUD', ops: 'L', p: '/admin/w0-crud/:id' }),
      'a CRUD path ends in a fixed segment and has no :id',
    ],
    ['a bad path segment', good({ p: '/admin/a b' }), 'path segment "a b" is not a name or :param'],
    ['an empty path segment', good({ p: '/admin//x' }), 'path segment "" is not a name or :param'],
    ['a repeated parameter', good({ p: '/admin/:id/x/:id' }), 'path repeats the parameter :id'],
    ['the auth text "session"', good({ a: 'session' }), 'unknown auth value "session"'],
    ['a missing f', good({ f: undefined }), 'f (the Arabic sentence)'],
    ['a missing en', good({ en: undefined }), 'en (the English sentence)'],
    ['a two-line en', good({ en: 'one\ntwo' }), 'en (the English sentence)'],
    ['a missing module', good({ module: undefined }), 'module "undefined" is not a module'],
    ['an unknown module', good({ module: 'nope' }), 'module "nope" is not a module'],
    ['a missing spec', good({ spec: undefined }), 'spec "undefined" must be'],
    ['the spec TBD', good({ spec: 'TBD' }), 'spec "TBD" must be'],
    ['the spec B-TBD without a slug', good({ spec: 'B-TBD' }), 'spec "B-TBD" must be'],
    ['an unknown table', good({ t: ['nope'] }), 'table "nope" is neither a map table nor an additionalTables entry'],
    ['a repeated table', good({ t: ['settings', 'settings'] }), 't (tables) lists a table twice'],
    ['stage -1', good({ st: -1 }), 'st (stage)'],
    ['stage 1.5', good({ st: 1.5 }), 'st (stage)'],
    ['status 203', good({ successStatus: 203 }), 'successStatus 203 must be one of'],
    ['status 302 on a POST', good({ successStatus: 302 }), 'successStatus 302 must be one of'],
    [
      'a status object on a GET',
      good({ m: 'GET', successStatus: { L: 200 } }),
      'successStatus {"L":200} must be one of',
    ],
    [
      'a status letter outside ops',
      good({ m: 'CRUD', ops: 'L', p: '/admin/w0-crud', successStatus: { C: 201 } }),
      'successStatus key "C" is not in ops "L"',
    ],
    [
      'a number as the status of a CRUD row',
      good({ m: 'CRUD', ops: 'L', p: '/admin/w0-crud', successStatus: 200 }),
      'successStatus of a CRUD row is an object keyed by ops letters',
    ],
    [
      'a 302 on a CRUD create',
      good({ m: 'CRUD', ops: 'C', p: '/admin/w0-crud', successStatus: { C: 302 } }),
      'successStatus C: 302 must be one of',
    ],
    ['an unknown key', good({ sucessStatus: 204 }), 'has an unknown key "sucessStatus"'],
  ];
  for (const [name, row, expected] of refused)
    it(`refuses ${name}, naming file, row number and row key`, () => {
      const text = message(row);
      expect(text).toContain('map additions problems:');
      expect(text).toContain('scripts/map-additions/x.mjs row 1 (');
      expect(text).toContain(expected);
    });

  it('accepts 302 on a GET and on a CRUD list', () => {
    expect(message(good({ m: 'GET', successStatus: 302 }))).toBe('');
    expect(
      message(good({ m: 'CRUD', ops: 'LC', p: '/admin/w0-crud', a: 'settings:*', successStatus: { L: 302, C: 201 } })),
    ).toBe('');
  });

  it('refuses an endpoint added twice, in one file and across files, naming the first', () => {
    const one = message(good(), good());
    expect(one).toContain('scripts/map-additions/x.mjs row 2 (admin POST /admin/w0-x/ping)');
    expect(one).toContain('is also added by scripts/map-additions/x.mjs row 1');
    const row = good({ p: '/admin/w0-x/:name/ping' });
    expect(() =>
      map.checkAdditions([
        { file: 'scripts/map-additions/a.mjs', rows: [good({ p: '/admin/w0-x/:id/ping' })] },
        { file: 'scripts/map-additions/b.mjs', rows: [row] },
      ]),
    ).toThrow('is also added by scripts/map-additions/a.mjs row 1');
  });

  it('collects every problem into one error', () => {
    const text = message(good({ spec: 'TBD' }), good({ s: 'dhru' }), good({ p: '/admin/w0-y' }));
    expect(text).toContain('x.mjs row 1 (admin POST /admin/w0-x/ping): spec "TBD"');
    expect(text).toContain('x.mjs row 2 (dhru POST /admin/w0-x/ping): surface "dhru"');
    expect(text).not.toContain('row 3');
  });

  it('refuses rows that are not an array, and a row that is not an object', () => {
    expect(() => map.checkAdditions([{ file: 'scripts/map-additions/x.mjs', rows: 'rows' }])).toThrow(
      '"rows" must be an array',
    );
    expect(message('text')).toContain('row 1 (?): is not an object');
  });
});

describe('the row flags (feature 24A)', () => {
  /** A valid flag; each case changes one thing. */
  const flag = (extra: Record<string, unknown> = {}): Record<string, unknown> => ({
    row: 'client POST /client/auth/verify-email',
    turnstile: true,
    spec: 'B-TBD w0-flag',
    ...extra,
  });
  /** The error message of checking these flags in one file, or '' when they are accepted. */
  const flagMessage = (...rowFlags: unknown[]): string => {
    try {
      map.checkRowFlags([{ file: 'scripts/map-additions/x.mjs', rowFlags }]);
      return '';
    } catch (error) {
      return (error as Error).message;
    }
  };

  it('accepts the sample flag and returns it with its file', () => {
    expect(map.checkRowFlags([{ file: `${FIXTURES}/sample.mjs`, rowFlags: sample.rowFlags }])).toEqual([
      {
        row: 'client POST /client/auth/password/reset',
        turnstile: true,
        file: `${FIXTURES}/sample.mjs`,
        spec: 'B-TBD w0-sample-flag',
      },
    ]);
    expect(flagMessage(flag())).toBe('');
    expect(map.checkRowFlags([{ file: 'scripts/map-additions/x.mjs' }])).toEqual([]);
  });

  it('flags exactly the three merchant auth rows from the real folder', () => {
    expect(map.rowFlags.map((entry) => entry.row).sort()).toEqual([
      'client POST /client/auth/login',
      'client POST /client/auth/password/forgot',
      'client POST /client/auth/register',
    ]);
  });

  const refused: Array<[string, Record<string, unknown>, string]> = [
    ['an unknown row', flag({ row: 'client POST /client/nope' }), 'is not the key of a map row'],
    ['a row given as an endpoint key', flag({ row: 'POST /client/auth/verify-email' }), 'is not the key of a map row'],
    ['an admin row', flag({ row: 'admin POST /admin/auth/login' }), 'only client and store rows can be flagged'],
    ['a session row', flag({ row: 'client POST /client/auth/logout' }), 'only a public row can get Turnstile'],
    ['a row that already has Turnstile', flag({ row: 'store POST /store/v1/auth/login' }), 'already has Turnstile'],
    ['turnstile false', flag({ turnstile: false }), 'turnstile must be true'],
    ['a missing turnstile', flag({ turnstile: undefined }), 'turnstile must be true'],
    ['a missing spec', flag({ spec: undefined }), 'spec "undefined" must be'],
    ['the spec TBD', flag({ spec: 'TBD' }), 'spec "TBD" must be'],
    ['an unknown key', flag({ idempotencyKey: true }), 'has an unknown key "idempotencyKey"'],
  ];
  for (const [name, entry, expected] of refused)
    it(`refuses ${name}, naming file, flag number and row key`, () => {
      const text = flagMessage(entry);
      expect(text).toContain('map additions problems:');
      expect(text).toContain('scripts/map-additions/x.mjs flag 1 (');
      expect(text).toContain(expected);
    });

  it('refuses a CRUD row (the map has none on client or store today, so an in-memory map stands in)', () => {
    const crud = { s: 'client', g: 'auth', m: 'CRUD', ops: 'LC', p: '/client/w0-things', a: 'عام' };
    const ctx = {
      mapRoutes: [crud],
      rowKey: (row: object) => {
        const r = row as { s: string; m: string; p: string };
        return `${r.s} ${r.m} ${r.p}`;
      },
      normaliseAccess: () => ({ access: 'public', turnstile: false }),
    };
    expect(() =>
      lib.validateRowFlags([{ file: 'x.mjs', rowFlags: [flag({ row: 'client CRUD /client/w0-things' })] }], ctx),
    ).toThrow(
      'x.mjs flag 1 (client CRUD /client/w0-things): row is a CRUD row; only a single-endpoint row can be flagged',
    );
  });

  it('refuses a row flagged twice, in one file and across files, naming the first', () => {
    expect(flagMessage(flag(), flag())).toContain(
      'x.mjs flag 2 (client POST /client/auth/verify-email): row is also flagged by scripts/map-additions/x.mjs flag 1',
    );
    expect(() =>
      map.checkRowFlags([
        { file: 'scripts/map-additions/a.mjs', rowFlags: [flag()] },
        { file: 'scripts/map-additions/b.mjs', rowFlags: [flag()] },
      ]),
    ).toThrow('is also flagged by scripts/map-additions/a.mjs flag 1');
  });

  it('refuses rowFlags that are not an array, and a flag that is not an object', () => {
    expect(() => map.checkRowFlags([{ file: 'scripts/map-additions/x.mjs', rowFlags: 'flags' }])).toThrow(
      '"rowFlags" must be an array',
    );
    expect(flagMessage('text')).toContain('flag 1 (?): is not an object');
  });
});

describe('the file reader', () => {
  it('reads the *.mjs files of a folder in name order and skips README.md', async () => {
    const dir = await tempDir();
    await writeFile(join(dir, 'README.md'), '# notes\n');
    await writeFile(join(dir, 'b.mjs'), 'export const rows = [{ marker: "b" }];\n');
    await writeFile(join(dir, 'a-1.mjs'), 'export const rows = [{ marker: "a" }];\n');
    const files = await lib.readAdditionFiles([dir], dir);
    expect(files).toEqual([
      { file: 'a-1.mjs', rows: [{ marker: 'a' }], rowFlags: [] },
      { file: 'b.mjs', rows: [{ marker: 'b' }], rowFlags: [] },
    ]);
  });

  it('refuses a stray file, a badly named module, a missing folder and a module without an array "rows"', async () => {
    const stray = await tempDir();
    await writeFile(join(stray, 'notes.txt'), 'x');
    await expectRejection(lib.readAdditionFiles([stray], stray), 'unexpected file notes.txt');
    const named = await tempDir();
    await writeFile(join(named, 'Feature_20.mjs'), 'export const rows = [];\n');
    await expectRejection(lib.readAdditionFiles([named], named), 'unexpected file Feature_20.mjs');
    await expectRejection(lib.readAdditionFiles([join(stray, 'missing')], stray), 'does not exist');
    const bad = await tempDir();
    await writeFile(join(bad, 'x.mjs'), 'export const rows = "no";\n');
    await expectRejection(lib.readAdditionFiles([bad], bad), 'x.mjs must export an array "rows"');
  });

  it('reads the real folder: only feature files named <id>.mjs beside the README', async () => {
    expect(Array.isArray(map.additions)).toBe(true);
    const real = await lib.readAdditionFiles([join(ROOT, 'scripts', 'map-additions')], ROOT);
    expect(
      real.map((entry) => entry.file).every((file) => /^scripts\/map-additions\/[a-z0-9][a-z0-9-]*\.mjs$/.test(file)),
    ).toBe(true);
  });
});

describe('the surface prefixes', () => {
  it('agree with surfaceOfPath (src/common/surface.ts)', () => {
    for (const [surface, prefix] of Object.entries(lib.ADDITION_SURFACES)) {
      if (prefix === null) expect(surfaceOfPath('/w0-status'), surface).toBe(surface as 'system');
      else {
        expect(surfaceOfPath(prefix), surface).toBe(surface as 'admin');
        expect(surfaceOfPath(`${prefix}/w0-x`), surface).toBe(surface as 'admin');
      }
    }
    expect(Object.keys(lib.ADDITION_SURFACES).sort()).toEqual(['admin', 'client', 'hooks', 'store', 'system', 'v1']);
  });

  it('list the success statuses a route may promise', () => {
    expect(lib.SUCCESS_STATUSES).toEqual([200, 201, 202, 204, 302]);
  });
});

/** The five endpoints of the sample rows. */
const PING = 'POST /admin/w0-sample/:id/ping';
const CHECK = 'POST /store/v1/w0-sample/check';
const LIST = 'GET /admin/w0-samples';
const CREATE = 'POST /admin/w0-samples';
const WALLET = 'GET /admin/customers/:id/w0-sample';
const SAMPLE_KEYS = [PING, CHECK, LIST, CREATE, WALLET];
/** The map endpoint the sample flag gives Turnstile. */
const FLAGGED = 'POST /client/auth/password/reset';

interface Run {
  code: number;
  stdout: string;
  stderr: string;
}
/** Runs a script from the repo root with only the given environment. */
async function run(script: string, args: string[], env: Record<string, string>): Promise<Run> {
  const child = Bun.spawn([process.execPath, '--no-env-file', join('scripts', script), ...args], {
    cwd: ROOT,
    env: { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? tmpdir(), ...env },
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  return { code, stdout, stderr };
}

const PING_ROW = {
  s: 'admin',
  g: 'ops',
  m: 'POST',
  p: '/admin/w0-sample/:id/ping',
  f: 'اختبار الأدوات: نبضة',
  a: 'settings:update',
  st: 99,
  t: ['settings', 'audit_logs'],
  en: 'Tooling sample: ping.',
  module: 'platform',
  spec: 'B-TBD w0-sample-ping',
};

describe('the route tools pick the sample rows up', () => {
  let docs = '';
  let console_ = '';
  let env: Record<string, string> = {};
  const runs: Record<string, Run> = {};
  let realRows = 0;
  let realEndpoints = 0;

  beforeAll(async () => {
    docs = await tempDir();
    console_ = await tempDir();
    const dir = join(console_, 'src', 'features', 'w0-sample', 'api');
    await mkdir(dir, { recursive: true });
    await writeFile(
      join(dir, 'sample.ts'),
      '/**\n * Sends a ping.\n *\n * @route POST /admin/w0-sample/:id/ping\n */\nexport async function pingSample(): Promise<void> {}\n',
    );
    env = { GSM_MAP_ADDITIONS_EXTRA_DIR: FIXTURES, GSM_DOCS_DIR: docs, FRONTEND_DIR: console_ };
    realRows = map.additions.length;
    realEndpoints = (map.additions as object[]).reduce<number>((n, row) => n + map.expandRow(row).length, 0);
    for (const script of [
      'build-route-manifest.mjs',
      'build-route-slices.mjs',
      'build-coverage.mjs',
      'build-contract-docs.mjs',
    ])
      runs[script] = await run(script, [], env);
    runs['manifest --check'] = await run('build-route-manifest.mjs', ['--check'], env);
  }, 120_000);

  it('every generator exits 0', () => {
    for (const [name, result] of Object.entries(runs)) expect(result.code, `${name}: ${result.stderr}`).toBe(0);
  });

  it('the manifest counts the map and the additions apart and adds them up', async () => {
    const manifest = JSON.parse(await readFile(join(docs, 'route-manifest.json'), 'utf8')) as {
      counts: {
        rows: number;
        endpoints: number;
        map: { rows: number; endpoints: number };
        additions: { rows: number; endpoints: number };
      };
      endpoints: Array<Record<string, unknown>>;
    };
    expect(manifest.counts.map).toEqual({
      rows: map.EXPECTED.rows as number,
      endpoints: map.EXPECTED.endpoints as number,
    });
    expect(manifest.counts.additions).toEqual({ rows: realRows + 4, endpoints: realEndpoints + 5 });
    expect(manifest.counts.rows).toBe(manifest.counts.map.rows + manifest.counts.additions.rows);
    expect(manifest.counts.endpoints).toBe(manifest.counts.map.endpoints + manifest.counts.additions.endpoints);

    const by = new Map(manifest.endpoints.map((endpoint) => [endpoint.key as string, endpoint]));
    for (const key of SAMPLE_KEYS) expect(by.get(key)?.kind, key).toBe('http');
    expect(SAMPLE_KEYS.map((key) => by.get(key)?.module)).toEqual([
      'platform',
      'catalog',
      'platform',
      'platform',
      'money',
    ]);
    expect(by.get(PING)).toMatchObject({
      description: 'Tooling sample: ping.',
      descriptionAr: 'اختبار الأدوات: نبضة',
      access: 'staff-permission',
      permission: 'settings:update',
      stage: 99,
      successStatus: 204,
      addition: { file: `${FIXTURES}/sample.mjs`, spec: 'B-TBD w0-sample-ping' },
      frontend: { file: 'src/features/w0-sample/api/sample.ts', fn: 'pingSample' },
    });
    expect(by.get(CHECK)).toMatchObject({ access: 'public', turnstile: true, permission: null });
    expect(by.get(CHECK)?.successStatus).toBeUndefined();
    expect(by.get(LIST)).toMatchObject({ permission: 'settings:*', successStatus: 200, op: 'list' });
    expect(by.get(CREATE)).toMatchObject({ permission: 'settings:*', successStatus: 201, op: 'create' });
    expect(by.get(WALLET)).toMatchObject({ permission: 'wallet:read', module: 'money' });
    expect(by.get(WALLET)?.successStatus).toBeUndefined();
    // A map endpoint gets no new field.
    expect(by.get('GET /health')?.addition).toBeUndefined();
    expect(by.get('GET /health')?.successStatus).toBeUndefined();

    // The sample flag adds Turnstile and its origin to its own endpoint only.
    expect(by.get(FLAGGED)).toMatchObject({
      access: 'public',
      turnstile: true,
      rowFlag: { file: `${FIXTURES}/sample.mjs`, spec: 'B-TBD w0-sample-flag' },
    });
    expect(by.get(FLAGGED)?.addition).toBeUndefined();
    expect(by.get('POST /client/auth/verify-email')).toMatchObject({ turnstile: false });
    expect(by.get('POST /client/auth/verify-email')?.rowFlag).toBeUndefined();

    const text = await readFile(join(docs, 'route-manifest.md'), 'utf8');
    expect(text).toContain(
      `${realRows + 4} rows (${realEndpoints + 5} endpoints) are backend additions beyond the map`,
    );
    expect(text).toContain('(Turnstile added, B-TBD w0-sample-flag)');
    expect(text).toContain('Tooling sample: ping. (addition, B-TBD w0-sample-ping)');
  });

  it('leaves every other endpoint as the committed manifest has it (the flag only adds)', async () => {
    type Endpoint = Record<string, unknown> & { key: string };
    const read = async (path: string) =>
      (JSON.parse(await readFile(path, 'utf8')) as { endpoints: Endpoint[] }).endpoints.map(
        ({ frontend: _frontend, ...rest }) => rest as Endpoint,
      );
    const flagged = new Map(
      (await read(join(docs, 'route-manifest.json'))).map((endpoint) => [endpoint.key, endpoint]),
    );
    const committed = await read(join(ROOT, 'docs', 'route-manifest.json'));
    for (const endpoint of committed) {
      if (endpoint.key === FLAGGED) {
        expect(flagged.get(FLAGGED)).toEqual({ ...endpoint, turnstile: true, rowFlag: expect.any(Object) });
        continue;
      }
      expect(flagged.get(endpoint.key), endpoint.key).toEqual(endpoint);
    }
  });

  it('a slice lists the additions of its module and knows the owner of an additionalTables table', async () => {
    const slice = async (name: string) =>
      JSON.parse(await readFile(join(docs, 'slices', `${name}.json`), 'utf8')) as {
        endpoints: Array<{ key: string }>;
        stages: number[];
        foreignTables: Array<{ table: string; owner: string }>;
      };
    const platform = await slice('platform');
    for (const key of [PING, LIST, CREATE]) expect(platform.endpoints.map((endpoint) => endpoint.key)).toContain(key);
    expect(platform.stages).toContain(99);
    expect((await slice('catalog')).foreignTables.map((entry) => entry.table)).not.toContain('listed_prices');
    expect((await slice('money')).foreignTables).toContainEqual({ table: 'idempotency_keys', owner: 'orders' });
  });

  it('coverage counts the additions under their stage', async () => {
    const text = await readFile(join(docs, 'COVERAGE.md'), 'utf8');
    expect(text).toMatch(/\| stage 99 \| 5 \| 5 \| 0 \| 100 % \| 1 of 1 \|/);
    const total = map.EXPECTED.endpoints! + realEndpoints + 5;
    expect(text).toContain(`**${total} of ${total} endpoints built`);
  });

  it('the endpoint document labels an addition and gives its success status', async () => {
    const text = await readFile(join(docs, 'contract', 'endpoints', 'platform.md'), 'utf8');
    const section = text.slice(text.indexOf(`## ${PING}`));
    const line = section.split('\n').find((candidate) => candidate.startsWith('- **Map addition**')) ?? '';
    expect(line).toContain('B-TBD w0-sample-ping');
    expect(line).toContain(`${FIXTURES}/sample.mjs`);
    expect(line).toContain('Tooling sample: ping.');
    expect(line).toContain('staff-permission `settings:update`');
    expect(line).toContain('success 204');
    expect(text).toContain('- **Map**: ');
  });

  it('the console-tag check refuses a console route that is in neither the map nor the additions', async () => {
    const fresh = await tempDir();
    const result = await run('build-route-manifest.mjs', [], { GSM_DOCS_DIR: fresh, FRONTEND_DIR: console_ });
    expect(result.code).toBe(1);
    expect(result.stderr).toContain('frontend @route POST /admin/w0-sample/:id/ping is not in the map');
  });

  it('demands a successStatus as soon as the console calls an addition', async () => {
    const extra = await tempDir();
    await writeFile(join(extra, 'ping.mjs'), `export const rows = ${JSON.stringify([PING_ROW])};\n`);
    const fresh = await tempDir();
    const result = await run('build-route-manifest.mjs', [], {
      GSM_MAP_ADDITIONS_EXTRA_DIR: extra,
      GSM_DOCS_DIR: fresh,
      FRONTEND_DIR: console_,
    });
    expect(result.code).toBe(1);
    expect(result.stderr).toContain('needs successStatus');
    expect(result.stderr).toContain('src/features/w0-sample/api/sample.ts');
  });

  it('stops every tool on a row that repeats a map row, naming the file', async () => {
    const extra = await tempDir();
    const wallet = {
      ...PING_ROW,
      g: 'clients',
      p: '/admin/clients/:id/wallet/adjust',
      a: 'wallet:adjust',
      t: ['ledger_accounts'],
      module: 'money',
    };
    await writeFile(join(extra, 'repeat.mjs'), `export const rows = ${JSON.stringify([wallet])};\n`);
    const fresh = await tempDir();
    for (const script of ['build-route-manifest.mjs', 'build-route-slices.mjs']) {
      const result = await run(script, [], {
        GSM_MAP_ADDITIONS_EXTRA_DIR: extra,
        GSM_DOCS_DIR: fresh,
        FRONTEND_DIR: console_,
      });
      expect(result.code, script).not.toBe(0);
      expect(result.stderr, script).toContain('repeats the map row');
      expect(result.stderr, script).toContain('repeat.mjs');
    }
  });

  describe('the contract comparisons over that manifest', () => {
    const contract = (key: string, extra: Partial<ContractRow> = {}): ContractRow => {
      const [method = 'GET', path = '/'] = key.split(' ');
      return { key, method, path, surface: 'admin', access: 'staff-permission', permission: null, ...extra };
    };

    it('read the success status of an addition next to the extraction, and nothing for a row without one', () => {
      const statuses = loadSuccessStatuses(loadManifest(join(docs, 'route-manifest.json')));
      expect(statuses.get(PING)).toBe(204);
      expect(statuses.get(LIST)).toBe(200);
      expect(statuses.get(CREATE)).toBe(201);
      expect(statuses.has(WALLET)).toBe(false);
      expect(statuses.has(CHECK)).toBe(false);
      expect(statuses.get('GET /health')).toBe(200);
    });

    it('expect the five sample routes to be built (route parity, and through it OpenAPI, which documents every contract)', () => {
      const manifest = loadManifest(join(docs, 'route-manifest.json'));
      const expected = expectedKeys(manifest, 'http', new Set());
      for (const key of SAMPLE_KEYS) expect(expected).toContain(key);
      const lines = difference('http', [], expected);
      for (const key of SAMPLE_KEYS) expect(lines).toContain(`http: ${key} is expected but not built`);
    });

    it('flag a sample contract without Turnstile and accept one with it', () => {
      const manifest = loadManifest(join(docs, 'route-manifest.json'));
      expect(turnstileMismatches([contract(CHECK, { surface: 'store', access: 'public' })], manifest)).toHaveLength(1);
      expect(
        turnstileMismatches([contract(CHECK, { surface: 'store', access: 'public', turnstile: true })], manifest),
      ).toEqual([]);
    });

    it('compare access and permission with the row, CRUD rows by operation', () => {
      const manifest = loadManifest(join(docs, 'route-manifest.json'));
      const ok = [
        contract(PING, { permission: 'settings:update' }),
        contract(LIST, { permission: 'settings:read' }),
        contract(CREATE, { permission: 'settings:create' }),
        contract(CHECK, { surface: 'store', access: 'public', turnstile: true }),
        contract(WALLET, { permission: 'wallet:read' }),
      ];
      expect(accessMismatches(ok, manifest, {})).toEqual([]);
      const wrong = [
        contract(PING, { permission: 'settings:read' }),
        contract(LIST, { permission: 'settings:create' }),
        contract(WALLET, { permission: 'wallet:adjust' }),
      ];
      const lines = accessMismatches(wrong, manifest, {});
      expect(lines).toHaveLength(3);
      for (const key of [PING, LIST, WALLET]) expect(lines.some((line) => line.startsWith(key))).toBe(true);
    });
  });
});
