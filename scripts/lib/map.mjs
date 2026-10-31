// Shared loader for the API design map (reference/gsm-map/data/*.mjs) used by the manifest and slices scripts.
// Turns map rows into endpoints with normalised access rules, so every script expands rows the same way.

import { routes, surfaces, groups } from '../../reference/gsm-map/data/routes.mjs';
import { tables, domains } from '../../reference/gsm-map/data/schema.mjs';
import * as system from '../../reference/gsm-map/data/system.mjs';

export { routes, surfaces, groups, tables, domains, system };

/** Counts fixed by the API design. A change in the map must be reviewed here before the docs are rebuilt. */
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
const ACCESS = {
  admin: { 'عام': 'public', 'جلسة': 'staff-session' },
  client: { 'عام': 'public', 'جلسة': 'merchant-session' },
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
  },
  dhru: { 'username + apiaccesskey': 'dhru-credentials' },
  hooks: { 'توقيع البوابة': 'gateway-signature', 'secret بالرابط': 'url-secret' },
  events: { 'HMAC-SHA256': 'outbound-hmac' },
  supplier: { 'حسابنا عند المورد': 'outbound-supplier-account' },
  system: { 'عام': 'public', 'شبكة داخلية أو token': 'internal-or-token' },
};

/**
 * Normalises a row's raw auth text into { access, permission, turnstile, idempotencyKey }.
 * Why: guards, OpenAPI security schemes and the contract tests need machine-readable access rules.
 * Admin "x:y" values are staff permissions; v1 "x:y" values are API key scopes.
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
