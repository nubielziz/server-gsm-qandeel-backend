// Validates one contract-extraction file (docs/contract/extraction/<group>.json) written in Phase 1:
// shape of every record, and coverage: every frontend @route of the listed features appears exactly once.
// Usage: bun scripts/validate-extraction.mjs [--global] <file> <feature> [<feature>...]   (exit 1 with a list of problems)
// --global also requires the cross-cutting catalogs owned by the auth/access group (authFlow, errorCatalog, ...).

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT } from './lib/manifest.mjs';

const args = process.argv.slice(2);
const globalMode = args.includes('--global');
const [file, ...features] = args.filter((a) => a !== '--global');
if (!file || !features.length) {
  console.error('usage: bun scripts/validate-extraction.mjs <file> <feature> [<feature>...]');
  process.exit(2);
}
const problems = [];
const need = (cond, msg) => cond || problems.push(msg);
const str = (v) => typeof v === 'string';

let data;
try {
  data = JSON.parse(readFileSync(file, 'utf8'));
} catch (e) {
  console.error(`not valid JSON: ${e.message}`);
  process.exit(1);
}
const fe = JSON.parse(readFileSync(join(ROOT, 'docs/contract/frontend-endpoints.json'), 'utf8'));
const featureOf = (path) => path.match(/^src\/features\/([^/]+)\//)?.[1] ?? (path.startsWith('src/lib') ? 'system' : null);

need(Array.isArray(data.features), 'features must be an array');
need(Array.isArray(data.crossCutting), 'crossCutting must be an array of strings');
const seen = new Map();
for (const f of data.features ?? []) {
  const where = `feature ${f.feature}`;
  need(str(f.feature) && features.includes(f.feature), `${where}: unexpected feature name`);
  need(str(f.summary) && f.summary.length > 20, `${where}: summary missing`);
  for (const k of ['endpoints', 'businessRules', 'questions', 'mismatches', 'fixtures']) need(Array.isArray(f[k]), `${where}: ${k} must be an array`);
  for (const e of f.endpoints ?? []) {
    const w = `${where} ${e.key}`;
    need(str(e.key) && /^(GET|POST|PUT|PATCH|DELETE) \//.test(e.key), `${w}: bad key`);
    need(Number.isInteger(e.successStatus), `${w}: successStatus must be an integer`);
    for (const k of ['query', 'request', 'response', 'mapConflict']) need(str(e[k]), `${w}: ${k} must be a string ('' if nothing)`);
    need(typeof e.assumed === 'boolean', `${w}: assumed must be boolean`);
    need(Array.isArray(e.errors) && e.errors.every((x) => Number.isInteger(x.status) && str(x.code) && str(x.when)), `${w}: errors[] needs {status, code, when, ui?}`);
    seen.set(e.key, (seen.get(e.key) ?? 0) + 1);
  }
  for (const q of f.questions ?? [])
    need(Number.isInteger(q.n) && str(q.question) && str(q.proposedAnswer) && str(q.basis) && ['high', 'medium', 'low'].includes(q.confidence) && typeof q.needsUser === 'boolean', `${where}: question ${q.n} incomplete`);
  for (const m of f.mismatches ?? []) need(str(m.id) && str(m.summary) && str(m.backendImpact), `${where}: mismatch entry incomplete`);
}
if (globalMode) {
  for (const k of ['authFlow', 'permissions', 'listConventions', 'headersAndCors', 'mockInfra']) need(str(data[k]) && data[k].length > 200, `global: ${k} must be a detailed markdown string`);
  need(Array.isArray(data.errorCatalog) && data.errorCatalog.length > 5, 'global: errorCatalog must list every error code');
  for (const c of data.errorCatalog ?? []) need(str(c.code) && Number.isInteger(c.status) && Array.isArray(c.where) && str(c.meaning), `global: errorCatalog entry ${c.code} incomplete`);
}
const expected = fe.endpoints.filter((e) => features.includes(featureOf(e.file))).map((e) => e.key);
for (const k of expected) need(seen.get(k) === 1, `endpoint ${k}: appears ${seen.get(k) ?? 0} times (need exactly 1)`);
for (const k of seen.keys()) need(expected.includes(k), `endpoint ${k}: not a route of these features`);

if (problems.length) {
  console.error(`${problems.length} problem(s):\n  ${problems.slice(0, 60).join('\n  ')}`);
  process.exit(1);
}
console.log(`ok: ${data.features.length} features, ${expected.length} endpoints covered`);
