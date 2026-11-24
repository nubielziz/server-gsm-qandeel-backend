// Rows of the shapes from before one account type (backend decision 064), written by raw SQL. Two needs:
// - the realistic data of the expand migration (scripts/accounts-merge/fixture.sql, loaded into a database held right before it, see
//   migrateUntil in ./migration-files), and the ids of its rows found again by their names;
// - an old word in an append-only table after the migration: its NOT VALID "current" check refuses client and customer in a new row, so a
//   test that needs such a row drops that check, writes the row and adds the check back NOT VALID, all in one transaction.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { sql } from 'drizzle-orm';
import type { Pool, PoolClient } from 'pg';
import type { Database } from '@src/infra/db';

/** The fixture file of the expand migration. */
export const FIXTURE_PATH = join(import.meta.dir, '../../scripts/accounts-merge/fixture.sql');

/** The two variants of the fixture: with the owner's approval of the pair (the last block), and without it (the migration stops, E5). */
export type FixtureVariant = 'approved' | 'not-approved';

const APPROVED_BLOCK = /^-- accounts-merge:fixture:approved:begin$[\s\S]*?^-- accounts-merge:fixture:approved:end$\n?/m;

/**
 * The fixture's SQL in one variant.
 *
 * @param variant `approved` (the whole file) or `not-approved` (without the approval block)
 * @returns the SQL to run as one query
 * @throws {Error} when the file lost its approval block
 */
export function fixtureSql(variant: FixtureVariant): string {
  const text = readFileSync(FIXTURE_PATH, 'utf8');
  if (!APPROVED_BLOCK.test(text)) throw new Error('scripts/accounts-merge/fixture.sql has no approval block.');
  return variant === 'approved' ? text : text.replace(APPROVED_BLOCK, '');
}

/** The ids of the fixture's people (merchants are `clients` ids, customers `customers` ids, both from before the migration). */
export interface FixtureIds {
  readonly staff: number;
  /** the active merchant whose email the guest typed */
  readonly ma: number;
  /** the pending merchant */
  readonly mb: number;
  /** the merchant of the pair */
  readonly mc: number;
  /** the blocked customer */
  readonly cb: number;
  /** the anonymized customer */
  readonly ca: number;
  /** the guest with merchant A's email */
  readonly cg: number;
  /** the customer of the pair */
  readonly cp: number;
  /** the customer with its own email */
  readonly co: number;
}

/**
 * Finds the fixture's people by their names (works before and after the migration: the old tables keep their rows).
 *
 * @param pool a pool on the database that holds the fixture
 * @returns their ids
 */
export async function fixtureIds(pool: Pool): Promise<FixtureIds> {
  const one = async (text: string, value: string): Promise<number> => {
    const { rows } = await pool.query<{ id: string }>(text, [value]);
    if (rows.length !== 1) throw new Error(`The fixture row ${value} was not found once.`);
    return Number(rows[0]!.id);
  };
  const merchant = (username: string) => one('select id from clients where username = $1', username);
  const customer = (email: string) => one('select id from customers where email = $1', email);
  return {
    staff: await one('select id from staff_users where email = $1', 'amfx-staff@example.test'),
    ma: await merchant('amfx-ma'),
    mb: await merchant('amfx-mb'),
    mc: await merchant('amfx-mc'),
    cb: await customer('amfx-cb@example.test'),
    ca: await customer('deleted-amfx@redacted.invalid'),
    cg: await customer('AMFX-MA@example.test'),
    cp: await customer('amfx-pair@example.test'),
    co: await customer('amfx-own@example.test'),
  };
}

/**
 * Loads the fixture into a database held right before the expand migration.
 *
 * Side effects: writes every row of the fixture (and, in the approved variant, the approvals settings row).
 *
 * @param pool a pool on that database
 * @param variant which variant
 * @returns the ids of its people
 */
export async function loadFixture(pool: Pool, variant: FixtureVariant): Promise<FixtureIds> {
  await pool.query(fixtureSql(variant));
  return fixtureIds(pool);
}

/** The NOT VALID checks of each append-only table that refuse the old words in a new row. */
export const CURRENT_CHECKS = {
  audit_logs: ['audit_logs_actor_type_current_check'],
  order_events: ['order_events_actor_type_current_check'],
  ledger_transactions: [
    'ledger_transactions_created_by_type_current_check',
    'ledger_transactions_ref_type_current_check',
  ],
} as const;

/** An append-only table whose old words a test may need in a new row. */
export type OldWordsTable = keyof typeof CURRENT_CHECKS;

const definitionsSql = `select conname, pg_get_constraintdef(oid) as definition from pg_constraint
  where conrelid = $1::regclass and conname = any($2::text[])`;

/**
 * Runs `work` with the current checks of a table dropped, then adds them back exactly as they were (NOT VALID), in one transaction.
 *
 * Why: after the expand migration a new row with an old word is refused, but the readers of old rows (audit, order timeline, journal)
 * must be tested with such rows; the rows a production database holds were written before the check existed.
 *
 * Side effects: whatever `work` writes; the checks end as they started.
 *
 * @param pool a pool on the database
 * @param table the append-only table
 * @param work what to write, with the client of the transaction
 * @returns what `work` returns
 * @throws {Error} when a check is missing (the database is not past the expand migration)
 */
export async function withOldWords<T>(
  pool: Pool,
  table: OldWordsTable,
  work: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('begin');
    const names: readonly string[] = CURRENT_CHECKS[table];
    const { rows } = await client.query<{ conname: string; definition: string }>(definitionsSql, [table, names]);
    if (rows.length !== names.length)
      throw new Error(`${table} does not have its current checks (${names.join(', ')}).`);
    for (const row of rows) await client.query(`alter table "${table}" drop constraint "${row.conname}"`);
    const result = await work(client);
    for (const row of rows)
      await client.query(`alter table "${table}" add constraint "${row.conname}" ${row.definition}`);
    await client.query('commit');
    return result;
  } catch (error) {
    await client.query('rollback').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

/**
 * The same with a Drizzle handle: `work` gets the transaction.
 *
 * @param db the test database
 * @param table the append-only table
 * @param work what to write
 * @returns what `work` returns
 * @throws {Error} when a check is missing
 */
export async function withOldWordsIn<T>(
  db: Database,
  table: OldWordsTable,
  work: (tx: Parameters<Parameters<Database['transaction']>[0]>[0]) => Promise<T>,
): Promise<T> {
  return db.transaction(async (tx) => {
    const names: readonly string[] = CURRENT_CHECKS[table];
    const found = await tx.execute<{ conname: string; definition: string }>(
      sql`select conname, pg_get_constraintdef(oid) as definition from pg_constraint
           where conrelid = ${table}::regclass and conname = any(${names}::text[])`,
    );
    if (found.rows.length !== names.length)
      throw new Error(`${table} does not have its current checks (${names.join(', ')}).`);
    for (const row of found.rows) await tx.execute(sql.raw(`alter table "${table}" drop constraint "${row.conname}"`));
    const result = await work(tx);
    for (const row of found.rows) {
      await tx.execute(sql.raw(`alter table "${table}" add constraint "${row.conname}" ${row.definition}`));
    }
    return result;
  });
}

/**
 * Inserts one row with old words into an append-only table ({@link withOldWords}).
 *
 * @param pool a pool on the database
 * @param table the append-only table
 * @param row the columns and their values (column names as in SQL)
 * @returns the id of the row
 */
export async function insertWithOldWords(
  pool: Pool,
  table: OldWordsTable,
  row: Readonly<Record<string, unknown>>,
): Promise<number> {
  const columns = Object.keys(row);
  const text = `insert into "${table}" (${columns.map((column) => `"${column}"`).join(', ')})
    values (${columns.map((_, index) => `$${index + 1}`).join(', ')}) returning id`;
  return withOldWords(pool, table, async (client) => {
    const { rows } = await client.query<{ id: string }>(text, Object.values(row));
    return Number(rows[0]!.id);
  });
}
