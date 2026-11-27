// The key of an alert rule (decision 077): its format and the key the server makes from a name. Pure.
import { identifierFrom } from '../../../common/identifier';

/** The format of an alert rule's key: a lower-case letter, then 2 to 40 lower-case letters, digits or underscores (3 to 41 characters). */
export const ALERT_KEY_PATTERN = /^[a-z][a-z0-9_]{2,40}$/;

/** The shortest key the format allows. */
export const ALERT_KEY_MIN_LENGTH = 3;

/** The longest key the format allows. */
export const ALERT_KEY_MAX_LENGTH = 41;

/** The key the server makes for a rule whose name has no letter or digit a-z in it (a name in another script). */
export const ALERT_KEY_FALLBACK = 'rule';

/**
 * The key the server makes for a new alert rule that came without one.
 *
 * Why: decision 077: staff no longer type the key. It is the name as an identifier (`Supplier timeouts` is `supplier_timeouts`); a name
 * that starts with a digit (`5xx errors`) or is shorter than 3 characters once cleaned is put behind `rule_`, so the key always
 * satisfies {@link ALERT_KEY_PATTERN}; a name with nothing usable in it is `rule`.
 *
 * @param name the rule's name
 * @returns the key to try first; the caller adds `_2`, `_3` when another rule that is not deleted holds it
 */
export function madeAlertRuleKey(name: string): string {
  return identifierFrom(name, {
    maxLength: ALERT_KEY_MAX_LENGTH,
    minLength: ALERT_KEY_MIN_LENGTH,
    startsWithLetter: true,
    fallback: ALERT_KEY_FALLBACK,
  });
}
