// Postgres's own comparison of field Names, for the one case the application's lower-casing cannot settle.
import { sql } from 'drizzle-orm';
import type { DbExecutor } from '../../../infra/db';

/**
 * Finds the Names of a field list that repeat an earlier Name by Postgres's `lower()`.
 *
 * Why: decision 065: the unique index `service_fields_name_uq` compares `lower(supplier_key)` in the database, while the fields route
 * compares in code first. Where the two lower-case a letter differently the index refuses a list that the code let through; the use
 * case then asks the database itself which rows clash, so the console still highlights `fields.N.name` instead of a bare failure.
 *
 * @param db the database (not the aborted transaction of the refused write)
 * @param names the Names in list order, trimmed
 * @returns the indexes of the later rows of every repeated Name, in list order
 */
export async function laterRepeatedNameIndexes(db: DbExecutor, names: readonly string[]): Promise<number[]> {
  if (names.length === 0) return [];
  const result = await db.execute<{ idx: number }>(sql`
    select ranked.idx
    from (
      select wanted.idx, row_number() over (partition by lower(btrim(wanted.name)) order by wanted.idx) as place
      from (values ${sql.join(
        names.map((name, idx) => sql`(${idx}::integer, ${name}::text)`),
        sql`, `,
      )}) as wanted(idx, name)
    ) as ranked
    where ranked.place > 1
    order by ranked.idx`);
  return result.rows.map((row) => Number(row.idx));
}
