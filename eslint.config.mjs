// ESLint flat config of the backend (P2.2; decisions 013 and 016). `bun run lint` runs it with the Bun runtime.
// Layers, general to specific: ignores, JS recommended, type-aware TypeScript, JSDoc on exports, the structural rules
// (module boundaries, process.env, console), plain .mjs files, test relaxations, and Prettier last.
import js from '@eslint/js';
import comments from '@eslint-community/eslint-plugin-eslint-comments/configs';
import { defineConfig, globalIgnores } from 'eslint/config';
import prettier from 'eslint-config-prettier';
import jsdoc from 'eslint-plugin-jsdoc';
import globals from 'globals';
import tseslint from 'typescript-eslint';
import { structuralRules } from './scripts/eslint/structural-rules.mjs';

/** TypeScript files that tsconfig.json covers: linted with type information. */
const TYPED_FILES = ['src/**/*.ts', 'test/**/*.ts', 'scripts/**/*.ts', '*.ts'];
/** Tests walk untyped JSON (HTTP bodies, OpenAPI documents), so the `no-unsafe-*` family is off for them. */
const TEST_FILES = ['test/**/*.ts', 'src/**/*.spec.ts'];

/**
 * Declarations the JSDoc rules treat as public API: everything `export`ed plus the public methods of exported classes.
 * Constructors are left out: the class comment says what the class is.
 */
const EXPORTED = [
  // `export function|class|interface|type|enum|const ...`: the doc block sits before `export`, so the selector
  // targets the export statement itself. Re-exports (`export { a } from`) have no `declaration` and need none.
  'ExportNamedDeclaration[declaration]',
  'ExportDefaultDeclaration',
  'ExportNamedDeclaration > ClassDeclaration > ClassBody > MethodDefinition[kind="method"][accessibility!=/^(private|protected)$/]',
];
/** The function-like nodes behind {@link EXPORTED}: @param and @returns are required there, not on private helpers. */
const EXPORTED_FUNCTIONS = [
  'ExportNamedDeclaration > FunctionDeclaration',
  'ExportDefaultDeclaration > FunctionDeclaration',
  'ExportNamedDeclaration > VariableDeclaration > VariableDeclarator > ArrowFunctionExpression',
  'ExportNamedDeclaration > ClassDeclaration > ClassBody > MethodDefinition[kind="method"][accessibility!=/^(private|protected)$/] > FunctionExpression',
];

export default defineConfig(
  globalIgnores([
    'node_modules/',
    // The API design map and the static demo of the frontend (symlink, read-only input).
    'reference/',
    'coverage/',
    'dist/',
    // Generated SQL migrations and the committed OpenAPI/contract documents are data, not code.
    'drizzle/',
    'docs/',
    // The Phase 0 Bun compatibility spike is retired by P2.4 and was never held to these rules.
    'spike/',
  ]),

  {
    name: 'gsm/linter-options',
    linterOptions: { reportUnusedDisableDirectives: 'error' },
  },

  js.configs.recommended,

  // --- TypeScript with type information --------------------------------------------------------------------------
  {
    name: 'gsm/typescript',
    files: TYPED_FILES,
    extends: [tseslint.configs.recommendedTypeChecked],
    languageOptions: {
      parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname },
    },
    rules: {
      // A pragmatic strict set on top of recommended-type-checked. `no-explicit-any` stays an error: where `any` is
      // unavoidable, disable the line with a reason (`// eslint-disable-next-line ... -- why`).
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/no-misused-promises': 'error',
      // AlternateResponse is thrown on purpose: a non-error answer with another status (GET /health?strict=1). It is
      // not an Error subclass so that no stack is captured for a normal reply.
      '@typescript-eslint/only-throw-error': [
        'error',
        { allow: [{ from: 'file', name: 'AlternateResponse', path: 'src/common/errors/alternate-response.ts' }] },
      ],
      '@typescript-eslint/switch-exhaustiveness-check': 'error',
      '@typescript-eslint/no-deprecated': 'error',
      '@typescript-eslint/return-await': ['error', 'error-handling-correctness-only'],
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_', ignoreRestSiblings: true },
      ],
      // `consistent-type-imports` stays off on purpose: Nest reads constructor parameter types as values for DI, so an
      // `import type` of an injected class (or an auto-fix to one) breaks the app under Bun.
      '@typescript-eslint/consistent-type-imports': 'off',
      eqeqeq: ['error', 'always', { null: 'ignore' }],
    },
  },

  // --- Directive comments: every eslint-disable says why, and none is left unused ---------------------------------
  comments.recommended,
  {
    name: 'gsm/eslint-comments',
    rules: {
      '@eslint-community/eslint-comments/require-description': ['error', { ignore: ['eslint-enable'] }],
      '@eslint-community/eslint-comments/disable-enable-pair': ['error', { allowWholeFile: true }],
    },
  },

  // --- JSDoc: every export is documented, with a description -----------------------------------------------------
  {
    name: 'gsm/jsdoc',
    files: ['src/**/*.ts'],
    ignores: ['src/**/*.spec.ts'],
    plugins: { jsdoc },
    settings: { jsdoc: { mode: 'typescript' } },
    rules: {
      'jsdoc/require-jsdoc': [
        'error',
        {
          publicOnly: false,
          require: {
            FunctionDeclaration: false,
            ClassDeclaration: false,
            MethodDefinition: false,
            ArrowFunctionExpression: false,
            FunctionExpression: false,
          },
          contexts: EXPORTED,
          checkConstructors: false,
          enableFixer: false,
        },
      ],
      'jsdoc/require-description': ['error', { contexts: EXPORTED, descriptionStyle: 'body' }],
      // @param / @returns on exported functions and public methods (the repo's TSDoc convention,
      // docs/briefs/_common.md).
      'jsdoc/require-param': [
        'error',
        { contexts: EXPORTED_FUNCTIONS, checkConstructors: false, checkDestructured: false },
      ],
      'jsdoc/require-param-description': 'error',
      'jsdoc/check-param-names': ['error', { checkDestructured: false }],
      'jsdoc/require-returns': ['error', { contexts: EXPORTED_FUNCTIONS, checkGetters: false }],
      'jsdoc/require-returns-description': 'error',
      // Types come from TypeScript, not from the comment. `@route` is the project's own tag for controllers.
      'jsdoc/no-types': 'error',
      'jsdoc/check-tag-names': ['error', { definedTags: ['route'] }],
      'jsdoc/check-alignment': 'error',
      'jsdoc/check-access': 'error',
      'jsdoc/empty-tags': 'error',
      'jsdoc/multiline-blocks': 'error',
      'jsdoc/no-multi-asterisks': 'error',
    },
  },

  // --- Layout rules: module boundaries, process.env only in src/config, no console in src -------------------------
  ...structuralRules,

  // --- Plain ESM scripts and this config (no type information) ---------------------------------------------------
  {
    name: 'gsm/scripts',
    files: ['**/*.mjs', '**/*.js'],
    languageOptions: { globals: { ...globals.node, Bun: 'readonly' } },
    rules: { eqeqeq: ['error', 'always', { null: 'ignore' }] },
  },

  // --- Tests -------------------------------------------------------------------------------------------------------
  {
    name: 'gsm/tests',
    files: TEST_FILES,
    rules: {
      '@typescript-eslint/no-unsafe-assignment': 'off',
      '@typescript-eslint/no-unsafe-member-access': 'off',
      '@typescript-eslint/no-unsafe-argument': 'off',
      '@typescript-eslint/no-unsafe-call': 'off',
      '@typescript-eslint/no-unsafe-return': 'off',
      // `expect(service.method)` and similar read a method without calling it.
      '@typescript-eslint/unbound-method': 'off',
    },
  },

  // Last: switches off every rule that would fight Prettier's formatting.
  prettier,
);
