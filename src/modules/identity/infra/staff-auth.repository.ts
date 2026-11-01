// Drizzle queries of the staff sign-in routes on `staff_users` and `roles` (identity module). Every function takes a
// DbExecutor so a sign-in step can run several of them in one transaction; times come from the caller.
import { and, eq, isNull, lt, or, sql } from 'drizzle-orm';
import { lower } from '../../../infra/db/columns';
import type { DbExecutor } from '../../../infra/db';
import { type Role, type StaffUser, roles, staffUsers } from '../db/schema';

/** A staff member with the role they hold (the role row is missing only if the foreign key were ever dropped). */
export interface StaffWithRole {
  readonly staff: StaffUser;
  readonly role: Pick<Role, 'id' | 'name' | 'permissions'> | undefined;
}

/**
 * Finds a staff member by email, ignoring case.
 *
 * Why: the sign-in matches the email case-insensitively (unique index on `lower(email)`).
 *
 * @param db the database or a transaction
 * @param email the email as typed
 * @returns the account, or `undefined`
 */
export async function findStaffByEmail(db: DbExecutor, email: string): Promise<StaffUser | undefined> {
  const [row] = await db
    .select()
    .from(staffUsers)
    .where(eq(lower(staffUsers.email), email.trim().toLowerCase()))
    .limit(1);
  return row;
}

/**
 * Finds a staff member by id.
 *
 * Why: the sensitive sign-in steps read the account itself, not the session's cached copy (decision 018).
 *
 * @param db the database or a transaction
 * @param id the staff id
 * @returns the account, or `undefined`
 */
export async function findStaffById(db: DbExecutor, id: number): Promise<StaffUser | undefined> {
  const [row] = await db.select().from(staffUsers).where(eq(staffUsers.id, id)).limit(1);
  return row;
}

/**
 * Finds a staff member together with their role.
 *
 * Why: `GET /admin/auth/me` answers the role's name and permissions; one query keeps it cheap.
 *
 * @param db the database or a transaction
 * @param id the staff id
 * @returns the account and its role, or `undefined` when the account is gone
 */
export async function findStaffWithRole(db: DbExecutor, id: number): Promise<StaffWithRole | undefined> {
  const [row] = await db
    .select({
      staff: staffUsers,
      role: { id: roles.id, name: roles.name, permissions: roles.permissions },
    })
    .from(staffUsers)
    .leftJoin(roles, eq(roles.id, staffUsers.roleId))
    .where(eq(staffUsers.id, id))
    .limit(1);
  if (!row) return undefined;
  return { staff: row.staff, role: row.role ?? undefined };
}

/**
 * Replaces a stored password hash with one made at the current cost.
 *
 * Why: decision 007 re-hashes a correct password when the configured cost went up. `password_changed_at` stays: the person
 * did not change their password.
 *
 * @param db the database or a transaction
 * @param id the staff id
 * @param passwordHash the new argon2id hash
 */
export async function replacePasswordHash(db: DbExecutor, id: number, passwordHash: string): Promise<void> {
  await db.update(staffUsers).set({ passwordHash }).where(eq(staffUsers.id, id));
}

/**
 * Stores a new pending TOTP secret.
 *
 * Why: `2fa/setup` replaces an older pending secret on every call. The guard `twofa_enabled = false` is the rule "no new
 * authenticator once 2FA is on" in the write itself, so two tabs cannot race it. A new secret starts a new replay history.
 *
 * @param db the database or a transaction
 * @param id the staff id
 * @param secretEnc the encrypted secret (decision 019)
 * @returns false when 2FA is already on (nothing was written)
 */
export async function savePendingTotpSecret(db: DbExecutor, id: number, secretEnc: string): Promise<boolean> {
  const rows = await db
    .update(staffUsers)
    .set({ totpSecretEnc: secretEnc, totpLastStep: null })
    .where(and(eq(staffUsers.id, id), eq(staffUsers.twofaEnabled, false)))
    .returning({ id: staffUsers.id });
  return rows.length > 0;
}

/** What completing the second step writes. */
export interface CompleteSignIn {
  readonly id: number;
  /** The TOTP time step of the accepted code. */
  readonly step: number;
  /** The encrypted secret the code was verified against; the write fails if the stored secret changed meanwhile. */
  readonly secretEnc: string;
  readonly ip: string;
  readonly now: Date;
}

/**
 * Completes the sign-in of an account: remembers the TOTP step, turns 2FA on, stamps the login, activates an invited account.
 *
 * Why: one guarded `UPDATE` makes four rules atomic across API instances: a time step is never accepted twice
 * (`totp_last_step` must be older), the account must not have been suspended meanwhile, the secret must be the one the code
 * was checked against (a concurrent `2fa/setup` replaced it otherwise), and `invited` becomes `active` at the first full
 * sign-in (admin-team step 5).
 *
 * @param db the database or a transaction
 * @param input the account, the step and the secret that was verified
 * @returns the account after the update, or `undefined` when a rule failed (a replayed step, a suspended account, a changed secret)
 */
export async function completeSignIn(db: DbExecutor, input: CompleteSignIn): Promise<StaffUser | undefined> {
  const [row] = await db
    .update(staffUsers)
    .set({
      totpLastStep: input.step,
      twofaEnabled: true,
      lastLoginAt: input.now,
      lastLoginIp: input.ip,
      status: sql`case when ${staffUsers.status} = 'invited' then 'active' else ${staffUsers.status} end`,
    })
    .where(
      and(
        eq(staffUsers.id, input.id),
        eq(staffUsers.totpSecretEnc, input.secretEnc),
        sql`${staffUsers.status} <> 'suspended'`,
        or(isNull(staffUsers.totpLastStep), lt(staffUsers.totpLastStep, input.step)),
      ),
    )
    .returning();
  return row;
}

/**
 * Stores a chosen password.
 *
 * Why: `password/set` ends the forced change and the invite or reset: the new hash, the time, and no more forced change. The
 * write refuses a suspended account, so a suspension that lands between the check and the write wins.
 *
 * @param db the database or a transaction
 * @param id the staff id
 * @param passwordHash the argon2id hash of the new password
 * @param now the time of the change
 * @returns false when the account is gone or suspended (nothing was written)
 */
export async function savePassword(db: DbExecutor, id: number, passwordHash: string, now: Date): Promise<boolean> {
  const rows = await db
    .update(staffUsers)
    .set({ passwordHash, passwordChangedAt: now, mustChangePassword: false })
    .where(and(eq(staffUsers.id, id), sql`${staffUsers.status} <> 'suspended'`))
    .returning({ id: staffUsers.id });
  return rows.length > 0;
}
