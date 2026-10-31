// Writes test/contract/pending.ts: every key of docs/route-manifest.json that has no contract yet, grouped by module.
// Run ONCE (`bun scripts/gen-contract-pending.mjs`); afterwards each feature deletes the keys it builds by hand, and the
// route-parity test fails if a built route is still listed (docs/contract/TESTS.md, "Scope per phase").
// It refuses to overwrite the file unless --force is given, so a feature's edits are never lost.
import 'reflect-metadata';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(ROOT, 'test', 'contract', 'pending.ts');

if (existsSync(OUT) && !process.argv.includes('--force')) {
  console.error(`${relative(ROOT, OUT)} exists: features maintain it by hand. Use --force to regenerate it from scratch.`);
  process.exit(1);
}

// Importing the application registers every route contract and event (their definitions run at import time).
await import('../src/app.module.ts');
const { contractRegistry, eventRegistry } = await import('../src/common/contract/index.ts');

const manifest = JSON.parse(readFileSync(join(ROOT, 'docs', 'route-manifest.json'), 'utf8'));
// Dhru actions and supplier calls have no registry yet (features 7a and 6), so only HTTP routes and events can be built.
const built = new Set([...contractRegistry.keys(), ...eventRegistry.keys()]);

const byModule = new Map(manifest.modules.map((module) => [module.id, []]));
for (const endpoint of manifest.endpoints) {
  if (built.has(endpoint.key)) continue;
  const group = byModule.get(endpoint.module) ?? byModule.set(endpoint.module ?? 'unassigned', []).get(endpoint.module ?? 'unassigned');
  group.push(endpoint.key);
}

const lines = [
  '// Routes of the map that are not built yet: the contract tests compare the registry with the route manifest minus this',
  '// list (docs/contract/TESTS.md). Generated once by scripts/gen-contract-pending.mjs; from then on each feature deletes',
  '// the keys of the routes it builds, and route-parity fails if a built route is still listed here.',
  '',
  '/**',
  ' * Manifest keys (`METHOD /path`, `DHRU <action>`, `SUPPLIER <call>`, `EVENT <name>`) that have no contract yet.',
  ' *',
  ' * Why: decision 009 and docs/contract/TESTS.md: the registry must equal the manifest, and this list is the part of the',
  ' * manifest that later features still owe, so the gap shrinks to nothing in Phase 4.',
  ' */',
  'export const PENDING: readonly string[] = [',
];
let total = 0;
for (const [module, keys] of byModule) {
  if (keys.length === 0) continue;
  lines.push(`  // ${module}`);
  for (const key of keys) lines.push(`  ${JSON.stringify(key).replaceAll("'", "\\'").replace(/^"|"$/g, "'")},`);
  total += keys.length;
}
lines.push('];', '');
writeFileSync(OUT, lines.join('\n'));
console.log(`wrote ${relative(ROOT, OUT)}: ${total} pending of ${manifest.endpoints.length} endpoints (${built.size} built)`);
