// ESLint rule `gsm/module-boundaries` (decision 016): the module layout of src/ is enforced at lint time.
// Written as plain ESM so ESLint loads it under Bun and Node alike; tested in test/lint/lint-rules.test.mjs.
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Paths are judged relative to the repository root (two levels above this file), whatever ESLint's working directory.
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

/**
 * Where a repo-relative file sits in the layout of decision 016.
 *
 * @typedef {{ zone: 'module', id: string, inner: string | undefined }
 *   | { zone: 'common' | 'infra' | 'other' | 'outside' }} Location
 */

const MODULE_PATH = /^src\/modules(?:\/([^/]+)(?:\/(.*))?)?$/;
// `db/schema` or `db/schema.ts` of a module: the Drizzle schema file the two exceptions below allow.
const SCHEMA_FILE = /^db\/schema(?:\.[cm]?[jt]s)?$/;
// What `import ... from '../orders'` resolves to: the module's public API.
const INDEX_FILE = /^index(?:\.[cm]?[jt]s)?$/;
const INFRA_SCHEMA_INDEX = 'src/infra/db/schema.ts';

/**
 * Classifies a repo-relative POSIX path.
 *
 * @param {string} rel path relative to the repository root
 * @returns {Location} the zone of the path (`outside` for anything not under `src/`)
 */
export function locate(rel) {
  if (rel.startsWith('../') || path.isAbsolute(rel) || !rel.startsWith('src/')) return { zone: 'outside' };
  const mod = MODULE_PATH.exec(rel);
  if (mod) return { zone: 'module', id: mod[1] ?? '', inner: mod[2] };
  if (rel === 'src/common' || rel.startsWith('src/common/')) return { zone: 'common' };
  if (rel === 'src/infra' || rel.startsWith('src/infra/')) return { zone: 'infra' };
  return { zone: 'other' };
}

/**
 * Judges one import from `file` to `target`.
 *
 * @param {string} file importing file, repo-relative
 * @param {string} target resolved import target, repo-relative, without checking that it exists
 * @returns {'noModuleImport' | 'deepImport' | undefined} the message id of the violation, or `undefined` when allowed
 */
export function judgeImport(file, target) {
  const to = locate(target);
  if (to.zone !== 'module') return undefined;
  const from = locate(file);
  if (from.zone === 'outside') return undefined;
  if (from.zone === 'module' && from.id === to.id) return undefined;

  // Exception 1 (decisions 016, 027): a module's db/schema.ts holds foreign keys to other modules' tables.
  const schemaToSchema =
    to.inner !== undefined &&
    SCHEMA_FILE.test(to.inner) &&
    from.zone === 'module' &&
    from.inner !== undefined &&
    SCHEMA_FILE.test(from.inner);
  // Exception 2: src/infra/db/schema.ts re-exports every module's db/schema.ts for Drizzle.
  const infraSchemaIndex = file === INFRA_SCHEMA_INDEX && to.inner !== undefined && SCHEMA_FILE.test(to.inner);
  if (schemaToSchema || infraSchemaIndex) return undefined;

  if (from.zone === 'common' || from.zone === 'infra') return 'noModuleImport';
  const viaIndex = to.inner === undefined || INDEX_FILE.test(to.inner);
  return viaIndex ? undefined : 'deepImport';
}

/** The rule: every relative import in src/ is judged by {@link judgeImport}. */
export const moduleBoundaries = {
  meta: {
    type: 'problem',
    docs: {
      description:
        'Modules import each other only through src/modules/<id>/index.ts; src/common and src/infra never import src/modules.',
    },
    schema: [],
    messages: {
      deepImport:
        'Import another module only through its public API (src/modules/<id>/index.ts), not "{{specifier}}" (decision 016).',
      noModuleImport:
        'src/common and src/infra never import from src/modules ("{{specifier}}"): modules register with infrastructure, not the other way round (decision 016).',
    },
  },
  create(context) {
    const toRepoPath = (absolute) => path.relative(REPO_ROOT, absolute).split(path.sep).join('/');
    const file = toRepoPath(context.filename);
    if (locate(file).zone === 'outside') return {};

    /** Judges one specifier; only relative ones can point into src/modules (the project has no path aliases). */
    const check = (node, specifier) => {
      if (typeof specifier !== 'string' || !specifier.startsWith('.')) return;
      const target = toRepoPath(path.resolve(path.dirname(context.filename), specifier));
      const messageId = judgeImport(file, target);
      if (messageId) context.report({ node, messageId, data: { specifier } });
    };
    return {
      ImportDeclaration: (node) => check(node.source, node.source.value),
      ExportAllDeclaration: (node) => check(node.source, node.source.value),
      ExportNamedDeclaration: (node) => {
        if (node.source) check(node.source, node.source.value);
      },
      ImportExpression: (node) => {
        if (node.source.type === 'Literal') check(node.source, node.source.value);
      },
      // `type X = import('../orders/internal').X` (typescript-eslint 8.72+ names the string `source`)
      TSImportType: (node) => {
        const source = node.source ?? node.argument?.literal;
        if (source?.type === 'Literal') check(source, source.value);
      },
    };
  },
};
