// ESLint config blocks for the layout rules of the backend that need no type information:
// module boundaries (decision 016), process.env only in src/config (decision 013), no wall clock outside
// src/common/clock.ts (decision 031), no console in src, and the unit tests in test/unit under the same three (decision 043).
// eslint.config.mjs spreads them; test/tooling/lint-rules.test.mjs lints code strings with the very same blocks.
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

const CLOCK_MESSAGE =
  'Read the time from the injected Clock (CLOCK, src/common/clock.ts), never from the wall clock: Date.now() and new Date() without arguments are allowed only in src/common/clock.ts (decision 031). Use performance.now() for elapsed-time measurements.';

/** `no-restricted-syntax` entries that catch every way of reading the wall clock: `Date.now`, `new Date()`, `new Date`. */
const CLOCK_SELECTORS = [
  // Date.now() and a reference to it (`const now = Date.now`)
  "MemberExpression[object.name='Date'][property.name='now']",
  "MemberExpression[object.name='Date'][property.value='now']",
  // globalThis.Date.now()
  "MemberExpression[object.property.name='Date'][property.name='now']",
  // new Date() / new Date: the current time; new Date(x) is a conversion and stays allowed
  "NewExpression[callee.name='Date'][arguments.length=0]",
  "NewExpression[callee.property.name='Date'][arguments.length=0]",
].map((selector) => ({ selector, message: CLOCK_MESSAGE }));

/** What the unit tests mirror: `test/unit/<path>` tests `src/<path>` (decision 043), under the same rules as the code. */
const CODE = ['src/**/*.ts', 'test/unit/**/*.ts'];
/** Where the environment may be read: the config and its unit tests. */
const CONFIG = ['src/config/**/*.ts', 'test/unit/config/**/*.ts'];
/** Where the wall clock may be read: the system clock and its unit test. */
const CLOCK = ['src/common/clock.ts', 'test/unit/common/clock.test.ts'];

const ALIAS_MESSAGE =
  'Import with a relative path inside src/: `@src/...` is for tests only, and the module boundary rule reads relative specifiers (decision 043).';

/**
 * Flat-config blocks for the structural rules. The module boundaries and the `@src` ban apply to `src/`; the environment,
 * wall clock and console rules apply to `src/` and to the unit tests that mirror it (`test/unit/`, decision 043).
 * Other tests and scripts may read the environment, the wall clock and print to the console.
 *
 * `no-restricted-syntax` is one rule: a later block replaces an earlier one for the same file, so each file gets exactly
 * one block that lists every selector that applies to it (`src/config` may read the clock, `src/common/clock.ts` the
 * environment never).
 */
export const structuralRules = [
  {
    name: 'gsm/module-boundaries',
    files: ['src/**/*.ts'],
    plugins: { gsm: gsmPlugin },
    rules: { 'gsm/module-boundaries': 'error' },
  },
  {
    name: 'gsm/no-src-alias-in-src',
    files: ['src/**/*.ts'],
    rules: {
      'no-restricted-imports': ['error', { patterns: [{ group: ['@src', '@src/*'], message: ALIAS_MESSAGE }] }],
    },
  },
  {
    name: 'gsm/no-process-env-no-wall-clock',
    files: CODE,
    ignores: [...CONFIG, ...CLOCK],
    rules: { 'no-restricted-syntax': ['error', ...ENV_SELECTORS, ...CLOCK_SELECTORS] },
  },
  {
    name: 'gsm/no-wall-clock-in-config',
    files: CONFIG,
    rules: { 'no-restricted-syntax': ['error', ...CLOCK_SELECTORS] },
  },
  {
    name: 'gsm/no-process-env-in-clock',
    files: CLOCK,
    rules: { 'no-restricted-syntax': ['error', ...ENV_SELECTORS] },
  },
  {
    name: 'gsm/no-console',
    files: CODE,
    rules: { 'no-console': 'error' },
  },
];
