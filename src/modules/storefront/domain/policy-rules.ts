// The eight storefront policies of the console's Policies tab (feature 16): their keys, labels, kinds and the check each value must pass.
// Pure; the route writes them as flat keys of the settings table.
import { imeiRetentionDaysProblem } from '../../platform';

/** The yes/no policies. */
export const BOOLEAN_POLICIES = [
  'guestCheckout',
  'require3ds',
  'withdrawalWaiver',
  'autoRefundFailed',
  'imeiPrecheck',
] as const;

/** The policies that are a number of hours, minutes or days. */
export const NUMBER_POLICIES = ['refundHoursBeforeDispatch', 'abandonedMinutes', 'imeiRetentionDays'] as const;

/** Every policy key, in the order of the console's rows. */
export const POLICY_KEYS = [...BOOLEAN_POLICIES, ...NUMBER_POLICIES] as const;

/** One policy key. */
export type PolicyKey = (typeof POLICY_KEYS)[number];

/** The words the audit log prints for a policy (the demo's `POLICY_LABEL`, the console's row labels for the numbers). */
export const POLICY_LABELS: Readonly<Record<PolicyKey, string>> = {
  guestCheckout: 'Guest checkout',
  require3ds: 'Require 3D Secure',
  withdrawalWaiver: 'Ask for withdrawal waiver at checkout',
  autoRefundFailed: 'Auto-refund failed unlocks',
  imeiPrecheck: 'Check the IMEI before payment',
  refundHoursBeforeDispatch: 'Free cancellation window',
  abandonedMinutes: 'Abandoned checkout reminder',
  imeiRetentionDays: 'IMEI retention',
};

/**
 * Tells whether a key is one of the eight policies.
 *
 * @param key the key as sent
 * @returns true for a policy key
 */
export function isPolicyKey(key: string): key is PolicyKey {
  return (POLICY_KEYS as readonly string[]).includes(key);
}

const integerProblem = (value: unknown, min: number, max: number): string | undefined =>
  typeof value !== 'number' || !Number.isInteger(value)
    ? 'Use a whole number.'
    : value < min || value > max
      ? `Use a number from ${min} to ${max}.`
      : undefined;

/**
 * Judges the value of a policy.
 *
 * Why: ANSWERS settings Q1 and the endpoint doc of `PATCH /admin/storefront/settings`: the five switches must be JSON booleans,
 * `refundHoursBeforeDispatch` an integer from 0 to 72, `abandonedMinutes` from 5 to 1440 and `imeiRetentionDays` from 0 to 3650 (the same
 * check as the generic settings route); any other key is not a storefront setting.
 *
 * @param key the key as sent
 * @param value the value as sent
 * @returns the sentence for the field, or `undefined` when the value is acceptable
 */
export function policyProblem(key: string, value: unknown): string | undefined {
  if (!isPolicyKey(key)) return 'This is not a storefront setting.';
  if ((BOOLEAN_POLICIES as readonly string[]).includes(key)) {
    return typeof value === 'boolean' ? undefined : 'Use true or false.';
  }
  if (key === 'refundHoursBeforeDispatch') return integerProblem(value, 0, 72);
  if (key === 'abandonedMinutes') return integerProblem(value, 5, 1440);
  return imeiRetentionDaysProblem(value);
}
