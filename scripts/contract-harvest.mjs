// Runs the fixture harvest (docs/contract/ALIGNMENT.md § 8): the frontend's own Vitest, under Node, with the config and
// the test of this repository (test/contract/harvest). The frontend repository is only read: caches and output stay
// here, and this script fails if `git status` of the frontend changed while it ran.
// Usage: `bun run contract:harvest` (needs `npm ci` done once in the frontend repository, FRONTEND_DIR to override).
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const FRONTEND = resolve(ROOT, process.env.FRONTEND_DIR ?? '../frontend-admin');
const VITEST = join(FRONTEND, 'node_modules', '.bin', 'vitest');
const CONFIG = join('test', 'contract', 'harvest', 'vitest.config.mjs');

if (!existsSync(VITEST)) {
  console.error(`The frontend's Vitest is missing (${VITEST}). Run \`npm ci\` in ${FRONTEND} (or set FRONTEND_DIR).`);
  process.exit(2);
}

/** `git status` of the frontend, to prove the harvest wrote nothing there (empty when it is not a git checkout). */
function frontendStatus() {
  const result = spawnSync('git', ['-C', FRONTEND, 'status', '--porcelain'], { encoding: 'utf8' });
  return result.status === 0 ? result.stdout : '';
}

const before = frontendStatus();
// `node` runs the binary: the mocks need Vite's transforms, which Bun cannot give them (ALIGNMENT § 8).
const run = spawnSync(process.execPath, [VITEST, 'run', '--config', CONFIG, '--reporter=verbose', '--silent=false'], {
  cwd: ROOT,
  stdio: 'inherit',
  env: { ...process.env, FRONTEND_DIR: FRONTEND },
});
const after = frontendStatus();

if (after !== before) {
  console.error('The frontend repository changed while the harvest ran. The harvest must never write there:');
  console.error(after);
  process.exit(1);
}
process.exit(run.status ?? 1);
