// Builds the backend route manifest in memory: every map row expanded into endpoints, with English text,
// owning module, normalised access and, for admin routes, the frontend function that calls it (its @route tag).

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { EXPECTED, additions, domains, expandRow, groups, mapRoutes, rowFlags, rowKey, routes, surfaces, system, tables } from './map.mjs';
import { ROOT } from './paths.mjs';
import { modules, modulesForRow } from '../module-map.mjs';
import { descriptions, groupNames, surfaceNames } from '../route-descriptions.en.mjs';

export { ROOT };

// Letter of the CRUD row each endpoint kind comes from (the key of a CRUD addition's `successStatus` object).
const CRUD_LETTER = { list: 'L', show: 'S', create: 'C', update: 'U', delete: 'D' };

/** Owning module of a row: an addition names it, a map row is matched by scripts/module-map.mjs. */
const ownersOf = (row) => (row.addition ? [row.addition.module] : modulesForRow(rowKey(row)));

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
 * Expands the whole map and the backend's additions, and checks the map against its fixed counts.
 * Counts: the map's own numbers are compared with EXPECTED; `counts.rows` and `counts.endpoints` are map + additions.
 * @throws {Error} when a map count changed, a row has no English text, a row has zero or several modules, two endpoints
 *   share a key, a frontend @route is unknown, or the console calls an addition that gives no successStatus.
 */
export function buildManifest() {
  const frontendRoutes = scanFrontendRoutes();
  const flags = new Map(rowFlags.map((flag) => [flag.row, flag]));
  const endpoints = [];
  const problems = [];
  for (const row of routes) {
    const key = rowKey(row);
    const owners = ownersOf(row);
    const description = row.addition ? row.addition.en : descriptions[key];
    if (owners.length !== 1) problems.push(`${key}: modules [${owners.join(', ')}] (need exactly one)`);
    if (!description) problems.push(`${key}: no English description`);
    for (const e of expandRow(row)) {
      const fe = e.kind === 'http' ? frontendRoutes.get(e.key) ?? null : null;
      const endpoint = { ...e, module: owners[0] ?? null, description: description ?? null, frontend: fe };
      // A row flag (feature 24A) only adds: Turnstile, and where it came from. Every other map endpoint stays as the map gives it.
      const flag = row.addition ? undefined : flags.get(key);
      if (flag) {
        endpoint.turnstile = true;
        endpoint.rowFlag = { file: flag.file, spec: flag.spec };
      }
      if (row.addition) {
        const given = row.addition.successStatus;
        const successStatus = typeof given === 'object' && given !== null ? given[CRUD_LETTER[e.op]] : given;
        endpoint.addition = { file: row.addition.file, spec: row.addition.spec };
        if (successStatus !== undefined) endpoint.successStatus = successStatus;
        else if (fe) problems.push(`${e.key}: the console calls this addition (${fe.file}:${fe.line}); its row needs successStatus (${row.addition.file})`);
      }
      endpoints.push(endpoint);
    }
  }
  const counts = {
    rows: routes.length,
    tables: tables.length,
    scenarios: system.scenarios.length,
    surfaces: surfaces.length,
    moneyEvents: system.moneyEvents.length,
    accounts: system.accounts.length,
    endpoints: endpoints.length,
  };
  // The map's own numbers (what EXPECTED pins): the totals above minus the additions.
  const mapCounts = { ...counts, rows: mapRoutes.length, endpoints: mapRoutes.reduce((n, row) => n + expandRow(row).length, 0) };

  for (const [name, want] of Object.entries(EXPECTED)) if (mapCounts[name] !== want) problems.push(`count ${name}: map has ${mapCounts[name]}, expected ${want}`);
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
      additions:
        'rows beyond the map are backend-owned: scripts/map-additions/<feature>.mjs (decision 035); they name their module, English sentence and spec decision, and are counted on top of the map numbers',
      rowFlags:
        'the same files may add Turnstile to a public client or store map row (rowFlags, feature 24A); the endpoint then has turnstile true and rowFlag { file, spec }',
    },
    counts: {
      ...counts,
      map: { rows: mapCounts.rows, endpoints: mapCounts.endpoints },
      additions: { rows: additions.length, endpoints: endpoints.filter((e) => e.addition).length },
      frontendRoutes: frontendRoutes.size,
      bySurface: tally({ row: (r) => r.s, endpoint: (e) => e.surface }),
      byModule: tally({ row: (r) => ownersOf(r)[0], endpoint: (e) => e.module }),
    },
    surfaces: surfaces.map((s) => ({ id: s.id, name: surfaceNames[s.id], base: s.base, actor: s.actor, authRaw: s.auth })),
    groups: Object.fromEntries(Object.entries(groups).map(([s, list]) => [s, list.map((g) => ({ id: g.id, name: groupNames[s]?.[g.id] ?? g.id, nameAr: g.name }))])),
    modules: modules.map(({ id, name, domain, tables: owned }) => ({ id, name, domain, domainNameAr: domains.find((d) => d.id === domain)?.name, tables: owned })),
    endpoints,
  };
}
