// Drizzle queries of the staff management routes on `staff_users` (identity module): the member with the joins the console
// shows (role, who added and who suspended, when the latest link was issued), and the writes of each action.
import { and, eq, sql } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import type { ParsedListQuery } from '../../../common/contract';
import { type DbExecutor, type ListColumns, listOrderBy, listWhere } from '../../../infra/db';
import { type NewStaffUser, type StaffUser, authTokens, roles, staffUsers } from '../db/schema';

const creators = alias(staffUsers, 'creators');
const suspenders = alias(staffUsers, 'suspenders');

/** A staff member with everything the console's row needs except the session count. */
export interface StaffRow {
  readonly staff: StaffUser;
  readonly role: { readonly id: number; readonly name: string; readonly permissions: string[] };
  readonly createdBy: { readonly id: number; readonly name: string } | null;
  readonly suspendedBy: { readonly id: number; readonly name: string } | null;
  /** When the latest invite or reset link was issued, before the "temporary password came later" rule. */
  readonly latestLinkAt: Date | null;
}

/** The latest invite or reset link of the member (`auth_tokens`, purposes `invite` and `reset`). */
const latestLinkAt = sql<Date | null>`(
  select max(${authTokens.createdAt}) from ${authTokens}
  where ${authTokens.subjectType} = 'staff' and ${authTokens.subjectId} = ${staffUsers.id}
    and ${authTokens.purpose} in ('invite', 'reset')
)`.mapWith(authTokens.createdAt);

const COLUMNS: ListColumns = {
  id: staffUsers.id,
  status: staffUsers.status,
  'role.id': staffUsers.roleId,
  name: staffUsers.name,
  email: staffUsers.email,
  createdAt: staffUsers.createdAt,
  lastLoginAt: staffUsers.lastLoginAt,
};

function selectRows(db: DbExecutor) {
  return db
    .select({
      staff: staffUsers,
      role: { id: roles.id, name: roles.name, permissions: roles.permissions },
      createdByRef: { id: creators.id, name: creators.name },
      suspendedByRef: { id: suspenders.id, name: suspenders.name },
      latestLinkAt,
    })
    .from(staffUsers)
    .innerJoin(roles, eq(roles.id, staffUsers.roleId))
    .leftJoin(creators, eq(creators.id, staffUsers.createdBy))
    .leftJoin(suspenders, eq(suspenders.id, staffUsers.suspendedBy));
}

type SelectedRow = Awaited<ReturnType<ReturnType<typeof selectRows>['limit']>>[number];

function toRow(row: SelectedRow): StaffRow {
  return {
    staff: row.staff,
    role: row.role,
    createdBy: row.createdByRef?.id == null ? null : { id: row.createdByRef.id, name: row.createdByRef.name },
    suspendedBy: row.suspendedByRef?.id == null ? null : { id: row.suspendedByRef.id, name: row.suspendedByRef.name },
    latestLinkAt: row.latestLinkAt,
  };
}

/**
 * Lists staff members for `GET /admin/staff`.
 *
 * @param db the database or a transaction
 * @param query the parsed list request
 * @returns the page of members with their joins, and the exact total
 */
export async function listStaffRows(
  db: DbExecutor,
  query: ParsedListQuery<'createdAt' | 'name' | 'email' | 'status' | 'lastLoginAt' | 'id'>,
): Promise<{ rows: StaffRow[]; total: number }> {
  const where = listWhere(query, COLUMNS);
  const [rows, [count]] = await Promise.all([
    selectRows(db)
      .where(where)
      .orderBy(...listOrderBy(query.sort, COLUMNS, staffUsers.id))
      .limit(query.range.limit)
      .offset(query.range.start),
    db
      .select({ total: sql<number>`count(*)::int` })
      .from(staffUsers)
      .where(where),
  ]);
  return { rows: rows.map(toRow), total: count?.total ?? 0 };
}

/**
 * Finds one staff member with the console's joins.
 *
 * @param db the database or a transaction
 * @param id the staff id
 * @returns the member, or `undefined`
 */
export async function findStaffRow(db: DbExecutor, id: number): Promise<StaffRow | undefined> {
  const [row] = await selectRows(db).where(eq(staffUsers.id, id)).limit(1);
  return row ? toRow(row) : undefined;
}

/**
 * Finds a staff member and locks the row for the rest of the transaction.
 *
 * Why: every staff action reads the member, checks a rule (own role, last Owner, already suspended) and writes; the lock keeps
 * two parallel actions on one member in order.
 *
 * @param db the transaction
 * @param id the staff id
 * @returns the member with their role's permissions, or `undefined`
 */
export async function lockStaff(
  db: DbExecutor,
  id: number,
): Promise<{ staff: StaffUser; permissions: string[] } | undefined> {
  const [row] = await db
    .select({ staff: staffUsers, permissions: roles.permissions })
    .from(staffUsers)
    .innerJoin(roles, eq(roles.id, staffUsers.roleId))
    .where(eq(staffUsers.id, id))
    .for('update', { of: staffUsers })
    .limit(1);
  return row;
}

/**
 * Inserts a staff member.
 *
 * @param db the database or a transaction
 * @param row the new account
 * @returns the stored account
 */
export async function insertStaffRow(db: DbExecutor, row: NewStaffUser): Promise<StaffUser> {
  const [created] = await db.insert(staffUsers).values(row).returning();
  return created!;
}

/**
 * Changes columns of a staff member.
 *
 * @param db the database or a transaction
 * @param id the staff id
 * @param changes the columns to write
 * @returns the updated account
 */
export async function updateStaffRow(
  db: DbExecutor,
  id: number,
  changes: Partial<NewStaffUser>,
): Promise<StaffUser | undefined> {
  const [row] = await db.update(staffUsers).set(changes).where(eq(staffUsers.id, id)).returning();
  return row;
}

/**
 * Reads the caller's own account status from the database.
 *
 * Why: decision 018: sensitive actions re-check the database, not the 60-second cached session view, so a suspension that was
 * just applied stops the caller's next staff-management write at once.
 *
 * @param db the database or a transaction
 * @param id the caller's staff id
 * @returns the status, or `undefined` when the account is gone
 */
export async function statusOfStaff(db: DbExecutor, id: number): Promise<StaffUser['status'] | undefined> {
  const [row] = await db.select({ status: staffUsers.status }).from(staffUsers).where(eq(staffUsers.id, id)).limit(1);
  return row?.status;
}

/**
 * Counts the staff members with an email, ignoring case, optionally leaving one out.
 *
 * @param db the database or a transaction
 * @param email the email
 * @param exceptId a staff id to leave out (the member being edited)
 * @returns the number of other accounts that use the email
 */
export async function countStaffWithEmail(db: DbExecutor, email: string, exceptId?: number): Promise<number> {
  const [row] = await db
    .select({ total: sql<number>`count(*)::int` })
    .from(staffUsers)
    .where(
      and(
        sql`lower(${staffUsers.email}) = ${email.toLowerCase()}`,
        exceptId === undefined ? undefined : sql`${staffUsers.id} <> ${exceptId}`,
      ),
    );
  return row?.total ?? 0;
}
