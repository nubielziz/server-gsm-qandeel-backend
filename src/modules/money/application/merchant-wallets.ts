// MerchantWallets: the read-only merchant-wallet figures of accounts for modules that show one (orders, payments, the rank admin). Reads only
// the account's two merchant ledger accounts (`client_wallet` and `client_hold`, owned by ('account', id), decision 064); the wallet of
// the live kind, store balances included, is `AccountWallets.viewsOf`.
import { Injectable } from '@nestjs/common';
import { and, eq, gt, inArray } from 'drizzle-orm';
import { Money } from '../../../common/money';
import type { DbExecutor } from '../../../infra/db';
import { ledgerAccounts } from '../db/schema';
import type { OpenedWallet } from './merchant-accounts';

/** The currency of a merchant wallet today (decision 011). */
const WALLET_CURRENCY = 'USD';

/**
 * Reads merchant wallets.
 *
 * Why: the order and payment screens show the merchant wallet of an account (`balance`, `reserved`, `creditLimit`, `available`) and the
 * rank admin asks who holds a credit limit. The ledger belongs to the money module, so the others ask this service for a whole page at once.
 * An account without merchant accounts reads as zeros (docs/contract/endpoints/money.md, GET /admin/clients/:id/wallet).
 *
 * Money rules: `balance` is the `client_wallet` balance (net of holds, negative while credit is used), `reserved` the
 * `client_hold` balance, `creditLimit` the wallet's `overdraft_limit`, `available = balance + creditLimit`.
 *
 * Side effects: none (reads only; the figures are never cached, decision 022).
 */
@Injectable()
export class MerchantWallets {
  /**
   * Reads the merchant wallets of several accounts in one query.
   *
   * @param db the database or the caller's transaction
   * @param accountIds the accounts
   * @returns the merchant wallet view of every account in `accountIds` (zeros for an account with no merchant wallet)
   */
  async viewsOf(db: DbExecutor, accountIds: readonly number[]): Promise<Map<number, OpenedWallet>> {
    const views = new Map<number, OpenedWallet>();
    const zero = Money.zero();
    for (const id of accountIds) {
      views.set(id, {
        balance: zero.toWire(),
        reserved: zero.toWire(),
        creditLimit: zero.toWire(),
        available: zero.toWire(),
      });
    }
    if (accountIds.length === 0) return views;
    const rows = await db
      .select({
        accountId: ledgerAccounts.ownerId,
        kind: ledgerAccounts.kind,
        balance: ledgerAccounts.balance,
        overdraftLimit: ledgerAccounts.overdraftLimit,
      })
      .from(ledgerAccounts)
      .where(
        and(
          eq(ledgerAccounts.ownerType, 'account'),
          eq(ledgerAccounts.currency, WALLET_CURRENCY),
          inArray(ledgerAccounts.kind, ['client_wallet', 'client_hold']),
          inArray(ledgerAccounts.ownerId, [...accountIds]),
        ),
      );
    const wallets = new Map<number, { balance: Money; reserved: Money; creditLimit: Money }>();
    for (const row of rows) {
      if (row.accountId === null) continue;
      const entry = wallets.get(row.accountId) ?? { balance: zero, reserved: zero, creditLimit: zero };
      if (row.kind === 'client_wallet') {
        entry.balance = Money.fromWire(row.balance);
        entry.creditLimit = Money.fromWire(row.overdraftLimit);
      } else {
        entry.reserved = Money.fromWire(row.balance);
      }
      wallets.set(row.accountId, entry);
    }
    for (const [accountId, wallet] of wallets) {
      views.set(accountId, {
        balance: wallet.balance.toWire(),
        reserved: wallet.reserved.toWire(),
        creditLimit: wallet.creditLimit.toWire(),
        available: wallet.balance.add(wallet.creditLimit).toWire(),
      });
    }
    return views;
  }

  /**
   * Reads one account's credit limit (the merchant wallet's `overdraft_limit`).
   *
   * Why: moving an account to a rank without overdraft is refused while its limit is above zero (RESOLUTIONS
   * identity-platform-3, user rule 2).
   *
   * @param db the database or the caller's transaction
   * @param accountId the account
   * @returns the limit; zero for an account without a merchant wallet
   */
  async creditLimitOf(db: DbExecutor, accountId: number): Promise<Money> {
    const [row] = await db
      .select({ overdraftLimit: ledgerAccounts.overdraftLimit })
      .from(ledgerAccounts)
      .where(
        and(
          eq(ledgerAccounts.ownerType, 'account'),
          eq(ledgerAccounts.ownerId, accountId),
          eq(ledgerAccounts.kind, 'client_wallet'),
          eq(ledgerAccounts.currency, WALLET_CURRENCY),
        ),
      )
      .limit(1);
    return row ? Money.fromWire(row.overdraftLimit) : Money.zero();
  }

  /**
   * Lists the accounts whose credit limit is above zero.
   *
   * Why: a rank stops allowing overdraft only while none of its accounts has credit (user rule 2, `PATCH
   * /admin/client-groups/:id`); credit holders are few, so the rank routes ask for them all and let identity say which
   * of them sit in the rank.
   *
   * @param db the database or the caller's transaction
   * @returns the ids of the accounts whose merchant wallet `overdraft_limit` is above zero, in id order
   */
  async idsWithCreditLimit(db: DbExecutor): Promise<number[]> {
    const rows = await db
      .select({ accountId: ledgerAccounts.ownerId })
      .from(ledgerAccounts)
      .where(
        and(
          eq(ledgerAccounts.ownerType, 'account'),
          eq(ledgerAccounts.kind, 'client_wallet'),
          eq(ledgerAccounts.currency, WALLET_CURRENCY),
          gt(ledgerAccounts.overdraftLimit, '0'),
        ),
      )
      .orderBy(ledgerAccounts.ownerId);
    return rows.flatMap((row) => (row.accountId === null ? [] : [row.accountId]));
  }
}
