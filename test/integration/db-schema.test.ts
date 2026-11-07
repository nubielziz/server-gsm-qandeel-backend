// The migrations and the schema (decision 027): they apply on an empty database, create the 66 tables of the map and the backend's additions, match
// the Drizzle definitions, keep an index behind every foreign key, and `db:check` sees no drift.
import { afterAll, describe, expect, it } from 'bun:test';
import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { is } from 'drizzle-orm';
import { CasingCache } from 'drizzle-orm/casing';
import { PgTable as PgTableClass, getTableConfig, type PgTable } from 'drizzle-orm/pg-core';
import { Pool } from 'pg';
import { schema } from '../../src/infra/db';
import { MIGRATIONS_FOLDER, migrateDatabase } from '../../src/infra/db/migrate';
import { TEST_DATABASE_URL, closeTestDb, testDb } from '../support/db';

afterAll(closeTestDb);

/** The tables the map assigns to modules (scripts/module-map.mjs), loaded at run time because it is plain JavaScript. */
async function mappedTables(): Promise<string[]> {
  const path = '../../scripts/module-map.mjs';
  const { modules } = (await import(path)) as {
    modules: Array<{ id: string; tables: string[]; additionalTables?: string[] }>;
  };
  return modules.flatMap((module) => [...module.tables, ...(module.additionalTables ?? [])]).sort();
}

const drizzleTables = (): PgTable[] =>
  (Object.values(schema) as unknown[]).filter((value): value is PgTable => is(value, PgTableClass));

describe('migrations', () => {
  it('create exactly the 66 tables of the map and the 1 the backend adds (listed_prices)', async () => {
    const { pool } = await testDb();
    const { rows } = await pool.query<{ tablename: string }>(
      `select tablename from pg_tables where schemaname = 'public' order by tablename`,
    );
    const names = rows.map((row) => row.tablename);
    expect(names).toHaveLength(67);
    expect(names).toEqual(await mappedTables());
    expect(
      drizzleTables()
        .map((table) => getTableConfig(table).name)
        .sort(),
    ).toEqual(names);
  });

  it('are all recorded in the drizzle migrations table', async () => {
    const { pool } = await testDb();
    const files = (await readdir(MIGRATIONS_FOLDER)).filter((name) => name.endsWith('.sql'));
    const { rows } = await pool.query<{ count: string }>('select count(*) from drizzle.__drizzle_migrations');
    expect(Number(rows[0]!.count)).toBe(files.length);
  });

  it('apply on an empty database and can be applied again', async () => {
    const { pool } = await testDb();
    const name = `gsm_mig_${crypto.randomUUID().replaceAll('-', '').slice(0, 12)}`;
    await pool.query(`create database "${name}"`);
    const url = new URL(TEST_DATABASE_URL);
    url.pathname = `/${name}`;
    try {
      await migrateDatabase(url.toString());
      await migrateDatabase(url.toString());
      const scratch = new Pool({ connectionString: url.toString(), max: 1 });
      try {
        const tables = await scratch.query(`select 1 from pg_tables where schemaname = 'public'`);
        expect(tables.rowCount).toBe(67);
        const triggers = await scratch.query(`select tgname from pg_trigger where not tgisinternal order by tgname`);
        expect(triggers.rows.map((row) => row.tgname)).toEqual([
          'audit_logs_append_only',
          'ledger_entries_append_only',
          'ledger_entries_zero_sum',
          'ledger_transactions_append_only',
          'order_events_append_only',
        ]);
      } finally {
        await scratch.end();
      }
    } finally {
      await pool.query(`drop database if exists "${name}" with (force)`);
    }
    // Creating and dropping a database checkpoints Postgres: alone the test takes seconds, but at the end of a full run (or with
    // another worktree testing on the same server) flushing every dirty buffer can take over a minute on a slow disk.
  }, 180_000);
});

describe('concurrent migrators', () => {
  it('wait for each other (advisory lock) instead of racing on a fresh database', async () => {
    const { pool } = await testDb();
    const name = `gsm_mig_${crypto.randomUUID().replaceAll('-', '').slice(0, 12)}`;
    await pool.query(`create database "${name}"`);
    const url = new URL(TEST_DATABASE_URL);
    url.pathname = `/${name}`;
    try {
      await Promise.all([
        migrateDatabase(url.toString()),
        migrateDatabase(url.toString()),
        migrateDatabase(url.toString()),
      ]);
      const scratch = new Pool({ connectionString: url.toString(), max: 1 });
      try {
        const applied = await scratch.query('select count(*)::int as n from drizzle.__drizzle_migrations');
        // Every committed migration, whatever their number grows to.
        const files = (await readdir(MIGRATIONS_FOLDER)).filter((file) => file.endsWith('.sql'));
        expect(applied.rows[0].n).toBe(files.length);
      } finally {
        await scratch.end();
      }
    } finally {
      await pool.query(`drop database if exists "${name}" with (force)`);
    }
  }, 180_000);
});

describe('the migrated database', () => {
  it('has the columns and nullability the Drizzle schema declares', async () => {
    const { pool } = await testDb();
    const { rows } = await pool.query<{ table_name: string; column_name: string; is_nullable: string }>(
      `select table_name, column_name, is_nullable from information_schema.columns where table_schema = 'public'`,
    );
    const actual = new Map(rows.map((row) => [`${row.table_name}.${row.column_name}`, row.is_nullable === 'YES']));
    const expected = new Map<string, boolean>();
    const casing = new CasingCache('snake_case');
    for (const table of drizzleTables()) {
      const config = getTableConfig(table);
      for (const column of config.columns) {
        expected.set(`${config.name}.${casing.getColumnCasing(column)}`, !column.notNull);
      }
    }
    expect([...actual.keys()].sort()).toEqual([...expected.keys()].sort());
    for (const [key, nullable] of expected) expect(actual.get(key), key).toBe(nullable);
  });

  it('has an index behind every foreign key (the first columns of a full index)', async () => {
    const { pool } = await testDb();
    const { rows } = await pool.query<{ tbl: string; conname: string }>(`
      select c.conrelid::regclass::text as tbl, c.conname
      from pg_constraint c
      where c.contype = 'f' and c.connamespace = 'public'::regnamespace
        and not exists (
          select 1 from pg_index i
          where i.indrelid = c.conrelid and i.indisvalid and i.indpred is null
            and array_to_string((i.indkey::int2[])[0:cardinality(c.conkey) - 1], ',') = array_to_string(c.conkey, ',')
        )
      order by 1, 2`);
    expect(rows).toEqual([]);
  });

  it('stores no money or rate as a float', async () => {
    const { pool } = await testDb();
    const { rows } = await pool.query(
      `select table_name, column_name from information_schema.columns
       where table_schema = 'public' and data_type in ('real', 'double precision')`,
    );
    expect(rows).toEqual([]);
  });

  it('keeps every enumeration column inside its CHECK list (one check per enum column)', async () => {
    const { pool } = await testDb();
    const { rows } = await pool.query<{ conname: string }>(
      `select conname from pg_constraint where contype = 'c' and connamespace = 'public'::regnamespace and conname like '%\\_check'`,
    );
    const names = new Set(rows.map((row) => row.conname));
    for (const expected of [
      'staff_users_status_check',
      'sessions_stage_check',
      'orders_status_check',
      'orders_dispatch_state_check',
      'ledger_accounts_kind_check',
      'ledger_transactions_ref_type_check',
      'support_tickets_status_check',
    ]) {
      expect(names.has(expected), expected).toBe(true);
    }
  });
});

describe('bun run db:check', () => {
  it('reports no drift between the schema and the committed migrations', async () => {
    const child = Bun.spawn([process.execPath, join(import.meta.dir, '../../scripts/db-check.ts')], {
      cwd: join(import.meta.dir, '../..'),
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const [stdout, stderr, code] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    expect(`${stdout}${stderr}`).toContain('no drift');
    expect(code).toBe(0);
  }, 180_000);
});
