// Drizzle queries of the admin session routes (identity module): the live, fully signed-in sessions of staff with the account
// behind each, and the counts of live sessions of staff and merchants. All of them use the one live-session predicate of
// `security/session.repository.ts`.
import { and, eq, inArray, sql } from 'drizzle-orm';
import type { ParsedListQuery } from '../../../common/contract';
import { type DbExecutor, type ListColumns, listOrderBy, listWhere } from '../../../infra/db';
import { type Session, roles, sessions, staffUsers } from '../db/schema';
import { type IdleLimits, liveSessionCondition } from '../security/session.repository';

/** A live staff session with the name (and email) of the staff member, and the permissions of the member's role. */
export interface SessionWithSubject {
  readonly session: Session;
  readonly subjectName: string | null;
  readonly subjectEmail: string | null;
  /** The permissions of the staff member's role; `null` for an account that no longer exists. */
  readonly subjectPermissions: string[] | null;
}

/** Fully signed-in sessions of staff: the rows `GET /admin/sessions` may show (B9). */
const listed = sql`(${sessions.stage} = 'active' and ${sessions.subjectType} = 'staff')`;

const COLUMNS: ListColumns = {
  subjectType: sessions.subjectType,
  lastSeenAt: sessions.lastSeenAt,
  createdAt: sessions.createdAt,
  id: sessions.id,
};

function withSubject(db: DbExecutor) {
  return db
    .select({
      session: sessions,
      subjectName: staffUsers.name,
      subjectEmail: staffUsers.email,
      subjectPermissions: roles.permissions,
    })
    .from(sessions)
    .leftJoin(staffUsers, eq(staffUsers.id, sessions.subjectId))
    .leftJoin(roles, eq(roles.id, staffUsers.roleId));
}

/**
 * Lists the live sessions of staff.
 *
 * @param db the database or a transaction
 * @param query the parsed list request (range, sort, `subjectType` filter, which accepts only `staff`)
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
 * Counts the live, fully signed-in sessions of several accounts of one subject type.
 *
 * Why: `StaffMember.activeSessions` and `Client.security.activeSessions` enable "Sign out all devices"; both count what the sessions
 * list would show.
 *
 * @param db the database or a transaction
 * @param subjectType `staff` or `client`
 * @param ids the account ids
 * @param now the current time
 * @param idle the idle limit of each subject type
 * @returns the count per account id (accounts with no live session are absent)
 */
export async function countLiveSessionsOf(
  db: DbExecutor,
  subjectType: 'staff' | 'client',
  ids: readonly number[],
  now: Date,
  idle: IdleLimits,
): Promise<Map<number, number>> {
  if (ids.length === 0) return new Map();
  const rows = await db
    .select({ subjectId: sessions.subjectId, total: sql<number>`count(*)::int` })
    .from(sessions)
    .where(
      and(
        eq(sessions.subjectType, subjectType),
        inArray(sessions.subjectId, [...ids]),
        eq(sessions.stage, 'active'),
        liveSessionCondition(now, idle),
      ),
    )
    .groupBy(sessions.subjectId);
  return new Map(rows.map((row) => [row.subjectId, row.total]));
}

/**
 * Counts the live, fully signed-in sessions of several staff members.
 *
 * @param db the database or a transaction
 * @param staffIds the staff members
 * @param now the current time
 * @param idle the idle limit of each subject type
 * @returns the count per staff id (members with no live session are absent)
 */
export function countLiveStaffSessions(
  db: DbExecutor,
  staffIds: readonly number[],
  now: Date,
  idle: IdleLimits,
): Promise<Map<number, number>> {
  return countLiveSessionsOf(db, 'staff', staffIds, now, idle);
}
