// The temporary lock after repeated failed sign-ins of an email (decision 052; it replaces the customers' lockout of feature 14b) and
// the network rule that lets an account's own networks keep trying. Pure rules; the counts live in the cache Redis (infra/sign-in-failures).
import { parseIpAddress, signInNetworkKey } from '../../../common/ip-address';

/**
 * The two places a sign-in email is counted apart: the console (`staff`), and the shop, where the merchant login, the customer login and
 * the smart sign-in share one form and one count (`shop`).
 */
export type SignInScope = 'staff' | 'shop';

/** Failed password sign-ins an email may have counted before the next attempt is refused and locks it. */
export const MAX_FAILED_SIGN_INS = 10;
/** How long a locked email refuses sign-in from networks its account has not used, from the attempt that started the lock. */
export const SIGN_IN_LOCK_MS = 15 * 60 * 1000;
/** How many of an account's newest full sessions are read to find the networks it signed in from. */
export const FAMILIAR_SIGN_INS_READ = 50;

/**
 * Tells whether an attempt, counted before its password is checked, goes beyond the failures an email may have.
 *
 * Why: decision 052. Every attempt is counted before the slow password check, atomically, so attempts sent at the same moment cannot
 * all pass a check made before any of them was counted; a correct password takes back only its own count. Ten counted attempts are
 * checked; the eleventh is refused and starts the lock. The count of an email nobody owns grows the same way, so a lock never tells an
 * attacker whether an account exists.
 *
 * @param attempts the attempts counted for the email since its last lock began, this one included
 * @returns true from the eleventh on
 */
export function exceedsFailureBudget(attempts: number): boolean {
  return attempts > MAX_FAILED_SIGN_INS;
}

/**
 * Tells how many seconds an email stays locked.
 *
 * @param lockedUntilMs the end of the lock in epoch milliseconds, or `0` when the email was never locked
 * @param nowMs the clock's time in milliseconds
 * @returns whole seconds (at least 1) while locked, or `0` when the email is not locked
 */
export function lockedForSeconds(lockedUntilMs: number, nowMs: number): number {
  const left = lockedUntilMs - nowMs;
  return left > 0 ? Math.ceil(left / 1000) : 0;
}

/**
 * Tells whether a request comes from a network the account already signed in from.
 *
 * Why: decision 052. While an email is locked, a stranger who guessed wrongly ten times must not keep the owner out; the owner's
 * network (an IPv4 /24 or an IPv6 /64 of one of the account's stored full sessions) keeps a budget of its own per email and network
 * while the lock runs (5 attempts in 15 minutes, limiter `sign-in-familiar`; see `SignInLock`).
 *
 * @param requestIp the address of the request as text
 * @param pastIps the addresses of the account's past full sessions as text
 * @returns true when the request's network is one of the past networks; false for an unreadable address or an empty list
 */
export function isFamiliarNetwork(requestIp: string, pastIps: readonly string[]): boolean {
  const own = signInNetworkKey(parseIpAddress(requestIp));
  if (own === undefined) return false;
  return pastIps.some((ip) => signInNetworkKey(parseIpAddress(ip)) === own);
}
