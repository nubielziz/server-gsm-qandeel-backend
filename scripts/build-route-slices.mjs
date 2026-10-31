// Writes docs/slices/<module>.json (one brief input per backend module) and docs/slices/index.json.
// A slice holds the module's endpoints, owned tables (columns, FKs, text), the foreign tables it may only reach
// through other modules' public services, and the scenario steps and money events that exercise it.
// Usage: `bun scripts/build-route-slices.mjs` to rebuild, `--check` to fail when committed slices are stale (CI).

import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { buildManifest, ROOT } from './lib/manifest.mjs';
import { system, tables } from './lib/map.mjs';
import { modules } from './module-map.mjs';
import { tableDescriptions } from './table-descriptions.en.mjs';

const OUT = join(ROOT, 'docs', 'slices');
const check = process.argv.includes('--check');

/** Every table must have exactly one owner module; returns table -> module id. */
function ownership() {
  const owner = new Map();
  const problems = [];
  for (const m of modules)
    for (const t of m.tables) {
      if (!tables.some((x) => x.n === t)) problems.push(`${m.id}: unknown table ${t}`);
      if (owner.has(t)) problems.push(`${t}: owned by ${owner.get(t)} and ${m.id}`);
      owner.set(t, m.id);
    }
  for (const t of tables) if (!owner.has(t.n)) problems.push(`${t.n}: no owner module`);
  if (problems.length) throw new Error(`table ownership problems:\n  ${problems.join('\n  ')}`);
  return owner;
}

/** A table as a slice shows it: columns, foreign keys (with kind) and both descriptions. */
const tableView = (name) => {
  const t = tables.find((x) => x.n === name);
  return {
    name,
    description: tableDescriptions[name] ?? null,
    descriptionAr: t.desc,
    b2c: t.b2c ?? null,
    columns: t.cols,
    foreignKeys: t.fk.map(([column, target, kind = 'fk']) => ({ column, target, kind })),
  };
};

const manifest = buildManifest();
const owner = ownership();
const files = {};
const index = [];

for (const mod of modules) {
  const endpoints = manifest.endpoints.filter((e) => e.module === mod.id);
  const used = [...new Set(endpoints.flatMap((e) => e.tables))].sort();
  const foreign = used.filter((t) => owner.get(t) !== mod.id).map((t) => ({ table: t, owner: owner.get(t) }));
  const owned = new Set(mod.tables);
  // Scenario steps that touch an owned table: each one becomes an assertion in that scenario's e2e test.
  const scenarios = system.scenarios
    .map((s) => ({
      id: s.id,
      nameAr: s.name,
      group: s.group,
      steps: s.steps
        .map((st, i) => ({ step: i + 1, from: st.from, to: st.to, label: st.label, textAr: st.text, tables: st.tables ?? [] }))
        .filter((st) => st.tables.some((t) => owned.has(t))),
    }))
    .filter((s) => s.steps.length);
  const slice = {
    module: mod.id,
    name: mod.name,
    domain: mod.domain,
    generatedBy: 'scripts/build-route-slices.mjs (do not edit by hand)',
    counts: {
      rows: manifest.counts.byModule[mod.id].rows,
      endpoints: endpoints.length,
      bySurface: Object.fromEntries([...new Set(endpoints.map((e) => e.surface))].map((s) => [s, endpoints.filter((e) => e.surface === s).length])),
      frontendCalled: endpoints.filter((e) => e.frontend).length,
    },
    stages: [...new Set(endpoints.map((e) => e.stage))].sort((a, b) => a - b),
    ownedTables: mod.tables.map(tableView),
    foreignTables: foreign,
    endpoints,
    scenarios,
    ...(mod.id === 'money' ? { ledgerAccounts: system.accounts, moneyEvents: system.moneyEvents } : {}),
    ...(mod.id === 'orders' ? { statuses: system.statuses, scenarioTracks: system.scenarios.map((s) => ({ id: s.id, tracks: s.tracks })) } : {}),
  };
  files[`${mod.id}.json`] = `${JSON.stringify(slice, null, 2)}\n`;
  index.push({ module: mod.id, name: mod.name, domain: mod.domain, ...slice.counts, stages: slice.stages, tables: mod.tables.length, scenarios: scenarios.map((s) => s.id) });
}
files['index.json'] = `${JSON.stringify({ generatedBy: 'scripts/build-route-slices.mjs', modules: index }, null, 2)}\n`;

if (check) {
  const present = existsSync(OUT) ? readdirSync(OUT).filter((f) => f.endsWith('.json')) : [];
  const stale = Object.entries(files).filter(([n, t]) => !existsSync(join(OUT, n)) || readFileSync(join(OUT, n), 'utf8') !== t).map(([n]) => n);
  const orphan = present.filter((f) => !files[f]);
  if (stale.length || orphan.length) {
    console.error(`stale slices: ${[...stale, ...orphan].join(', ')}. Run: bun scripts/build-route-slices.mjs`);
    process.exit(1);
  }
  console.log('slices are up to date');
} else {
  mkdirSync(OUT, { recursive: true });
  for (const f of readdirSync(OUT)) if (f.endsWith('.json') && !files[f]) throw new Error(`docs/slices/${f} is not a module slice; remove it`);
  for (const [n, t] of Object.entries(files)) writeFileSync(join(OUT, n), t);
  for (const s of index)
    console.log(`${s.module.padEnd(12)} ${String(s.endpoints).padStart(3)} endpoints  ${String(s.tables).padStart(2)} tables  stages ${s.stages.join(',')}  scenarios ${s.scenarios.join(',') || '-'}`);
}
