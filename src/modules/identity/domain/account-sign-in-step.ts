// The sign-in steps of an account of any rank (decision 064; B124 and feature 20 for the merchant steps): after the proven password there is
// a password to replace, a code to type, or nothing. The only place that decides the next step of a password sign-in, the forced change
// and the email link. Pure rules, unit-tested.
import { canAct } from '../accounts/account-status';
import type { ClientStatus, SessionStage } from '../db/schema';

/**
 * What the shop or the portal must do next after the password (the sign-in answers it as `next`).
 *
 * Why: the same three words as `AccountSignInStep` of the sign-in port, for every account: `password` (replace a temporary password),
 * `totp` (type the code of the authenticator) or `done` (the session is full).
 */
export type AccountSignInStep = 'password' | 'totp' | 'done';

/** What decides the step. */
export interface AccountSignInFacts {
  /** Staff set a temporary password that the account has not replaced yet. */
  readonly mustChangePassword: boolean;
  /** The account turned two-step sign-in on. */
  readonly twofaEnabled: boolean;
}

/**
 * Decides the step after a correct password.
 *
 * Why: a temporary password must go before anything else (it was spoken or emailed, so it is not a secret of the account), then the
 * authenticator code of an account that turned two-step sign-in on (decision 018, B124), then the sign-in is complete. The rule is the
 * same for a merchant rank and a retail rank (decision 064).
 *
 * @param facts whether the password must be replaced, and whether two-step sign-in is on
 * @returns the step the portal or the shop shows next
 */
export function nextAccountStep(facts: AccountSignInFacts): AccountSignInStep {
  if (facts.mustChangePassword) return 'password';
  return facts.twofaEnabled ? 'totp' : 'done';
}

/** The account facts a password sign-in is decided on: read for the password check, and read again when the session opens. */
export interface AccountSignInState extends AccountSignInFacts {
  /** The stored password hash (null for an account that has not chosen a password yet). */
  readonly passwordHash: string | null;
  /** When the password was last chosen or set; a hash upgrade at a higher cost keeps it (decision 007). */
  readonly passwordChangedAt: Date | null;
  /** The account status; only an account that may act signs in (`canAct`). */
  readonly status: ClientStatus;
}

/**
 * Tells whether a sign-in may still open its session: the account is as it was when the password was checked.
 *
 * Why: the password check (argon2, tens of milliseconds) runs without a lock, and a reset by link, a password change, a switch-on of
 * two-step sign-in, a temporary password, a suspension or a block may commit in between. Each of them ends the sessions that exist at
 * its commit, so the session of a sign-in decided before it must not be opened after it. Required: the same password (the same
 * `password_changed_at`: every chosen or staff-set password writes it, while the hash upgrade of a parallel sign-in of the same account
 * keeps it), a stored hash, the same two-step and forced-change state, and a status that may act (`canAct`, so a suspended, a blocked and
 * an anonymized account never get a session, whatever word the status holds).
 *
 * @param checked the account as it was read for the password check
 * @param current the account as it is read under the row lock of the session's transaction
 * @returns true when the session may be opened
 */
export function signInStillHolds(checked: AccountSignInState, current: AccountSignInState): boolean {
  return (
    current.passwordHash !== null &&
    current.passwordChangedAt?.getTime() === checked.passwordChangedAt?.getTime() &&
    current.twofaEnabled === checked.twofaEnabled &&
    current.mustChangePassword === checked.mustChangePassword &&
    canAct(current.status)
  );
}

/**
 * Names the session stage that holds a step.
 *
 * Why: the stage is what the guards check (`sessionStages` of each route): `password` waits in a pending session (10 minutes) that can
 * only call `POST /client/auth/password/change` and logout, `totp` one that can only call `POST /client/auth/2fa` and logout, `done` is a
 * full session at once.
 *
 * @param step the step after the password
 * @returns `pending_password`, `pending_totp` or `active`
 */
export function accountStageOfStep(step: AccountSignInStep): SessionStage {
  if (step === 'password') return 'pending_password';
  return step === 'totp' ? 'pending_totp' : 'active';
}
