// Rows of the legacy id map for tests (`account_legacy_ids`): which old client number or old customer number an account came from. The
// migration fills the map for the rows that existed then; a test that needs an account with a past makes the row here. The table is
// append-only, so a row is made once and never changed.
import { and, eq } from 'drizzle-orm';
import { type Database, schema as s } from '@src/infra/db';

/** The two old kinds of person the map names. */
export type LegacyType = 'client' | 'customer';

/** One row of the map. */
export interface LegacyRow {
  readonly legacyType: LegacyType;
  readonly legacyId: number;
  readonly accountId: number;
  /** True for a customer that the migration joined to a merchant of the same proven email. */
  readonly merged?: boolean;
}

/**
 * Inserts one row of the map.
 *
 * Why: a client row keeps its id (the map says so with a CHECK), a customer row points to the account that took its place.
 *
 * Side effects: inserts one `account_legacy_ids` row.
 *
 * @param db the test database
 * @param row the old kind, the old number and the account
 */
export async function insertLegacyRow(db: Database, row: LegacyRow): Promise<void> {
  await db.insert(s.accountLegacyIds).values({
    legacyType: row.legacyType,
    legacyId: row.legacyId,
    accountId: row.accountId,
    ...(row.merged === undefined ? {} : { merged: row.merged }),
  });
}

/**
 * Marks an account as a former merchant: the map row ('client', id) with the id of the account itself.
 *
 * @param db the test database
 * @param accountId the account
 */
export async function mapLegacyClient(db: Database, accountId: number): Promise<void> {
  await insertLegacyRow(db, { legacyType: 'client', legacyId: accountId, accountId });
}

/**
 * Marks an account as a former customer: the map row ('customer', old number) that points to the account.
 *
 * Why: an old customer number is never an account id, so a test of the legacy lookup gives the customer an old number that differs from
 * the account's id (and equals another account's id when it wants to prove the lookup never returns that one).
 *
 * @param db the test database
 * @param legacyCustomerId the old customer number
 * @param accountId the account that took its place
 * @param merged true for a customer joined to a merchant
 */
export async function mapLegacyCustomer(
  db: Database,
  legacyCustomerId: number,
  accountId: number,
  merged = false,
): Promise<void> {
  await insertLegacyRow(db, { legacyType: 'customer', legacyId: legacyCustomerId, accountId, merged });
}

/**
 * Reads the rows of the map that point to an account, oldest first.
 *
 * @param db the test database
 * @param accountId the account
 * @returns the rows
 */
export async function legacyRowsOf(db: Database, accountId: number) {
  return db
    .select()
    .from(s.accountLegacyIds)
    .where(eq(s.accountLegacyIds.accountId, accountId))
    .orderBy(s.accountLegacyIds.id);
}

/**
 * Reads what an old number maps to, straight from the table (no resolver: tests of the resolver compare with this).
 *
 * @param db the test database
 * @param legacyType the old kind
 * @param legacyId the old number
 * @returns the account id, or `undefined` for an unknown pair
 */
export async function accountOfLegacy(
  db: Database,
  legacyType: LegacyType,
  legacyId: number,
): Promise<number | undefined> {
  const [row] = await db
    .select({ accountId: s.accountLegacyIds.accountId })
    .from(s.accountLegacyIds)
    .where(and(eq(s.accountLegacyIds.legacyType, legacyType), eq(s.accountLegacyIds.legacyId, legacyId)));
  return row?.accountId;
}
