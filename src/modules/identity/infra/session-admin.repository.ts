// Drizzle queries of the admin session routes (identity module): the live, fully signed-in sessions of staff and merchants with
// the account behind each. All of them use the one live-session predicate of `security/session.repository.ts`.
import { and, eq, inArray, sql } from 'drizzle-orm';
import type { ParsedListQuery } from '../../../common/contract';
import { type DbExecutor, type ListColumns, listOrderBy, listWhere } from '../../../infra/db';
import { type Session, clients, sessions, staffUsers } from '../db/schema';
import { type IdleLimits, liveSessionCondition } from '../security/session.repository';

/** A live session with the name (and email) of the account that owns it. */
export interface SessionWithSubject {
  readonly session: Session;
  readonly subjectName: string | null;
  readonly subjectEmail: string | null;
}

/** Fully signed-in sessions of staff and merchants: the rows `GET /admin/sessions` may show (B9). */
const listed = sql`(${sessions.stage} = 'active' and ${sessions.subjectType} in ('staff', 'client'))`;

const COLUMNS: ListColumns = {
  subjectType: sessions.subjectType,
  lastSeenAt: sessions.lastSeenAt,
  createdAt: sessions.createdAt,
  id: sessions.id,
};

const subjectName = sql<string | null>`coalesce(${staffUsers.name}, ${clients.name})`;
const subjectEmail = sql<string | null>`coalesce(${staffUsers.email}, ${clients.email})`;

function withSubject(db: DbExecutor) {
  return db
    .select({ session: sessions, subjectName, subjectEmail })
    .from(sessions)
    .leftJoin(staffUsers, and(eq(sessions.subjectType, 'staff'), eq(staffUsers.id, sessions.subjectId)))
    .leftJoin(clients, and(eq(sessions.subjectType, 'client'), eq(clients.id, sessions.subjectId)));
}

/**
 * Lists the live sessions of staff and merchants.
 *
 * @param db the database or a transaction
 * @param query the parsed list request (range, sort, `subjectType` filter)
 * @param now the current time (the injected clock)
 * @param idle the idle limit of each subject type
 * @returns the page of sessions with their accounts, and the exact total
 */
export async function listLiveSessions(
  db: DbExecutor,
  query: ParsedListQuery<'lastSeenAt' | 'createdAt' | 'id'>,
  now: Date,
  idle: IdleLimits,
): Promise<{ rows: SessionWithSubject[]; total: number }> {
  const where = listWhere(query, COLUMNS, listed, liveSessionCondition(now, idle));
  const [rows, [count]] = await Promise.all([
    withSubject(db)
      .where(where)
      .orderBy(...listOrderBy(query.sort, COLUMNS, sessions.id))
      .limit(query.range.limit)
      .offset(query.range.start),
    db
      .select({ total: sql<number>`count(*)::int` })
      .from(sessions)
      .where(where),
  ]);
  return { rows, total: count?.total ?? 0 };
}

/**
 * Finds a session that `GET /admin/sessions` would list.
 *
 * Why: `DELETE /admin/sessions/:id` answers 404 for anything the list does not show (RESOLUTIONS identity-platform-6).
 *
 * @param db the database or a transaction
 * @param id the session id
 * @param now the current time
 * @param idle the idle limit of each subject type
 * @returns the session with its account, or `undefined`
 */
export async function findListedSession(
  db: DbExecutor,
  id: number,
  now: Date,
  idle: IdleLimits,
): Promise<SessionWithSubject | undefined> {
  const [row] = await withSubject(db)
    .where(and(eq(sessions.id, id), listed, liveSessionCondition(now, idle)))
    .limit(1);
  return row;
}

/**
 * Counts the live, fully signed-in sessions of several staff members.
 *
 * Why: `StaffMember.activeSessions` enables "Sign out all devices"; it counts what the sessions list would show.
 *
 * @param db the database or a transaction
 * @param staffIds the staff members
 * @param now the current time
 * @param idle the idle limit of each subject type
 * @returns the count per staff id (members with no live session are absent)
 */
export async function countLiveStaffSessions(
  db: DbExecutor,
  staffIds: readonly number[],
  now: Date,
  idle: IdleLimits,
): Promise<Map<number, number>> {
  if (staffIds.length === 0) return new Map();
  const rows = await db
    .select({ staffId: sessions.subjectId, total: sql<number>`count(*)::int` })
    .from(sessions)
    .where(
      and(
        eq(sessions.subjectType, 'staff'),
        inArray(sessions.subjectId, [...staffIds]),
        eq(sessions.stage, 'active'),
        liveSessionCondition(now, idle),
      ),
    )
    .groupBy(sessions.subjectId);
  return new Map(rows.map((row) => [row.staffId, row.total]));
}
