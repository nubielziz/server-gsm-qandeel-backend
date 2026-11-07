// Wallet rules that need no database: the credit limit (user rule 2) and the manual adjustment limits (ANSWERS merchants Q4).
import { AppError } from '../../../common/errors';
import { Money } from '../../../common/money';

/**
 * Checks a credit limit against the merchant group's overdraft permission and returns it.
 *
 * Why: user rule 2 (resolution identity-platform-3): a limit above zero on a group without `overdraft_allowed` is `422` on
 * `creditLimit`, and a negative limit is `422` too. One function serves `MerchantAccounts.open` and
 * `PATCH /admin/clients/:id/credit-limit`, so both answer alike. Lowering a limit below the credit in use is allowed (new
 * orders are refused until a top-up).
 *
 * @param creditLimit the limit as wire `Money`
 * @param overdraftAllowed `client_groups.overdraft_allowed` of the merchant's group
 * @returns the limit as `Money`
 * @throws {AppError} `VALIDATION_FAILED` on `creditLimit` when it is negative, or above zero and the group allows no credit
 */
export function checkCreditLimit(creditLimit: string, overdraftAllowed: boolean): Money {
  const limit = Money.fromWire(creditLimit);
  if (limit.isNegative()) {
    throw new AppError('VALIDATION_FAILED', {
      errors: [{ field: 'creditLimit', code: 'min', message: 'The credit limit cannot be negative.' }],
    });
  }
  if (limit.isPositive() && !overdraftAllowed) {
    throw new AppError('VALIDATION_FAILED', {
      errors: [{ field: 'creditLimit', code: 'not_allowed', message: 'This group does not allow credit.' }],
    });
  }
  return limit;
}

/**
 * The setting that holds the single-approver limit of manual adjustments.
 *
 * Why: ANSWERS merchants Q4: the demo's $10,000 is a setting, `wallet.adjust_approval_limit`.
 */
export const ADJUST_APPROVAL_LIMIT_KEY = 'wallet.adjust_approval_limit';

/** The default of {@link ADJUST_APPROVAL_LIMIT_KEY}: the demo's $10,000. */
export const DEFAULT_ADJUST_APPROVAL_LIMIT = '10000.0000';

/**
 * Reads the approval limit setting.
 *
 * Why: the setting is free JSON (a number or an amount text); a bad value must not lock every adjustment or lift the limit,
 * so anything that is not a non-negative amount with at most four places falls back to the default.
 *
 * @param value the raw setting value (`undefined` when never set)
 * @returns the limit
 */
export function approvalLimitOf(value: unknown): Money {
  const fallback = Money.fromWire(DEFAULT_ADJUST_APPROVAL_LIMIT);
  try {
    // A JSON number is read through its shortest decimal text, so 250.5 means exactly 250.5000; exponents and more than
    // four places are refused by Money.of.
    const text = typeof value === 'number' && Number.isFinite(value) ? String(value) : value;
    if (typeof text === 'string') {
      const limit = Money.of(text);
      return limit.isNegative() ? fallback : limit;
    }
  } catch {
    // A malformed value falls through to the default.
  }
  return fallback;
}

/**
 * Tells whether an adjustment needs a second approver.
 *
 * Why: ANSWERS merchants Q4: the server only refuses (409 `APPROVAL_REQUIRED`); there is no second-approver route. "Over
 * $10,000" is strictly above the limit.
 *
 * @param amount the adjustment amount
 * @param limit the approval limit
 * @returns true when the amount is above the limit
 */
export function needsSecondApprover(amount: Money, limit: Money): boolean {
  return amount.cmp(limit) > 0;
}
