// Drizzle queries on `consent_records` (customers module): the immutable proof of consent, for the checkout (feature 14a) and the
// account (feature 14b). Only inserts and reads: a withdrawn consent is a new row with `granted = false`.
import { desc, eq } from 'drizzle-orm';
import type { DbExecutor } from '../../../infra/db';
import { type ConsentRecord, type NewConsentRecord, consentRecords } from '../db/schema';

/**
 * Inserts a consent record.
 *
 * Side effects: inserts a `consent_records` row (the table has no `updated_at` and is never updated).
 *
 * @param db the transaction
 * @param values the record: who, what, granted or withdrawn, the request address and time
 * @returns the stored row
 */
export async function insertConsentRecord(db: DbExecutor, values: NewConsentRecord): Promise<ConsentRecord> {
  const [row] = await db.insert(consentRecords).values(values).returning();
  if (!row) throw new Error('Inserting a consent record returned no row.');
  return row;
}

/**
 * Reads the consent records of a checkout session, newest first.
 *
 * @param db the database or a transaction
 * @param sessionId the checkout session
 * @returns every record the session has, newest first
 */
export async function listSessionConsents(db: DbExecutor, sessionId: number): Promise<ConsentRecord[]> {
  return db
    .select()
    .from(consentRecords)
    .where(eq(consentRecords.checkoutSessionId, sessionId))
    .orderBy(desc(consentRecords.createdAt), desc(consentRecords.id));
}

/**
 * Inserts consent records.
 *
 * @param db the caller's transaction
 * @param values the rows (at least one)
 * @returns the stored rows in the order given
 */
export async function insertConsents(db: DbExecutor, values: NewConsentRecord[]): Promise<ConsentRecord[]> {
  if (values.length === 0) return [];
  return db.insert(consentRecords).values(values).returning();
}
