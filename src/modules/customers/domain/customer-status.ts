// The suspension reasons of the retired `POST /admin/customers/:id/suspend`: the contract of that route still names them until the contract
// release deletes it. Which status may sign in is the identity module's one helper (`canAct`, `sessionStateOf`, decision 064), not a rule of
// this module.

/**
 * The reasons the console's suspend dialog offers (customers/lib/status.ts, SUSPEND_REASONS in the demo).
 *
 * Why: customers.md suspend: `reason` is one of these five; the server refuses anything else with 422 on `reason`.
 */
export const SUSPEND_REASONS = [
  'Customer asked to pause the account',
  'Account may be compromised',
  'Unusual activity under review',
  'Waiting for proof of identity or payment',
  'Other',
] as const;

/** One value of {@link SUSPEND_REASONS}. */
export type SuspendReason = (typeof SUSPEND_REASONS)[number];

/** The most characters of the optional note of a suspension. */
export const MAX_SUSPEND_NOTE_LENGTH = 200;
