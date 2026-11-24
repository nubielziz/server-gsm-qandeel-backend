// Drizzle queries on `consent_records` (customers module): the immutable proof of consent, for the checkout (feature 14a) and the
// account (feature 14b). Only inserts and reads: a withdrawn consent is a new row with `granted = false`.
import { type SQL, desc, eq, sql } from 'drizzle-orm';
import type { DbExecutor } from '../../../infra/db';
import { type ConsentRecord, type NewConsentRecord, consentRecords, customers } from '../db/schema';

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

/**
 * Tells whether the customer's email address was proven.
 *
 * Why: decision 053. Anyone can type an address at a guest checkout or on a form, so a marketing answer typed there counts only once the
 * address is proven by one of the proofs the system already has: a sign-in or verification link was used, or an invitation was accepted
 * (`customers.email_verified_at` is set by all three), or a checkout of the customer was paid (a paid order by that guest). The literal
 * identifiers (an alias for the paid-session subquery, `"customers"."id"`) make it work in the one-table selects of the campaign audience.
 */
export const provenAddressSql: SQL<boolean> = sql<boolean>`(${customers.emailVerifiedAt} is not null or exists (
  select 1 from "checkout_sessions" "paid_session"
  where "paid_session"."customer_id" = "customers"."id" and "paid_session"."status" = 'paid'))`;

/**
 * Tells whether the customer agreed to marketing email, and the agreement counts.
 *
 * Why: ANSWERS checkouts 2 and RULES checkouts 1: consent is the latest `marketing` record (append-only proof; a withdrawal is a new
 * `granted = false` row) of the customer, and the customer's own `marketing_opt_in` must still say yes, so a switch turned off by the account
 * page or by staff stops the mail even when no withdrawal record exists. Both kinds of customer read the same way: a guest's choice is the
 * record its checkout wrote (14a), an account holder's the record its account page wrote (14b). Decision 053: the consent is effective only
 * for a proven address ({@link provenAddressSql}), because anyone can type an address; the recorded answer stays as proof and counts from
 * the moment the address is proven.
 */
export const consentSql: SQL<boolean> = sql<boolean>`(
  coalesce(${customers.marketingOptIn}, false) and coalesce((
    select ${consentRecords.granted} from ${consentRecords}
    where ${consentRecords.subjectType} = 'customer' and ${consentRecords.subjectId} = ${customers.id}
      and ${consentRecords.purpose} = 'marketing'
    order by ${consentRecords.createdAt} desc, ${consentRecords.id} desc
    limit 1), false) and ${provenAddressSql})`;
