// Where the route tooling reads and writes: repository root, the docs folder and the folders of map additions (decision 035).
// GSM_DOCS_DIR and GSM_MAP_ADDITIONS_EXTRA_DIR exist only for the tooling test (test/unit/map-additions.test.ts); nothing else sets them.

import { join, resolve } from 'node:path';

/** Repository root. */
export const ROOT = resolve(import.meta.dirname, '..', '..');

/**
 * Folder the generated route documents (route-manifest, slices, COVERAGE.md, contract docs) are written to.
 * Test-only override: GSM_DOCS_DIR (hand-written inputs such as docs/contract/lead-decisions.json stay under ROOT).
 */
export const docsDir = () => (process.env.GSM_DOCS_DIR ? resolve(ROOT, process.env.GSM_DOCS_DIR) : join(ROOT, 'docs'));

/**
 * Folders that hold `<feature>.mjs` map additions: the real one, plus GSM_MAP_ADDITIONS_EXTRA_DIR when set.
 * The extra folder is loaded after the real one and never instead of it (test-only).
 */
export const additionsDirs = () => {
  const dirs = [join(ROOT, 'scripts', 'map-additions')];
  if (process.env.GSM_MAP_ADDITIONS_EXTRA_DIR) dirs.push(resolve(ROOT, process.env.GSM_MAP_ADDITIONS_EXTRA_DIR));
  return dirs;
};
