// Finds a migration file by its name suffix (the lead renumbers migrations at merge, so tests never name the number) and reads its statements;
// builds scratch databases held at the schema right before a migration (a copy of drizzle/ whose journal stops there), for the tests of a
// data migration that must fill a database with rows of the old shape first.
import { randomUUID } from 'node:crypto';
import { cpSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Pool } from 'pg';
import { migrateDatabase } from '@src/infra/db/migrate';

const DRIZZLE_DIR = join(import.meta.dir, '../../drizzle');

/** The end of the file name of the expand migration of one account type (backend decision 064). */
export const ACCOUNTS_EXPAND_SUFFIX = '_accounts_expand.sql';

/** The end of the file name of the stored-roles migration of the same release. */
export const ACCOUNT_PERMISSIONS_SUFFIX = '_account_permissions.sql';

/** The end of the file name of the migration that makes a field's Name its supplier key and adds the main-input flag (decision 065). */
export const FIELD_NAMES_SUFFIX = '_field_names.sql';

/** The end of the file name of the migration that adds "Delivered from code stock" and `out_of_stock` (decision 069). */
export const CODE_STOCK_SUFFIX = '_code_stock.sql';

/** The end of the file name of the migration that gives every plain IMEI service its IMEI field (decision 071). */
export const IMEI_MAIN_INPUT_SUFFIX = '_imei_main_input_field.sql';

/** The end of the file name of the migration that adds the field type `imei` and gives it to the IMEI fields (decision 073). */
export const IMEI_FIELD_TYPE_SUFFIX = '_imei_field_type.sql';

/**
 * The file name of the migration that ends with a suffix.
 *
 * @param suffix the part after the number, for example `_public_abuse_limits.sql`
 * @returns the file name in `drizzle/`
 * @throws {Error} when no file, or more than one, ends with the suffix
 */
export function migrationFileName(suffix: string): string {
  const names = readdirSync(DRIZZLE_DIR).filter((name) => name.endsWith(suffix));
  if (names.length !== 1) throw new Error(`Expected one migration ending with ${suffix}, found ${names.length}.`);
  return names[0]!;
}

/**
 * The text of the migration whose file name ends with a suffix.
 *
 * @param suffix the part after the number, for example `_supplier_safety.sql`
 * @returns the file's text
 * @throws {Error} when no file, or more than one, ends with the suffix
 */
export function migrationSql(suffix: string): string {
  const names = readdirSync(DRIZZLE_DIR).filter((name) => name.endsWith(suffix));
  if (names.length !== 1) throw new Error(`Expected one migration ending with ${suffix}, found ${names.length}.`);
  return readFileSync(join(DRIZZLE_DIR, names[0]!), 'utf8');
}

/**
 * The statements of a migration without their comment lines, split on drizzle's statement breakpoint.
 *
 * @param suffix the part after the number
 * @returns the statements, trimmed
 */
export function migrationStatements(suffix: string): string[] {
  return migrationSql(suffix)
    .split('--> statement-breakpoint')
    .map((part) =>
      part
        .split('\n')
        .filter((line) => !line.trimStart().startsWith('--'))
        .join('\n')
        .trim(),
    )
    .filter((statement) => statement !== '');
}

/** One entry of drizzle/meta/_journal.json. */
interface JournalEntry {
  readonly idx: number;
  readonly tag: string;
  readonly when: number;
}

/**
 * The journal entries of the real migrations folder, oldest first.
 *
 * @returns the entries
 */
export function journalEntries(): JournalEntry[] {
  return (JSON.parse(readFileSync(join(DRIZZLE_DIR, 'meta', '_journal.json'), 'utf8')) as { entries: JournalEntry[] })
    .entries;
}

/**
 * The journal tag of the migration whose file name ends with a suffix.
 *
 * @param suffix the part after the number
 * @returns the tag, for example `0066_accounts_expand`
 */
export function migrationTag(suffix: string): string {
  return migrationFileName(suffix).replace(/\.sql$/, '');
}

/**
 * A temporary copy of drizzle/ whose journal stops right before the migration that ends with a suffix, so a database can be migrated
 * to the schema just before it (remove the folder when done).
 *
 * @param suffix the part after the number of the first migration to leave out
 * @returns the folder to pass to `migrateDatabase(url, folder)`
 * @throws {Error} when no journal entry has the migration's tag
 */
export function migrationsBefore(suffix: string): string {
  const tag = migrationTag(suffix);
  const folder = mkdtempSync(join(tmpdir(), 'gsm-migrations-'));
  cpSync(DRIZZLE_DIR, folder, { recursive: true });
  const path = join(folder, 'meta', '_journal.json');
  const journal = JSON.parse(readFileSync(path, 'utf8')) as { entries: JournalEntry[] };
  const first = journal.entries.findIndex((entry) => entry.tag === tag);
  if (first < 0) throw new Error(`drizzle/meta/_journal.json has no ${tag}`);
  journal.entries = journal.entries.slice(0, first);
  writeFileSync(path, JSON.stringify(journal, null, 2));
  return folder;
}

/**
 * Migrates a database up to, and not including, the migration whose file name ends with a suffix.
 *
 * @param url the database
 * @param suffix the part after the number of the first migration to leave out
 * @returns how many migrations were applied
 */
export async function migrateUntil(url: string, suffix: string): Promise<number> {
  const folder = migrationsBefore(suffix);
  try {
    return await migrateDatabase(url, folder);
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }
}

/**
 * How many migrations a database has applied.
 *
 * @param pool a pool on the database
 * @returns the count of `drizzle.__drizzle_migrations` (0 before the first)
 */
export async function appliedCount(pool: Pool): Promise<number> {
  const { rows } = await pool.query<{ n: number }>(
    `select case when to_regclass('drizzle.__drizzle_migrations') is null then 0
                 else (select count(*)::int from drizzle.__drizzle_migrations) end as n`,
  );
  return rows[0]?.n ?? 0;
}

/**
 * The text of one phase of an assembled migration: the lines between its two phase markers.
 *
 * @param suffix the part after the number
 * @param phase the phase number
 * @returns the phase's text, markers excluded
 * @throws {Error} when the phase's markers are not there
 */
export function phaseSql(suffix: string, phase: number): string {
  const lines = migrationSql(suffix).split('\n');
  const begin = lines.findIndex((line) => line.startsWith(`-- accounts-merge:phase:${phase}:begin`));
  const end = lines.findIndex((line) => line === `-- accounts-merge:phase:${phase}:end`);
  if (begin < 0 || end < begin) throw new Error(`The migration ending with ${suffix} has no phase ${phase}.`);
  return lines.slice(begin + 1, end).join('\n');
}

/**
 * The test server's connection string with another database name.
 *
 * Why: read lazily, so the unit and tooling tests that only read migration files never parse the test configuration.
 *
 * @param database the database name
 * @returns the connection string
 */
export async function serverUrlOf(database: string): Promise<string> {
  const { TEST_DATABASE_URL } = await import('./db');
  const url = new URL(TEST_DATABASE_URL);
  url.pathname = `/${database}`;
  return url.toString();
}

/**
 * A pool on a database (end it when done).
 *
 * @param url the database
 * @param max how many connections
 * @returns the pool
 */
export function poolOn(url: string, max = 2): Pool {
  const pool = new Pool({ connectionString: url, max });
  pool.on('error', () => undefined);
  return pool;
}

/**
 * Scratch databases of one test file on the test server, each named `<label>_<random>_<n>_test` and dropped by {@link dropAll}.
 *
 * Why: a data migration is tested on a database held at the schema before it and filled with rows of the old shape; the shared test
 * database (`resetDb`) is always at the newest schema and is used by other files at the same time.
 */
export class ScratchDatabases {
  private readonly prefix: string;
  private count = 0;

  /**
   * @param label a short word naming the test file (letters and digits)
   */
  constructor(label: string) {
    this.prefix = `gsm_${label}_${randomUUID().replaceAll('-', '').slice(0, 8)}`;
  }

  /**
   * Creates an empty database, or a copy of a template database (which must have no open connection).
   *
   * @param template the database to copy
   * @returns its name and connection string
   */
  async create(template?: string): Promise<{ name: string; url: string }> {
    const name = `${this.prefix}_${++this.count}_test`;
    const admin = poolOn(await serverUrlOf('postgres'), 1);
    try {
      await admin.query(`create database "${name}"${template === undefined ? '' : ` template "${template}"`}`);
    } finally {
      await admin.end();
    }
    return { name, url: await serverUrlOf(name) };
  }

  /** Drops every database of this file. */
  async dropAll(): Promise<void> {
    const admin = poolOn(await serverUrlOf('postgres'), 1);
    try {
      const { rows } = await admin.query<{ datname: string }>(`select datname from pg_database where datname like $1`, [
        `${this.prefix}\\_%`,
      ]);
      for (const row of rows) await admin.query(`drop database if exists "${row.datname}" with (force)`);
    } finally {
      await admin.end();
    }
  }
}
