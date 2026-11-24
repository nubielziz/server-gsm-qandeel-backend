// `bun scripts/accounts-merge-check.ts [--approve <file>]` and `bun scripts/accounts-merge-check.ts --rehearse <database> [--approve <file>]`:
// the check before the expand release of one account type (backend decision 064).
//
// Without arguments it runs the preflight block of the expand migration (phase 0, found in drizzle/ by its markers) against the database
// in a READ ONLY transaction and prints what would stop the migration: codes and ids, never an email. Nothing is written.
// With `--approve <file>` it reads the owner's approvals (JSON lines, ids only: {"clientId": 12, "customerId": 40, "action": "one_account"}:
// the merchant and the customer with a login that share an email become one account), writes them to the settings row
// accountsMerge.approvedPairs and runs the preflight with them in the same transaction: the row is committed only when no approved pair
// is refused (E1-E4, E6, E7). Findings that do not concern the approved pairs (E5 for a pair left out, G1-G8) are printed: the migration
// still stops on them until they are fixed. The runbook runs it from the release image (docs/OPERATIONS.md). Without arguments it also
// prints the approved pairs the settings row already holds, because the migration merges them.
// With `--rehearse <database>` it migrates a scratch copy on the same server instead (the rehearsal on a production copy and the restore
// test of the release): the database is named on the command line, the live one (of DATABASE_OWNER_URL or DATABASE_URL) is refused, the
// approvals of `--approve` are written to the copy only, and `scripts/db-migrate.ts` runs against the copy (a copy taken after the expand
// migration, for a later release, has nothing to approve and is migrated as it is). Leaving the option out runs the read-only check, so no
// single slip of the command migrates the live database.
//
// It imports only `pg` and Node built-ins (no src/**): the production image runs it through the `migrate` service without the rest of
// the configuration, and the image's verify stage imports it without running it (Dockerfile). A rehearsal starts scripts/db-migrate.ts as a
// process of its own, which reads the configuration of the service.
// Database: DATABASE_URL_TEST under NODE_ENV=test; otherwise DATABASE_OWNER_URL when set (the migrate service), else DATABASE_URL.
// Exit codes: 0 clean, or the approvals written, or the copy migrated; 1 an error (a bad file, no database, a refused or failed rehearsal);
// 2 findings (nothing written); 3 the expand migration has already run.
import { readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { Client } from 'pg';

/** The exit codes of the script. */
export const EXIT = { ok: 0, error: 1, findings: 2, applied: 3 } as const;

/** The settings row the preflight and the id map of the migration read the approved pairs from. */
export const APPROVALS_KEY = 'accountsMerge.approvedPairs';

/** The lines around the preflight block in the assembled expand migration. */
export const PREFLIGHT_MARKERS = {
  begin: '-- accounts-merge:preflight:begin',
  end: '-- accounts-merge:preflight:end',
} as const;

/** The end of the expand migration's file name, after its number. */
export const EXPAND_SUFFIX = '_accounts_expand.sql';

/** The migrations folder (drizzle/ at the repository root; the image copies it whole). */
export const DRIZZLE_DIR = resolve(import.meta.dir, '../drizzle');

/** The migration command a rehearsal runs against its scratch copy (the image copies it beside this script). */
export const MIGRATE_SCRIPT = resolve(import.meta.dir, 'db-migrate.ts');

/** The databases of the server itself, which a rehearsal never migrates. */
export const SERVER_DATABASES: readonly string[] = ['postgres', 'template0', 'template1'];

/** The codes whose findings refuse an approval: each one is about a pair in the approvals. */
export const REFUSING_CODES: readonly string[] = ['E1', 'E2', 'E3', 'E4', 'E6', 'E7'];

/** One approved pair, as the settings row holds it. */
export interface ApprovedPair {
  readonly clientId: number;
  readonly customerId: number;
  readonly action: 'one_account';
}

/** One finding of the preflight: its code and its text (the code and the ids). */
export interface Finding {
  readonly code: string;
  readonly text: string;
}

/** The part of a `pg` client the script uses (a test passes a fake). */
export interface SqlClient {
  query(text: string, values?: unknown[]): Promise<{ rows: Array<Record<string, unknown>> }>;
}

/** A file of approvals that cannot be used; the message names the line. */
export class ApprovalsError extends Error {
  override readonly name = 'ApprovalsError';
}

/**
 * The text of the expand migration.
 *
 * @param folder the migrations folder
 * @returns the file's text
 * @throws {Error} when no file, or more than one, ends with {@link EXPAND_SUFFIX}
 */
export function expandMigrationText(folder: string = DRIZZLE_DIR): string {
  const names = readdirSync(folder).filter((name) => name.endsWith(EXPAND_SUFFIX));
  if (names.length !== 1)
    throw new Error(`Expected one migration ending with ${EXPAND_SUFFIX}, found ${names.length}.`);
  return readFileSync(join(folder, names[0]!), 'utf8');
}

/**
 * The preflight block of the migration: the statement between the two preflight markers.
 *
 * @param text the migration's text
 * @returns the block (a DO statement)
 * @throws {Error} when the markers are missing, repeated or out of order, or hold no DO block
 */
export function preflightBlockOf(text: string): string {
  const lines = text.split('\n');
  const begins = lines.flatMap((line, index) => (line.trim() === PREFLIGHT_MARKERS.begin ? [index] : []));
  const ends = lines.flatMap((line, index) => (line.trim() === PREFLIGHT_MARKERS.end ? [index] : []));
  if (begins.length !== 1 || ends.length !== 1 || ends[0]! <= begins[0]!) {
    throw new Error('The expand migration does not hold exactly one preflight block between its markers.');
  }
  const block = lines
    .slice(begins[0]! + 1, ends[0])
    .join('\n')
    .trim();
  if (!/^DO \$\$/m.test(block)) throw new Error('The preflight block of the expand migration is not a DO block.');
  return block;
}

/**
 * Reads the owner's approvals: one JSON object per line with exactly `clientId`, `customerId` (positive whole numbers) and
 * `action` (`one_account`); blank lines are skipped; no merchant and no customer may appear twice.
 *
 * @param text the file's text
 * @returns the pairs, in file order
 * @throws {ApprovalsError} naming the first line that breaks a rule (never its content: the file holds ids only, but a mistyped line could
 *   hold anything)
 */
export function parseApprovals(text: string): ApprovedPair[] {
  const pairs: ApprovedPair[] = [];
  const clients = new Set<number>();
  const customers = new Set<number>();
  const lines = text.split(/\r?\n/);
  for (const [index, raw] of lines.entries()) {
    const line = raw.trim();
    if (line === '') continue;
    const number = index + 1;
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch {
      throw new ApprovalsError(`Line ${number} is not JSON.`);
    }
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      throw new ApprovalsError(`Line ${number} is not an object.`);
    }
    const entry = value as Record<string, unknown>;
    const keys = Object.keys(entry).sort();
    if (keys.join(',') !== 'action,clientId,customerId') {
      throw new ApprovalsError(`Line ${number} must hold exactly clientId, customerId and action.`);
    }
    const isId = (id: unknown): id is number => typeof id === 'number' && Number.isSafeInteger(id) && id > 0;
    if (!isId(entry.clientId) || !isId(entry.customerId)) {
      throw new ApprovalsError(`Line ${number}: clientId and customerId must be positive whole numbers.`);
    }
    if (entry.action !== 'one_account') throw new ApprovalsError(`Line ${number}: action must be "one_account".`);
    if (clients.has(entry.clientId))
      throw new ApprovalsError(`Line ${number}: merchant ${entry.clientId} is approved twice.`);
    if (customers.has(entry.customerId)) {
      throw new ApprovalsError(`Line ${number}: customer ${entry.customerId} is approved twice.`);
    }
    clients.add(entry.clientId);
    customers.add(entry.customerId);
    pairs.push({ clientId: entry.clientId, customerId: entry.customerId, action: 'one_account' });
  }
  if (pairs.length === 0) throw new ApprovalsError('The file holds no approval.');
  return pairs;
}

/**
 * The findings of a preflight stop, read from its message
 * (`accounts merge stopped, nothing changed: E5 client 3 customer 9; G3 orders 5 (2 findings)`).
 *
 * @param message the error message the block raised
 * @returns the findings it lists (at most 50: the block lists the first 50)
 */
export function findingsOf(message: string): Finding[] {
  const start = message.indexOf(': ');
  if (start < 0) return [];
  const body = message.slice(start + 2).replace(/ \(\d+ findings?\)\s*$/, '');
  return body
    .split('; ')
    .map((text) => text.trim())
    .filter((text) => text !== '')
    .map((text) => ({ code: text.split(' ')[0]!, text }));
}

/** Whether an error is the stop of the preflight block (and not a broken connection or a bug). */
function isPreflightStop(error: unknown): error is Error {
  const candidate = error as { code?: unknown; constraint?: unknown } | null;
  return error instanceof Error && candidate?.code === '23514' && candidate.constraint === 'accounts_merge_preflight';
}

/**
 * Whether the expand migration has already run on the database (its legacy id table exists).
 *
 * @param client a connected client
 * @returns true after the migration
 */
export async function expandApplied(client: SqlClient): Promise<boolean> {
  const { rows } = await client.query(`select to_regclass('public.account_legacy_ids') is not null as applied`);
  return rows[0]?.applied === true;
}

/** What one run of the preflight found. */
export interface PreflightResult {
  /** true when the block raised nothing */
  readonly clean: boolean;
  /** the message of the stop ('' when clean) */
  readonly message: string;
  readonly findings: readonly Finding[];
}

/**
 * Runs the preflight block in a READ ONLY transaction and rolls it back.
 *
 * @param client a connected client outside a transaction
 * @param block the block ({@link preflightBlockOf})
 * @returns clean, or the stop's message and findings
 * @throws {Error} any other database error
 */
export async function runPreflight(client: SqlClient, block: string): Promise<PreflightResult> {
  await client.query('BEGIN READ ONLY');
  try {
    await client.query(block);
    return { clean: true, message: '', findings: [] };
  } catch (error) {
    if (isPreflightStop(error)) return { clean: false, message: error.message, findings: findingsOf(error.message) };
    throw error;
  } finally {
    await client.query('ROLLBACK');
  }
}

/** What an approval run did. */
export interface ApprovalResult extends PreflightResult {
  /** true when the settings row was committed */
  readonly written: boolean;
  /** the findings that refused it (about an approved pair) */
  readonly refused: readonly Finding[];
}

/**
 * Writes the approvals and runs the preflight with them in one transaction; commits only when no approved pair is refused.
 *
 * Side effects: on success, inserts or replaces the settings row {@link APPROVALS_KEY}.
 *
 * @param client a connected client outside a transaction
 * @param block the preflight block
 * @param pairs the approved pairs ({@link parseApprovals})
 * @returns whether the row was written, and every finding
 * @throws {Error} any database error other than the preflight's stop (nothing is written)
 */
export async function approve(
  client: SqlClient,
  block: string,
  pairs: readonly ApprovedPair[],
): Promise<ApprovalResult> {
  await client.query('BEGIN');
  let committed = false;
  try {
    await client.query(
      `insert into settings (key, value) values ($1, $2::jsonb)
       on conflict (key) do update set value = excluded.value, updated_at = now()`,
      [APPROVALS_KEY, JSON.stringify(pairs)],
    );
    await client.query('SAVEPOINT accounts_merge_preflight');
    let result: PreflightResult = { clean: true, message: '', findings: [] };
    try {
      await client.query(block);
    } catch (error) {
      if (!isPreflightStop(error)) throw error;
      await client.query('ROLLBACK TO SAVEPOINT accounts_merge_preflight');
      result = { clean: false, message: error.message, findings: findingsOf(error.message) };
    }
    const refused = result.findings.filter((finding) => REFUSING_CODES.includes(finding.code));
    if (refused.length > 0) return { ...result, written: false, refused };
    await client.query('COMMIT');
    committed = true;
    return { ...result, written: true, refused: [] };
  } finally {
    if (!committed) await client.query('ROLLBACK');
  }
}

/**
 * The database the script connects to.
 *
 * @param env the environment
 * @returns the connection string
 * @throws {Error} when none is set
 */
export function databaseUrlOf(env: Readonly<Record<string, string | undefined>>): string {
  const url = env.NODE_ENV === 'test' ? env.DATABASE_URL_TEST : (env.DATABASE_OWNER_URL ?? env.DATABASE_URL);
  if (url === undefined || url === '') {
    throw new Error(
      env.NODE_ENV === 'test'
        ? 'Set DATABASE_URL_TEST.'
        : 'Set DATABASE_OWNER_URL or DATABASE_URL (the API environment).',
    );
  }
  return url;
}

/**
 * The name of the database a connection string names.
 *
 * @param url a Postgres connection string
 * @returns the name ('' when the string names none)
 * @throws {Error} when the string is not a URL
 */
function databaseNameOf(url: string): string {
  return decodeURIComponent(new URL(url).pathname.replace(/^\//, ''));
}

/** Where a rehearsal runs: the scratch copy, and the live database it is never allowed to be. */
export interface RehearsalTarget {
  /** the scratch copy's connection string: the live one's server, role and options with the copy's name */
  readonly url: string;
  readonly database: string;
  /** the name of the live database (the one {@link databaseUrlOf} connects to) */
  readonly live: string;
}

/**
 * The scratch copy a rehearsal migrates.
 *
 * Why: the rehearsal on a production copy runs days before the release, with the old API live, through the migrate service, whose
 * connection names the live database. The copy is named on the command line and checked here, so a missing or mistyped option can never
 * migrate the live database (docs/OPERATIONS.md, P7 and step 10).
 *
 * @param env the environment ({@link databaseUrlOf})
 * @param database the copy's name, as given after `--rehearse`
 * @returns the copy's connection string and the live database's name
 * @throws {Error} when the name is not lower-case letters, digits and "_", is the live database (of the connection the script would use,
 *   or of DATABASE_URL), or is a database of the server itself ({@link SERVER_DATABASES})
 */
export function rehearsalTarget(env: Readonly<Record<string, string | undefined>>, database: string): RehearsalTarget {
  if (!/^[a-z_][a-z0-9_]{0,62}$/.test(database)) {
    throw new Error(
      'A rehearsal names its scratch database in lower-case letters, digits and "_" (for example gsm_rehearsal).',
    );
  }
  const url = new URL(databaseUrlOf(env));
  const live = databaseNameOf(url.toString());
  const app = env.DATABASE_URL === undefined || env.DATABASE_URL === '' ? undefined : databaseNameOf(env.DATABASE_URL);
  if (database === live || database === app) {
    throw new Error(
      `Refused: ${database} is the live database. A rehearsal migrates a scratch copy only (for example gsm_rehearsal).`,
    );
  }
  if (SERVER_DATABASES.includes(database)) throw new Error(`Refused: ${database} is a database of the server itself.`);
  url.pathname = `/${database}`;
  return { url: url.toString(), database, live };
}

/**
 * The environment of the migration a rehearsal runs: the caller's, with the owner connection (and, under NODE_ENV=test, the test
 * connection that replaces it) moved to the scratch copy. DATABASE_URL stays: the grants step reads the application role from it and
 * applies the grants through the owner connection, so in the copy.
 *
 * @param env the caller's environment
 * @param target the copy ({@link rehearsalTarget})
 * @returns the child's environment
 */
export function rehearsalEnv(
  env: Readonly<Record<string, string | undefined>>,
  target: RehearsalTarget,
): Record<string, string | undefined> {
  return {
    ...env,
    DATABASE_OWNER_URL: target.url,
    ...(env.NODE_ENV === 'test' ? { DATABASE_URL_TEST: target.url } : {}),
  };
}

/**
 * The approved pairs the settings row holds now, as text (ids only).
 *
 * Why: the row outlives a migration that stopped, and the next migration merges what it holds; the read-only check says so, so an
 * approval meant for an earlier attempt is never reused unseen (docs/OPERATIONS.md, failure path A).
 *
 * @param client a connected client
 * @returns one phrase per entry, or null when there is no row
 */
export async function storedApprovals(client: SqlClient): Promise<string[] | null> {
  const { rows } = await client.query('select value from settings where key = $1', [APPROVALS_KEY]);
  if (rows.length === 0) return null;
  const value = rows[0]!.value;
  if (!Array.isArray(value)) return ['a value that is not a list (the migration stops on it: E6)'];
  return value.map((entry: unknown, index) => {
    const pair = entry as Partial<Record<'clientId' | 'customerId', unknown>> | null;
    return typeof pair?.clientId === 'number' && typeof pair.customerId === 'number'
      ? `merchant ${pair.clientId} with customer ${pair.customerId}`
      : `entry ${index + 1} of another shape (the migration stops on it: E6)`;
  });
}

/** Prints the approved pairs the settings row holds, when it holds any. */
async function printStoredApprovals(client: SqlClient): Promise<void> {
  const stored = await storedApprovals(client);
  if (stored === null) return;
  console.log(`The settings row ${APPROVALS_KEY} holds ${stored.length} approval(s); the migration merges them:`);
  for (const line of stored) console.log(`  ${line}`);
}

/** Prints the findings, one per line. */
function printFindings(findings: readonly Finding[], write: (line: string) => void): void {
  for (const finding of findings) write(`  ${finding.text}`);
}

/** What the command was asked to do. */
export type Mode =
  | { readonly kind: 'check' }
  | { readonly kind: 'approve'; readonly file: string }
  | { readonly kind: 'rehearse'; readonly database: string; readonly file?: string };

/**
 * Reads the arguments: none, `--approve <file>`, `--rehearse <database>` or `--rehearse <database> --approve <file>`.
 *
 * @param argv the arguments after the script name
 * @returns the mode, or null for any other arguments
 */
export function modeOf(argv: readonly string[]): Mode | null {
  if (argv.length === 0) return { kind: 'check' };
  if (argv.length === 2 && argv[0] === '--approve') return { kind: 'approve', file: argv[1]! };
  if (argv[0] !== '--rehearse') return null;
  if (argv.length === 2) return { kind: 'rehearse', database: argv[1]! };
  if (argv.length === 4 && argv[2] === '--approve') return { kind: 'rehearse', database: argv[1]!, file: argv[3]! };
  return null;
}

/** A client the command connects and ends. */
export interface CommandClient extends SqlClient {
  connect(): Promise<unknown>;
  end(): Promise<unknown>;
}

/** What the command reaches outside itself (a test passes fakes). */
export interface CommandDeps {
  /** a client on a connection string */
  readonly client: (url: string) => CommandClient;
  /** runs the migration command with an environment; resolves its exit code */
  readonly migrate: (env: Record<string, string | undefined>) => Promise<number>;
}

/** The real connection and the real migration command (`bun scripts/db-migrate.ts`, its output on this process's). */
export const DEFAULT_DEPS: CommandDeps = {
  client: (url) => {
    const client = new Client({ connectionString: url, connectionTimeoutMillis: 10_000 });
    client.on('error', () => undefined);
    return client;
  },
  migrate: async (env) => {
    const child = Bun.spawn([process.execPath, MIGRATE_SCRIPT], {
      env,
      stdin: 'inherit',
      stdout: 'inherit',
      stderr: 'inherit',
    });
    return await child.exited;
  },
};

const USAGE =
  'Usage: bun scripts/accounts-merge-check.ts [--approve <file>] | --rehearse <scratch database> [--approve <file>]';

/**
 * Writes the approvals in one transaction with the preflight, and prints what came of it.
 *
 * @returns {@link EXIT}.ok when the row was written, {@link EXIT}.findings when an approved pair refused it
 */
async function approveAndPrint(client: SqlClient, block: string, pairs: readonly ApprovedPair[]): Promise<number> {
  const result = await approve(client, block, pairs);
  if (!result.written) {
    console.error(`Nothing written: ${result.refused.length} finding(s) about the approved pairs.`);
    printFindings(result.findings, (line) => console.error(line));
    return EXIT.findings;
  }
  console.log(`Written: ${pairs.length} approved pair(s) in the settings row ${APPROVALS_KEY}.`);
  if (!result.clean) {
    console.log('The migration still stops on these findings until they are fixed:');
    printFindings(result.findings, (line) => console.log(line));
  }
  return EXIT.ok;
}

/** The check, or the approval, on the database of the configuration. */
async function checkOrApprove(
  client: SqlClient,
  block: string,
  pairs: readonly ApprovedPair[] | undefined,
): Promise<number> {
  if (await expandApplied(client)) {
    console.log('The expand migration has already run on this database: there is nothing to check.');
    return EXIT.applied;
  }
  if (pairs !== undefined) return approveAndPrint(client, block, pairs);
  await printStoredApprovals(client);
  const result = await runPreflight(client, block);
  if (result.clean) {
    console.log('Clean: the preflight of the expand migration finds nothing.');
    return EXIT.ok;
  }
  console.error(`The expand migration would stop: ${result.findings.length} finding(s).`);
  printFindings(result.findings, (line) => console.error(line));
  return EXIT.findings;
}

/**
 * Readies the scratch copy of a rehearsal: its approvals are written when there are any. A copy taken after the expand migration (the
 * rehearsal of a later release) has nothing to approve; its migration applies only what comes after.
 */
async function prepareCopy(
  client: SqlClient,
  block: string,
  pairs: readonly ApprovedPair[] | undefined,
): Promise<number> {
  if (await expandApplied(client)) {
    if (pairs !== undefined) {
      console.error('The expand migration has already run on this scratch database: there is nothing to approve.');
      return EXIT.applied;
    }
    console.log('The expand migration has already run on this scratch database: only the migrations after it apply.');
    return EXIT.ok;
  }
  if (pairs !== undefined) return approveAndPrint(client, block, pairs);
  await printStoredApprovals(client);
  return EXIT.ok;
}

/**
 * The command: parses the arguments, connects, and runs the check, the approval or the rehearsal.
 *
 * Side effects: `--approve` writes the settings row {@link APPROVALS_KEY} (of the copy, with `--rehearse`); `--rehearse` migrates the copy.
 *
 * @param argv the arguments after the script name
 * @param env the environment (the database variables)
 * @param folder the migrations folder
 * @param deps the connection and the migration command
 * @returns the exit code ({@link EXIT})
 */
export async function main(
  argv: readonly string[] = process.argv.slice(2),
  env: Readonly<Record<string, string | undefined>> = process.env,
  folder: string = DRIZZLE_DIR,
  deps: CommandDeps = DEFAULT_DEPS,
): Promise<number> {
  const mode = modeOf(argv);
  if (mode === null) {
    console.error(USAGE);
    return EXIT.error;
  }
  let block: string;
  let pairs: ApprovedPair[] | undefined;
  let url: string;
  let target: RehearsalTarget | undefined;
  try {
    block = preflightBlockOf(expandMigrationText(folder));
    const approvals = mode.kind === 'check' ? undefined : mode.file;
    if (approvals !== undefined) pairs = parseApprovals(readFileSync(approvals, 'utf8'));
    // The copy is checked before any connection: a refused name connects to nothing.
    if (mode.kind === 'rehearse') target = rehearsalTarget(env, mode.database);
    url = target?.url ?? databaseUrlOf(env);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return EXIT.error;
  }
  const client = deps.client(url);
  let code: number;
  try {
    await client.connect();
    code = await (target === undefined ? checkOrApprove(client, block, pairs) : prepareCopy(client, block, pairs));
  } catch (error) {
    console.error(`The check failed: ${error instanceof Error ? error.message : String(error)}`);
    return EXIT.error;
  } finally {
    await client.end().catch(() => undefined);
  }
  if (target === undefined || code !== EXIT.ok) return code;
  console.log(
    `Rehearsal: migrating the scratch database ${target.database}; the live database ${target.live} is not touched.`,
  );
  const migrated = await deps.migrate(rehearsalEnv(env, target));
  if (migrated !== 0) {
    console.error(
      `The rehearsal migration of ${target.database} failed (exit code ${migrated}, its output is above); ${target.live} was not touched.`,
    );
    return EXIT.error;
  }
  console.log(`Rehearsal done: ${target.database} is migrated. Run the verification queries against it, then drop it.`);
  return EXIT.ok;
}

if (import.meta.main) process.exit(await main());
