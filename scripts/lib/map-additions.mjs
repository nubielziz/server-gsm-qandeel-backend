// Backend-owned route rows beyond the read-only API design map (decision 035): the row helper, the file reader and the guards.
// MUST NOT import map.mjs or manifest.mjs: addition files import `R` from here while map.mjs awaits them (a cycle would hang the
// loader). Everything the guards need from the map arrives as arguments (`ctx` of validateAdditions).

import { readdir } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { pathToFileURL } from 'node:url';

/**
 * The map's row helper: surface, group, method, path, Arabic text, auth text, stage, tables, extras.
 * Addition rows add `en`, `module`, `spec` and optionally `successStatus` (and `ops` for CRUD) as extras. Since English only
 * (decision 039) a new row passes `undefined` as the Arabic text: the loader then uses `en` in its place.
 */
export const R = (s, g, m, p, f, a, st, t, extra = {}) => ({ s, g, m, p, f, a, st, t, ...extra });

/** Surfaces an addition may use, with the path prefix of each (`null` = everything the other prefixes do not take). */
export const ADDITION_SURFACES = { admin: '/admin', client: '/client', store: '/store/v1', v1: '/v1', hooks: '/webhooks', system: null };

/** Success statuses a route may promise (302 only on GET: a redirect). */
export const SUCCESS_STATUSES = [200, 201, 202, 204, 302];

const FILE_NAME = /^[a-z0-9][a-z0-9-]*\.mjs$/;
const SPEC = /^(B\d+|B-TBD [a-z0-9]+(-[a-z0-9]+)*)$/;
const SEGMENT = /^(?::([A-Za-z_][A-Za-z0-9_]*)|[A-Za-z0-9._~-]+)$/;
const KEYS = ['s', 'g', 'm', 'ops', 'p', 'f', 'a', 'st', 't', 'en', 'module', 'spec', 'successStatus'];
const HTTP_METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'];
const CRUD_LETTERS = { L: 'GET', S: 'GET', C: 'POST', U: 'PATCH', D: 'DELETE' };

/**
 * Reads every addition file of the given folders.
 * Why: one file per feature (`scripts/map-additions/<feature>.mjs`) lets features add routes without editing one shared list.
 * @param {string[]} dirs folders to read, in order (the real folder first)
 * @param {string} root repository root; the returned `file` is relative to it
 * @returns {Promise<{ file: string, rows: unknown[], rowFlags: unknown }[]>} one entry per file, per folder in name order; `rowFlags`
 *   is what the file exports under that name (`[]` when it exports none; checked by validateRowFlags)
 * @throws {Error} on a missing folder, a file that is neither README.md nor a valid `<feature>.mjs`, or a module without an array `rows`
 */
export async function readAdditionFiles(dirs, root) {
  const out = [];
  for (const dir of dirs) {
    let names;
    try {
      names = (await readdir(dir)).sort();
    } catch {
      throw new Error(`map additions: folder ${relative(root, dir) || dir} does not exist`);
    }
    for (const name of names) {
      if (name === 'README.md') continue;
      const path = join(dir, name);
      const file = relative(root, path);
      if (!FILE_NAME.test(name)) throw new Error(`map additions: unexpected file ${file} (only README.md and <feature>.mjs, e.g. 20.mjs)`);
      const mod = await import(pathToFileURL(path).href);
      if (!Array.isArray(mod.rows)) throw new Error(`map additions: ${file} must export an array "rows"`);
      out.push({ file, rows: mod.rows, rowFlags: mod.rowFlags ?? [] });
    }
  }
  return out;
}

const isLine = (v) => typeof v === 'string' && v.trim() !== '' && !/[\r\n]/.test(v);

/** Problems with the fields of one row (not its auth text, not its collisions). */
function fieldProblems(row, ctx) {
  const bad = [];
  if (typeof row !== 'object' || row === null || Array.isArray(row)) return ['is not an object'];
  for (const key of Object.keys(row)) if (!KEYS.includes(key)) bad.push(`has an unknown key "${key}"`);
  const surfaceKnown = typeof row.s === 'string' && Object.hasOwn(ADDITION_SURFACES, row.s);
  if (!surfaceKnown) bad.push(`surface "${String(row.s)}" must be one of ${Object.keys(ADDITION_SURFACES).join(', ')}`);

  if (surfaceKnown) {
    const groupIds = (ctx.groups[row.s] ?? []).map((g) => g.id);
    if (groupIds.length === 0) {
      if (row.g !== null) bad.push(`group must be null on surface ${row.s}`);
    } else if (!groupIds.includes(row.g)) bad.push(`group "${String(row.g)}" must be one of ${groupIds.join(', ')} (no new groups)`);
  }

  const crud = row.m === 'CRUD';
  if (!crud && !HTTP_METHODS.includes(row.m)) bad.push(`method "${String(row.m)}" must be ${HTTP_METHODS.join(', ')} or CRUD`);
  if (crud) {
    if (typeof row.ops !== 'string' || row.ops === '') bad.push('CRUD needs ops (letters of L S C U D)');
    else {
      const letters = [...row.ops];
      for (const l of letters) if (!Object.hasOwn(CRUD_LETTERS, l)) bad.push(`ops "${row.ops}" has the unknown letter "${l}"`);
      if (new Set(letters).size !== letters.length) bad.push(`ops "${row.ops}" repeats a letter`);
    }
  } else if (row.ops !== undefined) bad.push('ops only belongs to a CRUD row');

  bad.push(...pathProblems(row, surfaceKnown, crud));

  // English only (decision 039): the Arabic sentence is optional; a row without it reads its `en` in its place.
  if (row.f != null && !isLine(row.f)) bad.push('f (the Arabic sentence), when given, must be a non-empty single line');
  if (typeof row.a !== 'string' || row.a === '') bad.push('a (auth text) must be a non-empty string');
  if (!Number.isInteger(row.st) || row.st < 0) bad.push('st (stage) must be a whole number >= 0');
  if (!Array.isArray(row.t) || row.t.some((x) => typeof x !== 'string')) bad.push('t (tables) must be an array of table names');
  else {
    for (const name of row.t) if (!ctx.tableNames.has(name)) bad.push(`table "${name}" is neither a map table nor an additionalTables entry`);
    if (new Set(row.t).size !== row.t.length) bad.push('t (tables) lists a table twice');
  }
  if (!isLine(row.en)) bad.push('en (the English sentence) must be a non-empty single line');
  if (typeof row.module !== 'string' || !ctx.moduleIds.has(row.module)) bad.push(`module "${String(row.module)}" is not a module of scripts/module-map.mjs`);
  if (typeof row.spec !== 'string' || !SPEC.test(row.spec)) bad.push(`spec "${String(row.spec)}" must be B<n> or "B-TBD <slug>"`);
  if (row.successStatus !== undefined) bad.push(...statusProblems(row, crud));
  return bad;
}

/** Problems with the path of a row: shape, segments, surface prefix, CRUD rules. */
function pathProblems(row, surfaceKnown, crud) {
  if (typeof row.p !== 'string' || !row.p.startsWith('/')) return ['path must be a string starting with "/"'];
  const bad = [];
  const segments = row.p.split('/').slice(1);
  const names = [];
  for (const segment of segments) {
    const m = SEGMENT.exec(segment);
    if (!m) bad.push(`path segment "${segment}" is not a name or :param`);
    else if (m[1]) {
      if (names.includes(m[1])) bad.push(`path repeats the parameter :${m[1]}`);
      names.push(m[1]);
    }
  }
  if (surfaceKnown) {
    const prefix = ADDITION_SURFACES[row.s];
    const under = (base) => row.p === base || row.p.startsWith(`${base}/`);
    if (prefix !== null) {
      if (!under(prefix)) bad.push(`path must start with ${prefix} on surface ${row.s}`);
    } else {
      const taken = Object.values(ADDITION_SURFACES).filter((x) => x !== null && under(x));
      if (taken.length > 0 || row.p === '/api/index.php') bad.push(`path ${row.p} belongs to another surface, not system`);
    }
  }
  if (crud) {
    const last = segments[segments.length - 1] ?? '';
    if (last.startsWith(':') || segments.includes(':id')) bad.push('a CRUD path ends in a fixed segment and has no :id (the endpoints add /:id)');
  }
  return bad;
}

/** Problems with `successStatus` (a number for a plain route, an object per ops letter for CRUD). */
function statusProblems(row, crud) {
  const ok = (status, method) => SUCCESS_STATUSES.includes(status) && (status !== 302 || method === 'GET');
  const list = SUCCESS_STATUSES.join(', ');
  if (!crud) {
    if (typeof row.successStatus === 'number' && ok(row.successStatus, row.m)) return [];
    return [`successStatus ${JSON.stringify(row.successStatus)} must be one of ${list} (302 only on GET)`];
  }
  const given = row.successStatus;
  if (typeof given !== 'object' || given === null || Array.isArray(given)) return ['successStatus of a CRUD row is an object keyed by ops letters, e.g. { L: 200, C: 201 }'];
  const bad = [];
  for (const [letter, status] of Object.entries(given)) {
    if (typeof row.ops !== 'string' || !row.ops.includes(letter)) bad.push(`successStatus key "${letter}" is not in ops "${String(row.ops)}"`);
    else if (typeof status !== 'number' || !ok(status, CRUD_LETTERS[letter])) bad.push(`successStatus ${letter}: ${JSON.stringify(status)} must be one of ${list} (302 only on GET)`);
  }
  return bad;
}

/**
 * Checks every addition row and returns it in the map's row shape with an `addition` block.
 * Why: a malformed, duplicate or overriding row must stop every tool at once, naming the file and the row.
 * @param {{ file: string, rows: unknown[] }[]} files what readAdditionFiles returned (or the same shape built in memory)
 * @param {{ mapRoutes: object[], groups: object, tableNames: Set<string>, moduleIds: Set<string>, expandRow: (row: object) => { key: string }[], rowKey: (row: object) => string }} ctx the map, passed in (this file never imports it)
 * @returns {object[]} rows `{ s, g, m, p, f, a, st, t, ops?, addition: { file, en, module, spec, successStatus? } }`; `f` is the
 *   row's Arabic sentence, or its `en` when it has none (decision 039)
 * @throws {Error} `map additions problems:` followed by one line per problem (all of them), each `<file> row <n> (<row key>): <problem>`
 */
export function validateAdditions(files, ctx) {
  const problems = [];
  // A parameter's name never matters for a route: `:id` and `:clientId` are one route.
  const shape = (key) => key.replace(/:[A-Za-z_][A-Za-z0-9_]*/g, ':');
  const mapRows = new Set(ctx.mapRoutes.map((r) => ctx.rowKey(r)));
  const mapEndpoints = new Map();
  for (const r of ctx.mapRoutes) for (const e of ctx.expandRow(r)) mapEndpoints.set(shape(e.key), ctx.rowKey(r));
  const addedBy = new Map(); // endpoint shape -> "<file> row <n>"
  const out = [];

  for (const { file, rows } of files) {
    if (!Array.isArray(rows)) {
      problems.push(`${file}: "rows" must be an array`);
      continue;
    }
    rows.forEach((row, index) => {
      const n = index + 1;
      const bad = [];
      const name = row && typeof row === 'object' && ['s', 'm', 'p'].every((k) => typeof row[k] === 'string') ? ctx.rowKey(row) : '?';
      const fail = (text) => problems.push(`${file} row ${n} (${name}): ${text}`);
      bad.push(...fieldProblems(row, ctx));
      if (bad.length === 0) {
        if (mapRows.has(name)) bad.push(`repeats the map row ${name}`);
        else {
          let endpoints = [];
          try {
            endpoints = ctx.expandRow(row);
          } catch (error) {
            bad.push(error instanceof Error ? error.message.replace(`${name}: `, '') : String(error));
          }
          for (const e of endpoints) {
            const own = shape(e.key);
            const inMap = mapEndpoints.get(own);
            const other = addedBy.get(own);
            if (inMap) bad.push(`its endpoint ${e.key} already exists in the map (row ${inMap})`);
            else if (other) bad.push(`its endpoint ${e.key} is also added by ${other}`);
            else addedBy.set(own, `${file} row ${n}`);
          }
        }
      }
      if (bad.length > 0) {
        for (const text of bad) fail(text);
        return;
      }
      const { s, g, m, p, f, a, st, t, ops, en, module, spec, successStatus } = row;
      out.push({
        s,
        g,
        m,
        p,
        f: f ?? en, // every reader of `descriptionAr` keeps a sentence

        a,
        st,
        t: [...t],
        ...(m === 'CRUD' ? { ops } : {}),
        addition: { file, en, module, spec, ...(successStatus === undefined ? {} : { successStatus }) },
      });
    });
  }
  if (problems.length > 0) throw new Error(`map additions problems:\n  ${problems.join('\n  ')}`);
  return out;
}

const FLAG_KEYS = ['row', 'turnstile', 'spec'];
/** Surfaces whose public map rows may be flagged: the ones whose routes can carry the anti-bot check (decision 034, feature 24A). */
const FLAG_SURFACES = ['client', 'store'];

/**
 * Checks the row flags of the addition files: add-only changes to existing map rows (feature 24A).
 * Why: a feature may need a stricter rule on a route the map already has (Turnstile on the merchant sign-in forms) while the map stays
 * read-only. A flag can only add protection, so the only flag is `turnstile: true`, and only on a public, non-CRUD map row of `client` or
 * `store` that does not have it yet; a row is flagged by one file at most.
 * @param {{ file: string, rowFlags?: unknown }[]} files what readAdditionFiles returned (or the same shape built in memory)
 * @param {{ mapRoutes: object[], rowKey: (row: object) => string, normaliseAccess: (row: object) => { access: string, turnstile: boolean } }} ctx the map, passed in
 * @returns {{ row: string, turnstile: true, file: string, spec: string }[]} the flags, in file order
 * @throws {Error} `map additions problems:` followed by one line per problem, each `<file> flag <n> (<row key>): <problem>`
 */
export function validateRowFlags(files, ctx) {
  const problems = [];
  const mapRows = new Map(ctx.mapRoutes.map((r) => [ctx.rowKey(r), r]));
  const flaggedBy = new Map(); // row key -> "<file> flag <n>"
  const out = [];
  for (const { file, rowFlags = [] } of files) {
    if (!Array.isArray(rowFlags)) {
      problems.push(`${file}: "rowFlags" must be an array`);
      continue;
    }
    rowFlags.forEach((flag, index) => {
      const n = index + 1;
      const name = flag && typeof flag === 'object' && typeof flag.row === 'string' ? flag.row : '?';
      const bad = [];
      if (typeof flag !== 'object' || flag === null || Array.isArray(flag)) bad.push('is not an object');
      else {
        for (const key of Object.keys(flag)) if (!FLAG_KEYS.includes(key)) bad.push(`has an unknown key "${key}" (a flag has row, turnstile and spec)`);
        if (flag.turnstile !== true) bad.push('turnstile must be true (a flag adds protection to a row, never removes it)');
        if (typeof flag.spec !== 'string' || !SPEC.test(flag.spec)) bad.push(`spec "${String(flag.spec)}" must be B<n> or "B-TBD <slug>"`);
        const row = typeof flag.row === 'string' ? mapRows.get(flag.row) : undefined;
        if (!row) bad.push(`row "${String(flag.row)}" is not the key of a map row ("<surface> <method> <path>"; an addition states its own auth text)`);
        else {
          if (!FLAG_SURFACES.includes(row.s)) bad.push(`row is on surface ${row.s}; only ${FLAG_SURFACES.join(' and ')} rows can be flagged`);
          if (row.m === 'CRUD') bad.push('row is a CRUD row; only a single-endpoint row can be flagged');
          const auth = ctx.normaliseAccess(row);
          if (auth.access !== 'public') bad.push(`row has access ${auth.access}; only a public row can get Turnstile`);
          if (auth.turnstile) bad.push('row already has Turnstile in the map');
        }
        const other = typeof flag.row === 'string' ? flaggedBy.get(flag.row) : undefined;
        if (other) bad.push(`row is also flagged by ${other}`);
        else if (typeof flag.row === 'string') flaggedBy.set(flag.row, `${file} flag ${n}`);
      }
      if (bad.length > 0) {
        for (const text of bad) problems.push(`${file} flag ${n} (${name}): ${text}`);
        return;
      }
      out.push({ row: flag.row, turnstile: true, file, spec: flag.spec });
    });
  }
  if (problems.length > 0) throw new Error(`map additions problems:\n  ${problems.join('\n  ')}`);
  return out;
}
