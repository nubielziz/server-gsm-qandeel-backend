// Drizzle queries on `sessions` for the merchant portal's "my devices" routes (identity module): the live sessions of one
// merchant. The live rule is the one predicate of resolution identity-platform-6 (`liveSessionCondition`), shared with the staff
// routes.
import { type SQL, and, asc, count, desc, eq } from 'drizzle-orm';
import type { DbExecutor } from '../../../infra/db';
import { type Session, sessions } from '../db/schema';
import { liveSessionCondition } from '../security/session.repository';

/** The columns the list may be sorted by (wire names `createdAt`, `lastSeenAt`). */
export type ClientSessionSortField = 'createdAt' | 'lastSeenAt';

/** The page of the list: a range, the sort keys and the exact total. */
export interface ClientSessionPage {
  readonly rows: Session[];
  readonly total: number;
}

/**
 * The condition "this row is a live, fully signed-in session of this merchant".
 *
 * Why: B135/B136 and identity-platform-6: not revoked, not past `expires_at`, and for a full session `last_seen_at` within the
 * idle limit of merchants (`sessions.client_idle_minutes`); a session the idle rule ended reads as already ended. Only the
 * `active` stage is listed (B9): a pending sign-in step is not a device.
 *
 * @param clientId the merchant id
 * @param now the injected clock's time (decision 031)
 * @param idleMs the merchant idle limit in milliseconds
 * @returns the SQL condition
 */
function liveActiveSessionOf(clientId: number, now: Date, idleMs: number): SQL {
  return and(
    eq(sessions.subjectType, 'client'),
    eq(sessions.subjectId, clientId),
    eq(sessions.stage, 'active'),
    // The shared live rule; the row is a merchant's, so only the merchant idle limit can apply.
    liveSessionCondition(now, { staff: idleMs, client: idleMs, customer: idleMs }),
  )!;
}

/**
 * Lists a merchant's live sessions.
 *
 * @param db the database or a transaction
 * @param clientId the merchant id
 * @param now the injected clock's time
 * @param idleMs the merchant idle limit in milliseconds
 * @param page the range (`offset`, `limit`) and the sort keys; the id is appended so the order is stable
 * @returns the rows in the range and the exact count of live sessions
 */
export async function listLiveClientSessions(
  db: DbExecutor,
  clientId: number,
  now: Date,
  idleMs: number,
  page: {
    readonly offset: number;
    readonly limit: number;
    readonly sort: readonly { readonly field: ClientSessionSortField; readonly order: 'asc' | 'desc' }[];
  },
): Promise<ClientSessionPage> {
  const where = liveActiveSessionOf(clientId, now, idleMs);
  const columns = { createdAt: sessions.createdAt, lastSeenAt: sessions.lastSeenAt };
  const order = page.sort.map(({ field, order: direction }) =>
    direction === 'asc' ? asc(columns[field]) : desc(columns[field]),
  );
  const rows = await db
    .select()
    .from(sessions)
    .where(where)
    .orderBy(...order, desc(sessions.id))
    .limit(page.limit)
    .offset(page.offset);
  const [{ total } = { total: 0 }] = await db.select({ total: count() }).from(sessions).where(where);
  return { rows, total };
}

/**
 * Finds one live session of a merchant.
 *
 * Why: `DELETE /client/sessions/:id` answers 404 for a session that is not the caller's, unknown, or no longer live (B136), all
 * the same.
 *
 * @param db the database or a transaction
 * @param clientId the merchant id
 * @param sessionId the session id from the URL
 * @param now the injected clock's time
 * @param idleMs the merchant idle limit in milliseconds
 * @returns the session, or `undefined`
 */
export async function findLiveClientSession(
  db: DbExecutor,
  clientId: number,
  sessionId: number,
  now: Date,
  idleMs: number,
): Promise<Session | undefined> {
  const [row] = await db
    .select()
    .from(sessions)
    .where(and(eq(sessions.id, sessionId), liveActiveSessionOf(clientId, now, idleMs)))
    .limit(1);
  return row;
}
