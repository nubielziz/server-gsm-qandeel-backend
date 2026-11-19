// The test layout of decision 043: no test file under src/ (the image copies src/ whole), unit tests in test/unit at the
// path of the code they test, integration tests in one folder per module (or infra), nothing loose at the top of
// test/integration. A source folder that moves without its tests fails here instead of leaving orphaned specs behind.
import { describe, expect, it } from 'bun:test';
import { existsSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(import.meta.dir, '../..');
const IS_TEST = /\.(spec|test)\.(ts|mjs)$/;

/** Every file under a folder of the repository, as paths relative to that folder. */
const filesUnder = (dir: string): string[] =>
  readdirSync(join(ROOT, dir), { recursive: true, encoding: 'utf8' }).filter((path) =>
    statSync(join(ROOT, dir, path)).isFile(),
  );

describe('test layout (decision 043)', () => {
  it('keeps every test file out of src/', () => {
    expect(filesUnder('src').filter((path) => IS_TEST.test(path))).toEqual([]);
  });

  it('puts each unit test in the test/unit folder that mirrors the folder of its code', () => {
    const units = filesUnder('test/unit').filter((path) => IS_TEST.test(path));
    expect(units.length).toBeGreaterThan(250);
    const orphans = units.filter((path) => {
      const folder = path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '';
      return !existsSync(join(ROOT, 'src', folder));
    });
    expect(orphans).toEqual([]);
  });

  it('groups the integration tests by module, with infra for src/infra, src/common and src/config', () => {
    const modules = readdirSync(join(ROOT, 'src/modules'));
    const entries = readdirSync(join(ROOT, 'test/integration'), { withFileTypes: true });
    expect(entries.filter((entry) => entry.isFile()).map((entry) => entry.name)).toEqual([]);
    const unknown = entries
      .filter((entry) => entry.isDirectory() && entry.name !== 'infra' && !modules.includes(entry.name))
      .map((entry) => entry.name);
    expect(unknown).toEqual([]);
  });
});
