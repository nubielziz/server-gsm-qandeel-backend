// The merchant wallet of an account, read-only (map domain E, stage 3; decision 064): the four figures and the paged statement. Used by the
// merchant portal's own wallet routes and the Dhru account read. The staff writes and the staff reads of either wallet kind are in
// account-wallet-admin.ts.
import { Injectable } from '@nestjs/common';
import type { z } from 'zod';
import { Money } from '../../../common/money';
import { DbService } from '../../../infra/db';
import type { DbExecutor } from '../../../infra/db';
import type { StatementRowSchema } from '../contracts/wallet.contracts';
import { BASE_CURRENCY, type WalletView, walletViewOf } from '../domain/accounts';
import { type WalletAccounts, listAccountEntries, readWalletAccounts } from '../infra/ledger-read.repository';

/** A statement line on the wire. */
export type StatementLine = z.output<typeof StatementRowSchema>;

/** The most lines a CSV export holds. */
export const STATEMENT_EXPORT_LIMIT = 10_000;

function viewOf(accounts: WalletAccounts): WalletView {
  return walletViewOf({
    balance: Money.of(accounts.walletBalance),
    reserved: Money.of(accounts.holdBalance),
    creditLimit: Money.of(accounts.creditLimit),
  });
}

/**
 * Reads the merchant wallet of an account.
 *
 * Why: the portal shows a merchant the four wallet figures and a paged statement, and Dhru's `accountinfo` names the same balance (RULES
 * merchants 5-6). Balances are never cached (decision 022): every call reads the ledger accounts. The account is the merchant of its
 * session (the rank gate has already refused any other rank), so there is no existence check here; the staff reads of an account of any
 * rank are `AccountWalletAdmin`'s.
 *
 * Side effects: none (reads only).
 *
 * @see GET /client/wallet, GET /client/wallet/statement
 */
@Injectable()
export class WalletService {
  constructor(private readonly db: DbService) {}

  /**
   * The signed-in merchant's own wallet view.
   *
   * @param accountId the authenticated account (merchant rank)
   * @returns the four figures; all zero while the account has no merchant wallet
   */
  viewForMerchant(accountId: number): Promise<WalletView> {
    return this.viewOf(this.db.db, accountId);
  }

  /**
   * The merchant wallet view of an account, without any check.
   *
   * @param executor the database or a transaction
   * @param accountId the account (already authenticated or checked)
   * @returns the four figures; all zero while the account has no merchant wallet
   */
  async viewOf(executor: DbExecutor, accountId: number): Promise<WalletView> {
    const accounts = await readWalletAccounts(executor, accountId, BASE_CURRENCY);
    return viewOf(accounts);
  }

  /**
   * A merchant's statement lines, newest first by default.
   *
   * Why: `amount` is signed from the merchant side (a deposit is positive, an order hold negative), the wallet being credit-normal;
   * `balanceAfter` is the wallet balance after the line, which is already the merchant's side (ANSWERS merchants Q3).
   *
   * @param accountId the authenticated account (merchant rank)
   * @param order the direction of `createdAt`
   * @param range where the page starts and how many lines it holds
   * @returns the lines and the number of lines on the wallet
   */
  async statementOf(
    accountId: number,
    order: 'asc' | 'desc',
    range: { readonly start: number; readonly limit: number },
  ): Promise<{ rows: StatementLine[]; total: number }> {
    const { walletId } = await readWalletAccounts(this.db.db, accountId, BASE_CURRENCY);
    if (walletId === undefined) return { rows: [], total: 0 };
    const { rows, total } = await listAccountEntries(this.db.db, walletId, order, range);
    return {
      total,
      rows: rows.map((row) => ({
        id: row.id,
        transactionId: row.transactionId,
        kind: row.kind,
        memo: row.memo,
        amount: Money.of(row.amount).neg().toWire(),
        balanceAfter: row.balanceAfter,
        createdAt: row.createdAt.toISOString(),
      })),
    };
  }
}
