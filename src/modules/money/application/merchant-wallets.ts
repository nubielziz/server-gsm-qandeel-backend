// MerchantWallets: the read-only wallet figures of merchants for modules that show a merchant (identity: the wallet inside a
// merchant row). Reads only the merchant's two ledger accounts; the money module's own wallet routes arrive with feature 3.
import { Injectable } from '@nestjs/common';
import { and, eq, gt, inArray } from 'drizzle-orm';
import { Money } from '../../../common/money';
import type { DbExecutor } from '../../../infra/db';
import { ledgerAccounts } from '../db/schema';
import type { OpenedWallet } from './merchant-accounts';

/** The currency of a merchant's wallet today (decision 011). */
const WALLET_CURRENCY = 'USD';

/**
 * Reads merchant wallets.
 *
 * Why: `GET /admin/clients` shows the wallet of each merchant (`balance`, `reserved`, `creditLimit`, `available`) to staff who
 * hold `wallet:read` (MISMATCHES B26). The ledger belongs to the money module, so identity asks this service for a whole page
 * at once. A merchant without accounts reads as zeros (docs/contract/endpoints/money.md, GET /admin/clients/:id/wallet).
 *
 * Money rules: `balance` is the `client_wallet` balance (net of holds, negative while credit is used), `reserved` the
 * `client_hold` balance, `creditLimit` the wallet's `overdraft_limit`, `available = balance + creditLimit`.
 *
 * Side effects: none (reads only; the figures are never cached, decision 022).
 */
@Injectable()
export class MerchantWallets {
  /**
   * Reads the wallets of several merchants in one query.
   *
   * @param db the database or the caller's transaction
   * @param clientIds the merchants
   * @returns the wallet view of every merchant in `clientIds`
   */
  async viewsOf(db: DbExecutor, clientIds: readonly number[]): Promise<Map<number, OpenedWallet>> {
    const views = new Map<number, OpenedWallet>();
    const zero = Money.zero();
    for (const id of clientIds) {
      views.set(id, {
        balance: zero.toWire(),
        reserved: zero.toWire(),
        creditLimit: zero.toWire(),
        available: zero.toWire(),
      });
    }
    if (clientIds.length === 0) return views;
    const rows = await db
      .select({
        clientId: ledgerAccounts.ownerId,
        kind: ledgerAccounts.kind,
        balance: ledgerAccounts.balance,
        overdraftLimit: ledgerAccounts.overdraftLimit,
      })
      .from(ledgerAccounts)
      .where(
        and(
          eq(ledgerAccounts.ownerType, 'client'),
          eq(ledgerAccounts.currency, WALLET_CURRENCY),
          inArray(ledgerAccounts.kind, ['client_wallet', 'client_hold']),
          inArray(ledgerAccounts.ownerId, [...clientIds]),
        ),
      );
    const wallets = new Map<number, { balance: Money; reserved: Money; creditLimit: Money }>();
    for (const row of rows) {
      if (row.clientId === null) continue;
      const entry = wallets.get(row.clientId) ?? { balance: zero, reserved: zero, creditLimit: zero };
      if (row.kind === 'client_wallet') {
        entry.balance = Money.fromWire(row.balance);
        entry.creditLimit = Money.fromWire(row.overdraftLimit);
      } else {
        entry.reserved = Money.fromWire(row.balance);
      }
      wallets.set(row.clientId, entry);
    }
    for (const [clientId, wallet] of wallets) {
      views.set(clientId, {
        balance: wallet.balance.toWire(),
        reserved: wallet.reserved.toWire(),
        creditLimit: wallet.creditLimit.toWire(),
        available: wallet.balance.add(wallet.creditLimit).toWire(),
      });
    }
    return views;
  }

  /**
   * Reads one merchant's credit limit (the wallet's `overdraft_limit`).
   *
   * Why: moving a merchant to a group without overdraft is refused while its limit is above zero (RESOLUTIONS
   * identity-platform-3, user rule 2).
   *
   * @param db the database or the caller's transaction
   * @param clientId the merchant
   * @returns the limit; zero for a merchant without a wallet
   */
  async creditLimitOf(db: DbExecutor, clientId: number): Promise<Money> {
    const [row] = await db
      .select({ overdraftLimit: ledgerAccounts.overdraftLimit })
      .from(ledgerAccounts)
      .where(
        and(
          eq(ledgerAccounts.ownerType, 'client'),
          eq(ledgerAccounts.ownerId, clientId),
          eq(ledgerAccounts.kind, 'client_wallet'),
          eq(ledgerAccounts.currency, WALLET_CURRENCY),
        ),
      )
      .limit(1);
    return row ? Money.fromWire(row.overdraftLimit) : Money.zero();
  }

  /**
   * Lists the merchants whose credit limit is above zero.
   *
   * Why: a group stops allowing overdraft only while none of its merchants has credit (user rule 2, `PATCH
   * /admin/client-groups/:id`); credit holders are few, so the group routes ask for them all and let identity say which
   * of them sit in the group.
   *
   * @param db the database or the caller's transaction
   * @returns the ids of the merchants whose wallet `overdraft_limit` is above zero, in id order
   */
  async idsWithCreditLimit(db: DbExecutor): Promise<number[]> {
    const rows = await db
      .select({ clientId: ledgerAccounts.ownerId })
      .from(ledgerAccounts)
      .where(
        and(
          eq(ledgerAccounts.ownerType, 'client'),
          eq(ledgerAccounts.kind, 'client_wallet'),
          eq(ledgerAccounts.currency, WALLET_CURRENCY),
          gt(ledgerAccounts.overdraftLimit, '0'),
        ),
      )
      .orderBy(ledgerAccounts.ownerId);
    return rows.flatMap((row) => (row.clientId === null ? [] : [row.clientId]));
  }
}
