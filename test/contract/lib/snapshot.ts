// What the contract tests know about the running application: its route contracts, events and Fastify route table,
// read once per test run from a child process (see dump-app.ts for why a child).
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { JsonSchema } from '../../../src/common/contract';

/**
 * One route contract as plain JSON (the registry's `RouteContract` with its zod schemas turned into JSON Schema).
 *
 * Why: the comparator and the fixture validator work on JSON Schema; a plain snapshot keeps them free of zod and Nest.
 */
export interface RouteSnapshot {
  readonly key: string;
  readonly method: string;
  readonly path: string;
  readonly pathParams: readonly string[];
  readonly surface: string;
  readonly access: string;
  readonly permission: string | null;
  readonly errors: readonly string[];
  /** True for a route behind the anti-bot check (decision 034). */
  readonly turnstile?: boolean;
  readonly success: {
    readonly status: number;
    readonly alsoStatuses: readonly number[];
    readonly contentType?: string;
    readonly list: boolean;
    /** Output side; of ONE row for a list route. */
    readonly schema?: JsonSchema;
  };
  /** Input side. */
  readonly params?: JsonSchema;
  readonly query?: JsonSchema;
  readonly queryIsList: boolean;
  readonly body?: JsonSchema;
}

/**
 * The application as the contract tests see it.
 *
 * Why: route parity needs the registries and the router, shape parity needs the schemas (decision 009).
 */
export interface AppSnapshot {
  readonly contracts: readonly RouteSnapshot[];
  readonly events: readonly { readonly key: string; readonly name: string; readonly payload: JsonSchema }[];
  /** `DHRU <action>` of every Dhru action the application defines (the registry of `defineDhruAction`). */
  readonly dhruActions: readonly string[];
  /** `SUPPLIER <action>[+<action>bulk]` of every call the application makes to a supplier (the registry of `defineSupplierCall`). */
  readonly supplierCalls: readonly string[];
  /** `METHOD /path` of every route Fastify serves (no HEAD, no OPTIONS). */
  readonly served: readonly string[];
  /** Routes the application serves without a contract (`DOCUMENTATION_ROUTES`). */
  readonly documentationRoutes: readonly string[];
}

const ROOT = resolve(import.meta.dir, '..', '..', '..');
let cached: Promise<AppSnapshot> | undefined;

/**
 * Boots the application in a fresh Bun process and returns its snapshot (once per test process).
 *
 * Why: see dump-app.ts. The child needs the test database like every integration test (`docker compose up -d`).
 *
 * @returns the contracts, events and served routes of the application
 * @throws {Error} when the child fails (its output is in the message)
 */
export function appSnapshot(): Promise<AppSnapshot> {
  cached ??= (async () => {
    const dir = mkdtempSync(join(tmpdir(), 'gsm-contract-'));
    const file = join(dir, 'snapshot.json');
    try {
      const child = Bun.spawn([process.execPath, 'test/contract/lib/dump-app.ts', file], {
        cwd: ROOT,
        env: { ...process.env, NODE_ENV: 'test' },
        stdout: 'pipe',
        stderr: 'pipe',
      });
      const [stdout, stderr, code] = await Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
        child.exited,
      ]);
      if (code !== 0) throw new Error(`The app snapshot failed (exit ${code}).\n${stdout}\n${stderr}`);
      return JSON.parse(readFileSync(file, 'utf8')) as AppSnapshot;
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  })();
  return cached;
}
