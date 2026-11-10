// Pure comparisons between the built route contracts and the route manifest (decision 009, decision 035): the keys that must
// exist, method/path/surface, the anti-bot flag, and the access and permission of each row. No app import: the tests pass in a
// snapshot, and manifest-parity.test.ts passes hand-written rows.
import type { ManifestEndpoint } from './inputs';
import type { RouteSnapshot } from './snapshot';

/** The part of a route contract these comparisons read (a `RouteSnapshot` has more). */
export type ContractRow = Pick<
  RouteSnapshot,
  'key' | 'method' | 'path' | 'surface' | 'access' | 'permission' | 'turnstile'
>;

/**
 * Lists a symmetric difference as readable text, so a failure names the keys.
 *
 * @param label what the keys are (`http`, `dhru`, ...), shown in each line
 * @param actual the keys that exist
 * @param expected the keys that should exist
 * @returns one sorted line per key on one side only; empty when the sets are equal
 */
export function difference(label: string, actual: Iterable<string>, expected: Iterable<string>): string[] {
  const have = new Set(actual);
  const want = new Set(expected);
  return [
    ...[...have].filter((key) => !want.has(key)).map((key) => `${label}: ${key} is built but not expected`),
    ...[...want].filter((key) => !have.has(key)).map((key) => `${label}: ${key} is expected but not built`),
  ].sort();
}

/**
 * The manifest keys of one kind that must be built.
 *
 * @param manifest the manifest endpoints (the map's and the backend's additions)
 * @param kind `http`, `dhru-action`, `supplier-call` or `event`
 * @param pending the keys still owed (`test/contract/pending.ts`)
 * @returns the keys of that kind that are not pending
 */
export function expectedKeys(
  manifest: readonly ManifestEndpoint[],
  kind: string,
  pending: ReadonlySet<string>,
): string[] {
  return manifest.filter((row) => row.kind === kind && !pending.has(row.key)).map((row) => row.key);
}

const rowsByKey = (manifest: readonly ManifestEndpoint[]): Map<string, ManifestEndpoint> =>
  new Map(manifest.map((row) => [row.key, row]));

/**
 * Contracts whose method, path or surface differ from their manifest row.
 *
 * @param contracts the built route contracts
 * @param manifest the manifest endpoints
 * @returns one line per wrong contract; a contract without a row (the Dhru transport) is skipped
 */
export function rowMismatches(contracts: readonly ContractRow[], manifest: readonly ManifestEndpoint[]): string[] {
  const rows = rowsByKey(manifest);
  const wrong: string[] = [];
  for (const contract of contracts) {
    const row = rows.get(contract.key);
    if (row === undefined) continue;
    if (row.method !== contract.method || row.path !== contract.path || row.surface !== contract.surface)
      wrong.push(
        `${contract.key}: contract ${contract.method} ${contract.path} on ${contract.surface}, row ${row.method} ${row.path} on ${row.surface}`,
      );
  }
  return wrong;
}

/**
 * Contracts whose Turnstile flag differs from the one the row gives (decision 034).
 *
 * @param contracts the built route contracts
 * @param manifest the manifest endpoints
 * @returns one line per wrong contract
 */
export function turnstileMismatches(
  contracts: readonly ContractRow[],
  manifest: readonly ManifestEndpoint[],
): string[] {
  const rows = rowsByKey(manifest);
  const wrong: string[] = [];
  for (const contract of contracts) {
    const row = rows.get(contract.key);
    if (row !== undefined && (row.turnstile ?? false) !== (contract.turnstile ?? false))
      wrong.push(`${contract.key} (contract ${contract.turnstile ?? false}, row ${row.turnstile ?? false})`);
  }
  return wrong;
}

/** A contract that deviates from the map's access on purpose, tied to a B-entry. */
export interface AccessException {
  /** The access the contract has instead of the row's. */
  readonly access: string;
  /** The `B<n>` entry of MISMATCHES.md that explains it. */
  readonly mismatch: string;
  readonly reason: string;
}

/**
 * The contracts that differ from their row in access, on purpose.
 *
 * Why: the map says `public` for the second step of the sign-in with a one-time code, but the pre-2FA session of the first step
 * is mandatory, so the contract needs a session (MISMATCHES B1, B2, B125).
 */
export const ACCESS_EXCEPTIONS: Readonly<Record<string, AccessException>> = {
  'POST /admin/auth/2fa': {
    access: 'staff-session',
    mismatch: 'B1',
    reason: 'the map says public; the pre-2FA session of the sign-in is mandatory',
  },
  'POST /admin/auth/2fa/setup': {
    access: 'staff-session',
    mismatch: 'B2',
    reason: 'the map says public; the pre-2FA session of the sign-in is mandatory',
  },
  'POST /client/auth/2fa': {
    access: 'merchant-session',
    mismatch: 'B125',
    reason: 'the map says public; the pre-2FA session of the sign-in is mandatory',
  },
};

/** The permission word a CRUD endpoint gets under an `area:*` row (the console's `crudPermission` uses the same words). */
const CRUD_WORD: Readonly<Record<string, string>> = {
  list: 'read',
  show: 'read',
  create: 'create',
  update: 'update',
  delete: 'delete',
};

/** Whether the contract's permission is allowed by the row's permission; the second item says what was expected. */
function permissionFits(row: ManifestEndpoint, contract: ContractRow): readonly [boolean, string] {
  const have = contract.permission;
  const want = row.permission;
  if (want === null) return [have === null, 'none'];
  if (!want.endsWith(':*')) return [have === want, want];
  const area = want.slice(0, -1);
  const word = CRUD_WORD[row.op];
  if (word !== undefined) return [have === `${area}${word}`, `${area}${word}`];
  return [
    have === want || (have !== null && have.startsWith(area) && have.length > area.length),
    `${want} or one action of ${area.slice(0, -1)}`,
  ];
}

/**
 * Contracts whose access or permission differ from their manifest row (decision 035).
 *
 * Why: a contract with a weaker permission than its row would pass every other parity test. Rules: access equals the row's (or
 * the exception's for that key); a concrete permission is equal; `area:*` on a CRUD endpoint means `area:read|create|update|
 * delete` by operation; `area:*` on a single route allows `area:*` or one action of the same area; no permission stays none.
 *
 * @param contracts the built route contracts
 * @param manifest the manifest endpoints
 * @param exceptions contracts allowed to differ in access
 * @returns one line per wrong contract; a contract without a row is skipped
 */
export function accessMismatches(
  contracts: readonly ContractRow[],
  manifest: readonly ManifestEndpoint[],
  exceptions: Readonly<Record<string, AccessException>> = ACCESS_EXCEPTIONS,
): string[] {
  const rows = rowsByKey(manifest);
  const wrong: string[] = [];
  for (const contract of contracts) {
    const row = rows.get(contract.key);
    if (row === undefined) continue;
    const access = exceptions[contract.key]?.access ?? row.access;
    if (contract.access !== access) wrong.push(`${contract.key}: access ${contract.access}, the row says ${access}`);
    const [fits, expected] = permissionFits(row, contract);
    if (!fits)
      wrong.push(
        `${contract.key}: permission ${contract.permission ?? 'none'}, the row says ${row.permission ?? 'none'} (expected ${expected})`,
      );
  }
  return wrong;
}

/**
 * Exceptions that no longer apply.
 *
 * @param contracts the built route contracts
 * @param manifest the manifest endpoints
 * @param exceptions the exceptions to check
 * @returns one line per exception whose contract or row is gone, or whose contract now has the row's access
 */
export function staleAccessExceptions(
  contracts: readonly ContractRow[],
  manifest: readonly ManifestEndpoint[],
  exceptions: Readonly<Record<string, AccessException>> = ACCESS_EXCEPTIONS,
): string[] {
  const rows = rowsByKey(manifest);
  const built = new Map(contracts.map((contract) => [contract.key, contract]));
  const stale: string[] = [];
  for (const [key, exception] of Object.entries(exceptions)) {
    const contract = built.get(key);
    const row = rows.get(key);
    if (contract === undefined) stale.push(`${key}: no contract has this key any more`);
    else if (row === undefined) stale.push(`${key}: the manifest has no row with this key any more`);
    else if (contract.access === row.access)
      stale.push(`${key}: the contract has the access of its row (${exception.mismatch} no longer applies)`);
    else if (contract.access !== exception.access)
      stale.push(`${key}: the contract has access ${contract.access}, the exception says ${exception.access}`);
  }
  return stale;
}
