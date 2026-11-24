// The sign-in steps of a merchant (B124, feature 20): after the proven password there is a password to replace, a code to type, or nothing.
// The only place that decides a merchant's next step; feature 24A (smart sign-in) reuses it. Pure rules, unit-tested.
import type { ClientStatus, SessionStage } from '../db/schema';

/** What the merchant portal must do next after the password (`POST /client/auth/login` answers it as `{ next }`). */
export type MerchantSignInStep = 'password' | 'totp' | 'done';

/** What decides the step. */
export interface MerchantSignInFacts {
  /** Staff set a temporary password that the merchant has not replaced yet. */
  readonly mustChangePassword: boolean;
  /** The merchant turned two-factor sign-in on. */
  readonly twofaEnabled: boolean;
}

/**
 * Decides the step after a correct password.
 *
 * Why: a temporary password must go before anything else (feature 20: it was spoken or emailed, so it is not a secret of the merchant), then
 * the optional authenticator code (decision 018, B124), then the sign-in is complete.
 *
 * @param facts whether the password must be replaced, and whether 2FA is on
 * @returns the step the portal shows next
 */
export function nextMerchantStep(facts: MerchantSignInFacts): MerchantSignInStep {
  if (facts.mustChangePassword) return 'password';
  return facts.twofaEnabled ? 'totp' : 'done';
}

/** The account facts a password sign-in is decided on: read for the password check, and read again when the session opens. */
export interface MerchantSignInAccount extends MerchantSignInFacts {
  /** The stored password hash (null for a merchant that has not chosen a password yet). */
  readonly passwordHash: string | null;
  /** When the password was last chosen or set; a hash upgrade at a higher cost keeps it (decision 007). */
  readonly passwordChangedAt: Date | null;
  /** The account status; a suspended merchant does not sign in. */
  readonly status: ClientStatus;
}

/**
 * Tells whether a sign-in may still open its session: the account is as it was when the password was checked.
 *
 * Why: the password check (argon2, tens of milliseconds) runs without a lock, and a reset by link, a password change, a switch-on of
 * two-step sign-in, a temporary password or a suspension may commit in between. Each of them ends the sessions that exist at its commit,
 * so the session of a sign-in decided before it must not be opened after it. Required: the same password (the same
 * `password_changed_at`: every chosen or staff-set password writes it, while the hash upgrade of a parallel sign-in of the same merchant
 * keeps it), a stored hash, the same two-step and forced-change state, and a status that may sign in.
 *
 * @param checked the account as it was read for the password check
 * @param current the account as it is read under the row lock of the session's transaction
 * @returns true when the session may be opened
 */
export function signInStillHolds(checked: MerchantSignInAccount, current: MerchantSignInAccount): boolean {
  return (
    current.passwordHash !== null &&
    current.passwordChangedAt?.getTime() === checked.passwordChangedAt?.getTime() &&
    current.twofaEnabled === checked.twofaEnabled &&
    current.mustChangePassword === checked.mustChangePassword &&
    current.status !== 'suspended'
  );
}

/**
 * Tells whether a merchant takes precedence over a customer account with the same email on the one sign-in form.
 *
 * Why: decision 052. A merchant can hold a password before anyone proved the mailbox (staff set a temporary one), so it must not shadow the
 * password of a customer who owns that address. The merchant wins only once its email is verified (a link sent to the mailbox was used).
 *
 * @param merchant the merchant's email verification time
 * @returns true when the merchant's email is verified
 */
export function merchantShadowsCustomer(merchant: { readonly emailVerifiedAt: Date | null }): boolean {
  return merchant.emailVerifiedAt !== null;
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
export function merchantStageOfStep(step: MerchantSignInStep): SessionStage {
  if (step === 'password') return 'pending_password';
  return step === 'totp' ? 'pending_totp' : 'active';
}
