// Loads every module's public API, and the API and worker root modules, each in a fresh Bun process (decision 032).
// Modules import each other through their index.ts and some pairs form import cycles (identity calls money and catalog
// services, their controllers use identity's decorators); a cycle that reads a binding before it is initialised fails at
// class-definition time, and only for some entry orders, so each entry point is loaded on its own here.
import { describe, expect, it } from 'bun:test';
import { readdirSync } from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dir, '..', '..');

const MODULE_ENTRIES = readdirSync(path.join(ROOT, 'src', 'modules'), { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => `./src/modules/${entry.name}/index.ts`)
  .sort();

/** Every entry point a process or a script may load first. */
const ENTRIES = [...MODULE_ENTRIES, './src/app.module.ts', './src/worker.module.ts'];

/**
 * Imports one entry in a new Bun process started at the repository root (Bun reads the decorator flags of tsconfig.json
 * from the working directory).
 *
 * @param entry the file to import, relative to the repository root
 * @returns the exit code and what the process wrote to stderr
 */
async function load(entry: string): Promise<{ entry: string; exitCode: number; stderr: string }> {
  const child = Bun.spawn([process.execPath, '-e', `import 'reflect-metadata'; await import('${entry}');`], {
    cwd: ROOT,
    env: { ...process.env, NODE_ENV: 'test' },
    stdout: 'ignore',
    stderr: 'pipe',
  });
  const [exitCode, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()]);
  return { entry, exitCode, stderr };
}

describe('module public APIs', () => {
  it('each load on their own, whatever is imported first (no import-cycle TDZ errors)', async () => {
    expect(MODULE_ENTRIES.length).toBeGreaterThanOrEqual(12);
    const results = await Promise.all(ENTRIES.map(load));
    const failed = results
      .filter((result) => result.exitCode !== 0)
      .map(
        (result) => `${result.entry}: ${result.stderr.split('\n').find((line) => /Error/.test(line)) ?? result.stderr}`,
      );
    expect(failed).toEqual([]);
  }, 30_000);
});
