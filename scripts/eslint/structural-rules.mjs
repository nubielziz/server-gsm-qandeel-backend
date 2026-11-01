// ESLint config blocks for the layout rules of the backend that need no type information:
// module boundaries (decision 016), process.env only in src/config (decision 013), no wall clock outside
// src/common/clock.ts (decision 031) and no console in src.
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

/**
 * Flat-config blocks for the structural rules; all of them apply to `src/` only.
 * Tests and scripts may read the environment, the wall clock and print to the console.
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
    name: 'gsm/no-process-env-no-wall-clock',
    files: ['src/**/*.ts'],
    ignores: ['src/config/**', 'src/common/clock.ts'],
    rules: { 'no-restricted-syntax': ['error', ...ENV_SELECTORS, ...CLOCK_SELECTORS] },
  },
  {
    name: 'gsm/no-wall-clock-in-config',
    files: ['src/config/**/*.ts'],
    rules: { 'no-restricted-syntax': ['error', ...CLOCK_SELECTORS] },
  },
  {
    name: 'gsm/no-process-env-in-clock',
    files: ['src/common/clock.ts'],
    rules: { 'no-restricted-syntax': ['error', ...ENV_SELECTORS] },
  },
  {
    name: 'gsm/no-console',
    files: ['src/**/*.ts'],
    rules: { 'no-console': 'error' },
  },
];
