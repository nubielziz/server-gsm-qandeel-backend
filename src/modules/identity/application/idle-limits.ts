// The idle limits of the three subject types as the live-session predicate takes them (RESOLUTIONS identity-platform-6).
import type { IdleLimits } from '../security/session.repository';
import type { SessionPolicy } from '../security/session-policy';

/**
 * Reads the idle limit of each subject type from the session settings.
 *
 * Why: the live-session predicate compares `last_seen_at` with `now - idle limit` per subject type; the limits are settings
 * (decision 018), read through the cached settings snapshot.
 *
 * @param policy the session policy
 * @returns milliseconds a full session of each subject type may sit unused
 */
export async function idleLimitsOf(policy: SessionPolicy): Promise<IdleLimits> {
  const [staff, client, customer] = await Promise.all([
    policy.limits('staff'),
    policy.limits('client'),
    policy.limits('customer'),
  ]);
  return { staff: staff.idleMs, client: client.idleMs, customer: customer.idleMs };
}
