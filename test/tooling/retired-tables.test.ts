// The retiredTables seam of the module map (decision 064; scripts/lib/map.mjs, scripts/build-route-slices.mjs): the tables the contract
// release drops. A retired table is a map table its module still owns (the map names it), absent from the database and from Drizzle,
// and no route row may touch it. The expand release ships the lists empty so CI proves the seam before anything is dropped; the cases
// below run on a synthetic module map, and the last ones read the real one. No database, no Nest application.
import { afterAll, describe, expect, it } from 'bun:test';
import { cp, mkdir, mkdtemp, readFile, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getTableConfig, PgTable } from 'drizzle-orm/pg-core';
import { is } from 'drizzle-orm';
import * as barrel from '@src/infra/db/schema';

interface Mod {
  id: string;
  tables: string[];
  additionalTables?: string[];
  retiredTables?: unknown;
}
interface AdditionFile {
  file: string;
  rows: unknown;
}
interface MapModule {
  retiredTablesOf(list?: Mod[]): string[];
  liveTablesOf(list?: Mod[]): string[];
  retiredTableProblems(list?: Mod[], mapTableNames?: string[]): string[];
  checkRetiredTables(list?: Mod[], mapTableNames?: string[]): void;
  checkAdditions(files: AdditionFile[], list?: Mod[]): unknown[];
}
// Plain JavaScript, loaded at run time as test/tooling/map-additions.test.ts loads it.
const ROOT = join(import.meta.dir, '../..');
const mapPath = '../../scripts/lib/map.mjs';
const modulesPath = '../../scripts/module-map.mjs';
const map = (await import(mapPath)) as MapModule;
const { modules: realModules } = (await import(modulesPath)) as { modules: Mod[] };

/** A module map of two modules over table names of the real map, so an addition row can name them: money retires nothing. */
const synthetic = (): Mod[] => [
  { id: 'platform', tables: ['settings', 'files'], additionalTables: ['notification_inbox'], retiredTables: ['files'] },
  { id: 'money', tables: ['payments', 'refunds'], additionalTables: ['credit_limit_raises'], retiredTables: [] },
];
const MAP_TABLES = ['settings', 'files', 'payments', 'refunds'];

/** The error message of checking the retired lists of a module list, or '' when they are sound. */
function problems(list: Mod[]): string[] {
  return map.retiredTableProblems(list, MAP_TABLES);
}

/** An addition row (admin, stage 99) that touches these tables; module platform. */
const row = (t: string[]): Record<string, unknown> => ({
  s: 'admin',
  g: 'ops',
  m: 'POST',
  p: '/admin/w0-retired/ping',
  f: undefined,
  a: 'settings:update',
  st: 99,
  t,
  en: 'Tooling test row.',
  module: 'platform',
  spec: 'B-TBD w0-retired',
});

/** The error message of checking one row against a module list, or '' when it is accepted. */
function additionMessage(t: string[], list: Mod[]): string {
  try {
    map.checkAdditions([{ file: 'scripts/map-additions/x.mjs', rows: [row(t)] }], list);
    return '';
  } catch (error) {
    return (error as Error).message;
  }
}

describe('a retired table, on a synthetic module map', () => {
  it('stays owned by its module, leaves the live tables, and the lists are sound', () => {
    const list = synthetic();
    expect(problems(list)).toEqual([]);
    expect(map.retiredTablesOf(list)).toEqual(['files']);
    // owned: still one of the module's tables; live: absent from the database and from Drizzle
    expect(list[0]!.tables).toContain('files');
    expect(map.liveTablesOf(list)).toEqual([
      'credit_limit_raises',
      'notification_inbox',
      'payments',
      'refunds',
      'settings',
    ]);
    expect(() => map.checkRetiredTables(list, MAP_TABLES)).not.toThrow();
  });

  it('with no retired table every table of the map is live (the expand release)', () => {
    const list = synthetic();
    list[0]!.retiredTables = [];
    expect(map.retiredTablesOf(list)).toEqual([]);
    expect(map.liveTablesOf(list)).toContain('files');
    // a module that does not name the field at all is read as an empty list
    delete list[1]!.retiredTables;
    expect(problems(list)).toEqual([]);
  });

  it('fails when a table is retired by a module that does not own it', () => {
    const list = synthetic();
    list[1]!.retiredTables = ['files'];
    expect(problems(list).join('\n')).toContain("money: retired table files is not one of the module's own tables");
  });

  it('fails when the table is not a table of the map at all', () => {
    const list = synthetic();
    list[0]!.retiredTables = ['nope'];
    expect(problems(list)).toEqual(['platform: retired table nope is not a table of the map']);
  });

  it('fails when a table is retired and an additionalTables entry at once', () => {
    const list = synthetic();
    list[0]!.additionalTables = ['files'];
    expect(problems(list).join('\n')).toContain('platform: retired table files is also an additionalTables entry');
    // an additionalTables entry of another module counts too: the names are one list
    list[0]!.additionalTables = [];
    list[1]!.additionalTables = ['files'];
    expect(problems(list).join('\n')).toContain('platform: retired table files is also an additionalTables entry');
  });

  it('fails when a list names a table twice, or two modules retire the same table, or the list is not an array', () => {
    const twice = synthetic();
    twice[0]!.retiredTables = ['files', 'files'];
    expect(problems(twice)).toContain('platform: retiredTables lists a table twice');
    const both = synthetic();
    both[1]!.tables = ['payments', 'files'];
    both[1]!.retiredTables = ['files'];
    expect(problems(both)).toContain('files: retired by platform and money');
    const text = synthetic();
    text[0]!.retiredTables = 'files';
    expect(problems(text)).toEqual(['platform: retiredTables must be an array']);
  });

  it('stops the tool that loads the map, naming every problem', () => {
    const list = synthetic();
    list[0]!.retiredTables = ['nope', 'files', 'files'];
    expect(() => map.checkRetiredTables(list, MAP_TABLES)).toThrow('retired tables problems:');
    expect(() => map.checkRetiredTables(list, MAP_TABLES)).toThrow('retired table nope is not a table of the map');
    expect(() => map.checkRetiredTables(list, MAP_TABLES)).toThrow('retiredTables lists a table twice');
  });

  it('refuses an addition row that names a retired table, and accepts one that names a live or an additional table', () => {
    const list = synthetic();
    expect(additionMessage(['files'], list)).toContain(
      'table "files" is neither a map table nor an additionalTables entry',
    );
    expect(additionMessage(['settings'], list)).toBe('');
    expect(additionMessage(['notification_inbox'], list)).toBe('');
    // the same row is accepted while nothing is retired
    list[0]!.retiredTables = [];
    expect(additionMessage(['files'], list)).toBe('');
  });
});

describe('the retiredTables of the real module map', () => {
  /** The names of the tables Drizzle declares. */
  const drizzleNames = (): string[] =>
    Object.values(barrel as Record<string, unknown>)
      .filter((value): value is PgTable => is(value, PgTable))
      .map((table) => getTableConfig(table).name);

  it('gives every module a retiredTables list (empty in the expand release, filled by the contract release)', () => {
    for (const module of realModules) expect(Array.isArray(module.retiredTables), module.id).toBe(true);
  });

  it('is sound against the map, and a retired table is owned once, never live, and not declared in Drizzle', () => {
    expect(map.retiredTableProblems()).toEqual([]);
    const live = new Set(map.liveTablesOf(realModules));
    const declared = new Set(drizzleNames());
    for (const name of map.retiredTablesOf(realModules)) {
      expect(
        realModules.filter((module) => module.tables.includes(name)).map((module) => module.id),
        name,
      ).toHaveLength(1);
      expect(live.has(name), `${name} is live`).toBe(false);
      expect(declared.has(name), `${name} is still declared in Drizzle`).toBe(false);
    }
  });

  it('expects exactly the tables Drizzle declares, once the retired ones are left out', () => {
    expect(map.liveTablesOf(realModules)).toEqual(drizzleNames().sort());
  });
});

describe('build-route-slices.mjs on a copy of the scripts whose identity module retires a table', () => {
  const scratch: string[] = [];
  afterAll(async () => {
    await Promise.all(scratch.map((dir) => rm(dir, { recursive: true, force: true })));
  });

  interface Slice {
    ownedTables: Array<{ name: string; retired?: boolean }>;
  }
  interface Run {
    code: number;
    stderr: string;
    docs: string;
  }

  /**
   * Copies the scripts to a temporary folder, wraps their module map so that the identity module retires these tables, and runs the
   * slice builder there against a temporary docs folder and a console with no routes.
   */
  async function runSlices(retired: string[]): Promise<Run> {
    const dir = await mkdtemp(join(tmpdir(), 'gsm-retired-'));
    scratch.push(dir);
    await cp(join(ROOT, 'scripts'), join(dir, 'scripts'), { recursive: true });
    await symlink(join(ROOT, 'reference'), join(dir, 'reference'));
    const wrapped = join(dir, 'scripts', 'module-map.mjs');
    await rename(wrapped, join(dir, 'scripts', 'module-map.real.mjs'));
    await writeFile(
      wrapped,
      [
        "import * as real from './module-map.real.mjs';",
        `const retired = ${JSON.stringify(retired)};`,
        "export const modules = real.modules.map((m) => (m.id === 'identity' ? { ...m, retiredTables: retired } : m));",
        'export const modulesForRow = real.modulesForRow;',
        '',
      ].join('\n'),
    );
    const docs = join(dir, 'docs');
    const frontend = join(dir, 'frontend');
    await mkdir(docs);
    await mkdir(frontend);
    const child = Bun.spawn([process.execPath, '--no-env-file', join(dir, 'scripts', 'build-route-slices.mjs')], {
      cwd: dir,
      env: {
        PATH: process.env.PATH ?? '',
        HOME: process.env.HOME ?? tmpdir(),
        GSM_DOCS_DIR: docs,
        FRONTEND_DIR: frontend,
      },
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const [, stderr, code] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    return { code, stderr, docs };
  }

  it('marks the retired table in its slice, keeps it owned, and marks no other table', async () => {
    const run = await runSlices(['kyc_submissions']);
    expect(run.code, run.stderr).toBe(0);
    const slice = async (name: string) =>
      JSON.parse(await readFile(join(run.docs, 'slices', `${name}.json`), 'utf8')) as Slice;
    const identity = await slice('identity');
    const marked = identity.ownedTables.filter((table) => table.retired === true).map((table) => table.name);
    expect(marked).toEqual(['kyc_submissions']);
    // still owned by identity, with every other owned table unmarked
    expect(identity.ownedTables.map((table) => table.name)).toContain('kyc_submissions');
    expect(identity.ownedTables.filter((table) => table.name !== 'kyc_submissions' && 'retired' in table)).toEqual([]);
    expect((await slice('money')).ownedTables.some((table) => 'retired' in table)).toBe(false);
  }, 60_000);

  it('marks nothing while no table is retired (the expand release)', async () => {
    const run = await runSlices([]);
    expect(run.code, run.stderr).toBe(0);
    const identity = JSON.parse(await readFile(join(run.docs, 'slices', 'identity.json'), 'utf8')) as Slice;
    expect(identity.ownedTables.some((table) => 'retired' in table)).toBe(false);
  }, 60_000);

  it('stops on a retired table the module does not own', async () => {
    const run = await runSlices(['files']);
    expect(run.code).not.toBe(0);
    expect(run.stderr).toContain('retired tables problems:');
    expect(run.stderr).toContain("identity: retired table files is not one of the module's own tables");
  }, 60_000);
});
