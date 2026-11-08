// Read-only lookup into a table the risk module owns: how many IMEI checks used a TAC. Kept in this one small file, like the
// catalog's other foreign reads (foreign-reads.repository.ts), and for the same reason (decision 016: risk exports nothing yet).
// Replace the body with a call to risk's service when feature 18 exports one; nothing outside this file knows.
import { eq, sql } from 'drizzle-orm';
import { type DbExecutor, schema as s } from '../../../infra/db';

/**
 * Counts the IMEI checks that recorded a TAC.
 *
 * Why: RESOLUTIONS catalog-7: a TAC is editable only while no `imei_checks` row references it (the foreign key has no
 * `ON UPDATE CASCADE`, and a check's TAC is history).
 *
 * @param db the database or a transaction
 * @param tac the 8-digit TAC
 * @returns how many IMEI checks have this TAC
 */
export async function imeiChecksUsingTac(db: DbExecutor, tac: string): Promise<number> {
  const [row] = await db
    .select({ total: sql<number>`count(*)::int` })
    .from(s.imeiChecks)
    .where(eq(s.imeiChecks.tac, tac));
  return row?.total ?? 0;
}
