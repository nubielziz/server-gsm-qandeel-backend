// Wallet rules that need no database: the credit limit (user rule 2) and the manual adjustment limits (ANSWERS merchants Q4,
// decision 049).
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
 * Writes a dollar amount for a refusal: `$10,000` for whole dollars, `$10,000.50` otherwise.
 *
 * Why: the adjustment and credit-limit refusals name the limit the way the console shows it (ANSWERS merchants Q4).
 *
 * @param amount the amount
 * @returns the text with a dollar sign and thousands separators
 */
export function dollarsText(amount: Money): string {
  const [whole = '0', cents = '00'] = amount.toWire().split('.');
  const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return /^0+$/.test(cents) ? `$${grouped}` : `$${grouped}.${cents.slice(0, 2)}`;
}

/** How far back a staff member's credits count towards the approval limit: 24 hours (decision 049). */
export const ADJUST_WINDOW_MS = 24 * 60 * 60 * 1000;

/** What {@link adjustmentNeedsOwner} judges. */
export interface AdjustmentFacts {
  readonly direction: 'credit' | 'debit';
  readonly amount: Money;
  /** What the same staff member credited to wallets of the same kind within the window, this request not included. */
  readonly creditedInWindow: Money;
  /** The approval limit of that kind of wallet. */
  readonly limit: Money;
  /** The caller holds `*`. */
  readonly owner: boolean;
}

/**
 * Tells whether a manual adjustment needs an Owner.
 *
 * Why: decision 049 (amends ANSWERS merchants Q4): the approval limit caps what one staff member credits within 24 hours, so several
 * requests carry no more than one; a debit is judged alone; an Owner is the approver of what goes beyond. Strictly above the limit.
 *
 * @param facts the adjustment and the staff member's recent credits
 * @returns true when the adjustment is refused for anyone but an Owner
 */
export function adjustmentNeedsOwner(facts: AdjustmentFacts): boolean {
  if (facts.owner) return false;
  const counted = facts.direction === 'credit' ? facts.creditedInWindow.add(facts.amount) : facts.amount;
  return counted.cmp(facts.limit) > 0;
}

/**
 * The refusal of an adjustment above the limit (`409 APPROVAL_REQUIRED`).
 *
 * Why: decision 049: the console shows the detail, so it names the limit and, for a credit, the 24-hour total it would reach.
 *
 * @param facts the adjustment and the staff member's recent credits
 * @returns the detail the console shows
 */
export function adjustmentRefusalDetail(facts: Omit<AdjustmentFacts, 'owner'>): string {
  return facts.direction === 'credit'
    ? `Credits over ${dollarsText(facts.limit)} in 24 hours need an owner: yours would come to ${dollarsText(facts.creditedInWindow.add(facts.amount))}.`
    : `Debits over ${dollarsText(facts.limit)} need an owner.`;
}

/**
 * Tells whether a credit limit needs an Owner: it is above the approval limit of merchant adjustments and higher than the limit it replaces.
 *
 * Why: decision 049: a credit limit is money the merchant can spend; above what one staff member may credit by hand, an Owner decides.
 * Lowering a limit, or sending it unchanged, never needs one.
 *
 * @param next the new limit
 * @param current the limit it replaces (zero for a new merchant)
 * @param approvalLimit `wallet.adjust_approval_limit`
 * @returns true when only an Owner may set it
 */
export function creditLimitNeedsOwner(next: Money, current: Money, approvalLimit: Money): boolean {
  return next.cmp(approvalLimit) > 0 && next.cmp(current) > 0;
}

/**
 * The refusal of a credit limit above the approval limit (`403 FORBIDDEN`).
 *
 * Why: decision 049: the console shows the detail on the credit-limit dialog and on the merchant invitation.
 *
 * @param approvalLimit `wallet.adjust_approval_limit`
 * @returns the detail the console shows
 */
export function creditLimitOwnerDetail(approvalLimit: Money): string {
  return `Only an owner can set a credit limit above ${dollarsText(approvalLimit)}.`;
}
