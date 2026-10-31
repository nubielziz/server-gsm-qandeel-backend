// ESLint config blocks for the layout rules of the backend that need no type information:
// module boundaries (decision 016), process.env only in src/config (decision 013) and no console in src.
// eslint.config.mjs spreads them; test/lint/lint-rules.test.mjs lints code strings with the very same blocks.
import { moduleBoundaries } from './module-boundaries.mjs';

/** Local ESLint plugin holding the project's own rules. */
export const gsmPlugin = { meta: { name: 'gsm' }, rules: { 'module-boundaries': moduleBoundaries } };

const ENV_MESSAGE =
  'Read settings from the typed AppConfig (APP_CONFIG), never from the process environment: only src/config parses it (decision 013).';

/** `no-restricted-syntax` entries that catch every way of reading the environment under Bun and Node. */
const ENV_SELECTORS = [
  // process.env.X, process['env']
  "MemberExpression[object.name='process'][property.name='env']",
  "MemberExpression[object.name='process'][property.value='env']",
  // globalThis.process.env
  "MemberExpression[object.property.name='process'][property.name='env']",
  // Bun.env.X and import.meta.env.X
  "MemberExpression[object.name='Bun'][property.name='env']",
  "MemberExpression[object.type='MetaProperty'][property.name='env']",
  // const { env } = process
  "VariableDeclarator[init.name='process'] > ObjectPattern > Property[key.name='env']",
  // import { env } from 'node:process'
  "ImportDeclaration[source.value=/^(node:)?process$/] > ImportSpecifier[imported.name='env']",
].map((selector) => ({ selector, message: ENV_MESSAGE }));

/**
 * Flat-config blocks for the structural rules; all of them apply to `src/` only.
 * Tests and scripts may read the environment and print to the console.
 */
export const structuralRules = [
  {
    name: 'gsm/module-boundaries',
    files: ['src/**/*.ts'],
    plugins: { gsm: gsmPlugin },
    rules: { 'gsm/module-boundaries': 'error' },
  },
  {
    name: 'gsm/no-process-env',
    files: ['src/**/*.ts'],
    ignores: ['src/config/**'],
    rules: { 'no-restricted-syntax': ['error', ...ENV_SELECTORS] },
  },
  {
    name: 'gsm/no-console',
    files: ['src/**/*.ts'],
    rules: { 'no-console': 'error' },
  },
];
