// Vitest config of the fixture harvest (ALIGNMENT § 8). It lives in this repository and is run by the FRONTEND's own
// Vitest under Node, so the frontend repository is never written to: cache and output stay here.
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const FRONTEND = resolve(ROOT, process.env.FRONTEND_DIR ?? '../frontend-admin');

export default {
  root: ROOT,
  cacheDir: resolve(ROOT, 'node_modules', '.cache', 'contract-harvest'),
  resolve: { alias: { '@': resolve(FRONTEND, 'src') } },
  test: {
    globals: true,
    environment: 'node',
    include: ['test/contract/harvest/harvest.vitest.mjs'],
    // Node >= 25 ships its own localStorage, which warns and hides the mock layer's in-memory fallback.
    execArgv: ['--no-experimental-webstorage'],
    env: { VITE_API_BASE_URL: 'http://api.test' },
    server: { deps: { inline: ['@refinedev/react-router'] } },
    testTimeout: 120_000,
    passWithNoTests: false,
  },
};
