// AccountWalletsService: the money module's implementation of the AccountWallets port (decision 064): which wallet an account has now, the
// figures of the live wallet of many accounts, and the refusal of a new hold on a frozen merchant wallet.
import { Inject, Injectable } from '@nestjs/common';
import { CLOCK, type Clock } from '../../../common/clock';
import { AppError } from '../../../common/errors';
import { Money } from '../../../common/money';
import type { DbExecutor, Transaction } from '../../../infra/db';
import { rankKindOf } from '../../identity';
import { SettingsReader } from '../../platform';
import { BASE_CURRENCY, liveWalletFigures } from '../domain/accounts';
import { AUTOMATIC_TOPUP_LIVE_HOURS, customerWalletPolicy } from '../domain/customer-wallet-policy';
import { ADJUST_APPROVAL_LIMIT_KEY, approvalLimitOf } from '../domain/wallet-rules';
import { findRankGroupKind } from '../infra/foreign-directory.repository';
import {
  type AccountWalletRow,
  readAccountWalletRows,
  readMerchantWalletFreeze,
} from '../infra/ledger-read.repository';
import { AccountWallets, type AccountWalletKind, type AccountWalletView } from '../ports/account-wallets';

/**
 * Reads the live wallet of accounts and guards the merchant wallet's freeze.
 *
 * Why: the wallet kind follows the kind of the account's rank (decision 064): a merchant rank has `client_wallet` and `client_hold`, any
 * other rank has `customer_wallet`. A rank change can leave the other kind's wallet at zero behind, so callers never guess a kind: they ask
 * here, under the account row lock they already hold. The staff list of accounts needs every figure of a page in a few statements, not one
 * read per row.
 *
 * Side effects: none (reads only; balances are never cached, decision 022).
 *
 * @see GET /admin/clients, GET /client/wallet, GET /store/v1/me/wallet
 */
@Injectable()
export class AccountWalletsService extends AccountWallets {
  constructor(
    private readonly settings: SettingsReader,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {
    super();
  }

  /**
   * Names the kind of the account's live wallet.
   *
   * @param tx the caller's transaction, after it locked the account row (a path reads the rank kind only under that lock)
   * @param accountId the account
   * @returns `merchant` for a merchant rank, `store` for any other
   * @throws {Error} when no such account exists: the caller holds its row lock, so a missing row is a defect, never a request
   */
  async kindOf(tx: Transaction, accountId: number): Promise<AccountWalletKind> {
    const groupKind = await findRankGroupKind(tx, accountId);
    if (groupKind === undefined) throw new Error(`Account ${accountId} does not exist.`);
    return walletKindOf(groupKind);
  }

  /**
   * Reads the live wallet of many accounts.
   *
   * Why: the view of an account is the one of its rank's kind, so a merchant sees `client_wallet` and its hold and a retail account its store
   * balance, whatever the other kind holds (it must hold zero). An account whose wallet was never opened reads as zeros, with the kind of
   * its rank: the list shows a kind for every row.
   *
   * @param db the database or a transaction
   * @param accountIds the accounts
   * @returns the view of each account that exists; ids that name no account are missing from the map
   */
  async viewsOf(db: DbExecutor, accountIds: readonly number[]): Promise<Map<number, AccountWalletView>> {
    const views = new Map<number, AccountWalletView>();
    if (accountIds.length === 0) return views;
    const settings = await this.settings.all();
    const policy = customerWalletPolicy(settings);
    const merchantLimit = approvalLimitOf(settings[ADJUST_APPROVAL_LIMIT_KEY]);
    const liveSince = new Date(this.clock.now().getTime() - AUTOMATIC_TOPUP_LIVE_HOURS * 3_600_000);
    const rows = await readAccountWalletRows(db, accountIds, BASE_CURRENCY, liveSince);
    for (const row of rows) {
      const kind = walletKindOf(row.groupKind);
      views.set(
        row.accountId,
        kind === 'merchant'
          ? merchantView(row, merchantLimit)
          : storeView(row, policy.enabled, policy.adjustApprovalLimit),
      );
    }
    return views;
  }

  /**
   * Refuses a new hold on a frozen merchant wallet.
   *
   * Why: a frozen `client_wallet` takes no new hold: the portal and Dhru placement call this after the account row lock and before the
   * hold is posted. Settlement and release of holds that exist, credits and staff debits still post. The wallet row is read without a lock:
   * locking it here, before the system accounts of the posting, would break the ledger lock order, and a freeze that commits a moment after
   * this read is the same as a freeze that came right after the hold.
   *
   * @param tx the caller's transaction, after the account row lock
   * @param accountId the account
   * @throws {AppError} `WALLET_FROZEN` (409) when the account's merchant wallet is frozen
   */
  async assertNotFrozen(tx: Transaction, accountId: number): Promise<void> {
    const freeze = await readMerchantWalletFreeze(tx, accountId, BASE_CURRENCY);
    if (freeze !== undefined) {
      throw new AppError('WALLET_FROZEN', {
        detail: 'This wallet is on hold, so it cannot take new orders. Contact support.',
      });
    }
  }
}

/** The wallet kind of a stored rank kind: only `b2b` is a merchant rank, any other kind (and any unknown one) has the store balance. */
function walletKindOf(groupKind: string): AccountWalletKind {
  return rankKindOf(groupKind) === 'merchant' ? 'merchant' : 'store';
}

const frozenOf = (frozenAt: Date | null, reason: string): AccountWalletView['frozen'] =>
  frozenAt === null ? null : { at: frozenAt.toISOString(), reason };

function merchantView(row: AccountWalletRow, approvalLimit: Money): AccountWalletView {
  const wallet = row.merchant;
  const figures = liveWalletFigures({
    kind: 'merchant',
    balance: Money.of(wallet?.balance ?? '0'),
    hold: Money.of(row.holdBalance ?? '0'),
    creditLimit: Money.of(wallet?.creditLimit ?? '0'),
    frozen: wallet?.frozenAt != null,
    enabled: true,
  });
  return {
    kind: 'merchant',
    currency: BASE_CURRENCY,
    ...figures,
    creditAllowed: row.creditAllowed,
    frozen: wallet ? frozenOf(wallet.frozenAt, wallet.frozenReason) : null,
    enabled: true,
    pendingTopUps: { count: row.pendingCount, amount: Money.of(row.pendingNet).toWire() },
    openDisputes: row.openDisputes,
    adjustApprovalLimit: approvalLimit.toWire(),
  };
}

function storeView(row: AccountWalletRow, enabled: boolean, approvalLimit: Money): AccountWalletView {
  const wallet = row.store;
  const figures = liveWalletFigures({
    kind: 'store',
    balance: Money.of(wallet?.balance ?? '0'),
    hold: Money.zero(),
    creditLimit: Money.zero(),
    frozen: wallet?.frozenAt != null,
    enabled,
  });
  return {
    kind: 'store',
    currency: BASE_CURRENCY,
    ...figures,
    // The store balance never has credit, whatever the rank row says (the retail rank must not allow it).
    creditAllowed: false,
    frozen: wallet ? frozenOf(wallet.frozenAt, wallet.frozenReason) : null,
    enabled,
    pendingTopUps: { count: row.pendingCount, amount: Money.of(row.pendingNet).toWire() },
    openDisputes: row.openDisputes,
    adjustApprovalLimit: approvalLimit.toWire(),
  };
}
