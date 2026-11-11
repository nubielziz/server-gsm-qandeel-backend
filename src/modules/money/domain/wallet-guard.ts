// The wallet debit guard of postTransaction (decision 024 step 4, plan 21 § 5.5): a merchant wallet may not end below its credit limit, a
// customer's store balance may not end below zero; credits always pass. Pure, so every branch is unit-tested.
import { Money } from '../../../common/money';
import type { LedgerAccountKind } from '../db/schema';

/** What the guard knows of a locked account. */
export interface GuardedAccount {
  readonly kind: LedgerAccountKind;
  /** The credit limit (`overdraft_limit`); zero on every kind but `client_wallet`. */
  readonly overdraftLimit: string;
}

/** The overrides a posting may carry. */
export interface GuardFlags {
  /** Only the reversal of a paid commission and a merchant top-up clawback: a merchant wallet may end below its credit limit. */
  readonly allowBelowCreditLimit?: boolean;
  /** Only the customer top-up chargeback clawback: a customer wallet may end below zero (and must then be frozen at commit). */
  readonly allowNegativeCustomerWallet?: boolean;
}

/**
 * Tells why a posting must not take an account from `before` to `after`, or nothing when it may.
 *
 * Why: decision 024 step 4 for merchants (credit limit) and plan 21 § 5.1 invariant 2 for customers (no overdraft: O3). Only a debit
 * that ends below the floor is refused, so a wallet that is already below it can still receive money or be debited by staff only
 * through the named overrides. A frozen wallet is not refused here: staff must be able to debit it (plan § 2.3 item 5).
 *
 * @param account the locked account's kind and credit limit
 * @param before the balance before the posting, in the account's normal sign
 * @param after the balance after the posting, in the account's normal sign
 * @param flags the posting's overrides
 * @returns the detail of the `INSUFFICIENT_FUNDS` refusal, or `undefined` when the posting may go on
 */
export function walletDebitRefusal(
  account: GuardedAccount,
  before: Money,
  after: Money,
  flags: GuardFlags = {},
): string | undefined {
  if (after.cmp(before) >= 0) return undefined;
  if (account.kind === 'client_wallet') {
    if (flags.allowBelowCreditLimit === true) return undefined;
    const limit = Money.of(account.overdraftLimit);
    return after.cmp(limit.neg()) < 0
      ? `The wallet would end at ${after.toWire()}, below its credit limit of ${limit.toWire()}.`
      : undefined;
  }
  if (account.kind === 'customer_wallet') {
    if (flags.allowNegativeCustomerWallet === true) return undefined;
    return after.isNegative()
      ? `The balance would end at ${after.toWire()}; a store balance cannot go below zero.`
      : undefined;
  }
  return undefined;
}
