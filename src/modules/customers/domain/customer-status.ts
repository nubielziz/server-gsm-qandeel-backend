// Status rules of the admin customer actions (suspend, reactivate) and of sign-in: which states allow what, and the text of a
// suspension reason. Pure functions, unit-tested.
import type { CustomerStatus } from '../db/schema';

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

/**
 * Builds the text stored in `suspended_reason`: the reason, or `reason: note` when there is a note.
 *
 * Why: customers.md suspend: "suspended_reason = reason (or 'reason: note' when there is a note)".
 *
 * @param reason one of {@link SUSPEND_REASONS}
 * @param note the optional note (already trimmed; empty means none)
 * @returns the stored text
 */
export function suspendedReasonText(reason: SuspendReason, note: string | undefined): string {
  return note === undefined || note === '' ? reason : `${reason}: ${note}`;
}

/**
 * Tells whether an account in this status may sign in or hold a session.
 *
 * Why: the map says a suspended account has no sign-in; a blocked one (fraud) is refused the same way, and an anonymized
 * one has no credentials left. Only `active` signs in.
 *
 * @param status the customer's status
 * @returns true for `active`
 */
export function canSignIn(status: CustomerStatus): boolean {
  return status === 'active';
}

/**
 * Maps a customer status onto what the session guards judge: `ok`, `suspended` (403) or `gone` (401).
 *
 * Why: decision 018: every subject type maps its own statuses onto these three states; blocked behaves like suspended for the
 * caller, and an anonymized customer no longer exists as an account.
 *
 * @param status the customer's status
 * @returns the session state
 */
export function sessionStateOf(status: CustomerStatus): 'ok' | 'suspended' | 'gone' {
  if (status === 'active') return 'ok';
  return status === 'anonymized' ? 'gone' : 'suspended';
}
