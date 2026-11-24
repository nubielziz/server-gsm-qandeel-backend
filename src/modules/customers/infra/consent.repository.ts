// Drizzle queries on `consent_records` (customers module): the immutable proof of consent, for the checkout (feature 14a) and the
// account (feature 14b). Inserts and reads: a withdrawn consent is a new row with `granted = false`; the one update is the pointer of the
// guest claim (`subject_id`), never a proof column. The subject of a record is an account, of any rank (decision 064).
//
// DEVIATION to resolve when the identity module exports the facts of the audience (decision 016): the two audience conditions below read the
// columns `email_verified_at`, `marketing_opt_in` and `id` of `clients`, which belongs to identity; the campaign audience of this module
// is their only reader.
import { type SQL, and, desc, eq, sql } from 'drizzle-orm';
import { type DbExecutor, schema as s } from '../../../infra/db';
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

/**
 * Moves the consent records of one account row to another.
 *
 * Why: the guest claim (decision 064): the consents a guest row gave at its checkouts belong to the account that proved the mailbox. Only
 * the pointer `subject_id` changes: the purpose, the answer, the document, the address, the user agent and the time of every record stay
 * byte for byte, so the proof of a chargeback is the same. The rows are locked `FOR UPDATE NOWAIT` so the claim never waits.
 *
 * Side effects: updates `consent_records.subject_id`.
 *
 * @param db the claim's transaction
 * @param guestId the guest row that is the subject now
 * @param accountId the account that takes them
 * @returns how many records moved
 * @throws the lock error (SQLSTATE 55P03) when another transaction holds one of the rows
 */
export async function moveGuestConsents(db: DbExecutor, guestId: number, accountId: number): Promise<number> {
  const mine = and(eq(consentRecords.subjectType, 'account'), eq(consentRecords.subjectId, guestId));
  const locked = await db
    .select({ id: consentRecords.id })
    .from(consentRecords)
    .where(mine)
    .orderBy(consentRecords.id)
    .for('update', { noWait: true });
  if (locked.length === 0) return 0;
  const moved = await db
    .update(consentRecords)
    .set({ subjectId: accountId })
    .where(mine)
    .returning({ id: consentRecords.id });
  return moved.length;
}

/**
 * Tells whether the account's email address was proven.
 *
 * Why: decision 053. Anyone can type an address at a guest checkout or on a form, so a marketing answer typed there counts only once the
 * address is proven by one of the proofs the system already has: a sign-in or verification link was used, or an invitation was accepted
 * (`clients.email_verified_at` is set by all three), or a checkout of the account was paid (a paid session of that row). The literal
 * identifiers (an alias for the paid-session subquery, `"clients"."id"`) make it work in the one-table selects of the campaign audience.
 */
export const provenAddressSql: SQL<boolean> = sql<boolean>`(${s.clients.emailVerifiedAt} is not null or exists (
  select 1 from "checkout_sessions" "paid_session"
  where "paid_session"."account_id" = "clients"."id" and "paid_session"."status" = 'paid'))`;

/**
 * Tells whether the account agreed to marketing email, and the agreement counts.
 *
 * Why: ANSWERS checkouts 2 and RULES checkouts 1: consent is the latest `marketing` record (append-only proof; a withdrawal is a new
 * `granted = false` row) of the account, and the account's own `marketing_opt_in` must still say yes, so a switch turned off by the account
 * page or by staff stops the mail even when no withdrawal record exists. Every kind of row reads the same way: a guest row's choice is the
 * record its checkout wrote (14a), an account holder's the record its account page wrote (14b); the subject of both is `('account', id)`.
 * Decision 053: the consent is effective only for a proven address ({@link provenAddressSql}), because anyone can type an address; the
 * recorded answer stays as proof and counts from the moment the address is proven.
 */
export const consentSql: SQL<boolean> = sql<boolean>`(
  coalesce(${s.clients.marketingOptIn}, false) and coalesce((
    select ${consentRecords.granted} from ${consentRecords}
    where ${consentRecords.subjectType} = 'account' and ${consentRecords.subjectId} = ${s.clients.id}
      and ${consentRecords.purpose} = 'marketing'
    order by ${consentRecords.createdAt} desc, ${consentRecords.id} desc
    limit 1), false) and ${provenAddressSql})`;
