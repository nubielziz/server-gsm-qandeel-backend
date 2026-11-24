// The idle limits of the two subject types as the live-session predicate takes them (RESOLUTIONS identity-platform-6).
import type { IdleLimits } from '../security/session.repository';
import type { SessionPolicy } from '../security/session-policy';

/**
 * Reads the idle limit of each subject type from the session settings.
 *
 * Why: the live-session predicate compares `last_seen_at` with `now - idle limit` per subject type; the limits are settings
 * (decision 018), read through the cached settings snapshot. Every account has the one account limit, whatever its rank (decision 064).
 *
 * @param policy the session policy
 * @returns milliseconds a full session of each subject type may sit unused
 */
export async function idleLimitsOf(policy: SessionPolicy): Promise<IdleLimits> {
  const [staff, account] = await Promise.all([policy.limits('staff'), policy.limits('account')]);
  return { staff: staff.idleMs, account: account.idleMs };
}
