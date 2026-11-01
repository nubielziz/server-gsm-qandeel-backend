// Opens a merchant's ledger accounts (decision 024; resolution identity-platform-1, user decision): written by the lead
// before Phase 3 wave 1 because features 2a (POST /admin/clients) and 2b (POST /client/auth/register) call it while
// feature 3, which owns the money module, is built in parallel.
import { Injectable } from '@nestjs/common';
import { AppError } from '../../../common/errors';
import { Money } from '../../../common/money';
import type { DbExecutor } from '../../../infra/db';
import { ledgerAccounts } from '../db/schema';

/** What {@link MerchantAccounts.open} needs. */
export interface OpenMerchantAccountsInput {
  /** The merchant (`clients.id`) the accounts belong to. */
  readonly clientId: number;
  /** ISO currency code of the wallet (a `currencies.code`); merchants hold USD today. */
  readonly currency: string;
  /** The credit limit (wire `Money`, `'0.0000'` for none); stored as the wallet's `overdraft_limit`. */
  readonly creditLimit: string;
  /** `client_groups.overdraft_allowed` of the merchant's group. */
  readonly overdraftAllowed: boolean;
}

/** The wallet view a freshly opened merchant shows (all wire `Money`). */
export interface OpenedWallet {
  readonly balance: string;
  readonly reserved: string;
  readonly creditLimit: string;
  readonly available: string;
}

/**
 * Opens the `client_wallet` and `client_hold` accounts of a merchant inside the caller's transaction.
 *
 * Why: the user decided that creating a merchant creates its wallet in the same transaction, so a credit limit given at
 * creation is stored at once (resolution identity-platform-1); user rule 2 refuses a limit above zero on a group
 * without overdraft. No ledger transaction is posted: a new wallet has no money yet.
 */
@Injectable()
export class MerchantAccounts {
  /**
   * Opens both accounts; running it again for the same merchant and currency changes nothing.
   *
   * Side effects: inserts up to two `ledger_accounts` rows (`ON CONFLICT DO NOTHING` on the account identity).
   *
   * @param tx the caller's transaction (or the database)
   * @param input merchant, currency, credit limit and whether its group allows overdraft
   * @returns the wallet view: zero balance and reserve, the credit limit as available money
   * @throws {AppError} `VALIDATION_FAILED` on `creditLimit` when it is negative, or above zero on a group without
   *   overdraft (user rule 2)
   */
  async open(tx: DbExecutor, input: OpenMerchantAccountsInput): Promise<OpenedWallet> {
    const limit = Money.fromWire(input.creditLimit);
    if (limit.isNegative()) {
      throw new AppError('VALIDATION_FAILED', {
        errors: [{ field: 'creditLimit', code: 'min', message: 'The credit limit cannot be negative.' }],
      });
    }
    if (limit.isPositive() && !input.overdraftAllowed) {
      throw new AppError('VALIDATION_FAILED', {
        errors: [{ field: 'creditLimit', code: 'not_allowed', message: 'This group does not allow credit.' }],
      });
    }
    const owner = { ownerType: 'client' as const, ownerId: input.clientId, currency: input.currency };
    await tx
      .insert(ledgerAccounts)
      .values([
        { ...owner, kind: 'client_wallet', overdraftLimit: limit.toWire() },
        { ...owner, kind: 'client_hold', overdraftLimit: '0.0000' },
      ])
      .onConflictDoNothing();
    const zero = Money.zero().toWire();
    return { balance: zero, reserved: zero, creditLimit: limit.toWire(), available: limit.toWire() };
  }
}
