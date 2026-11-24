// The daily cap on wrong authenticator codes of one person (a staff member or an account of any rank): pure rules; the count lives in Postgres
// (`staff_users.totp_failures` and `clients.totp_failures`, written by infra/code-failures.repository).

/** Wrong authenticator codes one account may have counted within {@link CODE_FAILURE_WINDOW_MS}; the next attempt is refused. */
export const MAX_FAILED_CODES = 20;
/** The 24 hours wrong codes are counted over, from the first one counted. */
export const CODE_FAILURE_WINDOW_MS = 24 * 60 * 60 * 1000;

/**
 * Tells whether a code attempt, counted before its code is checked, finds the code step closed.
 *
 * Why: the code step is the second factor and must hold also for a person who knows the password. The budget of five codes per 15
 * minutes (`sign-in-code`) bounds their pace and starts again after a correct code; this cap bounds their total. Every attempt is
 * counted before its code is checked, atomically, and a correct code takes back only its own count, so attempts sent at the same
 * moment are all counted and a success never cancels the failures. Twenty counted attempts are checked; from the twenty-first, or once
 * the closing is recorded, the step is closed, also to the right code, until the 24 hours of the count end (then it opens by itself
 * with a count of zero), a new password is set by an emailed link or by staff, or staff reset two-factor sign-in.
 *
 * @param attempts the attempts counted for the account in its current 24 hours, this one included
 * @param closingRecorded whether the closing of the current 24 hours is already recorded (`totp_locked_at`)
 * @returns true from the twenty-first attempt on, or while the closing is recorded
 */
export function codeStepClosed(attempts: number, closingRecorded: boolean): boolean {
  return closingRecorded || attempts > MAX_FAILED_CODES;
}

/**
 * Tells whether a wrong code is the one that closes the code step.
 *
 * Why: the failure that reaches the cap is written to the audit log once, by the one request whose count reached it (and only when
 * the guarded write of `totp_locked_at` finds the closing not yet recorded).
 *
 * @param attempts the attempts counted for the account, this one included (its code was wrong)
 * @returns true for the twentieth
 */
export function closesCodeStep(attempts: number): boolean {
  return attempts === MAX_FAILED_CODES;
}

/**
 * The whole seconds until a closed code step opens again by itself: the end of the 24 hours of its count.
 *
 * Why: the `Retry-After` of the refusal tells the real wait, and the console builds its waiting banner from it.
 *
 * @param since when the 24 hours of the count began (`totp_failures_since`)
 * @param now the clock's time
 * @returns the seconds left, rounded up, at least 1
 */
export function secondsUntilCodeStepOpens(since: Date, now: Date): number {
  return Math.max(1, Math.ceil((since.getTime() + CODE_FAILURE_WINDOW_MS - now.getTime()) / 1000));
}

/**
 * The wait until a closed code step opens again, in words for the detail of the refusal ("3 hours 5 minutes", "12 minutes").
 *
 * Why: the person at the code step reads when it opens again; minutes are rounded up, so the step is open by the time named.
 *
 * @param seconds the seconds left (from {@link secondsUntilCodeStepOpens})
 * @returns the wait in hours and minutes
 */
export function codeStepWaitText(seconds: number): string {
  const minutes = Math.max(1, Math.ceil(seconds / 60));
  const plural = (n: number, unit: string): string => `${n} ${unit}${n === 1 ? '' : 's'}`;
  if (minutes < 60) return plural(minutes, 'minute');
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest === 0 ? plural(hours, 'hour') : `${plural(hours, 'hour')} ${plural(rest, 'minute')}`;
}
