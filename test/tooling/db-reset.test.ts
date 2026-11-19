// `bun run db:reset` (P4b): its steps against scratch resources (a scratch database, a scratch bucket, this worktree's own Redis
// databases), and the command end to end. The guards are unit-tested in test/tooling/db-reset-plan.test.ts; here the command is also
// started with environments it must refuse. Nothing here touches the development database or the shared test resources.
import { afterAll, afterEach, describe, expect, it, setDefaultTimeout } from 'bun:test';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import {
  CreateBucketCommand,
  DeleteBucketCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { Redis } from 'ioredis';
import { Pool } from 'pg';
import { parseEnv, searchPrefixOf } from '@src/config';
import { MIGRATIONS_FOLDER, migrateDatabase } from '@src/infra/db/migrate';
import { demoStatePath } from '../../scripts/seed/demo-state';
import {
  emptyBucket,
  flushRedisDatabase,
  pingPostgres,
  pingRedis,
  probeBucket,
  recreateDatabase,
} from '../../scripts/lib/db-reset-steps';
import { TEST_DATABASE_URL } from '../support/db';
import { testInstanceEnv } from '../support/env';
import { expectRejection } from '../support/rejection';
import { runInTerminal } from '../support/terminal-session';

// CREATE DATABASE copies the template and syncs to disk, and DROP DATABASE waits for a checkpoint: a second or two when the machine
// is idle, over 15 s when several worktrees run their suites at once, and past 60 s (95 to 176 s for this file) when four
// feature worktrees run their full checks together (2026-11-10). A timed-out test also left its create running, and the next test
// then met the half-made database, so the limit is generous.
setDefaultTimeout(180_000);

const ROOT = new URL('../..', import.meta.url).pathname;
const config = parseEnv({ NODE_ENV: 'test', DATABASE_URL_TEST: TEST_DATABASE_URL, ...testInstanceEnv() });

/** The server of the test database, with another database name. */
function urlOf(database: string): string {
  const url = new URL(TEST_DATABASE_URL);
  url.pathname = `/${database}`;
  return url.toString();
}

const ADMIN_URL = urlOf('postgres');

async function query<T extends object = object>(url: string, text: string): Promise<T[]> {
  const pool = new Pool({ connectionString: url, max: 1 });
  pool.on('error', () => undefined);
  try {
    return (await pool.query<T>(text)).rows;
  } finally {
    await pool.end();
  }
}

const databaseExists = async (name: string) =>
  (await query(ADMIN_URL, `select 1 from pg_database where datname = '${name}'`)).length === 1;

// Every test gets a scratch database of its own: this run's random prefix and a counter (no name ends in `_test`). A test that
// timed out while its CREATE DATABASE was still running used to leave a half-made database to the next test, which shared the name.
const SCRATCH_PREFIX = `gsm_p4b_reset_${randomUUID().slice(0, 8)}`;
let scratchCount = 0;
const scratchNames = new Set<string>();

/** The name and URL of a new scratch database; it is dropped after the test (and, as a safety net, after the file). */
function newScratch(): { name: string; url: string } {
  const name = `${SCRATCH_PREFIX}_${++scratchCount}`;
  scratchNames.add(name);
  return { name, url: urlOf(name) };
}

async function dropScratchDatabases(): Promise<void> {
  for (const name of scratchNames) {
    await query(ADMIN_URL, `drop database if exists "${name}" with (force)`);
    scratchNames.delete(name);
  }
}

/** Drops every database of this run's prefix: also one whose CREATE committed after its test's own cleanup had run. */
async function dropEveryScratchDatabase(): Promise<void> {
  await dropScratchDatabases();
  const left = await query<{ datname: string }>(
    ADMIN_URL,
    `select datname from pg_database where datname like '${SCRATCH_PREFIX}\\_%'`,
  );
  for (const { datname } of left) await query(ADMIN_URL, `drop database if exists "${datname}" with (force)`);
}

afterEach(dropScratchDatabases);
afterAll(dropEveryScratchDatabase);

describe('recreateDatabase', () => {
  it('drops the database with its data and its open connections, and creates it again empty', async () => {
    const scratch = newScratch();
    await recreateDatabase(ADMIN_URL, scratch.name);
    expect(await databaseExists(scratch.name)).toBe(true);

    // A running API or worker holds connections: the drop must end them instead of failing.
    const busy = new Pool({ connectionString: scratch.url, max: 1 });
    busy.on('error', () => undefined);
    await busy.query('create table keep_me (id int)');
    await busy.query('insert into keep_me values (1)');
    try {
      await recreateDatabase(ADMIN_URL, scratch.name);
    } finally {
      await busy.end().catch(() => undefined);
    }
    expect(await query(scratch.url, `select 1 from pg_tables where tablename = 'keep_me'`)).toEqual([]);
  });

  it('refuses a name that is not a plain identifier before it sends anything', async () => {
    await expectRejection(recreateDatabase(ADMIN_URL, 'x"; drop database postgres; --'), RangeError);
    await expectRejection(recreateDatabase(ADMIN_URL, 'my-db'), RangeError);
  });

  it('answers the ping of a reachable server', async () => {
    await pingPostgres(ADMIN_URL);
  });
});

describe('migrateDatabase', () => {
  it('reports how many migrations it applied: all of them on an empty database, none on the next call', async () => {
    const journal = JSON.parse(readFileSync(join(MIGRATIONS_FOLDER, 'meta/_journal.json'), 'utf8')) as {
      entries: unknown[];
    };
    expect(journal.entries.length).toBeGreaterThan(1);
    const scratch = newScratch();
    await recreateDatabase(ADMIN_URL, scratch.name);
    expect(await migrateDatabase(scratch.url)).toBe(journal.entries.length);
    expect(await migrateDatabase(scratch.url)).toBe(0);
  });
});

describe('the files bucket', () => {
  const bucket = {
    name: `gsm-p4b-reset-${randomUUID().slice(0, 8)}`,
    endpoint: config.s3.endpoint!,
    region: config.s3.region,
    accessKeyId: config.s3.accessKeyId,
    secretAccessKey: config.s3.secretAccessKey,
    forcePathStyle: config.s3.forcePathStyle,
  };
  const s3 = new S3Client({
    endpoint: bucket.endpoint,
    region: bucket.region,
    forcePathStyle: bucket.forcePathStyle,
    credentials: { accessKeyId: bucket.accessKeyId, secretAccessKey: bucket.secretAccessKey },
  });
  afterAll(async () => {
    await emptyBucket(bucket).catch(() => undefined);
    await s3.send(new DeleteBucketCommand({ Bucket: bucket.name })).catch(() => undefined);
    s3.destroy();
  });

  it('says a missing bucket is missing', async () => {
    expect(await probeBucket(bucket)).toBe(false);
  });

  it('empties every object, across more than one listing page, and keeps the bucket', async () => {
    await s3.send(new CreateBucketCommand({ Bucket: bucket.name }));
    expect(await probeBucket(bucket)).toBe(true);
    // 1,001 objects: one more than a listing page holds.
    const keys = Array.from({ length: 1001 }, (_, i) => `files/${String(i).padStart(4, '0')}.txt`);
    for (let start = 0; start < keys.length; start += 50) {
      await Promise.all(
        keys
          .slice(start, start + 50)
          .map((Key) => s3.send(new PutObjectCommand({ Bucket: bucket.name, Key, Body: 'x' }))),
      );
    }
    expect(await emptyBucket(bucket)).toBe(1001);
    const left = await s3.send(new ListObjectsV2Command({ Bucket: bucket.name }));
    expect(left.KeyCount).toBe(0);
    expect(await probeBucket(bucket)).toBe(true);
    // Nothing to remove the second time.
    expect(await emptyBucket(bucket)).toBe(0);
  }, 60_000);
});

// Redis: only the databases of this worktree's own `.env.test` (a number nobody else uses). Without them the default test databases
// are shared with other runs and are never flushed.
const ownRedis = process.env.REDIS_QUEUE_URL_TEST && process.env.REDIS_CACHE_URL_TEST;

describe.skipIf(!ownRedis)('the Redis databases', () => {
  it('empties only the database of the URL, and says how many keys it removed', async () => {
    const url = process.env.REDIS_QUEUE_URL_TEST!;
    const redis = new Redis(url);
    const marker = `gsm:p4b-reset:${randomUUID()}`;
    try {
      await redis.set(marker, '1');
      await redis.set(`${marker}:2`, '2');
      await pingRedis(url);
      expect(await flushRedisDatabase(url)).toBeGreaterThanOrEqual(2);
      expect(await redis.exists(marker)).toBe(0);
      expect(await redis.dbsize()).toBe(0);
    } finally {
      redis.disconnect();
    }
  });

  it('fails a ping to a server that is not there', async () => {
    await expectRejection(pingRedis('redis://127.0.0.1:1/0'));
  });
});

/** Runs `bun <script>` with exactly the given environment (no env files) and, if given, this text on standard input. */
async function runScript(script: string, env: Record<string, string>, stdin: string | undefined, args: string[]) {
  const child = Bun.spawn([process.execPath, '--no-env-file', script, ...args], {
    cwd: ROOT,
    env: { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '/tmp', ...env },
    stdin: stdin === undefined ? 'ignore' : new Blob([stdin]),
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  return { stdout, stderr, code };
}

/** Runs `bun scripts/db-reset.ts` with exactly the given environment (no env files) and, if given, this text on standard input. */
const resetCommandWithInput = (env: Record<string, string>, stdin: string | undefined, ...args: string[]) =>
  runScript('scripts/db-reset.ts', env, stdin, args);

/** Runs `bun scripts/db-reset.ts` with exactly the given environment (no env files) and no terminal. */
const resetCommand = (env: Record<string, string>, ...args: string[]) => resetCommandWithInput(env, undefined, ...args);

/**
 * An environment whose every server is harmless: a database that does not exist, Redis and S3 on a closed port. A guard that
 * failed would then stop at the first server check instead of changing anything.
 */
const HARMLESS = {
  DATABASE_URL: urlOf('gsm_p4b_never_created'),
  REDIS_QUEUE_URL: 'redis://127.0.0.1:1/0',
  REDIS_CACHE_URL: 'redis://127.0.0.1:1/0',
  S3_ENDPOINT: 'http://127.0.0.1:1',
  // The test-mode twins (read only under NODE_ENV=test), so no case falls back to the shared test defaults either.
  DATABASE_URL_TEST: urlOf('gsm_p4b_never_created'),
  REDIS_QUEUE_URL_TEST: 'redis://127.0.0.1:1/0',
  REDIS_CACHE_URL_TEST: 'redis://127.0.0.1:1/0',
};

describe('bun run db:reset refuses', () => {
  it('NODE_ENV=production, even with an incomplete production environment', async () => {
    const result = await resetCommand({ ...HARMLESS, NODE_ENV: 'production' });
    expect(result.code).toBe(1);
    expect(result.stderr).toContain('refuses NODE_ENV=production');
    expect(result.stdout).not.toContain('Resetting');
  });

  it('NODE_ENV=test: it never touches the test databases', async () => {
    const result = await resetCommand({ ...HARMLESS, NODE_ENV: 'test' });
    expect(result.code).toBe(1);
    expect(result.stderr).toContain('never touches the test databases');
    expect(result.stdout).not.toContain('Resetting');
  });

  it('a database on another machine', async () => {
    const result = await resetCommand({
      ...HARMLESS,
      NODE_ENV: 'development',
      DATABASE_URL: 'postgres://gsm:gsm@db.example.com:5432/gsm',
    });
    expect(result.code).toBe(1);
    expect(result.stderr).toContain('only works on this machine');
    expect(result.stdout).not.toContain('Resetting');
  });

  it('a database called like a test database', async () => {
    const result = await resetCommand({
      ...HARMLESS,
      NODE_ENV: 'development',
      DATABASE_URL: urlOf('gsm_p4b_never_created_test'),
    });
    expect(result.code).toBe(1);
    expect(result.stderr).toContain('never touches the test databases');
  });

  it('bad arguments, before anything else', async () => {
    // Every combination is unit-tested (test/tooling/db-reset-plan.test.ts); two spawns prove that a bad combination and a bad value
    // stop the command before it reads the configuration or touches a server (seven spawns took 9.8 s and a lot of memory).
    for (const args of [
      ['--seed', '--setup'],
      ['--setup', '--email', 'not-an-email', '--name', 'Layla Haddad'],
    ]) {
      const result = await resetCommand({ ...HARMLESS, NODE_ENV: 'development' }, ...args);
      expect(result.code).toBe(1);
      expect(result.stdout).toBe('');
      expect(result.stderr).not.toContain('did not answer');
    }
  });

  it('--setup without a terminal and without --email and --name, before anything is dropped', async () => {
    const scratch = newScratch();
    await recreateDatabase(ADMIN_URL, scratch.name);
    await query(scratch.url, 'create table keep_me (id int)');
    // Every server answers except Redis, so a refusal that came late would read "nothing was changed" from the server check instead.
    const result = await resetCommand({ ...HARMLESS, NODE_ENV: 'development', DATABASE_URL: scratch.url }, '--setup');
    expect(result.code).toBe(1);
    expect(result.stderr).toContain('--setup needs a terminal to ask for the first admin, or pass --email and --name');
    expect(result.stderr).not.toContain('did not answer');
    expect(result.stdout).not.toContain('Resetting');
    expect(await query(scratch.url, `select 1 from pg_tables where tablename = 'keep_me'`)).toHaveLength(1);
  });

  it('--password-stdin when standard input is the keyboard, before anything is dropped', async () => {
    const scratch = newScratch();
    await recreateDatabase(ADMIN_URL, scratch.name);
    await query(scratch.url, 'create table keep_me (id int)');
    const session = runInTerminal(
      [
        process.execPath,
        '--no-env-file',
        'scripts/db-reset.ts',
        '--setup',
        '--email',
        'a@b.co',
        '--name',
        'Layla Haddad',
        '--password-stdin',
      ],
      {
        cwd: ROOT,
        env: {
          PATH: process.env.PATH ?? '',
          HOME: process.env.HOME ?? '/tmp',
          TERM: 'xterm-256color',
          ...HARMLESS,
          NODE_ENV: 'development',
          DATABASE_URL: scratch.url,
        },
      },
    );
    // Read the screen first: `exitCode()` closes the terminal at once, so a late chunk would be lost.
    await session.waitFor('reads the password from a pipe, not from the keyboard');
    expect(await session.exitCode()).toBe(1);
    expect(session.screen()).not.toContain('Resetting');
    expect(session.screen()).not.toContain('did not answer');
    expect(await query(scratch.url, `select 1 from pg_tables where tablename = 'keep_me'`)).toHaveLength(1);
  });

  it('--seed when the demo state is missing, before anything is dropped', async () => {
    const scratch = newScratch();
    await recreateDatabase(ADMIN_URL, scratch.name);
    await query(scratch.url, 'create table keep_me (id int)');
    // Every server answers except Redis, so a refusal that came late would read "nothing was changed" from the server check instead.
    const result = await resetCommand(
      {
        ...HARMLESS,
        NODE_ENV: 'development',
        DATABASE_URL: scratch.url,
        FRONTEND_DIR: join(ROOT, 'no-such-frontend-checkout'),
      },
      '--seed',
    );
    expect(result.code).toBe(1);
    expect(result.stderr).toContain('--seed needs the demo state');
    expect(result.stderr).toContain('FRONTEND_DIR');
    expect(result.stderr).toContain('Nothing was changed.');
    expect(result.stderr).not.toContain('did not answer');
    expect(result.stdout).not.toContain('Resetting');
    expect(await query(scratch.url, `select 1 from pg_tables where tablename = 'keep_me'`)).toHaveLength(1);
  });

  it('--setup with a weak password on standard input, before anything is dropped, without repeating the password', async () => {
    const result = await resetCommandWithInput(
      { ...HARMLESS, NODE_ENV: 'development' },
      'short-pw\n',
      '--setup',
      '--email',
      'a@b.co',
      '--name',
      'Layla Haddad',
      '--password-stdin',
    );
    expect(result.code).toBe(1);
    expect(result.stderr).toContain('--password-stdin: Use at least 10 characters.');
    expect(result.stdout + result.stderr).not.toContain('short-pw');
    expect(result.stdout).not.toContain('Resetting');
  });

  it('and leaves everything as it was when a server does not answer', async () => {
    const scratch = newScratch();
    await recreateDatabase(ADMIN_URL, scratch.name);
    await query(scratch.url, 'create table keep_me (id int)');
    // The database is local and exists, Redis is not there: nothing may be dropped.
    const result = await resetCommand({ ...HARMLESS, NODE_ENV: 'development', DATABASE_URL: scratch.url });
    expect(result.code).toBe(1);
    expect(result.stderr).toContain('nothing was changed');
    expect(result.stdout).not.toContain('Resetting');
    expect(await query(scratch.url, `select 1 from pg_tables where tablename = 'keep_me'`)).toHaveLength(1);
  });

  it('answers --help with the usage and exit code 0', async () => {
    // Harmless servers like every other spawn here: if `--help` ever stopped exiting first, the reset would find nothing to drop.
    const result = await resetCommand({ ...HARMLESS, NODE_ENV: 'development' }, '--help');
    expect(result.code).toBe(0);
    expect(result.stdout).toContain('Usage: bun run db:reset');
  });
});

describe.skipIf(!ownRedis)('bun run db:reset end to end, on scratch resources', () => {
  const bucketName = `gsm-p4b-reset-cli-${randomUUID().slice(0, 8)}`;
  const s3 = new S3Client({
    endpoint: config.s3.endpoint!,
    region: config.s3.region,
    forcePathStyle: config.s3.forcePathStyle,
    credentials: { accessKeyId: config.s3.accessKeyId, secretAccessKey: config.s3.secretAccessKey },
  });
  const env = (scratch: { url: string }) => ({
    NODE_ENV: 'development',
    DATABASE_URL: scratch.url,
    REDIS_QUEUE_URL: process.env.REDIS_QUEUE_URL_TEST!,
    REDIS_CACHE_URL: process.env.REDIS_CACHE_URL_TEST!,
    // Feature 29: the reset drops the search names of its prefix; a scratch prefix of this test database, never gsm_development_.
    TYPESENSE_PREFIX: `${searchPrefixOf(TEST_DATABASE_URL)}reset_`,
    S3_BUCKET: bucketName,
    S3_ENDPOINT: config.s3.endpoint!,
    ...(process.env.FRONTEND_DIR ? { FRONTEND_DIR: process.env.FRONTEND_DIR } : {}),
  });

  /** Puts leftovers everywhere the reset must clean: a new scratch database with a table, Redis keys of both roles, a file in the bucket. */
  async function dirty(): Promise<{ name: string; url: string }> {
    const scratch = newScratch();
    await recreateDatabase(ADMIN_URL, scratch.name);
    await query(scratch.url, 'create table keep_me (id int)');
    for (const url of [process.env.REDIS_QUEUE_URL_TEST!, process.env.REDIS_CACHE_URL_TEST!]) {
      const redis = new Redis(url);
      await redis.set(`gsm:p4b-reset:${randomUUID()}`, 'stale');
      redis.disconnect();
    }
    await s3.send(new CreateBucketCommand({ Bucket: bucketName })).catch(() => undefined);
    await s3.send(new PutObjectCommand({ Bucket: bucketName, Key: 'old/file.txt', Body: 'old' }));
    return scratch;
  }

  afterAll(async () => {
    await emptyBucket({
      name: bucketName,
      endpoint: config.s3.endpoint!,
      region: config.s3.region,
      accessKeyId: config.s3.accessKeyId,
      secretAccessKey: config.s3.secretAccessKey,
      forcePathStyle: config.s3.forcePathStyle,
    }).catch(() => undefined);
    await s3.send(new DeleteBucketCommand({ Bucket: bucketName })).catch(() => undefined);
    s3.destroy();
  });

  it('with no flag: a new migrated empty database, empty Redis databases and an empty bucket', async () => {
    const scratch = await dirty();
    const result = await resetCommand(env(scratch));
    expect(result.stderr).toBe('');
    expect(result.code).toBe(0);
    expect(result.stdout).toContain('dropped and created again, empty');
    expect(result.stdout).toContain('migrations applied');
    expect(result.stdout).toContain('queue Redis');
    expect(result.stdout).toContain('cache Redis');
    expect(result.stdout).toContain('1 objects removed');
    expect(result.stdout).toContain('Reset finished.');

    expect(await query(scratch.url, `select 1 from pg_tables where tablename = 'keep_me'`)).toEqual([]);
    expect(await query(scratch.url, `select 1 from pg_tables where tablename = 'staff_users'`)).toHaveLength(1);
    expect(await query(scratch.url, 'select 1 from staff_users')).toEqual([]);
    for (const url of [process.env.REDIS_QUEUE_URL_TEST!, process.env.REDIS_CACHE_URL_TEST!]) {
      const redis = new Redis(url);
      expect(await redis.dbsize()).toBe(0);
      redis.disconnect();
    }
    expect((await s3.send(new ListObjectsV2Command({ Bucket: bucketName }))).KeyCount).toBe(0);
  }, 120_000);

  it('with --setup: the first run on the new database, the password printed once', async () => {
    const scratch = await dirty();
    const result = await resetCommand(
      env(scratch),
      '--setup',
      '--email',
      'Layla@Example.com',
      '--name',
      'Layla Haddad',
    );
    expect(result.stderr).toBe('');
    expect(result.code).toBe(0);
    const password = /Temporary password \(shown once, copy it now\): (\S+)/.exec(result.stdout)?.[1];
    expect(password).toBeDefined();
    expect(result.stdout.split(password!).length - 1).toBe(1);
    expect(await query(scratch.url, 'select email, status, must_change_password from staff_users')).toEqual([
      { email: 'layla@example.com', status: 'invited', must_change_password: true },
    ]);
    expect(await query(scratch.url, 'select count(*)::int as n from ledger_accounts')).toEqual([{ n: 12 }]);
    expect(await query(scratch.url, 'select code from currencies')).toEqual([{ code: 'USD' }]);
  }, 120_000);

  it('with --setup and --password-stdin: the admin has the chosen password, no change is forced, and nothing is printed', async () => {
    const scratch = await dirty();
    const password = 'a-long-passphrase-4U';
    const result = await resetCommandWithInput(
      env(scratch),
      `${password}\n`,
      '--setup',
      '--email',
      'Layla@Example.com',
      '--name',
      'Layla Haddad',
      '--password-stdin',
    );
    expect(result.stderr).toBe('');
    expect(result.code).toBe(0);
    expect(result.stdout).toContain('✓ First admin created: layla@example.com');
    expect(result.stdout).toContain('Reset finished.');
    expect(result.stdout).not.toContain('Temporary password');
    expect(result.stdout).not.toContain(password);
    expect(await query(scratch.url, 'select email, status, must_change_password from staff_users')).toEqual([
      { email: 'layla@example.com', status: 'invited', must_change_password: false },
    ]);
  }, 120_000);

  it('with --setup in a terminal: asks the same questions after the reset, and Ctrl+C leaves the reset database without an admin', async () => {
    const scratch = await dirty();
    const password = 'a-long-passphrase-4U';
    const terminalEnv = () => ({
      PATH: process.env.PATH ?? '',
      HOME: process.env.HOME ?? '/tmp',
      TERM: 'xterm-256color',
      ...env(scratch),
    });
    const answered = runInTerminal([process.execPath, '--no-env-file', 'scripts/db-reset.ts', '--setup'], {
      cwd: ROOT,
      env: terminalEnv(),
    });
    await answered.waitFor('Create the first one now? [Y/n] ');
    answered.send('\r');
    await answered.waitFor('Email: ');
    answered.send('Layla@Example.com\r');
    await answered.waitFor('Full name: ');
    answered.send('Layla Haddad\r');
    await answered.waitFor('Password: ');
    answered.send(`${password}\r`);
    await answered.waitFor('Repeat password: ');
    answered.send(`${password}\r`);
    await answered.waitFor('Reset finished.');
    expect(await answered.exitCode()).toBe(0);
    expect(answered.screen()).toContain('✓ First admin created: layla@example.com');
    expect(answered.screen()).not.toContain(password);
    expect(await query(scratch.url, 'select email, must_change_password from staff_users')).toEqual([
      { email: 'layla@example.com', must_change_password: false },
    ]);

    // The same command cancelled at the first question: the database was reset all the same, only the admin is missing.
    const cancelled = runInTerminal([process.execPath, '--no-env-file', 'scripts/db-reset.ts', '--setup'], {
      cwd: ROOT,
      env: terminalEnv(),
    });
    await cancelled.waitFor('Create the first one now? [Y/n] ');
    cancelled.send('\x03');
    await cancelled.waitFor('Cancelled: no admin account was created.');
    await cancelled.waitFor('run `bun run setup` to create the first admin');
    expect(await cancelled.exitCode()).toBe(130);
    expect(cancelled.screen()).not.toContain('Reset finished.');
    expect(await query(scratch.url, 'select 1 from staff_users')).toEqual([]);
    expect(await query(scratch.url, 'select code from currencies')).toEqual([{ code: 'USD' }]);
  }, 180_000);

  it.skipIf(!existsSync(demoStatePath()))(
    'with --seed: the demo data on the new database',
    async () => {
      const scratch = await dirty();
      const result = await resetCommand(env(scratch), '--seed');
      expect(result.code).toBe(0);
      expect(result.stdout).toContain('Seed finished.');
      expect(result.stdout).toContain('Reset finished.');
      expect(await query(scratch.url, 'select count(*)::int as n from staff_users')).toEqual([{ n: 6 }]);
    },
    240_000,
  );
});

/**
 * A complete production environment, as the deploy would give it (the values of `PRODUCTION` in test/tooling/db-reset-plan.test.ts),
 * except that Redis and S3 are on closed ports and the database is named by the test: nothing of the developer's is reachable.
 */
const productionEnv = (databaseUrl: string): Record<string, string> => ({
  NODE_ENV: 'production',
  ERRORS_BASE_URL: 'https://errors.gsm.example',
  PORTAL_BASE_URL: 'https://portal.gsm.example',
  CONSOLE_BASE_URL: 'https://admin.gsm.example',
  STORE_BASE_URL: 'https://shop.gsm.example',
  DATABASE_URL: databaseUrl,
  REDIS_QUEUE_URL: 'redis://127.0.0.1:1/0',
  REDIS_CACHE_URL: 'redis://127.0.0.1:1/0',
  S3_BUCKET: 'gsm-prod-files',
  S3_ENDPOINT: 'http://127.0.0.1:1',
  S3_ACCESS_KEY_ID: 'AKIA-ID',
  S3_SECRET_ACCESS_KEY: 'secret-access-key',
  CSRF_SECRET: 'c'.repeat(40),
  TOKEN_PEPPER: 'p'.repeat(40),
  ENCRYPTION_KEYS: `k1:${Buffer.alloc(32, 7).toString('base64')}`,
  ENCRYPTION_ACTIVE_KID: 'k1',
  METRICS_TOKEN: 'm'.repeat(32),
  MAIL_SMTP_URL: 'smtps://mailer:pw@smtp.gsm.example:465',
  MAIL_FROM: 'IMEI-HUB <noreply@gsm.example>',
  TURNSTILE_SECRET_KEY: 'turnstile-secret-for-tests',
  // Feature 29: required in production while search is on.
  TYPESENSE_URL: 'http://typesense.internal:8108',
});

/** The number of migrations of the repository, counted from its journal: not just "some number". */
function journalLength(): number {
  const journal = JSON.parse(readFileSync(join(MIGRATIONS_FOLDER, 'meta/_journal.json'), 'utf8')) as {
    entries: unknown[];
  };
  return journal.entries.length;
}

describe('bun run setup', () => {
  it('applies the pending migrations first, on a database without tables, and says how many', async () => {
    const scratch = newScratch();
    await recreateDatabase(ADMIN_URL, scratch.name);
    const { stdout, stderr, code } = await runScript(
      'scripts/setup.ts',
      {
        // The worktree's own test targets, then the scratch database in place of the test database.
        ...testInstanceEnv(),
        NODE_ENV: 'test',
        DATABASE_URL_TEST: scratch.url,
      },
      undefined,
      [],
    );
    expect(stderr).toBe('');
    expect(code).toBe(0);
    expect(stdout).toContain(`✓ Migrations: ${journalLength()} applied\n`);
    expect(stdout).toContain('✓ Base currency USD: created');
    expect(await query(scratch.url, `select 1 from pg_tables where tablename = 'staff_users'`)).toHaveLength(1);
    expect(await query(scratch.url, 'select code from currencies')).toEqual([{ code: 'USD' }]);
  });

  it('is allowed in production (unlike the seed): it migrates, creates the first admin and prints the password once', async () => {
    const scratch = newScratch();
    await recreateDatabase(ADMIN_URL, scratch.name);
    const { stdout, stderr, code } = await runScript('scripts/setup.ts', productionEnv(scratch.url), undefined, [
      '--email',
      'Layla@Example.com',
      '--name',
      'Layla Haddad',
    ]);
    expect(stderr).toBe('');
    expect(code).toBe(0);
    expect(stdout).toContain(`✓ Migrations: ${journalLength()} applied\n`);
    expect(stdout).toContain('✓ Base currency USD: created');
    expect(stdout).toContain('✓ 12 system ledger accounts: created');
    expect(stdout).toContain('✓ Owner role: created');
    expect(stdout).toContain('✓ First admin created: layla@example.com');
    const password = /Temporary password \(shown once, copy it now\): (\S+)/.exec(stdout)?.[1];
    expect(password).toBeDefined();
    expect(stdout.split(password!).length - 1).toBe(1);
    expect(await query(scratch.url, 'select email, status, must_change_password from staff_users')).toEqual([
      { email: 'layla@example.com', status: 'invited', must_change_password: true },
    ]);
  });
});
