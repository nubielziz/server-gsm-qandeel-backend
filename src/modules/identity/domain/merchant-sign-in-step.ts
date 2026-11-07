// The sign-in steps of a merchant (B124): after the password there is either a code to type or nothing. Pure rules, unit-tested.
import type { SessionStage } from '../db/schema';

/** What the merchant portal must do next after the password (`POST /client/auth/login` answers it as `{ next }`). */
export type MerchantSignInStep = 'totp' | 'done';

/**
 * Decides the step after a correct password.
 *
 * Why: merchant 2FA is optional (decision 018, B124): `totp` when the merchant turned it on, otherwise the sign-in is complete.
 *
 * @param twofaEnabled whether the merchant has two-factor sign-in on
 * @returns the step the portal shows next
 */
export function nextMerchantStep(twofaEnabled: boolean): MerchantSignInStep {
  return twofaEnabled ? 'totp' : 'done';
}

/**
 * Names the session stage that holds a step.
 *
 * Why: the stage is what the guards check (`sessionStages` of each route): `totp` waits in a pending session (10 minutes) that
 * can only call `POST /client/auth/2fa` and logout, `done` is a full session at once.
 *
 * @param step the step after the password
 * @returns `pending_totp` or `active`
 */
export function merchantStageOfStep(step: MerchantSignInStep): SessionStage {
  return step === 'totp' ? 'pending_totp' : 'active';
}
