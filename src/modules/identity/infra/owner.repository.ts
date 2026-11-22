// Queries behind the Owner rules (decision 018, RESOLUTIONS identity-platform-4): who is an active Owner, and the lock that
// keeps two changes from removing the last two Owners together.
import { and, eq, isNotNull, ne, sql } from 'drizzle-orm';
import type { DbExecutor } from '../../../infra/db';
import { roles, sessions, staffUsers } from '../db/schema';
import { type IdleLimits, liveSessionCondition } from '../security/session.repository';

/** The advisory lock key of every change that can remove an Owner (a fixed number: `hashtext` of a name is not stable). */
const OWNER_LOCK_KEY = 7_201_001;

/**
 * Serialises the changes that can remove an active Owner for the rest of the transaction.
 *
 * Why: "the last Owner" is a count. Two parallel requests (suspend one Owner, demote the other) each see two Owners and both
 * pass; the transaction-level advisory lock makes the second wait for the first and count again.
 *
 * Side effects: takes `pg_advisory_xact_lock`, released at commit or rollback.
 *
 * @param db the transaction
 */
export async function lockOwnerChanges(db: DbExecutor): Promise<void> {
  await db.execute(sql`select pg_advisory_xact_lock(${OWNER_LOCK_KEY})`);
}

/** The role holds the permission that grants everything (`*`, or its spelling `*:*`). */
const grantsAll = sql`('*' = any(${roles.permissions}) or '*:*' = any(${roles.permissions}))`;

/**
 * Counts the active staff members whose role grants everything.
 *
 * Why: the last-Owner rule: an Owner is a staff member whose role contains `*` (MISMATCHES B113); an account that never
 * signed in (`invited`) or is suspended cannot run the console, so it does not count.
 *
 * @param db the database or a transaction
 * @param excluding what to leave out: one staff member (the one being changed) or one role (the one being edited)
 * @returns how many active Owners remain
 */
export async function countActiveOwners(
  db: DbExecutor,
  excluding: { readonly staffId?: number; readonly roleId?: number } = {},
): Promise<number> {
  const [row] = await db
    .select({ total: sql<number>`count(*)::int` })
    .from(staffUsers)
    .innerJoin(roles, eq(roles.id, staffUsers.roleId))
    .where(
      and(
        eq(staffUsers.status, 'active'),
        grantsAll,
        excluding.staffId === undefined ? undefined : ne(staffUsers.id, excluding.staffId),
        excluding.roleId === undefined ? undefined : ne(roles.id, excluding.roleId),
      ),
    );
  return row?.total ?? 0;
}

/**
 * The addresses active Owners use: the address of each of their live, fully signed-in sessions and each one's last sign-in
 * address.
 *
 * Why: decision 046: a staff member who is not an Owner cannot shut these out of the console; a signed-out Owner is protected by
 * the last sign-in address.
 *
 * @param db the database or a transaction
 * @param now the injected clock's time (decision 031), for the live-session rule
 * @param idle the idle limit of each subject type in milliseconds
 * @returns the distinct addresses as stored (not parsed)
 */
export async function activeOwnerAddresses(db: DbExecutor, now: Date, idle: IdleLimits): Promise<string[]> {
  const live = await db
    .select({ ip: sessions.ip })
    .from(sessions)
    .innerJoin(staffUsers, eq(staffUsers.id, sessions.subjectId))
    .innerJoin(roles, eq(roles.id, staffUsers.roleId))
    .where(
      and(
        eq(sessions.subjectType, 'staff'),
        eq(sessions.stage, 'active'),
        liveSessionCondition(now, idle),
        eq(staffUsers.status, 'active'),
        grantsAll,
      ),
    );
  const last = await db
    .select({ ip: staffUsers.lastLoginIp })
    .from(staffUsers)
    .innerJoin(roles, eq(roles.id, staffUsers.roleId))
    .where(and(eq(staffUsers.status, 'active'), isNotNull(staffUsers.lastLoginIp), grantsAll));
  return [...new Set([...live.map((row) => row.ip), ...last.flatMap((row) => (row.ip === null ? [] : [row.ip]))])];
}
