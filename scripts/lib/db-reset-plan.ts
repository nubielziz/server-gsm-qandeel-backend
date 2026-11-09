// The arguments and the safety guards of `bun run db:reset` (P4b), pure so unit tests prove every refusal without a database
// (the terminal, if any, is a parameter).
// The effects (drop, migrate, flush, empty the bucket) are in db-reset-steps.ts; the command is scripts/db-reset.ts.
import type { AppConfig } from '../../src/config';
import { type OwnerInput, type SetupArgs, checkOwnerInput, parseSetupArgs } from '../first-run';

/**
 * A reset the guards refuse, or a command line that makes no sense.
 *
 * Why: the command prints the message and exits with code 1 before anything is changed.
 */
export class ResetRefusedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ResetRefusedError';
  }
}

/** The usage text of `bun run db:reset`. */
export const RESET_USAGE = [
  'Usage: bun run db:reset [--seed | --setup [--email <address> --name "<full name>" [--password-stdin]]]',
  '',
  '  Development only. Drops and recreates the database of DATABASE_URL, runs the migrations, empties the queue Redis and the',
  '  cache Redis databases of the configuration and the files bucket, then does one of:',
  '',
  '  (nothing)  leave the new database empty (run `bun run setup` or `bun run db:seed` yourself)',
  '  --seed     load the demo data (`bun run db:seed`)',
  '  --setup    run the first run (`bun run setup`): in a terminal it asks for the first admin account (email, full name,',
  '             password). With --email and --name it creates the account without asking (a temporary password is printed',
  '             once; --password-stdin reads the password from standard input instead). Without a terminal it needs',
  '             --email and --name, and is refused before anything is dropped when they are missing.',
  '',
  '  Refused under NODE_ENV=production or a production configuration, for the test databases, and when the database, the',
  '  Redis servers or the S3 endpoint are not on this machine. Stop the API and the worker first and start them again after.',
].join('\n');

/** What `parseResetArgs` found on the command line. */
export interface ResetArgs {
  readonly seed: boolean;
  readonly setup: boolean;
  readonly email?: string;
  readonly name?: string;
  /** `--password-stdin`: the first admin's password comes from standard input. */
  readonly passwordStdin: boolean;
  readonly help: boolean;
}

/**
 * Reads the flags of `db:reset`: `--seed`, `--setup`, `--email`, `--name`, `--password-stdin` and `--help`.
 *
 * Why: the three outcomes (empty, demo data, first run) are mutually exclusive, and the first admin's details belong only to the
 * first run. Bad input must be found before the database is dropped, never after.
 *
 * @param argv the arguments after the script name
 * @returns the flags
 * @throws {ResetRefusedError} for an unknown or repeated option, `--seed` together with `--setup`, `--email`, `--name` or
 *   `--password-stdin` without `--setup`, or only one of `--email` and `--name`
 */
export function parseResetArgs(argv: readonly string[]): ResetArgs {
  const own = new Set(['--seed', '--setup']);
  // Like the options of `setup`, a repeated flag is a mistake to point out, not to accept silently.
  for (const flag of own) {
    if (argv.filter((arg) => arg === flag).length > 1) throw new ResetRefusedError(`${flag} was given twice.`);
  }
  const seed = argv.includes('--seed');
  const setup = argv.includes('--setup');
  let parsed: SetupArgs;
  try {
    parsed = parseSetupArgs(
      argv.filter((arg) => !own.has(arg)),
      'db:reset',
    );
  } catch (error) {
    throw new ResetRefusedError(error instanceof Error ? error.message : String(error));
  }
  const { email, name, passwordStdin, help } = parsed;
  const args: ResetArgs = {
    seed,
    setup,
    passwordStdin,
    help,
    ...(email === undefined ? {} : { email }),
    ...(name === undefined ? {} : { name }),
  };
  if (help) return args;
  if (seed && setup) throw new ResetRefusedError('Choose --seed or --setup, not both.');
  if (!setup && (email !== undefined || name !== undefined || passwordStdin)) {
    throw new ResetRefusedError('--email, --name and --password-stdin belong to --setup.');
  }
  if (setup && (email === undefined) !== (name === undefined)) {
    throw new ResetRefusedError(
      'Give both --email and --name to create the first admin, or neither (you are then asked).',
    );
  }
  return args;
}

/** How `--setup` will make the first admin. */
export interface ResetFirstRun {
  /** The first admin from `--email`/`--name` (cleaned and checked), or `undefined` when the person is asked. */
  readonly owner: OwnerInput | undefined;
  /** True when the questions are asked (a terminal, and no owner on the command line). */
  readonly interactive: boolean;
}

/**
 * Decides how `--setup` makes the first admin, and refuses what cannot work, before the database is dropped.
 *
 * Why: the questions need a person at a terminal. Asking only after the drop would leave an emptied database behind a command that
 * could never finish, so a missing terminal without `--email` and `--name` is refused up front. The email, the name and a password
 * read from standard input are checked with the staff rules for the same reason.
 *
 * @param args the parsed flags
 * @param options whether standard input and output are both terminals, and the password read from standard input, if any
 * @returns how the first run goes, or `undefined` without `--setup`
 * @throws {ResetRefusedError} when the email, the name or the password is not acceptable, or there is neither a terminal nor an owner
 */
export function firstRunOfResetArgs(
  args: ResetArgs,
  options: { readonly terminal: boolean; readonly password?: string | undefined },
): ResetFirstRun | undefined {
  if (!args.setup) return undefined;
  if (args.passwordStdin && options.password === undefined) {
    // The command reads standard input before it calls this; a missing password must never turn into a generated one silently.
    throw new ResetRefusedError('--password-stdin: no password was read from standard input.');
  }
  let owner: OwnerInput | undefined;
  try {
    owner = checkOwnerInput({ email: args.email, name: args.name, password: options.password });
  } catch (error) {
    throw new ResetRefusedError(error instanceof Error ? error.message : String(error));
  }
  if (owner) return { owner, interactive: false };
  if (!options.terminal) {
    throw new ResetRefusedError(
      '--setup needs a terminal to ask for the first admin, or pass --email and --name. Nothing was changed.',
    );
  }
  return { owner: undefined, interactive: true };
}

/**
 * Refuses `NODE_ENV=production` from the raw variable, before the configuration is even validated.
 *
 * Why: a production environment must be refused even when its configuration is incomplete (the same first check as the seed).
 *
 * @param rawNodeEnv `process.env.NODE_ENV`
 * @throws {ResetRefusedError} for `production`
 */
export function refuseProductionEnv(rawNodeEnv: string | undefined): void {
  if (rawNodeEnv === 'production') {
    throw new ResetRefusedError('db:reset is for development only and refuses NODE_ENV=production.');
  }
}

/** Where a reset works: the database it recreates, the Redis databases it empties and the bucket it clears. */
export interface ResetTarget {
  readonly databaseName: string;
  /** The connection string of the database to recreate. */
  readonly databaseUrl: string;
  /** The same server's maintenance database `postgres`, which can drop and create other databases. */
  readonly adminUrl: string;
  /** The queue and cache Redis databases of the configuration. */
  readonly redis: ReadonlyArray<{ readonly role: 'queue' | 'cache'; readonly url: string }>;
  readonly bucket: {
    readonly name: string;
    readonly endpoint: string;
    readonly region: string;
    readonly accessKeyId: string;
    readonly secretAccessKey: string;
    readonly forcePathStyle: boolean;
  };
}

/**
 * Tells whether a host name is this machine.
 *
 * Why: the reset destroys data, so it only runs against servers on this machine: a shared or production server is never a
 * target, whatever the configuration says.
 *
 * @param host a host name from a URL (`localhost`, `127.0.0.1`, `[::1]`)
 * @returns true for `localhost`, any `127.x.x.x` address and the IPv6 loopback
 */
export function isLocalHost(host: string): boolean {
  const name = host.toLowerCase();
  return name === 'localhost' || name === '[::1]' || name === '::1' || /^127(?:\.\d{1,3}){3}$/.test(name);
}

/** Names a Postgres URL may not point at: the server's own databases. */
const SYSTEM_DATABASES = new Set(['postgres', 'template0', 'template1']);
/** A database name the reset may quote into SQL without escaping: letters, digits and underscores only. */
const SAFE_IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;

function parsed(url: string, what: string): URL {
  try {
    return new URL(url);
  } catch {
    throw new ResetRefusedError(`${what} is not a valid URL.`);
  }
}

function requireLocal(what: string, host: string): void {
  if (!isLocalHost(host)) {
    throw new ResetRefusedError(
      `db:reset only works on this machine, but ${what} is on "${host}". Nothing was changed.`,
    );
  }
}

/**
 * Judges the configuration and names what the reset would touch.
 *
 * Why: the reset drops a database and empties Redis and a bucket, so every doubt is a refusal: a production configuration, the
 * test databases (they belong to the tests), a database that is not an ordinary one on this machine, Redis or S3 servers that
 * are not on this machine.
 *
 * @param config the loaded configuration (`NODE_ENV` development)
 * @returns the target of the reset
 * @throws {ResetRefusedError} for a production configuration, `NODE_ENV=test`, a database name that ends in `_test`, is a server
 *   database or is not a plain identifier, a Postgres, Redis or S3 host that is not local, or an S3 endpoint left to the AWS default
 */
export function planReset(config: AppConfig): ResetTarget {
  if (config.isProduction) {
    throw new ResetRefusedError('db:reset is for development only and refuses a production configuration.');
  }
  if (config.env === 'test') {
    throw new ResetRefusedError('db:reset never touches the test databases and refuses NODE_ENV=test.');
  }

  const databaseUrl = config.database.url;
  const url = parsed(databaseUrl, 'DATABASE_URL');
  const databaseName = decodeURIComponent(url.pathname.replace(/^\//, ''));
  if (!SAFE_IDENTIFIER.test(databaseName) || SYSTEM_DATABASES.has(databaseName.toLowerCase())) {
    throw new ResetRefusedError(`db:reset will not recreate a database called "${databaseName}".`);
  }
  if (/_test$/i.test(databaseName)) {
    throw new ResetRefusedError(`db:reset never touches the test databases and refuses "${databaseName}".`);
  }
  // node-postgres lets `?host=` and `?hostaddr=` override the host of the URL: judge those too.
  for (const key of ['host', 'hostaddr']) {
    for (const value of url.searchParams.getAll(key)) requireLocal('the database', value);
  }
  requireLocal('the database', url.hostname);

  const admin = new URL(url);
  admin.pathname = '/postgres';
  admin.search = '';

  const redis = [
    { role: 'queue', url: config.redis.queueUrl },
    { role: 'cache', url: config.redis.cacheUrl },
  ] as const;
  for (const { role, url: redisUrl } of redis)
    requireLocal(`the ${role} Redis`, parsed(redisUrl, `the ${role} Redis URL`).hostname);

  const endpoint = config.s3.endpoint;
  if (endpoint === undefined) {
    throw new ResetRefusedError('db:reset only works on this machine, but S3_ENDPOINT is not set (the AWS default).');
  }
  requireLocal('the S3 endpoint', parsed(endpoint, 'S3_ENDPOINT').hostname);

  return {
    databaseName,
    databaseUrl,
    adminUrl: admin.toString(),
    redis,
    bucket: {
      name: config.s3.bucket,
      endpoint,
      region: config.s3.region,
      accessKeyId: config.s3.accessKeyId,
      secretAccessKey: config.s3.secretAccessKey,
      forcePathStyle: config.s3.forcePathStyle,
    },
  };
}
