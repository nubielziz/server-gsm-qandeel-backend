// RoleAdminService: the use cases of the role routes (map domain A, stage 2): list, show, create, update, delete and the
// permission catalog. Roles are free records of permission strings; the Owner rules keep the console from losing its last Owner.
import { Injectable } from '@nestjs/common';
import type { ParsedListQuery } from '../../../common/contract';
import { AppError } from '../../../common/errors';
import { DbService, isForeignKeyViolation, isUniqueViolation } from '../../../infra/db';
import { AuditService } from '../../platform';
import type { Role } from '../db/schema';
import { cleanPermissions, describePermission, samePermissions, unknownPermissions } from '../domain/role-rules';
import { countActiveOwners, lockOwnerChanges } from '../infra/owner.repository';
import {
  type RoleWithCount,
  countActiveStaffOfRole,
  countStaffOfRole,
  deleteRoleRow,
  findRoleWithCount,
  insertRoleRow,
  listRoleRows,
  lockRole,
  staffIdsOfRole,
  updateRoleRow,
} from '../infra/role.repository';
import { grants, grantsEverything } from '../security/permission-grammar';
import { PermissionsCatalog } from '../security/permissions-catalog';
import {
  PER_PERSON_MONEY_PERMISSIONS,
  assertOwnerTargetAllowed,
  assertWithinCeiling,
  isOwner,
  requireOwner,
} from '../security/principal';
import type { StaffPrincipal } from '../security/principal';
import { RolePermissions } from '../security/role-permissions';
import { SessionService } from '../security/session.service';

/** A role as the console reads it. */
export interface RoleView {
  readonly id: number;
  readonly name: string;
  readonly permissions: string[];
  readonly staffCount: number;
}

/** The keys `PATCH /admin/roles/:id` may change. */
export interface RoleChanges {
  readonly name?: string | undefined;
  readonly permissions?: string[] | undefined;
}

const toView = ({ role, staffCount }: RoleWithCount): RoleView => ({
  id: role.id,
  name: role.name,
  permissions: role.permissions,
  staffCount,
});

const snapshot = (role: Pick<Role, 'name' | 'permissions'>) => ({ name: role.name, permissions: role.permissions });

const OWNER_ARMS_HELD_ROLE_DETAIL =
  'Only an owner can give a role that staff members hold the right to adjust wallets, set credit limits, approve payments or ' +
  'issue invoices.';

function nameTaken(): AppError {
  return new AppError('VALIDATION_FAILED', {
    errors: [{ field: 'name', code: 'duplicate', message: 'Another role already has this name.' }],
  });
}

/**
 * Manages roles.
 *
 * Why: the map treats roles as free records with a permissions list (MISMATCHES B8); staff get their permissions from the
 * role they hold, on every request (decision 018). Changes apply on the next request because every change deletes the role's
 * cached permissions after its commit.
 *
 * Owner rules (decision 018, RESOLUTIONS identity-platform-4): a role that grants `*` is an Owner role: only an Owner may
 * create, edit or delete one, or give a role `*`; removing `*` from the role of the last active Owner is `409 LAST_OWNER`
 * on `permissions` (the Owner role may be renamed); the check runs under an advisory lock so two parallel changes cannot
 * both pass.
 *
 * Privilege ceiling (decision 046): the caller must hold every permission of a role they create, edit or delete, and every
 * permission they give it; only an Owner edits the role they hold themselves (`409 CANNOT_CHANGE_OWN_ROLE` for everyone else).
 *
 * Money rules per person (decision 049): a role that a staff member of any status holds gains an entry of
 * `PER_PERSON_MONEY_PERMISSIONS` only from an Owner; a role nobody holds stays editable, because giving it to a member needs an Owner.
 *
 * Open live streams: a change of a role's permissions ends the open streams of its members (`SessionService.invalidateSubject`, so
 * each stream gets `bye reauth` and reconnects with the permissions of the moment); the streams copy the permissions when they open.
 *
 * Side effects: writes `roles` and `audit_logs`; deletes `gsm:{env}:identity:role:{id}` after the commit; when the permissions
 * change, deletes the cached session views of the role's members and rings `session subject` (ids only) for those with live sessions.
 *
 * @see docs/contract/endpoints/identity.md (the `/admin/roles` and `/admin/permissions` sections)
 */
@Injectable()
export class RoleAdminService {
  constructor(
    private readonly db: DbService,
    private readonly audit: AuditService,
    private readonly catalog: PermissionsCatalog,
    private readonly rolePermissions: RolePermissions,
    private readonly sessions: SessionService,
  ) {}

  /**
   * Lists roles.
   *
   * @param query the parsed list request
   * @returns the page of roles and the exact total
   */
  async list(query: ParsedListQuery<'id' | 'name'>): Promise<{ rows: RoleView[]; total: number }> {
    const { rows, total } = await listRoleRows(this.db.db, query);
    return { rows: rows.map(toView), total };
  }

  /**
   * Shows one role.
   *
   * @param id the role id
   * @returns the role
   * @throws {AppError} `NOT_FOUND` (404)
   */
  async show(id: number): Promise<RoleView> {
    const found = await findRoleWithCount(this.db.db, id);
    if (!found) throw new AppError('NOT_FOUND', { detail: 'No role has this id.' });
    return toView(found);
  }

  /**
   * Lists the permission catalog for the role editor.
   *
   * @returns every concrete permission with its group and label
   */
  permissions(): Array<{ key: string; label: string; group: string }> {
    return this.catalog.list().map(describePermission);
  }

  /**
   * Creates a role.
   *
   * @param caller the signed-in staff member
   * @param input the name and permissions
   * @returns the new role (no holders yet)
   * @throws {AppError} `VALIDATION_FAILED` (422 on `permissions` for unknown entries, on `name` for a duplicate), `FORBIDDEN`
   *   (403: only an Owner may create a role that grants `*`; the caller must hold every permission given, decision 046)
   */
  async create(caller: StaffPrincipal, input: { name: string; permissions: string[] }): Promise<RoleView> {
    const permissions = this.checkedPermissions(input.permissions);
    if (grantsEverything(permissions)) assertOwnerTargetAllowed(caller, { permissions });
    assertWithinCeiling(caller, permissions, 'list');
    return this.db.runInTransaction(async (work) => {
      let role: Role;
      try {
        role = await insertRoleRow(work.tx, { name: input.name, permissions });
      } catch (error) {
        if (isUniqueViolation(error, 'roles_name_uq')) throw nameTaken();
        throw error;
      }
      await this.rolePermissions.invalidate(role.id, work);
      await this.audit.record(work.tx, {
        action: 'created role',
        entityType: 'role',
        entityId: role.id,
        entityLabel: role.name,
        after: snapshot(role),
      });
      return { id: role.id, name: role.name, permissions: role.permissions, staffCount: 0 };
    });
  }

  /**
   * Changes a role's name and/or permissions.
   *
   * @param caller the signed-in staff member
   * @param id the role id
   * @param changes the keys to change
   * @returns the updated role
   * Side effects: see the class; the members' open streams end only when the permissions really change.
   *
   * @throws {AppError} `NOT_FOUND` (404), `VALIDATION_FAILED` (422), `CANNOT_CHANGE_OWN_ROLE` (409: the caller holds this role and
   *   is not an Owner), `FORBIDDEN` (403: an Owner role, or granting `*`, needs an Owner; the caller must hold every permission
   *   the role has and every permission sent, decision 046; a role somebody holds gains a permission whose money rules count per
   *   person only from an Owner, decision 049), `LAST_OWNER` (409 on `permissions`)
   */
  async update(caller: StaffPrincipal, id: number, changes: RoleChanges): Promise<RoleView> {
    const permissions = changes.permissions === undefined ? undefined : this.checkedPermissions(changes.permissions);
    return this.db.runInTransaction(async (work) => {
      await lockOwnerChanges(work.tx);
      const before = await lockRole(work.tx, id);
      if (!before) throw new AppError('NOT_FOUND', { detail: 'No role has this id.' });
      // Decision 046: only an Owner edits the role they hold (the last-Owner rule below still applies to them).
      if (before.id === caller.roleId && !isOwner(caller)) {
        throw new AppError('CANNOT_CHANGE_OWN_ROLE', { detail: 'You cannot edit the role you hold.' });
      }
      assertOwnerTargetAllowed(caller, before);
      // Editing a role acts on everyone who holds it: the caller must hold what it has now and what it will have.
      assertWithinCeiling(caller, before.permissions, 'role');
      if (permissions && grantsEverything(permissions)) assertOwnerTargetAllowed(caller, { permissions });
      if (permissions) assertWithinCeiling(caller, permissions, 'list');
      // Decision 049 counts these money rules per staff member: the holders of a role must not gain one without an Owner. Adding a
      // member and changing a member's role lock this role row too, so the count cannot miss a holder added meanwhile.
      if (
        permissions &&
        PER_PERSON_MONEY_PERMISSIONS.some(
          (entry) => grants(permissions, entry) && !grants(before.permissions, entry),
        ) &&
        (await countStaffOfRole(work.tx, id)) > 0
      ) {
        requireOwner(caller, OWNER_ARMS_HELD_ROLE_DETAIL);
      }
      if (permissions && grantsEverything(before.permissions) && !grantsEverything(permissions)) {
        await this.assertAnotherOwnerRemains(work.tx, before.id);
      }

      let after: Role;
      try {
        after = (await updateRoleRow(work.tx, id, {
          ...(changes.name === undefined ? {} : { name: changes.name }),
          ...(permissions === undefined ? {} : { permissions }),
        }))!;
      } catch (error) {
        if (isUniqueViolation(error, 'roles_name_uq')) throw nameTaken();
        throw error;
      }
      await this.rolePermissions.invalidate(id, work);
      // The open streams copied the old permissions when they opened: end them after the role cache is dropped (the callbacks run
      // in registration order), so each reconnect reads the new list. The member list is read under the role lock.
      if (permissions && !samePermissions(before.permissions, after.permissions)) {
        for (const memberId of await staffIdsOfRole(work.tx, id)) {
          await this.sessions.invalidateSubject('staff', memberId, work);
        }
      }
      await this.audit.record(work.tx, {
        action: 'edited role',
        entityType: 'role',
        entityId: id,
        entityLabel: after.name,
        before: snapshot(before),
        after: snapshot(after),
      });
      const staffCount = await countStaffOfRole(work.tx, id);
      return { id: after.id, name: after.name, permissions: after.permissions, staffCount };
    });
  }

  /**
   * Deletes a role nobody holds.
   *
   * @param caller the signed-in staff member
   * @param id the role id
   * @throws {AppError} `NOT_FOUND` (404), `ROLE_IN_USE` (409: a staff member of any status holds it, the caller's own role
   *   included), `FORBIDDEN` (403: an Owner role needs an Owner; the caller must hold every permission of the role, decision 046)
   */
  async remove(caller: StaffPrincipal, id: number): Promise<void> {
    await this.db.runInTransaction(async (work) => {
      await lockOwnerChanges(work.tx);
      const role = await lockRole(work.tx, id);
      if (!role) throw new AppError('NOT_FOUND', { detail: 'No role has this id.' });
      assertOwnerTargetAllowed(caller, role);
      assertWithinCeiling(caller, role.permissions, 'role');
      const inUse = new AppError('ROLE_IN_USE', { detail: 'Move the staff members to another role first.' });
      if ((await countStaffOfRole(work.tx, id)) > 0) throw inUse;
      try {
        await deleteRoleRow(work.tx, id);
      } catch (error) {
        // A staff member took the role between the count and the delete: the foreign key says no.
        if (isForeignKeyViolation(error)) throw inUse;
        throw error;
      }
      await this.rolePermissions.invalidate(id, work);
      await this.audit.record(work.tx, {
        action: 'deleted role',
        entityType: 'role',
        entityId: id,
        entityLabel: role.name,
        before: snapshot(role),
      });
    });
  }

  /** Cleans a permission list and refuses entries the catalog does not know. */
  private checkedPermissions(entries: readonly string[]): string[] {
    const permissions = cleanPermissions(entries);
    const unknown = unknownPermissions(permissions, this.catalog.list());
    if (unknown.length > 0) {
      throw new AppError('VALIDATION_FAILED', {
        errors: [{ field: 'permissions', code: 'unknown', message: `Unknown permissions: ${unknown.join(', ')}.` }],
      });
    }
    return permissions;
  }

  /** The Owner role may lose `*` only while another role keeps an active Owner (or this role has no active member). */
  private async assertAnotherOwnerRemains(tx: Parameters<typeof countActiveOwners>[0], roleId: number): Promise<void> {
    if ((await countActiveStaffOfRole(tx, roleId)) === 0) return;
    if ((await countActiveOwners(tx, { roleId })) > 0) return;
    throw new AppError('LAST_OWNER', {
      detail: 'There must always be one active owner. Give another role the "Everything" permission first.',
      errors: [{ field: 'permissions', code: 'LAST_OWNER', message: 'This role holds the last active owner.' }],
    });
  }
}
