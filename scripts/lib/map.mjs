// Shared loader for the API design map (reference/gsm-map/data/*.mjs) used by the manifest and slices scripts.
// Turns map rows into endpoints with normalised access rules, so every script expands rows the same way.
// `routes` is the map's rows plus the backend's own rows of scripts/map-additions (decision 035), checked at load time; `rowFlags` are
// the add-only Turnstile flags those files put on map rows (feature 24A). `retiredTables` (decision 064) is the seam for the tables
// the contract release drops: checked at load time, and subtracted from what an addition row may name.

import { routes as mapRoutes, surfaces, groups } from '../../reference/gsm-map/data/routes.mjs';
import { tables, domains } from '../../reference/gsm-map/data/schema.mjs';
import * as system from '../../reference/gsm-map/data/system.mjs';
import { modules } from '../module-map.mjs';
import { readAdditionFiles, validateAdditions, validateRowFlags } from './map-additions.mjs';
import { ROOT, additionsDirs } from './paths.mjs';

export { mapRoutes, surfaces, groups, tables, domains, system };

/**
 * The map's own numbers, fixed by the API design. A change in the map must be reviewed here before the docs are rebuilt.
 * Additions are counted on top (manifest `counts.additions`), never here.
 */
export const EXPECTED = { rows: 274, endpoints: 382, tables: 66, scenarios: 13, surfaces: 9, moneyEvents: 13, accounts: 14 };

/** Unique key of a map row: "<surface> <m> <p>" (Dhru and supplier rows share action names, so the surface is part of it). */
export const rowKey = (row) => `${row.s} ${row.m} ${row.p}`;

// CRUD expansion, same order and verbs as the frontend manifest: byId means the endpoint targets /resource/:id.
const CRUD_OPS = [
  { letter: 'L', method: 'GET', op: 'list', byId: false },
  { letter: 'S', method: 'GET', op: 'show', byId: true },
  { letter: 'C', method: 'POST', op: 'create', byId: false },
  { letter: 'U', method: 'PATCH', op: 'update', byId: true },
  { letter: 'D', method: 'DELETE', op: 'delete', byId: true },
];
const HTTP_METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'];
const PERMISSION = /^[a-z_]+:(\*|[a-z_]+)$/;

// Raw auth text of the map (Arabic) -> normalised access per surface. Unknown text throws: decide, never guess.
// English only (decision 039): a row beyond the map may also write the access name itself (`public`, `staff-session`, ...),
// on the surfaces where the map's word means it, so no new row needs an Arabic word. The map's own rows keep their words.
const ACCESS = {
  admin: { 'عام': 'public', 'جلسة': 'staff-session', 'public': 'public', 'staff-session': 'staff-session' },
  client: {
    'عام': 'public',
    'عام + Turnstile': 'public',
    'جلسة': 'merchant-session',
    'public': 'public',
    'public + Turnstile': 'public',
    'merchant-session': 'merchant-session',
  },
  store: {
    'عام': 'public',
    'عام + Turnstile': 'public',
    'رمز الجلسة': 'checkout-token',
    'رمز الجلسة + Idempotency-Key': 'checkout-token',
    'رمز التتبع (لا يُخمَّن)': 'tracking-token',
    'رمز التتبع': 'tracking-token',
    'رمز الرابط': 'link-token',
    'جلسة الزبون': 'customer-session',
    'رمز التذكرة': 'ticket-token',
    'public': 'public',
    'public + Turnstile': 'public',
    'checkout-token': 'checkout-token',
    'checkout-token + Idempotency-Key': 'checkout-token',
    'tracking-token': 'tracking-token',
    'link-token': 'link-token',
    'customer-session': 'customer-session',
    'ticket-token': 'ticket-token',
  },
  dhru: { 'username + apiaccesskey': 'dhru-credentials' },
  hooks: {
    'توقيع البوابة': 'gateway-signature',
    'secret بالرابط': 'url-secret',
    'gateway-signature': 'gateway-signature',
    'url-secret': 'url-secret',
  },
  events: { 'HMAC-SHA256': 'outbound-hmac' },
  supplier: { 'حسابنا عند المورد': 'outbound-supplier-account' },
  system: { 'عام': 'public', 'شبكة داخلية أو token': 'internal-or-token', 'public': 'public', 'internal-or-token': 'internal-or-token' },
};

/**
 * Normalises a row's raw auth text into { access, permission, turnstile, idempotencyKey }.
 * Why: guards, OpenAPI security schemes and the contract tests need machine-readable access rules.
 * Admin "x:y" values are staff permissions; v1 "x:y" values are API key scopes. The map's Arabic words and, for rows beyond the
 * map, the access names themselves (decision 039) are both accepted.
 * @throws {Error} on auth text the map has not used before.
 */
export function normaliseAccess(row) {
  const raw = row.a;
  const flags = { turnstile: raw.includes('Turnstile'), idempotencyKey: raw.includes('Idempotency-Key') };
  if (row.s === 'admin' && PERMISSION.test(raw)) return { access: 'staff-permission', permission: raw, ...flags };
  if (row.s === 'v1' && PERMISSION.test(raw)) return { access: 'api-key', permission: raw, ...flags };
  const access = ACCESS[row.s]?.[raw];
  if (!access) throw new Error(`${rowKey(row)}: unknown auth value "${raw}"`);
  return { access, permission: null, ...flags };
}

/** What kind of thing a row describes: an HTTP route we serve, a Dhru action, a call we make, or an event we send. */
function kindOf(row) {
  if (row.s === 'dhru') return 'dhru-action';
  if (row.s === 'supplier') return 'supplier-call';
  if (row.s === 'events') return 'event';
  return 'http';
}

/**
 * Expands one map row into endpoints: a CRUD row gives one endpoint per ops letter (L,S,C,U,D order),
 * every other row gives one endpoint. Why: the backend implements endpoints, the map stores CRUD resources as rows.
 * Keys: "METHOD /path" for HTTP, "DHRU <action>", "SUPPLIER <action>", "EVENT <name>".
 */
export function expandRow(row) {
  const kind = kindOf(row);
  const auth = normaliseAccess(row);
  const base = {
    surface: row.s,
    kind,
    group: row.g ?? null,
    descriptionAr: row.f,
    ...auth,
    authRaw: row.a,
    stage: row.st,
    tables: [...row.t],
    dhruResponse: row.r ?? null,
    origin: { row: rowKey(row), method: row.m, ops: row.ops ?? null, path: row.p },
  };

  if (kind === 'dhru-action') return [{ key: `DHRU ${row.p}`, method: 'POST', path: '/api/index.php', action: row.p, op: 'action', ...base }];
  if (kind === 'supplier-call') {
    // "placeimeiorder · bulk" is one row covering the single and the bulk Dhru action.
    const [single, bulk] = row.p.split('·').map((s) => s.trim());
    const actions = bulk ? [single, `${single}${bulk}`] : [single];
    return [{ key: `SUPPLIER ${actions.join('+')}`, method: 'POST', path: '<supplier>/api/index.php', action: actions.join('+'), op: 'call', ...base }];
  }
  if (kind === 'event') return [{ key: `EVENT ${row.p}`, method: 'POST', path: '<merchant webhook url>', event: row.p, op: 'event', ...base }];

  if (row.m !== 'CRUD') {
    if (!HTTP_METHODS.includes(row.m)) throw new Error(`${rowKey(row)}: unsupported method "${row.m}"`);
    return [{ key: `${row.m} ${row.p}`, method: row.m, path: row.p, op: 'action', ...base }];
  }
  const unknown = [...row.ops].filter((l) => !CRUD_OPS.some((o) => o.letter === l));
  if (unknown.length) throw new Error(`${rowKey(row)}: unknown CRUD ops "${unknown.join('')}"`);
  return CRUD_OPS.filter((o) => row.ops.includes(o.letter)).map((o) => {
    const path = o.byId ? `${row.p}/:id` : row.p;
    return { key: `${o.method} ${path}`, method: o.method, path, op: o.op, ...base };
  });
}

/**
 * The tables the contract release drops (decision 064): the `retiredTables` of every module.
 * Why: the map still names them, so a module keeps owning them (every map table needs one owner), but the database and Drizzle no
 * longer hold them and no new route row may touch them. The lists are empty in the expand release and filled by the contract release.
 * @param {{ retiredTables?: string[] }[]} moduleList the module map's modules (or a synthetic list, as the tests use)
 * @returns {string[]} every retired table, in module order
 */
export const retiredTablesOf = (moduleList = modules) => moduleList.flatMap((m) => m.retiredTables ?? []);

/**
 * The tables the database and the Drizzle schema must hold: the modules' tables and additionalTables, without the retired ones.
 * Why: the schema tests subtract the retired tables from what they expect; a retired table stays owned but is absent from both.
 * @param {{ tables: string[], additionalTables?: string[], retiredTables?: string[] }[]} moduleList the modules (or a synthetic list)
 * @returns {string[]} the live table names, sorted
 */
export const liveTablesOf = (moduleList = modules) => {
  const retired = new Set(retiredTablesOf(moduleList));
  return moduleList
    .flatMap((m) => [...m.tables, ...(m.additionalTables ?? [])])
    .filter((name) => !retired.has(name))
    .sort();
};

/**
 * Problems with the `retiredTables` lists: each list is an array, each entry is a map table the same module owns, once, never an
 * additionalTables entry of any module, and never retired by two modules.
 * @param {{ id: string, tables: string[], additionalTables?: string[], retiredTables?: unknown }[]} moduleList the modules (or a synthetic list)
 * @param {string[]} mapTableNames the names of the map's tables
 * @returns {string[]} one line per problem (empty when the lists are sound)
 */
export function retiredTableProblems(moduleList = modules, mapTableNames = tables.map((t) => t.n)) {
  const problems = [];
  const additional = new Set(moduleList.flatMap((m) => m.additionalTables ?? []));
  const retiredBy = new Map();
  for (const m of moduleList) {
    const list = m.retiredTables ?? [];
    if (!Array.isArray(list)) {
      problems.push(`${m.id}: retiredTables must be an array`);
      continue;
    }
    if (new Set(list).size !== list.length) problems.push(`${m.id}: retiredTables lists a table twice`);
    for (const name of list) {
      if (!mapTableNames.includes(name)) problems.push(`${m.id}: retired table ${name} is not a table of the map`);
      else if (!m.tables.includes(name)) problems.push(`${m.id}: retired table ${name} is not one of the module's own tables`);
      if (additional.has(name)) problems.push(`${m.id}: retired table ${name} is also an additionalTables entry`);
      if (retiredBy.has(name) && retiredBy.get(name) !== m.id) problems.push(`${name}: retired by ${retiredBy.get(name)} and ${m.id}`);
      retiredBy.set(name, m.id);
    }
  }
  return problems;
}

/**
 * Stops the tool that loads the map when a `retiredTables` list is unsound (see {@link retiredTableProblems}).
 * @param {{ id: string, tables: string[], additionalTables?: string[], retiredTables?: unknown }[]} moduleList the modules (or a synthetic list)
 * @param {string[]} mapTableNames the names of the map's tables
 * @returns {void}
 * @throws {Error} `retired tables problems:` listing every problem
 */
export function checkRetiredTables(moduleList = modules, mapTableNames = tables.map((t) => t.n)) {
  const problems = retiredTableProblems(moduleList, mapTableNames);
  if (problems.length) throw new Error(`retired tables problems:\n  ${problems.join('\n  ')}`);
}

checkRetiredTables();

/**
 * Checks addition files against the map: shape, groups, tables, modules, auth text, no repeated or overriding row.
 * A row may name a map table or an additionalTables entry, never a retired table.
 * @param {{ file: string, rows: unknown[] }[]} files result of readAdditionFiles (or the same shape built in memory)
 * @param {{ id: string, tables: string[], additionalTables?: string[], retiredTables?: string[] }[]} moduleList the modules whose
 *   tables and ids the rows may name (the real map's unless a test passes a synthetic list)
 * @returns {object[]} the normalised addition rows
 * @throws {Error} `map additions problems:` listing every problem with its file, row number and row key
 */
export const checkAdditions = (files, moduleList = modules) => {
  const retired = new Set(retiredTablesOf(moduleList));
  return validateAdditions(files, {
    mapRoutes,
    groups,
    tableNames: new Set([
      ...tables.map((t) => t.n).filter((name) => !retired.has(name)),
      ...moduleList.flatMap((m) => m.additionalTables ?? []),
    ]),
    moduleIds: new Set(moduleList.map((m) => m.id)),
    expandRow,
    rowKey,
  });
};

/**
 * Checks the row flags of addition files against the map (add-only Turnstile on public client and store rows, feature 24A).
 * @param {{ file: string, rowFlags?: unknown }[]} files result of readAdditionFiles (or the same shape built in memory)
 * @returns {{ row: string, turnstile: true, file: string, spec: string }[]} the flags
 * @throws {Error} `map additions problems:` listing every problem with its file, flag number and row key
 */
export const checkRowFlags = (files) => validateRowFlags(files, { mapRoutes, rowKey, normaliseAccess });

const additionFiles = await readAdditionFiles(additionsDirs(), ROOT);

/** The backend's own rows beyond the map (scripts/map-additions/*.mjs), already checked. */
export const additions = checkAdditions(additionFiles);

/** The backend's add-only flags on map rows (`rowFlags` of scripts/map-additions/*.mjs), already checked. */
export const rowFlags = checkRowFlags(additionFiles);

/** Every row the backend serves: the map's, then the additions. */
export const routes = [...mapRoutes, ...additions];
