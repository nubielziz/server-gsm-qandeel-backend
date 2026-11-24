// Insert helpers shared by the seeders: explicit ids on identity columns, idempotent inserts, sequence repair, the retail rank.
import { asc, eq, getTableName, sql } from 'drizzle-orm';
import type { PgTable } from 'drizzle-orm/pg-core';
import { type DbExecutor, schema as s } from '../../src/infra/db';
import { INVENTED_ACCOUNT_ID_FIRST } from './account-ids';

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

/**
 * Moves the id sequence of the accounts past the demo accounts, and no further.
 *
 * Why: the accounts are one table (`clients`) with the merchants 1 to 20, the retail accounts 101 to 130 and the guest accounts the
 * checkout seed invents from 900 000. A plain `syncIdentity` would follow that last range, and the next account a person makes in a
 * development database would be 900 228; this one ignores the invented range, so the next number after the demo is 131. Rerunning the
 * seed gives the same answer.
 *
 * @param db the transaction (or database) to write with
 */
export async function syncAccountIdentity(db: DbExecutor): Promise<void> {
  await db.execute(
    sql`select setval(pg_get_serial_sequence('public.clients', 'id'), coalesce(max(id), 1), max(id) is not null) from ${s.clients} where id < ${INVENTED_ACCOUNT_ID_FIRST}`,
  );
}

/**
 * The id of the retail rank: the one client group of kind `b2c_retail`.
 *
 * Why: every demo customer and every guest account holds the retail rank, and the identity seeder is the one that makes it (the demo's
 * fourth group), so the seeders that write retail accounts ask for it by kind, not by the number.
 *
 * @param db the transaction (or database) to read with
 * @returns the id of the rank
 * @throws {Error} when no group has the kind (the identity seeder has not run)
 */
export async function retailGroupId(db: DbExecutor): Promise<number> {
  const [row] = await db
    .select({ id: s.clientGroups.id })
    .from(s.clientGroups)
    .where(eq(s.clientGroups.kind, 'b2c_retail'))
    .orderBy(asc(s.clientGroups.id))
    .limit(1);
  if (row === undefined) {
    throw new Error('The retail rank (a client group of kind b2c_retail) is missing: the identity seeder creates it.');
  }
  return row.id;
}
