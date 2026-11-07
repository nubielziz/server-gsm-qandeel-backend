// Drizzle queries on consent_records for the storefront checkout (feature 14a): the records of a session and new records. Only the
// customers module touches this table.
import { desc, eq } from 'drizzle-orm';
import type { DbExecutor } from '../../../infra/db';
import { type ConsentRecord, type NewConsentRecord, consentRecords } from '../db/schema';

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
