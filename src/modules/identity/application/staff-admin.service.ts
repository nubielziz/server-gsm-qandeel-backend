// StaffAdminService: the use cases of the staff management routes (map domain A, stage 2, scenario admin-team): list, show, add
// by invitation or temporary password, edit, password, end sessions, suspend, reactivate and reset 2FA.
import { randomInt } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import { CLOCK, type Clock } from '../../../common/clock';
import type { ParsedListQuery } from '../../../common/contract';
import { AppError } from '../../../common/errors';
import { PasswordHasher } from '../../../infra/crypto';
import { DbService, isForeignKeyViolation, isUniqueViolation } from '../../../infra/db';
import type { TransactionContext } from '../../../infra/db';
import { AuditService } from '../../platform';
import type { StaffUser } from '../db/schema';
import { temporaryPasswordFor } from '../domain/temporary-password';
import { voidOpenStaffTokens } from '../infra/auth-token.repository';
import { countActiveOwners, lockOwnerChanges } from '../infra/owner.repository';
import { lockRole } from '../infra/role.repository';
import {
  type StaffRow,
  findStaffRow,
  insertStaffRow,
  listStaffRows,
  lockStaff,
  statusOfStaff,
  updateStaffRow,
} from '../infra/staff-admin.repository';
import { countLiveStaffSessions } from '../infra/session-admin.repository';
import { grantsEverything } from '../security/permission-grammar';
import { assertOwnerTargetAllowed } from '../security/principal';
import type { StaffPrincipal } from '../security/principal';
import { SessionPolicy } from '../security/session-policy';
import { SessionService } from '../security/session.service';
import { StaffAuthTokens } from './staff-auth-tokens';
import { idleLimitsOf } from './idle-limits';

/** A staff member as the console reads it. */
export interface StaffMemberView {
  readonly id: number;
  readonly createdAt: string;
  readonly name: string;
  readonly email: string;
  readonly twofaEnabled: boolean;
  readonly mustChangePassword: boolean;
  readonly passwordChangedAt: string | null;
  readonly suspendedAt: string | null;
  readonly lastLoginAt: string | null;
  readonly role: { id: number; name: string };
  readonly status: StaffUser['status'];
  readonly lastLoginIp: string | null;
  readonly activeSessions: number;
  readonly createdBy: { id: number; name: string } | null;
  readonly suspendedReason: string | null;
  readonly suspendedBy: { id: number; name: string } | null;
  readonly resetSentAt: string | null;
}

/** The input of `POST /admin/staff`. */
export interface CreateStaffInput {
  readonly name: string;
  readonly email: string;
  readonly roleId: number;
  readonly onboarding: 'invite' | 'temporary_password';
}

/** The keys `PATCH /admin/staff/:id` may change. */
export interface StaffChanges {
  readonly name?: string | undefined;
  readonly email?: string | undefined;
  readonly roleId?: number | undefined;
}

const iso = (date: Date | null): string | null => date?.toISOString() ?? null;
const collapse = (text: string): string => text.replace(/\s+/g, ' ').trim();

function emailTaken(): AppError {
  return new AppError('EMAIL_TAKEN', { detail: 'Another staff member already uses this email address.' });
}

function invalid(field: string, message: string): AppError {
  return new AppError('VALIDATION_FAILED', { errors: [{ field, code: 'invalid', message }] });
}

/**
 * Manages staff members.
 *
 * Why: scenario admin-team. An Owner (a member whose role grants `*`) adds a member by invitation link or temporary password,
 * changes their role, resets their password or 2FA, ends their sessions and suspends or reactivates them. Rules (decision 018,
 * RESOLUTIONS identity-platform-4 and -14): actions on an Owner account need `*`; nobody changes their own role; the last
 * active Owner cannot be demoted or suspended (checked under an advisory lock); nobody suspends themselves; a suspension, a
 * password reset with `revokeSessions`, "end all sessions" and a 2FA reset end the member's sessions in the same transaction.
 * Sensitive actions re-check the caller's account in the database, not the cached session.
 *
 * Side effects: writes `staff_users`, `auth_tokens`, `sessions` and `audit_logs`; deletes cached session views after the
 * commit; never writes a password, token or secret to the audit log.
 *
 * @see docs/contract/endpoints/identity.md (the `/admin/staff` sections)
 */
@Injectable()
export class StaffAdminService {
  constructor(
    private readonly db: DbService,
    private readonly hasher: PasswordHasher,
    private readonly sessions: SessionService,
    private readonly policy: SessionPolicy,
    private readonly tokens: StaffAuthTokens,
    private readonly audit: AuditService,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  /**
   * Lists staff members.
   *
   * @param query the parsed list request
   * @returns the page and the exact total
   */
  async list(
    query: ParsedListQuery<'createdAt' | 'name' | 'email' | 'status' | 'lastLoginAt' | 'id'>,
  ): Promise<{ rows: StaffMemberView[]; total: number }> {
    const { rows, total } = await listStaffRows(this.db.db, query);
    return { rows: await this.viewsOf(this.db.db, rows), total };
  }

  /**
   * Shows one staff member.
   *
   * @param id the staff id
   * @returns the member
   * @throws {AppError} `NOT_FOUND` (404)
   */
  async show(id: number): Promise<StaffMemberView> {
    return this.viewOf(this.db.db, id);
  }

  /**
   * Adds a staff member.
   *
   * @param caller the signed-in staff member
   * @param input name, email, role and how the member gets a first password
   * @returns the new member (status `invited`) and, for the temporary-password onboarding, the password (shown once)
   * @throws {AppError} `VALIDATION_FAILED` (422 on `name` or `roleId`), `EMAIL_TAKEN` (409), `FORBIDDEN` (403: a role that
   *   grants `*` needs an Owner), `ACCOUNT_SUSPENDED` (403: the caller was suspended meanwhile)
   */
  async create(
    caller: StaffPrincipal,
    input: CreateStaffInput,
  ): Promise<StaffMemberView & { temporaryPassword?: string }> {
    const name = collapse(input.name);
    if (name.length < 2) throw invalid('name', 'Enter their name.');
    const temporary =
      input.onboarding === 'temporary_password'
        ? temporaryPasswordFor((max) => randomInt(max), { email: input.email, name })
        : undefined;
    // argon2 takes tens of milliseconds: hash before the transaction opens.
    const passwordHash = temporary === undefined ? null : await this.hasher.hash(temporary);

    const view = await this.db.runInTransaction(async (work) => {
      await this.assertCallerActive(work.tx, caller);
      const role = await lockRole(work.tx, input.roleId);
      if (!role) throw invalid('roleId', 'Choose a role.');
      if (grantsEverything(role.permissions)) assertOwnerTargetAllowed(caller, role);
      const now = this.clock.now();
      let created: StaffUser;
      try {
        created = await insertStaffRow(work.tx, {
          email: input.email,
          name,
          roleId: role.id,
          status: 'invited',
          passwordHash,
          mustChangePassword: temporary !== undefined,
          passwordChangedAt: temporary === undefined ? null : now,
          createdBy: caller.staffId,
          createdAt: now,
        });
      } catch (error) {
        if (isUniqueViolation(error, 'staff_users_email_uq')) throw emailTaken();
        if (isForeignKeyViolation(error)) throw invalid('roleId', 'Choose a role.');
        throw error;
      }
      if (temporary === undefined) {
        await this.tokens.issue(work, {
          staffId: created.id,
          purpose: 'invite',
          createdBy: caller.staffId,
          ip: caller.ip,
        });
      }
      await this.audit.record(work.tx, {
        action: 'added admin',
        entityType: 'staff',
        entityId: created.id,
        entityLabel: created.name,
        after: {
          name: created.name,
          email: created.email,
          roleId: role.id,
          status: 'invited',
          onboarding: input.onboarding,
        },
      });
      return this.viewOf(work.tx, created.id);
    });
    return temporary === undefined ? view : { ...view, temporaryPassword: temporary };
  }

  /**
   * Changes a staff member's name, email or role.
   *
   * @param caller the signed-in staff member
   * @param id the member
   * @param changes the keys to change
   * @returns the updated member
   * @throws {AppError} `NOT_FOUND` (404), `VALIDATION_FAILED` (422 on `name` or `roleId`), `EMAIL_TAKEN` (409),
   *   `CANNOT_CHANGE_OWN_ROLE` (409 on `roleId`), `LAST_OWNER` (409 on `roleId`), `FORBIDDEN` (403: an Owner account, or a
   *   role that grants `*`, needs an Owner)
   */
  async update(caller: StaffPrincipal, id: number, changes: StaffChanges): Promise<StaffMemberView> {
    const name = changes.name === undefined ? undefined : collapse(changes.name);
    if (name !== undefined && name.length < 2) throw invalid('name', 'Enter their name.');
    return this.db.runInTransaction(async (work) => {
      await this.assertCallerActive(work.tx, caller);
      // A role change can remove an Owner: serialise it with the other Owner-affecting changes.
      if (changes.roleId !== undefined) await lockOwnerChanges(work.tx);
      const target = await this.lockTarget(work.tx, id);
      assertOwnerTargetAllowed(caller, { permissions: target.permissions });

      const roleChanged = changes.roleId !== undefined && changes.roleId !== target.staff.roleId;
      if (roleChanged) await this.checkRoleChange(work.tx, caller, target, changes.roleId);

      const written: Partial<StaffUser> = {
        ...(name !== undefined && name !== target.staff.name ? { name } : {}),
        ...(changes.email !== undefined && changes.email !== target.staff.email.toLowerCase()
          ? { email: changes.email }
          : {}),
        ...(roleChanged ? { roleId: changes.roleId } : {}),
      };
      if (Object.keys(written).length > 0) {
        try {
          await updateStaffRow(work.tx, id, written);
        } catch (error) {
          if (isUniqueViolation(error, 'staff_users_email_uq')) throw emailTaken();
          throw error;
        }
        // The cached session view holds the member's role id and name (the audit actor's snapshot).
        if (written.roleId !== undefined || written.name !== undefined) {
          await this.sessions.invalidateSubject('staff', id, work);
        }
      }
      await this.audit.record(work.tx, {
        action: 'edited admin',
        entityType: 'staff',
        entityId: id,
        entityLabel: written.name ?? target.staff.name,
        before: pick(target.staff, written),
        after: written,
      });
      return this.viewOf(work.tx, id);
    });
  }

  /**
   * Sends a set-password link or sets a temporary password.
   *
   * @param caller the signed-in staff member
   * @param id the member
   * @param input the mode and whether to end the member's sessions
   * @returns `{ temporaryPassword }` for the temporary mode (shown once), `{}` for the link
   * @throws {AppError} `NOT_FOUND` (404), `FORBIDDEN` (403: an Owner account needs an Owner)
   */
  async setPassword(
    caller: StaffPrincipal,
    id: number,
    input: { mode: 'reset_link' | 'temporary_password'; revokeSessions: boolean },
  ): Promise<{ temporaryPassword?: string }> {
    const existing = await findStaffRow(this.db.db, id);
    if (!existing) throw new AppError('NOT_FOUND', { detail: 'No staff member has this id.' });
    const temporary =
      input.mode === 'temporary_password'
        ? temporaryPasswordFor((max) => randomInt(max), { email: existing.staff.email, name: existing.staff.name })
        : undefined;
    const passwordHash = temporary === undefined ? undefined : await this.hasher.hash(temporary);

    await this.db.runInTransaction(async (work) => {
      await this.assertCallerActive(work.tx, caller);
      const target = await this.lockTarget(work.tx, id);
      assertOwnerTargetAllowed(caller, { permissions: target.permissions });
      const now = this.clock.now();
      if (passwordHash !== undefined) {
        await updateStaffRow(work.tx, id, { passwordHash, mustChangePassword: true, passwordChangedAt: now });
        // An older link must not undo the temporary password.
        await voidOpenStaffTokens(work.tx, id, now);
      } else {
        await this.tokens.issue(work, {
          staffId: id,
          purpose: target.staff.status === 'invited' ? 'invite' : 'reset',
          createdBy: caller.staffId,
          ip: caller.ip,
        });
      }
      if (input.revokeSessions) await this.sessions.revokeAllOf('staff', id, {}, work);
      await this.audit.record(work.tx, {
        action: temporary === undefined ? 'sent a password reset link to admin' : 'set a temporary password for admin',
        entityType: 'staff',
        entityId: id,
        entityLabel: target.staff.name,
        after: { mode: input.mode, revokeSessions: input.revokeSessions },
      });
    });
    return temporary === undefined ? {} : { temporaryPassword: temporary };
  }

  /**
   * Ends every session of a staff member.
   *
   * @param caller the signed-in staff member
   * @param id the member
   * @throws {AppError} `NOT_FOUND` (404), `FORBIDDEN` (403: an Owner account needs an Owner)
   */
  async revokeSessions(caller: StaffPrincipal, id: number): Promise<void> {
    const idle = await idleLimitsOf(this.policy);
    await this.db.runInTransaction(async (work) => {
      await this.assertCallerActive(work.tx, caller);
      const target = await this.lockTarget(work.tx, id);
      assertOwnerTargetAllowed(caller, { permissions: target.permissions });
      const live = (await countLiveStaffSessions(work.tx, [id], this.clock.now(), idle)).get(id) ?? 0;
      await this.sessions.revokeAllOf('staff', id, {}, work);
      await this.audit.record(work.tx, {
        action: 'signed out all devices of admin',
        entityType: 'staff',
        entityId: id,
        entityLabel: target.staff.name,
        before: { sessions: live },
        after: { sessions: 0 },
      });
    });
  }

  /**
   * Suspends a staff member.
   *
   * @param caller the signed-in staff member
   * @param id the member
   * @param reason "Reason" or "Reason: note", as the console writes it
   * @throws {AppError} `NOT_FOUND` (404), `CANNOT_SUSPEND_SELF`, `ALREADY_SUSPENDED`, `LAST_OWNER` (409), `FORBIDDEN` (403: an
   *   Owner account needs an Owner)
   */
  async suspend(caller: StaffPrincipal, id: number, reason: string): Promise<void> {
    await this.db.runInTransaction(async (work) => {
      await this.assertCallerActive(work.tx, caller);
      await lockOwnerChanges(work.tx);
      const target = await this.lockTarget(work.tx, id);
      assertOwnerTargetAllowed(caller, { permissions: target.permissions });
      if (target.staff.id === caller.staffId) {
        throw new AppError('CANNOT_SUSPEND_SELF', { detail: 'You cannot suspend your own account.' });
      }
      if (target.staff.status === 'suspended') throw new AppError('ALREADY_SUSPENDED');
      if (
        target.staff.status === 'active' &&
        grantsEverything(target.permissions) &&
        (await countActiveOwners(work.tx, { staffId: id })) === 0
      ) {
        throw new AppError('LAST_OWNER', { detail: 'Make someone else an owner before suspending the last one.' });
      }
      const now = this.clock.now();
      await updateStaffRow(work.tx, id, {
        status: 'suspended',
        suspendedAt: now,
        suspendedReason: reason,
        suspendedBy: caller.staffId,
      });
      await this.sessions.revokeAllOf('staff', id, {}, work);
      await voidOpenStaffTokens(work.tx, id, now);
      await this.audit.record(work.tx, {
        action: 'suspended admin',
        entityType: 'staff',
        entityId: id,
        entityLabel: target.staff.name,
        before: { status: target.staff.status },
        after: { status: 'suspended', reason },
      });
    });
  }

  /**
   * Lifts a suspension.
   *
   * @param caller the signed-in staff member
   * @param id the member
   * @throws {AppError} `NOT_FOUND` (404), `NOT_SUSPENDED` (409), `FORBIDDEN` (403: an Owner account needs an Owner)
   */
  async reactivate(caller: StaffPrincipal, id: number): Promise<void> {
    await this.db.runInTransaction(async (work) => {
      await this.assertCallerActive(work.tx, caller);
      const target = await this.lockTarget(work.tx, id);
      assertOwnerTargetAllowed(caller, { permissions: target.permissions });
      if (target.staff.status !== 'suspended') throw new AppError('NOT_SUSPENDED');
      const status = target.staff.lastLoginAt === null ? 'invited' : 'active';
      await updateStaffRow(work.tx, id, { status, suspendedAt: null, suspendedReason: null, suspendedBy: null });
      // The cached views say "suspended" until they are dropped; no session is restored.
      await this.sessions.invalidateSubject('staff', id, work);
      await this.audit.record(work.tx, {
        action: 'reactivated admin',
        entityType: 'staff',
        entityId: id,
        entityLabel: target.staff.name,
        before: { status: 'suspended' },
        after: { status },
      });
    });
  }

  /**
   * Clears a member's authenticator.
   *
   * @param caller the signed-in staff member
   * @param id the member
   * @throws {AppError} `NOT_FOUND` (404), `TWOFA_NOT_ENABLED` (409), `FORBIDDEN` (403: an Owner account needs an Owner)
   */
  async resetTwoFactor(caller: StaffPrincipal, id: number): Promise<void> {
    await this.db.runInTransaction(async (work) => {
      await this.assertCallerActive(work.tx, caller);
      const target = await this.lockTarget(work.tx, id);
      assertOwnerTargetAllowed(caller, { permissions: target.permissions });
      if (!target.staff.twofaEnabled) throw new AppError('TWOFA_NOT_ENABLED');
      await updateStaffRow(work.tx, id, { twofaEnabled: false, totpSecretEnc: null, totpLastStep: null });
      // The caller keeps their own session (they set 2FA up again at the next sign-in); everyone else is signed out.
      if (id !== caller.staffId) await this.sessions.revokeAllOf('staff', id, {}, work);
      await this.audit.record(work.tx, {
        action: 'reset 2FA of admin',
        entityType: 'staff',
        entityId: id,
        entityLabel: target.staff.name,
        before: { twofaEnabled: true },
        after: { twofaEnabled: false },
      });
    });
  }

  /** The caller's account is read again: a suspension that landed a moment ago stops the next write. */
  private async assertCallerActive(tx: TransactionContext['tx'], caller: StaffPrincipal): Promise<void> {
    const status = await statusOfStaff(tx, caller.staffId);
    if (status === undefined) throw new AppError('UNAUTHORIZED');
    if (status === 'suspended') throw new AppError('ACCOUNT_SUSPENDED');
  }

  private async lockTarget(tx: TransactionContext['tx'], id: number) {
    const target = await lockStaff(tx, id);
    if (!target) throw new AppError('NOT_FOUND', { detail: 'No staff member has this id.' });
    return target;
  }

  /** The rules of changing a member's role: not your own, a role that exists, `*` only by an Owner, never the last Owner. */
  private async checkRoleChange(
    tx: TransactionContext['tx'],
    caller: StaffPrincipal,
    target: { staff: StaffUser; permissions: string[] },
    roleId: number,
  ): Promise<void> {
    if (target.staff.id === caller.staffId) {
      throw new AppError('CANNOT_CHANGE_OWN_ROLE', {
        errors: [{ field: 'roleId', code: 'CANNOT_CHANGE_OWN_ROLE', message: 'You cannot change your own role.' }],
      });
    }
    const role = await lockRole(tx, roleId);
    if (!role) throw invalid('roleId', 'Choose a role.');
    if (grantsEverything(role.permissions)) assertOwnerTargetAllowed(caller, role);
    if (
      target.staff.status === 'active' &&
      grantsEverything(target.permissions) &&
      !grantsEverything(role.permissions) &&
      (await countActiveOwners(tx, { staffId: target.staff.id })) === 0
    ) {
      throw new AppError('LAST_OWNER', {
        detail: 'There must always be one active owner. Make someone else an owner first.',
        errors: [{ field: 'roleId', code: 'LAST_OWNER', message: 'This is the last active owner.' }],
      });
    }
  }

  private async viewOf(db: Parameters<typeof findStaffRow>[0], id: number): Promise<StaffMemberView> {
    const row = await findStaffRow(db, id);
    if (!row) throw new AppError('NOT_FOUND', { detail: 'No staff member has this id.' });
    return (await this.viewsOf(db, [row]))[0]!;
  }

  private async viewsOf(db: Parameters<typeof findStaffRow>[0], rows: StaffRow[]): Promise<StaffMemberView[]> {
    const counts = await countLiveStaffSessions(
      db,
      rows.map((row) => row.staff.id),
      this.clock.now(),
      await idleLimitsOf(this.policy),
    );
    return rows.map((row) => toView(row, counts.get(row.staff.id) ?? 0));
  }
}

/** The members of `source` whose names `changes` has: the "before" side of an edit's audit row. */
function pick(source: StaffUser, changes: Partial<StaffUser>): Record<string, unknown> {
  const before: Record<string, unknown> = {};
  for (const key of Object.keys(changes) as Array<keyof StaffUser>) before[key] = source[key];
  return before;
}

function toView(row: StaffRow, activeSessions: number): StaffMemberView {
  const { staff } = row;
  // A temporary password set after the link makes the link moot (the drawer then reads "Temporary password set ...").
  const linkMoot =
    row.latestLinkAt !== null &&
    staff.mustChangePassword &&
    staff.passwordChangedAt !== null &&
    staff.passwordChangedAt.getTime() >= row.latestLinkAt.getTime();
  return {
    id: staff.id,
    createdAt: staff.createdAt.toISOString(),
    name: staff.name,
    email: staff.email,
    twofaEnabled: staff.twofaEnabled,
    mustChangePassword: staff.mustChangePassword,
    passwordChangedAt: iso(staff.passwordChangedAt),
    suspendedAt: iso(staff.suspendedAt),
    lastLoginAt: iso(staff.lastLoginAt),
    role: { id: row.role.id, name: row.role.name },
    status: staff.status,
    lastLoginIp: staff.lastLoginIp,
    activeSessions,
    createdBy: row.createdBy,
    suspendedReason: staff.suspendedReason,
    suspendedBy: row.suspendedBy,
    resetSentAt: linkMoot ? null : iso(row.latestLinkAt),
  };
}
