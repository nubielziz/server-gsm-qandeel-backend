// Loaders for the committed inputs of the contract tests (docs/contract/TESTS.md, "Inputs"): the route manifest, the
// frontend's endpoint shapes, what the extraction recorded (success statuses, error codes), the B-ids of MISMATCHES.md,
// the error catalog document and the harvested fixtures. Plain JSON in, typed data out; nothing here imports the app.
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { FrontendParam } from './compare-http';
import type { FrontendShape } from './normalize';

/** Repository root. */
export const ROOT = resolve(import.meta.dir, '..', '..', '..');
const CONTRACT = join(ROOT, 'docs', 'contract');
/** Folder of the harvested fixtures. */
export const FIXTURES_DIR = join(ROOT, 'test', 'contract', 'fixtures', 'frontend');

const readJson = <T>(file: string): T => JSON.parse(readFileSync(file, 'utf8')) as T;

/** One endpoint of `docs/route-manifest.json`. */
export interface ManifestEndpoint {
  readonly key: string;
  readonly kind: 'http' | 'dhru-action' | 'event' | 'supplier-call';
  readonly method: string;
  readonly path: string;
  readonly surface: string;
  readonly module: string | null;
}

/**
 * Reads the route manifest.
 *
 * @returns every endpoint of the map (HTTP routes, Dhru actions, supplier calls and outgoing events)
 */
export function loadManifest(): readonly ManifestEndpoint[] {
  return readJson<{ endpoints: ManifestEndpoint[] }>(join(ROOT, 'docs', 'route-manifest.json')).endpoints;
}

/** One frontend function tagged `@route`, as extracted into `docs/contract/frontend-endpoints.json`. */
export interface FrontendEndpoint {
  readonly key: string;
  readonly fn: string;
  readonly file: string;
  readonly line: number;
  readonly params: readonly FrontendParam[];
  readonly returnsText: string;
  readonly returns: FrontendShape | null;
}

/**
 * Reads the frontend's endpoint shapes.
 *
 * @returns the 269 functions of the console with their parameters and resolved return types
 */
export function loadFrontendEndpoints(): readonly FrontendEndpoint[] {
  return readJson<{ endpoints: FrontendEndpoint[] }>(join(CONTRACT, 'frontend-endpoints.json')).endpoints;
}

/** What the Phase 1 analysts recorded for one endpoint (`docs/contract/extraction/*.json`). */
interface ExtractedEndpoint {
  readonly key: string;
  readonly successStatus: number;
}

/** An error code the frontend's code or mocks reference (`errorCatalog` of the extraction). */
export interface FrontendErrorRef {
  readonly code: string;
  readonly status: number;
  /** `file:line` places in the frontend that mention the code. */
  readonly where: readonly string[];
}

/** The extraction files, loaded once. */
function extractionFiles(): { features: { endpoints: ExtractedEndpoint[] }[]; errorCatalog?: FrontendErrorRef[] }[] {
  const dir = join(CONTRACT, 'extraction');
  return readdirSync(dir)
    .filter((name) => name.endsWith('.json'))
    .sort()
    .map((name) => readJson(join(dir, name)));
}

/**
 * Reads the success status the frontend contract documents for each endpoint.
 *
 * Why: ALIGNMENT § 1 fixes one success status per endpoint (`successStatus` in the extraction); the console accepts
 * any 2xx, so the frontend's TypeScript alone cannot tell 200 from 201.
 *
 * @returns a map from `METHOD /path` to the documented status
 */
export function loadSuccessStatuses(): ReadonlyMap<string, number> {
  const statuses = new Map<string, number>();
  for (const file of extractionFiles()) {
    for (const feature of file.features)
      for (const endpoint of feature.endpoints) statuses.set(endpoint.key, endpoint.successStatus);
  }
  return statuses;
}

/**
 * Reads the error codes the frontend references.
 *
 * @returns one entry per code, from the `errorCatalog` of the extraction files
 */
export function loadFrontendErrorRefs(): readonly FrontendErrorRef[] {
  const refs = new Map<string, FrontendErrorRef>();
  for (const file of extractionFiles()) for (const ref of file.errorCatalog ?? []) refs.set(ref.code, ref);
  return [...refs.values()];
}

/** One row of the table in `docs/contract/error-codes.md`. */
export interface DocumentedError {
  readonly code: string;
  readonly status: number;
  /** The "Frontend" column: the console's code or mocks reference the code. */
  readonly frontend: boolean;
}

/**
 * Reads the error catalog document.
 *
 * @returns the rows of the code table in file order
 */
export function loadErrorCodesDocument(): readonly DocumentedError[] {
  const text = readFileSync(join(CONTRACT, 'error-codes.md'), 'utf8');
  const rows: DocumentedError[] = [];
  for (const line of text.split('\n')) {
    const cells = /^\| ([A-Z][A-Z0-9_]+) \| (\d{3}) \|(.*)\|\s*(yes)?\s*\|\s*$/.exec(line);
    if (cells) rows.push({ code: cells[1] as string, status: Number(cells[2]), frontend: cells[4] === 'yes' });
  }
  return rows;
}

/**
 * Reads the ids of the frontend/map mismatches.
 *
 * @returns the set of `B<n>` ids that exist in `docs/contract/MISMATCHES.md`
 */
export function loadMismatchIds(): ReadonlySet<string> {
  const text = readFileSync(join(CONTRACT, 'MISMATCHES.md'), 'utf8');
  return new Set([...text.matchAll(/^\| (B\d+) \|/gm)].map((match) => match[1] as string));
}

/**
 * The file name of a route's fixture: method, then the path without slashes and colons.
 *
 * Why: the harvest writes `GET_admin_staff_id.json` for `GET /admin/staff/:id`; the tests find the fixture of a route
 * by this name.
 *
 * @param key a manifest key such as `GET /admin/staff/:id`
 * @returns the fixture file name
 */
export function fixtureFileName(key: string): string {
  const [method = '', path = ''] = key.split(' ');
  const slug = path
    .replaceAll(':', '')
    .replaceAll(/[^A-Za-z0-9]+/g, '_')
    .replaceAll(/^_+|_+$/g, '');
  return `${method}_${slug}.json`;
}

/** A harvested response (`test/contract/fixtures/frontend/<METHOD>_<path>.json`). */
export interface Fixture {
  readonly file: string;
  readonly status: number;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: unknown;
}

/**
 * Reads the harvested fixtures.
 *
 * @returns every fixture file, sorted by name; empty when the harvest has not run
 */
export function loadFixtures(): readonly Fixture[] {
  if (!existsSync(FIXTURES_DIR)) return [];
  return readdirSync(FIXTURES_DIR)
    .filter((name) => name.endsWith('.json'))
    .sort()
    .map((file) => ({ file, ...readJson<Omit<Fixture, 'file'>>(join(FIXTURES_DIR, file)) }));
}
