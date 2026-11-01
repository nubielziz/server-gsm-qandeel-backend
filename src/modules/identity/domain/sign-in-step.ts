// The sign-in steps of a staff member (ALIGNMENT § 3): which step comes after the password, and which session stage holds it.
// Pure rules, unit-tested; the services only apply them.
import type { SessionStage } from '../db/schema';

/** What the console must do next after the password (`POST /admin/auth/login` answers it as `{ next }`). */
export type SignInStep = 'password' | 'totp' | 'totp_setup';

/**
 * The account facts the next step depends on.
 *
 * Why: a temporary password forces a change first; then 2FA is a code when it is on and an enrolment when it is not.
 */
export interface SignInFacts {
  readonly mustChangePassword: boolean;
  readonly twofaEnabled: boolean;
}

/**
 * Decides the step after a correct password.
 *
 * Why: ALIGNMENT § 3: `password` first (checked before anything else), then `totp`, else `totp_setup`.
 *
 * @param facts the account's password and 2FA state
 * @returns the step the console shows next
 */
export function nextStepOf(facts: SignInFacts): SignInStep {
  if (facts.mustChangePassword) return 'password';
  return facts.twofaEnabled ? 'totp' : 'totp_setup';
}

const STAGE_OF_STEP: Readonly<Record<SignInStep, SessionStage>> = {
  password: 'pending_password',
  totp: 'pending_totp',
  totp_setup: 'pending_totp_setup',
};

/**
 * Names the pending session stage that holds a step.
 *
 * Why: the stage is what the guards check (`sessionStages` of each sign-in route), so a pending session can only call the
 * route of its own step.
 *
 * @param step the next step
 * @returns the session stage
 */
export function stageOfStep(step: SignInStep): SessionStage {
  return STAGE_OF_STEP[step];
}
