// Builds the backend route manifest in memory: every map row expanded into endpoints, with English text,
// owning module, normalised access and, for admin routes, the frontend function that calls it (its @route tag).

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { EXPECTED, domains, expandRow, groups, rowKey, routes, surfaces, system, tables } from './map.mjs';
import { modules, modulesForRow } from '../module-map.mjs';
import { descriptions, groupNames, surfaceNames } from '../route-descriptions.en.mjs';

export const ROOT = resolve(import.meta.dirname, '..', '..');

/** Frontend repo location (read-only input): FRONTEND_DIR env, default ../frontend-admin next to this repo. */
export const frontendDir = () => resolve(ROOT, process.env.FRONTEND_DIR ?? '../frontend-admin');

/** Lists .ts files under a folder (skips tests and generated mocks of no interest). */
function tsFiles(dir) {
  const out = [];
  if (!existsSync(dir)) return out;
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...tsFiles(p));
    else if (/\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name)) out.push(p);
  }
  return out;
}

/**
 * Finds every `@route METHOD /path` tag in the frontend sources and the exported function under it.
 * Why: each admin endpoint must answer in the exact shape its frontend function expects; the slice points at it.
 * @returns {Map<string, {file: string, line: number, fn: string|null}>} keyed by "METHOD /path".
 */
export function scanFrontendRoutes(dir = frontendDir()) {
  const found = new Map();
  for (const file of tsFiles(join(dir, 'src'))) {
    const lines = readFileSync(file, 'utf8').split('\n');
    lines.forEach((text, i) => {
      const m = text.match(/@route\s+(GET|POST|PUT|PATCH|DELETE)\s+(\/\S*)/);
      if (!m) return;
      let fn = null;
      for (let j = i + 1; j < Math.min(lines.length, i + 25) && !fn; j++) {
        const f = lines[j].match(/export\s+(?:async\s+)?function\s+(\w+)|export\s+const\s+(\w+)/);
        if (f) fn = f[1] ?? f[2];
      }
      const key = `${m[1]} ${m[2]}`;
      if (!found.has(key)) found.set(key, { file: relative(dir, file), line: i + 1, fn });
    });
  }
  return found;
}

/**
 * Expands the whole map and checks it against the fixed counts.
 * @throws {Error} when a count changed, a row has no English text, a row has zero or several modules,
 *   or two endpoints share a key.
 */
export function buildManifest() {
  const counts = {
    rows: routes.length,
    tables: tables.length,
    scenarios: system.scenarios.length,
    surfaces: surfaces.length,
    moneyEvents: system.moneyEvents.length,
    accounts: system.accounts.length,
  };
  const frontendRoutes = scanFrontendRoutes();
  const endpoints = [];
  const problems = [];
  for (const row of routes) {
    const key = rowKey(row);
    const owners = modulesForRow(key);
    if (owners.length !== 1) problems.push(`${key}: modules [${owners.join(', ')}] (need exactly one)`);
    if (!descriptions[key]) problems.push(`${key}: no English description`);
    for (const e of expandRow(row)) {
      const fe = e.kind === 'http' ? frontendRoutes.get(e.key) ?? null : null;
      endpoints.push({ ...e, module: owners[0] ?? null, description: descriptions[key] ?? null, frontend: fe });
    }
  }
  counts.endpoints = endpoints.length;

  for (const [name, want] of Object.entries(EXPECTED)) if (counts[name] !== want) problems.push(`count ${name}: map has ${counts[name]}, expected ${want}`);
  const seen = new Set();
  for (const e of endpoints) {
    if (seen.has(e.key)) problems.push(`duplicate endpoint key ${e.key}`);
    seen.add(e.key);
  }
  // Every frontend @route must exist on the backend side (the reverse is the frontend's own coverage check).
  for (const key of frontendRoutes.keys()) if (!seen.has(key)) problems.push(`frontend @route ${key} is not in the map`);
  if (problems.length) throw new Error(`route manifest problems:\n  ${problems.join('\n  ')}`);

  const tally = (pick) => {
    const out = {};
    for (const row of routes) (out[pick.row(row)] ??= { rows: 0, endpoints: 0 }).rows++;
    for (const e of endpoints) out[pick.endpoint(e)].endpoints++;
    return out;
  };
  return {
    source: 'reference/gsm-map/data/{routes,schema,system}.mjs',
    rules: {
      keys: 'HTTP: "METHOD /path"; Dhru: "DHRU <action>"; supplier calls: "SUPPLIER <action>[+<bulk action>]"; outgoing events: "EVENT <name>"',
      crud: 'L=GET /resource, S=GET /resource/:id, C=POST /resource, U=PATCH /resource/:id, D=DELETE /resource/:id; other rows are one endpoint',
      access: 'normalised from the map auth text per surface (scripts/lib/map.mjs); admin "x:y" = staff permission, v1 "x:y" = API key scope',
      modules: 'every row belongs to exactly one module (scripts/module-map.mjs); table ownership follows the map domains',
      frontend: 'admin endpoints point at the frontend function carrying the same @route tag (FRONTEND_DIR)',
    },
    counts: {
      ...counts,
      frontendRoutes: frontendRoutes.size,
      bySurface: tally({ row: (r) => r.s, endpoint: (e) => e.surface }),
      byModule: tally({ row: (r) => modulesForRow(rowKey(r))[0], endpoint: (e) => e.module }),
    },
    surfaces: surfaces.map((s) => ({ id: s.id, name: surfaceNames[s.id], base: s.base, actor: s.actor, authRaw: s.auth })),
    groups: Object.fromEntries(Object.entries(groups).map(([s, list]) => [s, list.map((g) => ({ id: g.id, name: groupNames[s]?.[g.id] ?? g.id, nameAr: g.name }))])),
    modules: modules.map(({ id, name, domain, tables: owned }) => ({ id, name, domain, domainNameAr: domains.find((d) => d.id === domain)?.name, tables: owned })),
    endpoints,
  };
}
