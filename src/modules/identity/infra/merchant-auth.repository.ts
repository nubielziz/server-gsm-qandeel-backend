// Drizzle queries of the merchant portal's account routes on `clients` (identity module): sign-in, registration, password,
// 2FA and profile. Every function takes a DbExecutor so a use case can run several in one transaction; times come from the caller.
import { and, eq, isNull, lt, or, sql } from 'drizzle-orm';
import type { DbExecutor } from '../../../infra/db';
import { lower } from '../../../infra/db/columns';
import { type Client, type NewClient, clients } from '../db/schema';

/**
 * Finds a merchant by email, ignoring case.
 *
 * Why: sign-in, registration and "forgot password" match the email case-insensitively (unique index on `lower(email)`).
 *
 * @param db the database or a transaction
 * @param email the email as typed
 * @returns the merchant, or `undefined`
 */
export async function findClientByEmail(db: DbExecutor, email: string): Promise<Client | undefined> {
  const [row] = await db
    .select()
    .from(clients)
    .where(eq(lower(clients.email), email.trim().toLowerCase()))
    .limit(1);
  return row;
}

/**
 * Finds a merchant by id.
 *
 * Why: the sensitive steps read the account itself, not the session's cached copy (decision 018).
 *
 * @param db the database or a transaction
 * @param id the merchant id
 * @returns the merchant, or `undefined`
 */
export async function findClientById(db: DbExecutor, id: number): Promise<Client | undefined> {
  const [row] = await db.select().from(clients).where(eq(clients.id, id)).limit(1);
  return row;
}

/**
 * Finds the merchant that owns a referral code.
 *
 * Why: B122 stores `referred_by_id` from the code a new merchant typed; an unknown code is a validation error.
 *
 * @param db the database or a transaction
 * @param code the referral code as typed (compared upper-case)
 * @returns the referring merchant's id, or `undefined`
 */
export async function findClientIdByReferralCode(db: DbExecutor, code: string): Promise<number | undefined> {
  const [row] = await db
    .select({ id: clients.id })
    .from(clients)
    .where(eq(clients.referralCode, code.trim().toUpperCase()))
    .limit(1);
  return row?.id;
}

/**
 * Inserts a merchant.
 *
 * @param db the database or a transaction
 * @param row the new merchant (password already hashed)
 * @returns the stored row
 * @throws the database's unique violation (`clients_email_uq`, `clients_username_uq`, `clients_referral_code_uq`)
 */
export async function insertClient(db: DbExecutor, row: NewClient): Promise<Client> {
  const [created] = await db.insert(clients).values(row).returning();
  return created!;
}

/**
 * Replaces a stored password hash with one made at the current cost.
 *
 * Why: decision 007 re-hashes a correct password when the configured cost went up; `password_changed_at` stays, since the
 * merchant did not change their password.
 *
 * @param db the database or a transaction
 * @param id the merchant id
 * @param passwordHash the new argon2id hash
 */
export async function replaceClientPasswordHash(db: DbExecutor, id: number, passwordHash: string): Promise<void> {
  await db.update(clients).set({ passwordHash }).where(eq(clients.id, id));
}

/** What choosing a password writes besides the hash. */
export interface SaveClientPassword {
  readonly id: number;
  readonly passwordHash: string;
  readonly now: Date;
  /** An invite link proves the email address, so it also verifies it (B128, resolution identity-platform-2). */
  readonly verifyEmail: boolean;
}

/**
 * Stores a chosen password.
 *
 * Why: the reset, invite and change routes all end here. The write refuses a suspended merchant, so a suspension that lands
 * between the check and the write wins; an invite also fills `email_verified_at` when it is still empty.
 *
 * @param db the database or a transaction
 * @param input the merchant, the hash and the time
 * @returns false when the merchant is gone or suspended (nothing was written)
 */
export async function saveClientPassword(db: DbExecutor, input: SaveClientPassword): Promise<boolean> {
  const rows = await db
    .update(clients)
    .set({
      passwordHash: input.passwordHash,
      passwordChangedAt: input.now,
      ...(input.verifyEmail ? { emailVerifiedAt: sql`coalesce(${clients.emailVerifiedAt}, ${input.now})` } : {}),
    })
    .where(and(eq(clients.id, input.id), sql`${clients.status} <> 'suspended'`))
    .returning({ id: clients.id });
  return rows.length > 0;
}

/**
 * Marks the email verified.
 *
 * Why: `POST /client/auth/verify-email` (B123); the first verification time stays when the link is used twice by two tabs.
 *
 * @param db the database or a transaction
 * @param id the merchant id
 * @param now the time of verification
 */
export async function markClientEmailVerified(db: DbExecutor, id: number, now: Date): Promise<void> {
  await db
    .update(clients)
    .set({ emailVerifiedAt: sql`coalesce(${clients.emailVerifiedAt}, ${now})` })
    .where(eq(clients.id, id));
}

/** The editable fields of `PATCH /client/profile`; a missing key is left alone. */
export interface ClientProfilePatch {
  readonly name?: string;
  readonly company?: string;
  readonly phone?: string;
  readonly country?: string;
}

/**
 * Updates the profile fields the merchant may edit.
 *
 * Why: B130: name, company, phone and country; the email, username and group are never editable here.
 *
 * @param db the database or a transaction
 * @param id the merchant id
 * @param patch the fields to change (an empty patch changes nothing)
 * @returns the merchant after the update, or `undefined` when it is gone
 */
export async function saveClientProfile(
  db: DbExecutor,
  id: number,
  patch: ClientProfilePatch,
): Promise<Client | undefined> {
  const values = {
    ...(patch.name === undefined ? {} : { name: patch.name }),
    ...(patch.company === undefined ? {} : { company: patch.company }),
    ...(patch.phone === undefined ? {} : { phone: patch.phone }),
    ...(patch.country === undefined ? {} : { country: patch.country }),
  };
  if (Object.keys(values).length === 0) return findClientById(db, id);
  const [row] = await db.update(clients).set(values).where(eq(clients.id, id)).returning();
  return row;
}

/**
 * Stores a new pending TOTP secret.
 *
 * Why: `2fa/setup` replaces an older pending secret on every call (B132). The guard `twofa_enabled = false` is the rule "no new
 * authenticator once 2FA is on" in the write itself, so two tabs cannot race it. A new secret starts a new replay history.
 *
 * @param db the database or a transaction
 * @param id the merchant id
 * @param secretEnc the encrypted secret (decision 019)
 * @returns false when 2FA is already on (nothing was written)
 */
export async function savePendingClientTotpSecret(db: DbExecutor, id: number, secretEnc: string): Promise<boolean> {
  const rows = await db
    .update(clients)
    .set({ totpSecretEnc: secretEnc, totpLastStep: null })
    .where(and(eq(clients.id, id), eq(clients.twofaEnabled, false)))
    .returning({ id: clients.id });
  return rows.length > 0;
}

/** A TOTP step to remember, checked against the secret the code was verified with. */
export interface ClientTotpStep {
  readonly id: number;
  /** The TOTP time step of the accepted code. */
  readonly step: number;
  /** The encrypted secret the code was verified against; the write fails if the stored secret changed meanwhile. */
  readonly secretEnc: string;
}

/** The rule every code-accepting write shares: the same secret, and a step newer than the last accepted one. */
function freshStepOf(input: ClientTotpStep) {
  return and(
    eq(clients.id, input.id),
    eq(clients.totpSecretEnc, input.secretEnc),
    or(isNull(clients.totpLastStep), lt(clients.totpLastStep, input.step)),
  );
}

/**
 * Accepts the code of the second sign-in step.
 *
 * Why: one guarded `UPDATE` makes three rules atomic across API instances: a time step is never accepted twice
 * (`totp_last_step` must be older), the merchant must not have been suspended meanwhile, and the secret must be the one the
 * code was checked against (a concurrent setup or disable replaced it otherwise).
 *
 * @param db the database or a transaction
 * @param input the merchant, the step and the secret that was verified
 * @returns false when a rule failed (a replayed step, a suspended merchant, a changed secret, 2FA turned off)
 */
export async function acceptClientSignInStep(db: DbExecutor, input: ClientTotpStep): Promise<boolean> {
  const rows = await db
    .update(clients)
    .set({ totpLastStep: input.step })
    .where(and(freshStepOf(input), eq(clients.twofaEnabled, true), sql`${clients.status} <> 'suspended'`))
    .returning({ id: clients.id });
  return rows.length > 0;
}

/**
 * Turns 2FA on after the pending secret was confirmed with a code.
 *
 * Why: B133. The guard `twofa_enabled = false` makes a second enable (two tabs) lose; the confirming step is remembered so the
 * same code cannot be used again at once.
 *
 * @param db the database or a transaction
 * @param input the merchant, the step and the pending secret that was verified
 * @returns false when 2FA was already on, the secret changed, or the step is not newer
 */
export async function enableClientTwoFactor(db: DbExecutor, input: ClientTotpStep): Promise<boolean> {
  const rows = await db
    .update(clients)
    .set({ twofaEnabled: true, totpLastStep: input.step })
    .where(and(freshStepOf(input), eq(clients.twofaEnabled, false)))
    .returning({ id: clients.id });
  return rows.length > 0;
}

/**
 * Turns 2FA off after a current code, and forgets the secret.
 *
 * Why: B134. The code must be newer than the last accepted step, so a code used a moment ago to sign in does not disable 2FA.
 *
 * @param db the database or a transaction
 * @param input the merchant, the step and the secret that was verified
 * @returns false when 2FA was already off, the secret changed, or the step is not newer
 */
export async function disableClientTwoFactor(db: DbExecutor, input: ClientTotpStep): Promise<boolean> {
  const rows = await db
    .update(clients)
    .set({ twofaEnabled: false, totpSecretEnc: null, totpLastStep: null })
    .where(and(freshStepOf(input), eq(clients.twofaEnabled, true)))
    .returning({ id: clients.id });
  return rows.length > 0;
}

/**
 * Names the constraint a unique violation broke.
 *
 * Why: registration treats a taken email as "already registered" (same answer, B122) but retries when only the generated
 * username or referral code clashed.
 *
 * @param error whatever the query threw (Drizzle wraps the driver's error as `cause`)
 * @returns the constraint name (`clients_email_uq`), or `undefined` when the error is not a unique violation
 */
export function uniqueViolationOf(error: unknown): string | undefined {
  for (let current: unknown = error, depth = 0; current && depth < 4; depth++) {
    const candidate = current as { code?: unknown; constraint?: unknown; cause?: unknown };
    if (candidate.code === '23505') return typeof candidate.constraint === 'string' ? candidate.constraint : '';
    current = candidate.cause;
  }
  return undefined;
}
