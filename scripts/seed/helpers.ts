// Insert helpers shared by the seeders: explicit ids on identity columns, idempotent inserts, sequence repair.
import { getTableName, sql } from 'drizzle-orm';
import type { PgTable } from 'drizzle-orm/pg-core';
import type { DbExecutor } from '../../src/infra/db';

const CHUNK = 500;

/** What one seeder did to one table. */
export interface SeedReport {
  readonly table: string;
  /** Rows written by this run. */
  readonly inserted: number;
  /** Rows that were already there (same id or unique key), left untouched. */
  readonly existing: number;
}

/**
 * Inserts rows, skipping any that conflict with an existing row, and keeps explicit ids.
 *
 * Why: seeds are idempotent (running twice changes nothing) and must keep the demo ids; identity columns are
 * `GENERATED ALWAYS` (decision 027), so explicit ids need `OVERRIDING SYSTEM VALUE`.
 *
 * @param db the transaction (or database) to write with
 * @param table the Drizzle table
 * @param rows the rows to insert; those with an `id` keep it
 * @returns how many rows were new and how many already existed
 */
export async function insertRows<T extends PgTable>(
  db: DbExecutor,
  table: T,
  rows: ReadonlyArray<T['$inferInsert']>,
): Promise<SeedReport> {
  let inserted = 0;
  for (let start = 0; start < rows.length; start += CHUNK) {
    const written = await db
      .insert(table)
      .overridingSystemValue()
      .values(rows.slice(start, start + CHUNK))
      .onConflictDoNothing()
      .returning();
    inserted += written.length;
  }
  return { table: getTableName(table), inserted, existing: rows.length - inserted };
}

/**
 * Moves the table's id sequence past the largest id.
 *
 * Why: an explicit id does not advance an identity sequence, so the next normal insert would collide with a seeded row.
 *
 * @param db the transaction (or database) to write with
 * @param table a table with an identity `id` column
 */
export async function syncIdentity(db: DbExecutor, table: PgTable): Promise<void> {
  await db.execute(
    sql`select setval(pg_get_serial_sequence(${`public.${getTableName(table)}`}, 'id'), coalesce(max(id), 1), max(id) is not null) from ${table}`,
  );
}
