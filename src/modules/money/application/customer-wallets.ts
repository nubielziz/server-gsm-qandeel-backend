// CustomerWallets: the read side, the freeze and the erasure check of an account's store balance (feature 21, plan § 5.6.1 to § 5.6.3 and
// § 5.6.10, decision 064). Public service of the money module: the customers module calls it for the anonymize guard and the data export, the
// disputes call it to hold a wallet, the checkout asks it for the figures of a balance payment.
import { Inject, Injectable } from '@nestjs/common';
import type { z } from 'zod';
import { CLOCK, type Clock } from '../../../common/clock';
import type { ParsedFilter, ParsedListQuery } from '../../../common/contract';
import { type CustomerContact, customerEmailIn } from '../../../common/customer-contact';
import { AppError } from '../../../common/errors';
import { Money } from '../../../common/money';
import { DbService, type DbExecutor, type Transaction, escapeLike } from '../../../infra/db';
import { AuditService, SettingsReader } from '../../platform';
import type {
  StoreStatementRowSchema,
  StoreWalletSchema,
  WalletRowSchema,
} from '../contracts/customer-wallet.contracts';
import { BASE_CURRENCY } from '../domain/accounts';
import {
  type CustomerWalletPolicy,
  availableOf,
  customerMemo,
  customerWalletPolicy,
  erasureRefusal,
  roomOf,
} from '../domain/customer-wallet-policy';
import type { AccountWalletView } from '../ports/account-wallets';
import type { WalletErasure } from '../ports/wallet-erasure';
import {
  type CustomerWalletRow,
  balancePaidOrderIds,
  countOpenTopUpDisputes,
  ensureLockedCustomerWallet,
  hasPendingTopUpPayment,
  listCustomerWallets,
  listWalletEntries,
  lockWalletsOf,
  openBalanceRefundId,
  readCustomerWallet,
  readTopUpFigures,
  voidUnpaidTopUps,
  writeWalletFreeze,
} from '../infra/customer-wallet.repository';
import { type WalletCustomer, findWalletCustomer } from '../infra/foreign-directory.repository';
import { CustomerWalletMails } from './customer-wallet-mails';
import { StorefrontOrderPorts } from './storefront-ports';

/** The store balance of an account on the store wire. */
export type StoreWallet = z.output<typeof StoreWalletSchema>;
/** The store wallet of an account as staff read it: the one wallet view of every account, for the store kind. */
export type AdminWallet = AccountWalletView;
/** A line of the account's own statement. */
export type StoreStatementLine = z.output<typeof StoreStatementRowSchema>;
/** A wallet of the staff list. */
export type WalletListRow = z.output<typeof WalletRowSchema>;

/** What a balance payment checks before it posts (a friendly pre-check; the posting's own guard decides). */
export interface WalletPeek {
  readonly balance: Money;
  readonly frozen: boolean;
}

/** The wallet part of an account's data export. */
export interface WalletExport {
  readonly currency: string;
  readonly balance: string;
  readonly entries: ReadonlyArray<{ at: string; kind: string; memo: string; amount: string; balanceAfter: string }>;
}

/** The most statement lines a data export holds. */
const EXPORT_LINES = 10_000;

/** The posting-time window of a statement request (`createdAt_gte`, `createdAt_lte`). */
function windowOf(filters: readonly ParsedFilter[]): { from?: Date; to?: Date } {
  const at = (op: 'gte' | 'lte') => {
    const value = filters.find((filter) => filter.field === 'createdAt' && filter.op === op)?.values[0];
    return value instanceof Date ? value : undefined;
  };
  const from = at('gte');
  const to = at('lte');
  return { ...(from ? { from } : {}), ...(to ? { to } : {}) };
}

const frozenOf = (wallet: CustomerWalletRow | undefined) =>
  wallet?.frozenAt ? { at: wallet.frozenAt.toISOString(), reason: wallet.frozenReason } : null;

/** How an audit row names an account: the name, else the email; an anonymized one by number (its old name is personal data). */
function labelOf(account: WalletCustomer): string {
  if (account.status === 'anonymized') return `account ${account.id}`;
  return account.name.trim() || account.email;
}

/**
 * Reads and holds the store balances of accounts, and checks their erasure.
 *
 * Why: the owner's store balance (ROADMAP 2W, lead rule L5, decision 064): an account of the retail rank reads its balance, its limits and a
 * statement; staff list every live store wallet, and the unified wallet routes of `/admin/clients/:id` hold and release it through the
 * in-transaction methods here. Balances, freezes and limits are read from Postgres on every call and never cached (decision 022, plan § 5.1
 * invariant 7). The freeze use cases lock only the wallet row and post nothing afterwards (plan § 5.7). The wallet is the `customer_wallet`
 * ledger account owned by `('account', id)`; every id here is an account id. The class is the implementation of `WalletErasure` (`closeForErasure`).
 *
 * Side effects: `freezeInTx` and `freezeAfterPosting` update the wallet row, write an audit row (entity `account`) and a `wallet.frozen` mail;
 * `unfreezeInTx` updates the row and writes an audit row; `closeForErasure` locks the account's wallet rows and voids unpaid top-ups.
 */
@Injectable()
export class CustomerWallets implements WalletErasure {
  constructor(
    private readonly db: DbService,
    private readonly audit: AuditService,
    private readonly settings: SettingsReader,
    private readonly mails: CustomerWalletMails,
    private readonly orders: StorefrontOrderPorts,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  /**
   * The store wallet policy of the current settings.
   *
   * @returns the eight settings with their safe defaults
   */
  async policy(): Promise<CustomerWalletPolicy> {
    return customerWalletPolicy(await this.settings.all());
  }

  /**
   * The signed-in account's own store balance.
   *
   * @param accountId the authenticated account (the route allows the retail rank only)
   * @returns the store view (zeros while no wallet exists)
   */
  async viewForCustomer(accountId: number): Promise<StoreWallet> {
    const policy = await this.policy();
    const now = this.clock.now();
    const [wallet, figures] = await Promise.all([
      readCustomerWallet(this.db.db, accountId),
      readTopUpFigures(this.db.db, accountId, now),
    ]);
    const balance = Money.of(wallet?.balance ?? '0');
    const pendingNet = Money.of(figures.pendingNet);
    const amountLeft = policy.topUpAmountPerDay.sub(Money.of(figures.dayAmount));
    return {
      enabled: policy.enabled,
      cardTopUps: policy.cardTopUps,
      currency: BASE_CURRENCY,
      balance: balance.toWire(),
      reserved: Money.zero().toWire(),
      creditLimit: Money.zero().toWire(),
      available: availableOf({ balance, frozen: wallet?.frozenAt != null, enabled: policy.enabled }).toWire(),
      frozen: wallet?.frozenAt ? { at: wallet.frozenAt.toISOString() } : null,
      pendingTopUps: { count: figures.pendingCount, amount: pendingNet.toWire() },
      limits: {
        minTopUp: policy.minTopUp.toWire(),
        maxTopUp: policy.maxTopUp.toWire(),
        maxBalance: policy.maxBalance.toWire(),
        room: roomOf(policy.maxBalance, balance, pendingNet).toWire(),
        topUpsLeftToday: Math.max(0, policy.topUpsPerDay - figures.dayCount),
        amountLeftToday: (amountLeft.isNegative() ? Money.zero() : amountLeft).toWire(),
      },
    };
  }

  /**
   * A page of the account's own statement, the staff reason of an adjustment hidden.
   *
   * @param accountId the authenticated account
   * @param query the parsed list request (`createdAt` sort and window)
   * @returns the lines and their total
   */
  async statementForCustomer(
    accountId: number,
    query: ParsedListQuery<'createdAt'>,
  ): Promise<{ rows: StoreStatementLine[]; total: number }> {
    const wallet = await readCustomerWallet(this.db.db, accountId);
    if (!wallet) return { rows: [], total: 0 };
    const page = await listWalletEntries(this.db.db, wallet.id, {
      order: query.sort[0]?.order ?? 'desc',
      range: query.range,
      ...windowOf(query.filters),
    });
    return {
      total: page.total,
      rows: page.rows.map((row) => ({
        id: row.id,
        transactionId: row.transactionId,
        kind: row.kind,
        memo: customerMemo(row.kind, row.memo),
        orderId: row.refType === 'order' ? row.refId : null,
        amount: Money.of(row.amount).neg().toWire(),
        balanceAfter: row.balanceAfter,
        createdAt: row.createdAt.toISOString(),
      })),
    };
  }

  /**
   * Lists the live store wallets of accounts for staff.
   *
   * Why: decision 064: a wallet is listed while its owner's rank is a retail rank; `customer.id` is the account id.
   *
   * @param query the parsed list request (`state`, sorts, `q` on the owner's name and, for a caller who may read accounts, address)
   * @param contact what the caller may see of an address (decision 047, rule A and the search)
   * @returns the page and the total
   */
  async list(
    query: ParsedListQuery<'balance' | 'updatedAt'>,
    contact: CustomerContact,
  ): Promise<{ rows: WalletListRow[]; total: number }> {
    const page = await listCustomerWallets(
      this.db.db,
      query,
      query.search ? { pattern: `%${escapeLike(query.search.text)}%`, matchEmail: contact === 'full' } : undefined,
    );
    return {
      total: page.total,
      rows: page.rows.map((row) => ({
        customer: {
          id: row.ownerId,
          name: row.name,
          email: customerEmailIn(contact, row.email),
          status: row.status,
        },
        balance: row.balance,
        frozen: frozenOf(row),
        updatedAt: row.updatedAt.toISOString(),
      })),
    };
  }

  /**
   * Puts an account's store balance on hold inside the caller's transaction (staff, or a top-up dispute as the system).
   *
   * Why: the freeze locks only the wallet row and the caller posts nothing afterwards (plan § 5.7). The audit row's actor comes from the
   * request context: staff, or `system` for a webhook or a job. Freezing a frozen wallet changes nothing and is still audited
   * (`alreadyFrozen`). The caller holds the account row lock and has read that the account's live wallet is the store wallet (decision 064).
   *
   * Side effects: may open the wallet; sets `frozen_at` and `frozen_reason` on the locked wallet row; one audit row; one `wallet.frozen`
   * mail when it changed.
   *
   * @param tx the caller's transaction
   * @param accountId the account (checked by the caller)
   * @param reason why
   * @returns whether the wallet was frozen by this call
   */
  async freezeInTx(tx: DbExecutor, accountId: number, reason: string): Promise<{ changed: boolean }> {
    const wallet = await ensureLockedCustomerWallet(tx, accountId);
    return this.applyFreeze(tx, accountId, wallet, reason);
  }

  /**
   * Freezes a wallet whose row this transaction already holds through a posting (the top-up chargeback clawback).
   *
   * Why: plan 21 § 5.7: a transaction that posts never locks the wallet first; the freeze after the posting reuses the posting's lock, and
   * the deferred trigger checks at commit that a wallet below zero is frozen.
   *
   * Side effects: updates the wallet row; one audit row; one `wallet.frozen` mail when it changed.
   *
   * @param tx the transaction that posted
   * @param accountId the account
   * @param reason why
   * @returns whether the wallet was frozen by this call
   */
  async freezeAfterPosting(tx: DbExecutor, accountId: number, reason: string): Promise<{ changed: boolean }> {
    const wallet = await readCustomerWallet(tx, accountId, true);
    if (!wallet) throw new Error(`Account ${accountId} has no store wallet after a posting.`);
    return this.applyFreeze(tx, accountId, wallet, reason);
  }

  /**
   * Lifts the hold on an account's store balance inside the caller's transaction (staff).
   *
   * Why: plan 21 § 5.6.3 and P2: a person decides; a wallet below zero stays frozen until the balance is brought back (the database also
   * refuses it at commit), and so does one with an open top-up dispute. Unfreezing a wallet that is not frozen changes nothing and is
   * still audited (`alreadyUnfrozen`). The caller holds the account row lock (decision 064).
   *
   * Side effects: clears `frozen_at` and `frozen_reason` on the locked wallet row; one audit row.
   *
   * @param tx the caller's transaction
   * @param accountId the account (checked by the caller)
   * @param reason the staff note
   * @returns whether the wallet was unfrozen by this call
   * @throws {AppError} `CONFLICT` (balance below zero), `OPEN_DISPUTE`
   */
  async unfreezeInTx(tx: DbExecutor, accountId: number, reason: string): Promise<{ changed: boolean }> {
    const wallet = await readCustomerWallet(tx, accountId, true);
    const frozenAt = wallet?.frozenAt ?? null;
    if (wallet && frozenAt) {
      if (Money.of(wallet.balance).isNegative()) {
        throw new AppError('CONFLICT', { detail: 'Bring the balance to zero or above first.' });
      }
      if ((await countOpenTopUpDisputes(tx, accountId)) > 0) throw new AppError('OPEN_DISPUTE');
      await writeWalletFreeze(tx, wallet.id, null, this.clock.now());
    }
    const account = await findWalletCustomer(tx, accountId);
    await this.audit.record(tx, {
      action: 'unfroze wallet of',
      entityType: 'account',
      entityId: accountId,
      entityLabel: account ? labelOf(account) : `account ${accountId}`,
      before: { frozen: frozenAt ? { at: frozenAt.toISOString(), reason: wallet?.frozenReason ?? '' } : null },
      after: { frozen: null, reason, ...(frozenAt ? {} : { alreadyUnfrozen: true }) },
    });
    return { changed: frozenAt !== null };
  }

  /**
   * A cheap look at the balance and the hold, for a friendly refusal before a balance payment posts.
   *
   * @param tx the caller's transaction
   * @param accountId the account
   * @returns the balance (zero without a wallet) and whether it is frozen
   */
  async peek(tx: DbExecutor, accountId: number): Promise<WalletPeek> {
    const wallet = await readCustomerWallet(tx, accountId);
    return { balance: Money.of(wallet?.balance ?? '0'), frozen: wallet?.frozenAt != null };
  }

  /**
   * The balance and what can be spent of it now, as a balance payment answers them.
   *
   * @param db the database or the caller's transaction
   * @param accountId the account
   * @param policy the wallet policy read before the transaction
   * @returns the balance and the available amount (zero while frozen, switched off or not positive)
   */
  async figuresOf(
    db: DbExecutor,
    accountId: number,
    policy: CustomerWalletPolicy,
  ): Promise<{ balance: string; available: string }> {
    const { balance, frozen } = await this.peek(db, accountId);
    return { balance: balance.toWire(), available: availableOf({ balance, frozen, enabled: policy.enabled }).toWire() };
  }

  /**
   * Refuses to erase an account while money is on, or on its way to, any of its wallets, and voids the top-ups nobody can pay any more.
   *
   * Why: decision 064, O12 and risk K11: a balance is never stranded on an anonymized account. It runs as the last step of the anonymize
   * transaction, under the account row lock the caller holds: it locks every wallet-kind ledger account of the account in id order (which
   * must come after every other row: plan § 5.7) and refuses while a wallet or the hold is not zero or a wallet is on hold, a top-up
   * waits for review, a top-up dispute is open, an order paid from the balance is still open (its rejection refunds to the balance, plan
   * § 5.6.7; the orders module tells which orders are open: `StorefrontOrderPort.openAmong`) or a refund to the balance waits for staff.
   * The refusal text is `erasureRefusal`'s. An open order paid by card does not hold the erasure.
   *
   * Side effects: locks the account's wallet rows; voids the account's open top-ups that have no payment.
   *
   * @param tx the anonymize transaction
   * @param accountId the account (the retail account, or the guest row erased with it)
   * @throws {AppError} `CONFLICT` (409) naming what is left
   */
  async closeForErasure(tx: Transaction, accountId: number): Promise<void> {
    const wallets = await lockWalletsOf(tx, accountId);
    const paidFromBalance = await balancePaidOrderIds(tx, accountId);
    // Only an account with a balance-paid order asks the orders module, so a process without it never reaches the port.
    const [openOrderId] = paidFromBalance.length === 0 ? [] : await this.orders.get().openAmong(tx, paidFromBalance);
    const refusal = erasureRefusal({
      wallets: wallets.map((wallet) => ({
        kind: wallet.kind,
        balance: Money.of(wallet.balance),
        frozen: wallet.frozenAt !== null,
      })),
      pendingTopUpPayment: await hasPendingTopUpPayment(tx, accountId),
      openTopUpDisputes: await countOpenTopUpDisputes(tx, accountId),
      openBalanceOrderId: openOrderId,
      openBalanceRefundId: await openBalanceRefundId(tx, accountId),
    });
    if (refusal !== undefined) throw new AppError('CONFLICT', { detail: refusal });
    await voidUnpaidTopUps(tx, accountId, this.clock.now());
  }

  /**
   * The wallet part of an account's data export.
   *
   * Why: plan 21 § 5.6.10: the access right covers the balance and its history; the memos are the account's (staff reasons hidden).
   *
   * @param tx the export transaction
   * @param accountId the account
   * @returns the currency, the balance and up to 10,000 lines, oldest first
   */
  async exportOf(tx: DbExecutor, accountId: number): Promise<WalletExport> {
    const wallet = await readCustomerWallet(tx, accountId);
    if (!wallet) return { currency: BASE_CURRENCY, balance: Money.zero().toWire(), entries: [] };
    const { rows } = await listWalletEntries(tx, wallet.id, { order: 'asc', range: { start: 0, limit: EXPORT_LINES } });
    return {
      currency: BASE_CURRENCY,
      balance: wallet.balance,
      entries: rows.map((row) => ({
        at: row.createdAt.toISOString(),
        kind: row.kind,
        memo: customerMemo(row.kind, row.memo),
        amount: Money.of(row.amount).neg().toWire(),
        balanceAfter: row.balanceAfter,
      })),
    };
  }

  /**
   * The staff view of an account's store wallet, read with the given executor.
   *
   * Why: the one wallet view of every account (decision 064) for the store kind; the unified wallet routes answer it. A store wallet has no
   * reserved amount, no credit and never allows credit.
   *
   * @param db the database or the use case's transaction
   * @param accountId the account (already checked)
   * @param policy the wallet policy
   * @returns the view, `kind: 'store'` (zeros while no wallet exists)
   */
  async adminView(db: DbExecutor, accountId: number, policy: CustomerWalletPolicy): Promise<AdminWallet> {
    // One after the other: `db` may be a transaction, whose single connection runs one query at a time.
    const wallet = await readCustomerWallet(db, accountId);
    const figures = await readTopUpFigures(db, accountId, this.clock.now());
    const openDisputes = await countOpenTopUpDisputes(db, accountId);
    const balance = Money.of(wallet?.balance ?? '0');
    return {
      kind: 'store',
      enabled: policy.enabled,
      currency: BASE_CURRENCY,
      balance: balance.toWire(),
      reserved: Money.zero().toWire(),
      creditLimit: Money.zero().toWire(),
      available: availableOf({ balance, frozen: wallet?.frozenAt != null, enabled: policy.enabled }).toWire(),
      creditAllowed: false,
      frozen: frozenOf(wallet),
      pendingTopUps: { count: figures.pendingCount, amount: figures.pendingNet },
      openDisputes,
      adjustApprovalLimit: policy.adjustApprovalLimit.toWire(),
    };
  }

  private async applyFreeze(
    tx: DbExecutor,
    accountId: number,
    wallet: CustomerWalletRow,
    reason: string,
  ): Promise<{ changed: boolean }> {
    const account = await findWalletCustomer(tx, accountId);
    const already = wallet.frozenAt !== null;
    const at = this.clock.now();
    if (!already) await writeWalletFreeze(tx, wallet.id, { at, reason }, at);
    await this.audit.record(tx, {
      action: 'froze wallet of',
      entityType: 'account',
      entityId: accountId,
      entityLabel: account ? labelOf(account) : `account ${accountId}`,
      before: { frozen: wallet.frozenAt ? { at: wallet.frozenAt.toISOString(), reason: wallet.frozenReason } : null },
      after: wallet.frozenAt
        ? { frozen: { at: wallet.frozenAt.toISOString(), reason: wallet.frozenReason }, alreadyFrozen: true, reason }
        : { frozen: { at: at.toISOString(), reason } },
    });
    if (!already) await this.mails.frozen(tx, { customerId: accountId, frozenAt: at });
    return { changed: !already };
  }
}
