// The sign-in steps of a merchant (B124, feature 20): after the proven password there is a password to replace, a code to type, or nothing.
// The only place that decides a merchant's next step; feature 24A (smart sign-in) reuses it. Pure rules, unit-tested.
import type { SessionStage } from '../db/schema';

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

/**
 * Tells whether a merchant takes precedence over a customer account with the same email on the one sign-in form.
 *
 * Why: decision 052. A registration makes a merchant with a password before anyone proved the mailbox, so it must not shadow the
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
