// The one place that reads what an account status means (decision 064): may it act, and what happens to its sessions.
import type { ClientStatus } from '../db/schema';

/**
 * What a status does to the sessions of an account: `ok` (they work), `suspended` (every session is refused with 403
 * `ACCOUNT_SUSPENDED` and revoked) or `gone` (the account was erased; a session is refused with 401).
 */
export type SessionState = 'ok' | 'suspended' | 'gone';

/**
 * Tells whether an account with this status may act: sign in, order, hold keys, receive mail.
 *
 * Why: every reader of `clients.status` asks here instead of comparing words, so a status added later (`blocked`, `anonymized`) is
 * refused everywhere at once. Only `active` may act; a status this code does not know may not.
 *
 * @param status the stored status of the account
 * @returns true only for `active`
 * @see decision 064
 */
export function canAct(status: ClientStatus): boolean {
  return status === 'active';
}

/**
 * Tells what a status does to the account's sessions.
 *
 * Why: `suspended` and `blocked` both end every session and answer 403 `ACCOUNT_SUSPENDED`; `anonymized` is final and answers 401, as if
 * the account never existed. The check fails closed: a status this code does not know (including the retired `pending`) counts as
 * suspended, never as ok.
 *
 * @param status the stored status of the account
 * @returns `ok` for `active`, `gone` for `anonymized`, `suspended` for every other status
 * @see decision 064
 */
export function sessionStateOf(status: ClientStatus): SessionState {
  // Read as plain text: the stored list may be wider than the type of the moment, and an unknown word must land on 'suspended'.
  const stored: string = status;
  if (stored === 'active') return 'ok';
  if (stored === 'anonymized') return 'gone';
  return 'suspended';
}

/**
 * Whether staff suspended the account: suspended, and nothing stronger (not blocked, not erased).
 *
 * Why: the staff rules that depend on a suspension ask here, so this word is compared in one file only (decision 064).
 *
 * @param status the stored status
 * @returns true only for `suspended`
 */
export function isSuspended(status: ClientStatus): boolean {
  return (status as string) === 'suspended';
}
