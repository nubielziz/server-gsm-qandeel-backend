// Drizzle queries of the account routes on `clients` (identity module), for an account of any rank: sign-in, password, 2FA and profile.
// Every function takes a DbExecutor so a use case can run several in one transaction; times come from the caller. There is no lookup by
// email here: `AccountDirectory` is the one reader of an email (decision 064), and these queries start from an id it gave.
import { type SQL, and, eq, isNull, lt, or, sql } from 'drizzle-orm';
import type { DbExecutor } from '../../../infra/db';
import { type Client, clients } from '../db/schema';

/**
 * The SQL twin of `canAct` (`identity/accounts/account-status.ts`): the status lets the account act.
 *
 * Why: a write that must not land on an account that was suspended, blocked or erased meanwhile checks it in the statement itself, so
 * the check and the write are one step. Only `active` acts; every other status, one this code does not know included, does not.
 */
const mayAct = (): SQL => sql`${clients.status} = 'active'`;

/**
 * Finds an account by id, whatever its rank.
 *
 * Why: the sensitive steps read the account itself, not the session's cached copy (decision 018). The row carries the password hash,
 * which never leaves the identity module: other modules read an `AccountRecord` through `AccountDirectory`.
 *
 * @param db the database or a transaction
 * @param id the account id
 * @returns the account row, or `undefined`
 */
export async function findClientById(db: DbExecutor, id: number): Promise<Client | undefined> {
  const [row] = await db.select().from(clients).where(eq(clients.id, id)).limit(1);
  return row;
}

/**
 * Reads an account and locks its row until the transaction ends.
 *
 * Why: switching two-step sign-in on is decided on the account's state at the moment of the write (decision 052): a change of the
 * email address that lands at the same time must wait, so the second step never gets enrolled on an address that stopped being
 * confirmed in between. Call it first in a transaction, before the write that depends on what it read.
 *
 * @param db the transaction
 * @param id the account id
 * @returns the account as it is now, or `undefined` when it does not exist
 */
export async function lockClientById(db: DbExecutor, id: number): Promise<Client | undefined> {
  const [row] = await db.select().from(clients).where(eq(clients.id, id)).limit(1).for('update');
  return row;
}

/**
 * Reads an account for the opening of a sign-in session and holds its row until the transaction ends.
 *
 * Why: a sign-in opens its session only if the account is still as it was when the password was checked. A reset by link, a password
 * change, a switch-on of two-step sign-in, a temporary password and a suspension change this row, in the commit that ends the account's
 * sessions where they end them, so with the row held either that change waits and then ends the new session too, or the sign-in reads the
 * changed row.
 * `FOR NO KEY UPDATE`: the sign-in writes non-key columns only, so inserts that reference the account do not wait for it.
 *
 * @param db the transaction
 * @param id the account id
 * @returns the account as it is now, or `undefined` when it does not exist
 */
export async function lockClientForSignIn(db: DbExecutor, id: number): Promise<Client | undefined> {
  const [row] = await db.select().from(clients).where(eq(clients.id, id)).limit(1).for('no key update');
  return row;
}

/**
 * Replaces a stored password hash with one made at the current cost, while the stored hash is still the one that was verified.
 *
 * Why: decision 007 re-hashes a correct password when the configured cost went up; `password_changed_at` stays, since the
 * account did not change its password. The write is guarded by the verified hash in the same statement, so a password chosen
 * meanwhile is never replaced by a hash of the one it replaced, and a password ended meanwhile (a verification that ended the
 * password chosen before) is never written back.
 *
 * @param db the database or a transaction
 * @param id the account id
 * @param passwordHash the new argon2id hash
 * @param verifiedHash the stored hash the password was verified against
 * @returns false when the stored hash is another one or none (nothing was written)
 */
export async function replaceClientPasswordHash(
  db: DbExecutor,
  id: number,
  passwordHash: string,
  verifiedHash: string,
): Promise<boolean> {
  const rows = await db
    .update(clients)
    .set({ passwordHash })
    .where(and(eq(clients.id, id), eq(clients.passwordHash, verifiedHash)))
    .returning({ id: clients.id });
  return rows.length > 0;
}

/** What choosing a password writes besides the hash. */
export interface SaveClientPassword {
  readonly id: number;
  readonly passwordHash: string;
  readonly now: Date;
  /** An invite link proves the email address, so it also verifies it (B128, resolution identity-platform-2). */
  readonly verifyEmail: boolean;
  /**
   * Turn two-factor sign-in off in the same write when the account's email was not verified before it (decision 052): the link proves the
   * mailbox, so what an unverified registrant enrolled before it (a second factor nobody with the mailbox holds) must not outlive it.
   */
  readonly clearTwoFactor?: boolean;
  /**
   * The password comes from a link mailed to the account's address (reset or invitation): it clears the mark `password_set_by_staff` (a
   * staff temporary password; nothing reads it since decision 067). A change on the security page does not. The mark of an email
   * address staff set (`email_set_by_staff`) stays: the link went to that address.
   */
  readonly fromMailedLink?: boolean;
  /**
   * The hash the current password was checked against (an own change): the write lands only while the row still holds it, so a
   * password changed or ended since that check is not replaced.
   */
  readonly expectedHash?: string;
}

/**
 * Stores a chosen password.
 *
 * Why: the reset, invite and change routes all end here. The write refuses an account that may not act (`canAct`), so a suspension or
 * a block that lands between the check and the write wins; an invite also fills `email_verified_at` when it is still empty; a link on an account whose
 * email is not verified also turns its two-factor sign-in off (`clearTwoFactor`, decision 052); a link also clears
 * `password_set_by_staff` (`fromMailedLink`); an own change writes only over the hash its current password was checked against
 * (`expectedHash`).
 *
 * @param db the database or a transaction
 * @param input the account, the hash and the time
 * @returns false when the account is gone, may not act, or no longer holds `expectedHash` (nothing was written)
 */
export async function saveClientPassword(db: DbExecutor, input: SaveClientPassword): Promise<boolean> {
  const rows = await db
    .update(clients)
    .set({
      passwordHash: input.passwordHash,
      passwordChangedAt: input.now,
      // Any chosen password (reset link, invitation, change) ends a forced change (feature 20).
      mustChangePassword: false,
      ...(input.fromMailedLink ? { passwordSetByStaff: false } : {}),
      ...(input.verifyEmail ? { emailVerifiedAt: sql`coalesce(${clients.emailVerifiedAt}, ${input.now})` } : {}),
      // The right side of every SET reads the row as it was, so this sees the email before an invite verifies it.
      ...(input.clearTwoFactor
        ? {
            twofaEnabled: sql`case when ${clients.emailVerifiedAt} is null then false else ${clients.twofaEnabled} end`,
            totpSecretEnc: sql`case when ${clients.emailVerifiedAt} is null then null else ${clients.totpSecretEnc} end`,
            totpLastStep: sql`case when ${clients.emailVerifiedAt} is null then null else ${clients.totpLastStep} end`,
          }
        : {}),
    })
    .where(
      and(
        eq(clients.id, input.id),
        mayAct(),
        input.expectedHash === undefined ? undefined : eq(clients.passwordHash, input.expectedHash),
      ),
    )
    .returning({ id: clients.id });
  return rows.length > 0;
}

/**
 * Stores the password an account chose in the forced-change step of the sign-in (feature 20).
 *
 * Why: staff set a temporary password (`must_change_password`); the account replaces it before anything else. The guards are in the write:
 * a parallel request that already replaced it, or a suspension or block that landed meanwhile, leaves no row (the caller answers `401`).
 *
 * @param db the database or a transaction
 * @param input the account, the hash and the time
 * @returns whether the account has two-factor sign-in on (the next step), or `undefined` when nothing was written
 */
export async function saveForcedClientPassword(
  db: DbExecutor,
  input: { readonly id: number; readonly passwordHash: string; readonly now: Date },
): Promise<{ readonly twofaEnabled: boolean } | undefined> {
  const [row] = await db
    .update(clients)
    .set({ passwordHash: input.passwordHash, passwordChangedAt: input.now, mustChangePassword: false })
    .where(and(eq(clients.id, input.id), mayAct(), eq(clients.mustChangePassword, true)))
    .returning({ twofaEnabled: clients.twofaEnabled });
  return row;
}

/**
 * Records a completed sign-in.
 *
 * Why: `security.lastLoginAt` and `lastLoginIp` on the account page: written when a session of the account becomes fully signed in (feature 20).
 *
 * @param db the database or a transaction
 * @param id the account id
 * @param now the time from the injected clock
 * @param ip the address of the request
 */
export async function recordClientSignIn(db: DbExecutor, id: number, now: Date, ip: string): Promise<void> {
  await db.update(clients).set({ lastLoginAt: now, lastLoginIp: ip }).where(eq(clients.id, id));
}

/**
 * Marks the email verified and, when asked, stores no password and no second factor any more in the same write.
 *
 * Why: `POST /client/auth/verify-email` (B123); the first verification time stays when the link is used twice by two tabs. The link
 * proves the mailbox, not the holder of the password chosen before it: a verification without a full session of the account also
 * ends that password (`voidPassword`, together with a forced change it may have carried) and the two-step sign-in its holder
 * enrolled (the same rule as `clearTwoFactor` of a password link on an unproven mailbox, decision 052), so the password that signs
 * in is chosen through a link mailed to the verified address and no second factor of the previous holder stays in front of it.
 *
 * @param db the database or a transaction
 * @param id the account id
 * @param now the time of verification
 * @param options `voidPassword`: clear `password_hash` (no password signs in) and `must_change_password`, and turn two-factor sign-in
 *   off (`twofa_enabled` false, `totp_secret_enc` and `totp_last_step` cleared)
 */
export async function markClientEmailVerified(
  db: DbExecutor,
  id: number,
  now: Date,
  options: { readonly voidPassword?: boolean } = {},
): Promise<void> {
  await db
    .update(clients)
    .set({
      emailVerifiedAt: sql`coalesce(${clients.emailVerifiedAt}, ${now})`,
      ...(options.voidPassword
        ? {
            passwordHash: null,
            mustChangePassword: false,
            twofaEnabled: false,
            totpSecretEnc: null,
            totpLastStep: null,
          }
        : {}),
    })
    .where(eq(clients.id, id));
}

/** The editable fields of `PATCH /client/profile`; a missing key is left alone. */
export interface ClientProfilePatch {
  readonly name?: string;
  readonly company?: string;
  readonly phone?: string;
  readonly country?: string;
  readonly address?: string;
  readonly taxId?: string;
}

/**
 * Updates the profile fields the account may edit.
 *
 * Why: B130: name, company, phone and country, and (feature 20) address and tax id; the email, username and group are never
 * editable here.
 *
 * @param db the database or a transaction
 * @param id the account id
 * @param patch the fields to change (an empty patch changes nothing)
 * @returns the account after the update, or `undefined` when it is gone
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
    ...(patch.address === undefined ? {} : { address: patch.address }),
    ...(patch.taxId === undefined ? {} : { taxId: patch.taxId }),
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
 * @param id the account id
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
 * (`totp_last_step` must be older), the account must still be allowed to act, and the secret must be the one the
 * code was checked against (a concurrent setup or disable replaced it otherwise).
 *
 * @param db the database or a transaction
 * @param input the account, the step and the secret that was verified
 * @returns false when a rule failed (a replayed step, an account that may no longer act, a changed secret, 2FA turned off)
 */
export async function acceptClientSignInStep(db: DbExecutor, input: ClientTotpStep): Promise<boolean> {
  const rows = await db
    .update(clients)
    .set({ totpLastStep: input.step })
    .where(and(freshStepOf(input), eq(clients.twofaEnabled, true), mayAct()))
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
 * @param input the account, the step and the pending secret that was verified
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
 * @param input the account, the step and the secret that was verified
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
