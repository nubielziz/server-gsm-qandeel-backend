// Drizzle queries of the role routes on `roles` (identity module), with the number of staff who hold each role.
import { and, eq, sql } from 'drizzle-orm';
import type { ParsedListQuery } from '../../../common/contract';
import { type DbExecutor, type ListColumns, listOrderBy, listWhere } from '../../../infra/db';
import { type NewRole, type Role, roles, staffUsers } from '../db/schema';

/** A role with the staff members who hold it. */
export interface RoleWithCount {
  readonly role: Role;
  readonly staffCount: number;
}

/**
 * Counts the staff of a role, any status (the console disables Delete when it is above zero).
 *
 * The outer column is written out (`"roles"."id"`) and the inner table aliased: in a one-table select Drizzle prints
 * `${roles.id}` as a bare `"id"`, which inside the subquery would mean `staff_users.id` and count the wrong rows.
 */
const staffCountOf = sql<number>`(select count(*)::int from ${staffUsers} as role_member where role_member.role_id = "roles"."id")`;

const COLUMNS: ListColumns = { id: roles.id, name: roles.name };

/**
 * Lists roles for `GET /admin/roles`.
 *
 * @param db the database or a transaction
 * @param query the parsed list request (range, sort, search)
 * @returns the page of roles with their staff counts, and the exact total
 */
export async function listRoleRows(
  db: DbExecutor,
  query: ParsedListQuery<'id' | 'name'>,
): Promise<{ rows: RoleWithCount[]; total: number }> {
  const where = listWhere(query, COLUMNS);
  const [rows, [count]] = await Promise.all([
    db
      .select({ role: roles, staffCount: staffCountOf })
      .from(roles)
      .where(where)
      .orderBy(...listOrderBy(query.sort, COLUMNS, roles.id))
      .limit(query.range.limit)
      .offset(query.range.start),
    db
      .select({ total: sql<number>`count(*)::int` })
      .from(roles)
      .where(where),
  ]);
  return { rows, total: count?.total ?? 0 };
}

/**
 * Finds a role with its staff count.
 *
 * @param db the database or a transaction
 * @param id the role id
 * @returns the role, or `undefined`
 */
export async function findRoleWithCount(db: DbExecutor, id: number): Promise<RoleWithCount | undefined> {
  const [row] = await db.select({ role: roles, staffCount: staffCountOf }).from(roles).where(eq(roles.id, id)).limit(1);
  return row;
}

/**
 * Finds a role by id and locks it for the rest of the transaction.
 *
 * Why: a role change and a staff role assignment must not interleave (the staff member could gain a role that was just
 * emptied of its permissions, or hold a role that is deleted meanwhile).
 *
 * @param db the transaction
 * @param id the role id
 * @returns the role, or `undefined`
 */
export async function lockRole(db: DbExecutor, id: number): Promise<Role | undefined> {
  const [row] = await db.select().from(roles).where(eq(roles.id, id)).for('update').limit(1);
  return row;
}

/**
 * Finds a role by id.
 *
 * @param db the database or a transaction
 * @param id the role id
 * @returns the role, or `undefined`
 */
export async function findRole(db: DbExecutor, id: number): Promise<Role | undefined> {
  const [row] = await db.select().from(roles).where(eq(roles.id, id)).limit(1);
  return row;
}

/**
 * Inserts a role.
 *
 * @param db the database or a transaction
 * @param row the new role
 * @returns the stored role
 */
export async function insertRoleRow(db: DbExecutor, row: Pick<NewRole, 'name' | 'permissions'>): Promise<Role> {
  const [created] = await db.insert(roles).values(row).returning();
  return created!;
}

/**
 * Changes a role's name and/or permissions.
 *
 * @param db the database or a transaction
 * @param id the role id
 * @param changes the keys that change
 * @returns the updated role, or `undefined` when it is gone
 */
export async function updateRoleRow(
  db: DbExecutor,
  id: number,
  changes: Partial<Pick<NewRole, 'name' | 'permissions'>>,
): Promise<Role | undefined> {
  const [row] = await db.update(roles).set(changes).where(eq(roles.id, id)).returning();
  return row;
}

/**
 * Deletes a role.
 *
 * @param db the database or a transaction
 * @param id the role id
 * @returns true when a row was deleted
 */
export async function deleteRoleRow(db: DbExecutor, id: number): Promise<boolean> {
  const rows = await db.delete(roles).where(eq(roles.id, id)).returning({ id: roles.id });
  return rows.length > 0;
}

/**
 * Counts the staff members who hold a role, any status.
 *
 * @param db the database or a transaction
 * @param roleId the role id
 * @returns the count
 */
export async function countStaffOfRole(db: DbExecutor, roleId: number): Promise<number> {
  const [row] = await db
    .select({ total: sql<number>`count(*)::int` })
    .from(staffUsers)
    .where(eq(staffUsers.roleId, roleId));
  return row?.total ?? 0;
}

/**
 * Counts the active staff members of a role.
 *
 * @param db the database or a transaction
 * @param roleId the role id
 * @returns the count
 */
export async function countActiveStaffOfRole(db: DbExecutor, roleId: number): Promise<number> {
  const [row] = await db
    .select({ total: sql<number>`count(*)::int` })
    .from(staffUsers)
    .where(and(eq(staffUsers.roleId, roleId), eq(staffUsers.status, 'active')));
  return row?.total ?? 0;
}
