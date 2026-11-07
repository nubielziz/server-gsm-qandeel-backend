// Drizzle queries on `sessions` (identity module). Every function takes a DbExecutor, so a sign-in step can run several of
// them in one transaction; times come from the caller, so the application and the tests share one clock.
import { type SQL, and, eq, gt, isNull, lte, ne, sql } from 'drizzle-orm';
import type { DbExecutor } from '../../../infra/db';
import { type NewSession, type Session, type SubjectType, sessions } from '../db/schema';

/**
 * Inserts a session.
 *
 * @param db the database or a transaction
 * @param row the new session (token already hashed)
 * @returns the stored row
 */
export async function insertSession(db: DbExecutor, row: NewSession): Promise<Session> {
  const [created] = await db.insert(sessions).values(row).returning();
  return created!;
}

/**
 * Finds a session by its token hash, only while it is neither revoked nor past its absolute end.
 *
 * Why: the guards look sessions up by the hash of the cookie token (unique index, decision 019).
 *
 * @param db the database or a transaction
 * @param tokenHash the keyed hash of the token
 * @param now the current time
 * @returns the live session, or `undefined`
 */
export async function findLiveSessionByHash(
  db: DbExecutor,
  tokenHash: string,
  now: Date,
): Promise<Session | undefined> {
  const [row] = await db
    .select()
    .from(sessions)
    .where(and(eq(sessions.tokenHash, tokenHash), isNull(sessions.revokedAt), gt(sessions.expiresAt, now)))
    .limit(1);
  return row;
}

/**
 * Revokes one session if it is still live.
 *
 * Why: the guarded `UPDATE ... WHERE revoked_at IS NULL` makes revoking and rotating race-safe: only one caller gets the row
 * back (decision 018, idempotent sign-in steps).
 *
 * @param db the database or a transaction
 * @param id the session id
 * @param now the revocation time
 * @returns the row that was revoked, or `undefined` when it was already revoked
 */
export async function revokeLiveSession(db: DbExecutor, id: number, now: Date): Promise<Session | undefined> {
  const [row] = await db
    .update(sessions)
    .set({ revokedAt: now })
    .where(and(eq(sessions.id, id), isNull(sessions.revokedAt)))
    .returning();
  return row;
}

/**
 * Revokes every live session of a subject, optionally keeping one.
 *
 * @param db the database or a transaction
 * @param subjectType staff, client or customer
 * @param subjectId the account id
 * @param now the revocation time
 * @param exceptId a session to keep (the caller's own, after a password change)
 * @returns the revoked rows (their token hashes name the cache keys to delete)
 */
export async function revokeLiveSessionsOf(
  db: DbExecutor,
  subjectType: SubjectType,
  subjectId: number,
  now: Date,
  exceptId?: number,
): Promise<Session[]> {
  return db
    .update(sessions)
    .set({ revokedAt: now })
    .where(
      and(
        eq(sessions.subjectType, subjectType),
        eq(sessions.subjectId, subjectId),
        isNull(sessions.revokedAt),
        exceptId === undefined ? undefined : ne(sessions.id, exceptId),
      ),
    )
    .returning();
}

/**
 * Lists the token hashes of a subject's live sessions.
 *
 * Why: when an account changes (suspension, role, password) the cached views of its sessions must be deleted.
 *
 * @param db the database or a transaction
 * @param subjectType staff, client or customer
 * @param subjectId the account id
 * @returns the hashes of the sessions that are not revoked
 */
export async function liveTokenHashesOf(
  db: DbExecutor,
  subjectType: SubjectType,
  subjectId: number,
): Promise<string[]> {
  const rows = await db
    .select({ tokenHash: sessions.tokenHash })
    .from(sessions)
    .where(and(eq(sessions.subjectType, subjectType), eq(sessions.subjectId, subjectId), isNull(sessions.revokedAt)));
  return rows.map((row) => row.tokenHash);
}

/**
 * Writes `last_seen_at`, but only if the stored value is at least `minGapMs` old.
 *
 * Why: decision 018 writes it at most once a minute; the guard in the `WHERE` keeps that true across API instances.
 *
 * @param db the database or a transaction
 * @param id the session id
 * @param now the time to write
 * @param minGapMs the shortest time between two writes
 * @returns true when a row was updated
 */
export async function touchSession(db: DbExecutor, id: number, now: Date, minGapMs: number): Promise<boolean> {
  const rows = await db
    .update(sessions)
    .set({ lastSeenAt: now })
    .where(
      and(
        eq(sessions.id, id),
        isNull(sessions.revokedAt),
        lte(sessions.lastSeenAt, new Date(now.getTime() - minGapMs)),
      ),
    )
    .returning({ id: sessions.id });
  return rows.length > 0;
}

/** How long a full session of each subject type may sit unused, in milliseconds (`SessionPolicy.limits(...).idleMs`). */
export type IdleLimits = Readonly<Record<SubjectType, number>>;

/**
 * The one "live session" predicate (RESOLUTIONS identity-platform-6): not revoked, not past its absolute end, and, for a full
 * session, used within the idle limit of its subject type. A pending sign-in step has no idle limit, only its short lifetime.
 *
 * Why: `GET /admin/sessions`, `StaffMember.activeSessions` (which enables "Sign out all devices"), the
 * `DELETE /admin/sessions/:id` 404 and the merchant `GET /client/sessions` must agree on what "active" means, so the rule is
 * written once. `now` is the injected clock's time (decision 031), never the database's `now()`. `revokeAllOf` is not
 * limited by it: it still revokes every non-revoked row, idle-dead ones included.
 *
 * @param now the current time
 * @param idle the idle limit of each subject type in milliseconds
 * @returns the condition on `sessions` to use in a `WHERE`
 */
export function liveSessionCondition(now: Date, idle: IdleLimits): SQL {
  const cutoff = (ms: number): string => new Date(now.getTime() - ms).toISOString();
  return sql`(${sessions.revokedAt} is null
    and ${sessions.expiresAt} > ${now.toISOString()}::timestamptz
    and (${sessions.stage} <> 'active'
      or ${sessions.lastSeenAt} > case ${sessions.subjectType}
        when 'staff' then ${cutoff(idle.staff)}::timestamptz
        when 'client' then ${cutoff(idle.client)}::timestamptz
        else ${cutoff(idle.customer)}::timestamptz
      end))`;
}
