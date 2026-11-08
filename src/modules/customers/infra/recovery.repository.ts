// Drizzle queries of the abandoned-checkout recovery (feature 19): the list of `GET /admin/checkouts/abandoned`, the locked read the
// recovery send decides on, the guarded claim, and the selection of the automatic reminder. Only the customers module touches
// these tables.
import { type SQL, and, asc, eq, inArray, isNotNull, isNull, sql } from 'drizzle-orm';
import type { ParsedListQuery } from '../../../common/contract';
import { type DbExecutor, type ListColumns, listOrderBy, listWhere } from '../../../infra/db';
import { type CheckoutSession, type CustomerStatus, checkoutSessions, consentRecords, customers } from '../db/schema';
import { recoveryBounds } from '../domain/recovery';

/** The sorts `GET /admin/checkouts/abandoned` accepts. */
export type AbandonedSort = 'createdAt' | 'grossAmount' | 'recoveryEmailedAt';

/** The clock's time and the `abandonedMinutes` setting: what "due" means in every query below. */
export interface RecoveryClock {
  readonly now: Date;
  readonly delayMinutes: number;
}

/** A checkout session with the facts the recovery rule needs from its customer. */
export interface RecoveryRow {
  readonly session: CheckoutSession;
  /** True when the latest `marketing` consent of the session's customer is a grant and the customer's own switch is on. */
  readonly consent: boolean;
  /** The customer's status, `null` when the session has none. */
  readonly customerStatus: CustomerStatus | null;
  /** The customer's name (empty for a guest who never gave one), `null` when the session has no customer. */
  readonly customerName: string | null;
  /** The customer's language, `null` when the session has no customer. */
  readonly customerLocale: string | null;
}

/**
 * Tells whether the session's customer agreed to marketing email.
 *
 * Why: ANSWERS checkouts 2 and RULES checkouts 1: consent is the latest `marketing` record (append-only proof; a withdrawal is a new
 * `granted = false` row) of the session's customer, and the customer's own `marketing_opt_in` must still say yes, so a switch turned
 * off by the account page or by staff stops the mail even when no withdrawal record exists. A session without a customer has none.
 * Both kinds of customer read the same way: a guest's choice is the record its checkout wrote (14a), an account holder's the record
 * its account page wrote (14b).
 */
export const consentSql: SQL<boolean> = sql<boolean>`(
  coalesce(${customers.marketingOptIn}, false) and coalesce((
    select ${consentRecords.granted} from ${consentRecords}
    where ${consentRecords.subjectType} = 'customer' and ${consentRecords.subjectId} = ${customers.id}
      and ${consentRecords.purpose} = 'marketing'
    order by ${consentRecords.createdAt} desc, ${consentRecords.id} desc
    limit 1), false))`;

/**
 * The SQL twin of `recoveryVerdict(...) === null`: may this session get its recovery email now.
 *
 * Why: RULES checkouts 2 says the `canRecover=true` filter must use the same predicate as the row's flag; the automatic reminder
 * selects with it too. A test walks every state and keeps the two equal.
 *
 * @param clock the clock's time and the delay setting
 * @returns a boolean condition over `checkout_sessions` joined with `customers`
 */
export function canRecoverSql(clock: RecoveryClock): SQL {
  const { dueBefore, notBefore } = recoveryBounds(clock.now, clock.delayMinutes);
  const s = checkoutSessions;
  return sql`(${consentSql} and ${customers.status} = 'active' and ${s.recoveryEmailedAt} is null and ${s.orderId} is null
    and ${s.status} <> 'paid' and ${s.createdAt} <= ${dueBefore} and ${s.createdAt} >= ${notBefore})`;
}

/**
 * The sessions the abandoned list shows.
 *
 * Why: ANSWERS checkouts 8: not paid, plus paid ones that had a recovery email (recovered), created in the last 30 days.
 */
function listedSql(now: Date): SQL {
  const s = checkoutSessions;
  const { notBefore } = recoveryBounds(now, 0);
  return sql`(${s.createdAt} >= ${notBefore} and ((${s.orderId} is null and ${s.status} <> 'paid') or ${s.recoveryEmailedAt} is not null))`;
}

const select = (db: DbExecutor) =>
  db
    .select({
      session: checkoutSessions,
      consent: consentSql,
      customerStatus: customers.status,
      customerName: customers.name,
      customerLocale: customers.locale,
    })
    .from(checkoutSessions)
    .leftJoin(customers, eq(customers.id, checkoutSessions.customerId));

/**
 * Lists the abandoned checkouts of one page.
 *
 * @param db the database or a transaction
 * @param query the parsed list request (`canRecover` filter, `q` over the full email, the three sorts)
 * @param clock the clock's time and the delay setting
 * @returns the page of rows and the exact total
 */
export async function listAbandoned(
  db: DbExecutor,
  query: ParsedListQuery<AbandonedSort>,
  clock: RecoveryClock,
): Promise<{ rows: RecoveryRow[]; total: number }> {
  const columns: ListColumns = {
    createdAt: checkoutSessions.createdAt,
    grossAmount: checkoutSessions.grossAmount,
    recoveryEmailedAt: checkoutSessions.recoveryEmailedAt,
    email: checkoutSessions.email,
    canRecover: canRecoverSql(clock),
  };
  const where = listWhere(query, columns, listedSql(clock.now));
  const [rows, [count]] = await Promise.all([
    select(db)
      .where(where)
      .orderBy(...listOrderBy(query.sort, columns, checkoutSessions.id))
      .limit(query.range.limit)
      .offset(query.range.start),
    db
      .select({ total: sql<number>`count(*)::int` })
      .from(checkoutSessions)
      .leftJoin(customers, eq(customers.id, checkoutSessions.customerId))
      .where(where),
  ]);
  return { rows, total: count?.total ?? 0 };
}

/**
 * Reads some sessions with their consent, optionally locking them.
 *
 * Why: the recovery send decides per id from one read taken under the sessions' locks (`FOR UPDATE OF checkout_sessions`, in id order,
 * so two sends over the same ids never deadlock and the second sees the first's claim). The customer row is not locked.
 *
 * @param db the database or a transaction
 * @param ids the session ids
 * @param lock true inside the send's transaction
 * @returns the rows found, by ascending id (an unknown id is absent)
 */
export async function readRecoveryRows(db: DbExecutor, ids: readonly number[], lock = false): Promise<RecoveryRow[]> {
  if (ids.length === 0) return [];
  const query = select(db)
    .where(inArray(checkoutSessions.id, [...ids]))
    .orderBy(asc(checkoutSessions.id));
  const rows = await (lock ? query.for('update', { of: checkoutSessions }) : query);
  return rows;
}

/**
 * Marks a session as emailed.
 *
 * Why: "once only" (M1): the guard `recovery_emailed_at IS NULL` makes the claim atomic even if two writers got past the verdict.
 *
 * @param db the caller's transaction
 * @param id the session
 * @param now the injected clock's time
 * @returns true when this call set it
 */
export async function claimRecovery(db: DbExecutor, id: number, now: Date): Promise<boolean> {
  const rows = await db
    .update(checkoutSessions)
    .set({ recoveryEmailedAt: now, updatedAt: now })
    .where(and(eq(checkoutSessions.id, id), isNull(checkoutSessions.recoveryEmailedAt)))
    .returning({ id: checkoutSessions.id });
  return rows.length > 0;
}

/**
 * Takes the "emailed" mark off a session.
 *
 * Why: the mark is set when the mail is queued; when the mail job then ends without sending anything, the checkout must not look
 * emailed: it shows as recoverable again and a later send can try again. The guard `recovery_emailed_at IS NOT NULL` makes it a no-op
 * for a session that was never claimed.
 *
 * @param db the caller's transaction
 * @param id the session
 * @param now the injected clock's time
 * @returns true when this call cleared the mark
 */
export async function releaseRecovery(db: DbExecutor, id: number, now: Date): Promise<boolean> {
  const rows = await db
    .update(checkoutSessions)
    .set({ recoveryEmailedAt: null, updatedAt: now })
    .where(and(eq(checkoutSessions.id, id), isNotNull(checkoutSessions.recoveryEmailedAt)))
    .returning({ id: checkoutSessions.id });
  return rows.length > 0;
}

/**
 * Selects the sessions the automatic reminder should email now.
 *
 * Why: the reminder takes a fixed number of the oldest due sessions each tick, so a session that can never be mailed (its customer's
 * language has no usable template) would be picked again and again and fill the batch, starving the others. `languages` leaves those
 * out of the selection: only customers whose language can be written in are taken.
 *
 * @param db the database or a transaction
 * @param clock the clock's time and the delay setting
 * @param limit the most to take
 * @param languages the customer languages that can be mailed now; `undefined` means every language
 * @returns the ids, oldest first (the ones closest to the end of the 30 days go first)
 */
export async function dueRecoveryIds(
  db: DbExecutor,
  clock: RecoveryClock,
  limit: number,
  languages?: readonly string[],
): Promise<number[]> {
  if (languages?.length === 0) return [];
  const rows = await db
    .select({ id: checkoutSessions.id })
    .from(checkoutSessions)
    .leftJoin(customers, eq(customers.id, checkoutSessions.customerId))
    .where(and(canRecoverSql(clock), languages === undefined ? undefined : inArray(customers.locale, [...languages])))
    .orderBy(asc(checkoutSessions.createdAt), asc(checkoutSessions.id))
    .limit(limit);
  return rows.map((row) => row.id);
}
