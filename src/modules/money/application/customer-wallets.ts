// CustomerWallets: the read side, staff adjustments and the freeze of a storefront customer's store balance (feature 21, plan § 5.6.1 to
// § 5.6.3 and § 5.6.10). Public service of the money module: the customers module calls it for the anonymize guard and the data export.
import { Inject, Injectable } from '@nestjs/common';
import type { z } from 'zod';
import { CLOCK, type Clock } from '../../../common/clock';
import type { ParsedFilter, ParsedListQuery } from '../../../common/contract';
import { type CustomerContact, customerEmailIn } from '../../../common/customer-contact';
import { AppError } from '../../../common/errors';
import { Money } from '../../../common/money';
import { DbService, type DbExecutor, escapeLike } from '../../../infra/db';
import { type StaffPrincipal, isOwner } from '../../identity';
import { AuditService, SettingsReader } from '../../platform';
import type {
  AdminWalletSchema,
  StoreStatementRowSchema,
  StoreWalletSchema,
  WalletRowSchema,
} from '../contracts/customer-wallet.contracts';
import type { StatementRowSchema } from '../contracts/wallet.contracts';
import { BASE_CURRENCY } from '../domain/accounts';
import { customerAdjust } from '../domain/customer-wallet-events';
import {
  type CustomerWalletPolicy,
  availableOf,
  customerMemo,
  customerWalletPolicy,
  roomOf,
} from '../domain/customer-wallet-policy';
import { ADJUST_WINDOW_MS, adjustmentNeedsOwner, adjustmentRefusalDetail } from '../domain/wallet-rules';
import { lockStaffAdjustments, staffCreditsSince } from '../infra/adjustment.repository';
import {
  type CustomerWalletRow,
  balancePaidOrderIds,
  countOpenTopUpDisputes,
  ensureLockedCustomerWallet,
  hasPendingTopUpPayment,
  listCustomerWallets,
  listWalletEntries,
  openBalanceRefundId,
  readCustomerWallet,
  readTopUpFigures,
  voidUnpaidTopUps,
  writeWalletFreeze,
} from '../infra/customer-wallet.repository';
import {
  type WalletCustomer,
  findCustomerIdsByNameOrEmail,
  findWalletCustomer,
  loadWalletCustomers,
} from '../infra/foreign-directory.repository';
import { findJournal } from '../infra/ledger-read.repository';
import { findHeaderByKey } from '../infra/ledger-writer.repository';
import { CustomerWalletMails } from './customer-wallet-mails';
import { LedgerPoster, type PostedTransaction } from './post-transaction';
import { StorefrontOrderPorts } from './storefront-ports';

/** The customer's wallet on the store wire. */
export type StoreWallet = z.output<typeof StoreWalletSchema>;
/** A customer's wallet on the staff wire. */
export type AdminWallet = z.output<typeof AdminWalletSchema>;
/** A line of the customer's own statement. */
export type StoreStatementLine = z.output<typeof StoreStatementRowSchema>;
/** A line of the staff statement (the merchant statement's shape). */
export type AdminStatementLine = z.output<typeof StatementRowSchema>;
/** A wallet of the staff list. */
export type WalletListRow = z.output<typeof WalletRowSchema>;

/** What a staff adjustment asks for. */
export interface CustomerAdjustInput {
  readonly amount: string;
  readonly direction: 'credit' | 'debit';
  readonly reason: string;
  /** The required `Idempotency-Key` (O15). */
  readonly idempotencyKey: string;
}

/** What a balance payment checks before it posts (a friendly pre-check; the posting's own guard decides). */
export interface WalletPeek {
  readonly balance: Money;
  readonly frozen: boolean;
}

/** The wallet part of a customer data export. */
export interface WalletExport {
  readonly currency: string;
  readonly balance: string;
  readonly entries: ReadonlyArray<{ at: string; kind: string; memo: string; amount: string; balanceAfter: string }>;
}

/** The most statement lines a data export holds. */
const EXPORT_LINES = 10_000;

const notFound = () => new AppError('NOT_FOUND', { detail: 'No customer with this id.' });

/** How an audit row names a customer: the name, else the email; an anonymized one by number (its old name is personal data). */
function labelOf(customer: WalletCustomer): string {
  if (customer.status === 'anonymized') return `customer ${customer.id}`;
  return customer.name.trim() || customer.email;
}

function parsePositiveAmount(text: string): Money {
  const bad = new AppError('VALIDATION_FAILED', {
    errors: [{ field: 'amount', code: 'min', message: 'Enter an amount greater than zero.' }],
  });
  try {
    const amount = Money.fromWire(text);
    if (!amount.isPositive()) throw bad;
    return amount;
  } catch (error) {
    if (error instanceof AppError) throw error;
    throw bad;
  }
}

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

/**
 * Reads and changes customers' store balances.
 *
 * Why: the owner's customer wallet (ROADMAP 2W, lead rule L5): the customer reads the balance, its limits and a statement; staff read the
 * same, adjust it with a reason, freeze and unfreeze it, and list every wallet. Balances, freezes and limits are read from Postgres on every
 * call and never cached (decision 022, plan § 5.1 invariant 7). Every posting goes through `LedgerPoster`; the freeze use cases lock only
 * the wallet row and post nothing afterwards (plan § 5.7).
 *
 * Side effects: `adjust` posts one ledger transaction, writes an audit row and a `wallet.adjusted` mail; `freeze`/`unfreeze` update the
 * wallet row, write an audit row (and a `wallet.frozen` mail); `closeForErasure` voids unpaid top-ups.
 */
@Injectable()
export class CustomerWallets {
  constructor(
    private readonly db: DbService,
    private readonly poster: LedgerPoster,
    private readonly audit: AuditService,
    private readonly settings: SettingsReader,
    private readonly mails: CustomerWalletMails,
    private readonly orders: StorefrontOrderPorts,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  /**
   * The customer wallet policy of the current settings.
   *
   * @returns the eight settings with their safe defaults
   */
  async policy(): Promise<CustomerWalletPolicy> {
    return customerWalletPolicy(await this.settings.all());
  }

  /**
   * The signed-in customer's own wallet.
   *
   * @param customerId the authenticated customer
   * @returns the store view (zeros while no wallet exists)
   */
  async viewForCustomer(customerId: number): Promise<StoreWallet> {
    const policy = await this.policy();
    const now = this.clock.now();
    const [wallet, figures] = await Promise.all([
      readCustomerWallet(this.db.db, customerId),
      readTopUpFigures(this.db.db, customerId, now),
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
   * A customer's wallet, for staff.
   *
   * @param customerId the customer
   * @returns the staff view (zeros while no wallet exists)
   * @throws {AppError} `NOT_FOUND` when there is no customer with this id
   */
  async viewForStaff(customerId: number): Promise<AdminWallet> {
    if (!(await findWalletCustomer(this.db.db, customerId))) throw notFound();
    return this.adminView(this.db.db, customerId, await this.policy());
  }

  /**
   * A page of the customer's own statement, the staff reason of an adjustment hidden.
   *
   * @param customerId the authenticated customer
   * @param query the parsed list request (`createdAt` sort and window)
   * @returns the lines and their total
   */
  async statementForCustomer(
    customerId: number,
    query: ParsedListQuery<'createdAt'>,
  ): Promise<{ rows: StoreStatementLine[]; total: number }> {
    const page = await this.entriesOf(customerId, query);
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
   * A page of a customer's statement, for staff (full memos).
   *
   * @param customerId the customer
   * @param query the parsed list request (`createdAt` sort and window)
   * @returns the lines and their total
   * @throws {AppError} `NOT_FOUND` when there is no customer with this id
   */
  async statementForStaff(
    customerId: number,
    query: ParsedListQuery<'createdAt'>,
  ): Promise<{ rows: AdminStatementLine[]; total: number }> {
    if (!(await findWalletCustomer(this.db.db, customerId))) throw notFound();
    const page = await this.entriesOf(customerId, query);
    return {
      total: page.total,
      rows: page.rows.map((row) => ({
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

  /**
   * Lists customer wallets for staff.
   *
   * @param query the parsed list request (`state`, sorts, `q` on the customer's name and, for a caller who may read customers, email)
   * @param contact what the caller may see of a customer's address (decision 047, rule A and the search)
   * @returns the page and the total
   */
  async list(
    query: ParsedListQuery<'balance' | 'updatedAt'>,
    contact: CustomerContact,
  ): Promise<{ rows: WalletListRow[]; total: number }> {
    const db = this.db.db;
    const ids = query.search
      ? await findCustomerIdsByNameOrEmail(db, `%${escapeLike(query.search.text)}%`, contact === 'full')
      : undefined;
    const page = await listCustomerWallets(db, query, ids);
    const customers = await loadWalletCustomers(
      db,
      page.rows.map((row) => row.ownerId),
    );
    return {
      total: page.total,
      rows: page.rows.map((row) => {
        const customer = customers.get(row.ownerId);
        return {
          customer: {
            id: row.ownerId,
            name: customer?.name ?? '',
            email: customerEmailIn(contact, customer?.email ?? ''),
            status: customer?.status ?? 'anonymized',
          },
          balance: row.balance,
          frozen: frozenOf(row),
          updatedAt: row.updatedAt.toISOString(),
        };
      }),
    };
  }

  /**
   * Adds to or deducts from a customer's balance by hand.
   *
   * Why: plan 21 § 5.6.2 (the merchant adjust for a customer): a credit needs a customer with an account who is not anonymized; a debit
   * may never take the balance below zero (`INSUFFICIENT_FUNDS`: customers have no credit). The key is
   * `adjust:customer:<id>:<Idempotency-Key>`, so a retry posts once and can never collide with a merchant's `adjust:<id>:...`. Above the
   * approval limit (setting `wallet.customer.adjust_approval_limit`) the server refuses: a staff member's credits to customer balances
   * count together over a rolling 24 hours and a debit counts alone; an Owner is not limited, and a retry of an accepted adjustment is
   * not judged again (decision 049). Allowed while the switch is off or the wallet is frozen (P1, P6).
   *
   * Side effects: one ledger transaction (kind `adjustment`, ref type `customer`), the wallet balance, one audit row, one `wallet.adjusted`
   * mail (not on a replay); opens the wallet on its first credit. Takes the staff member's adjustment lock until the commit.
   *
   * @param caller the staff member who adjusts
   * @param customerId the customer
   * @param input amount, direction, reason and the idempotency key
   * @returns the journal id and the wallet after posting
   * @throws {AppError} `VALIDATION_FAILED` on `amount`, `NOT_FOUND`, `ANONYMIZED` or `NO_ACCOUNT` (a credit), `APPROVAL_REQUIRED`
   *   (409: above the limit, decision 049), `INSUFFICIENT_FUNDS`, `IDEMPOTENCY_KEY_REUSED`
   */
  async adjust(
    caller: StaffPrincipal,
    customerId: number,
    input: CustomerAdjustInput,
  ): Promise<{ transactionId: number; wallet: AdminWallet }> {
    const amount = parsePositiveAmount(input.amount);
    const policy = await this.policy();
    return this.db.runInTransaction(async ({ tx }) => {
      // Lock order: this staff member's adjustment lock first, then (inside the posting) the wallet row.
      await lockStaffAdjustments(tx, caller.staffId);
      const customer = await findWalletCustomer(tx, customerId);
      if (!customer) throw notFound();
      if (input.direction === 'credit') {
        if (customer.status === 'anonymized') throw new AppError('ANONYMIZED');
        if (!customer.hasAccount) {
          throw new AppError('NO_ACCOUNT', { detail: 'Only a customer with an account can hold a store balance.' });
        }
      }
      const key = `adjust:customer:${customerId}:${input.idempotencyKey}`;
      // A retry of an accepted adjustment replays it: it is already part of the sum it would be judged against (decision 049).
      if (!isOwner(caller) && !(await findHeaderByKey(tx, key))) {
        const creditedInWindow =
          input.direction === 'credit'
            ? await staffCreditsSince(tx, caller.staffId, 'customer', new Date(this.clock.nowMs() - ADJUST_WINDOW_MS))
            : Money.zero();
        const facts = { direction: input.direction, amount, creditedInWindow, limit: policy.adjustApprovalLimit };
        if (adjustmentNeedsOwner({ ...facts, owner: false })) {
          throw new AppError('APPROVAL_REQUIRED', { detail: adjustmentRefusalDetail(facts) });
        }
      }
      const memo = `Manual ${input.direction}: ${input.reason}`;
      const posted = await this.poster.post(tx, {
        ...customerAdjust({ customerId, amount, direction: input.direction }),
        refId: customerId,
        idempotencyKey: key,
        currency: BASE_CURRENCY,
        memo,
        createdBy: { type: 'staff', id: caller.staffId },
      });
      if (posted.replayed) await this.assertSameAdjustment(tx, posted, memo, input.direction, amount);
      // The wallet row is locked by the posting until commit, so these figures are the posting's own.
      const wallet = await this.adminView(tx, customerId, policy);
      const touched = posted.touched.find((account) => account.kind === 'customer_wallet');
      await this.audit.record(tx, {
        action: posted.replayed ? 'repeated wallet adjustment of' : 'adjusted wallet of',
        entityType: 'customer',
        entityId: customerId,
        entityLabel: labelOf(customer),
        before: { balance: touched?.before ?? wallet.balance },
        after: {
          balance: wallet.balance,
          transactionId: posted.id,
          amount: amount.toWire(),
          direction: input.direction,
          reason: input.reason,
        },
      });
      if (!posted.replayed) {
        await this.mails.adjusted(tx, {
          customerId,
          transactionId: posted.id,
          amount: amount.toWire(),
          direction: input.direction,
          balance: wallet.balance,
        });
      }
      return { transactionId: posted.id, wallet };
    });
  }

  /**
   * Puts a customer's balance on hold (staff).
   *
   * Why: plan 21 § 5.6.3 and P1: a hold stops paying from the balance and card top-ups. Freezing a frozen wallet changes nothing and
   * answers the same view (still audited, `alreadyFrozen`).
   *
   * Side effects: may open the wallet; sets `frozen_at` and `frozen_reason` on the locked wallet row; one audit row; one `wallet.frozen`
   * mail when it changed.
   *
   * @param customerId the customer
   * @param reason the staff note
   * @returns the wallet after the change
   * @throws {AppError} `NOT_FOUND`
   */
  async freeze(customerId: number, reason: string): Promise<AdminWallet> {
    const policy = await this.policy();
    return this.db.runInTransaction(async ({ tx }) => {
      if (!(await findWalletCustomer(tx, customerId))) throw notFound();
      await this.freezeInTx(tx, customerId, reason);
      return this.adminView(tx, customerId, policy);
    });
  }

  /**
   * Puts a customer's balance on hold inside the caller's transaction (staff, or a top-up dispute as the system).
   *
   * Why: the freeze locks only the wallet row and the caller posts nothing afterwards (plan § 5.7). The audit row's actor comes from the
   * request context: staff, or `system` for a webhook or a job.
   *
   * Side effects: may open the wallet; updates the locked wallet row; one audit row; one `wallet.frozen` mail when it changed.
   *
   * @param tx the caller's transaction
   * @param customerId the customer (checked by the caller)
   * @param reason why
   * @returns whether the wallet was frozen by this call
   */
  async freezeInTx(tx: DbExecutor, customerId: number, reason: string): Promise<{ changed: boolean }> {
    const wallet = await ensureLockedCustomerWallet(tx, customerId);
    return this.applyFreeze(tx, customerId, wallet, reason);
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
   * @param customerId the customer
   * @param reason why
   * @returns whether the wallet was frozen by this call
   */
  async freezeAfterPosting(tx: DbExecutor, customerId: number, reason: string): Promise<{ changed: boolean }> {
    const wallet = await readCustomerWallet(tx, customerId, true);
    if (!wallet) throw new Error(`Customer ${customerId} has no wallet after a posting.`);
    return this.applyFreeze(tx, customerId, wallet, reason);
  }

  /**
   * Lifts the hold on a customer's balance (staff).
   *
   * Why: plan 21 § 5.6.3 and P2: a person decides; a wallet below zero stays frozen until the balance is brought back (the database also
   * refuses it at commit), and so does one with an open top-up dispute. Unfreezing a wallet that is not frozen changes nothing.
   *
   * Side effects: clears `frozen_at` and `frozen_reason` on the locked wallet row; one audit row.
   *
   * @param customerId the customer
   * @param reason the staff note
   * @returns the wallet after the change
   * @throws {AppError} `NOT_FOUND`, `CONFLICT` (balance below zero), `OPEN_DISPUTE`
   */
  async unfreeze(customerId: number, reason: string): Promise<AdminWallet> {
    const policy = await this.policy();
    return this.db.runInTransaction(async ({ tx }) => {
      const customer = await findWalletCustomer(tx, customerId);
      if (!customer) throw notFound();
      const wallet = await readCustomerWallet(tx, customerId, true);
      const frozen = wallet?.frozenAt != null;
      if (wallet && frozen) {
        if (Money.of(wallet.balance).isNegative()) {
          throw new AppError('CONFLICT', { detail: 'Bring the balance to zero or above first.' });
        }
        if ((await countOpenTopUpDisputes(tx, customerId)) > 0) throw new AppError('OPEN_DISPUTE');
        await writeWalletFreeze(tx, wallet.id, null, this.clock.now());
      }
      await this.audit.record(tx, {
        action: 'unfroze wallet of',
        entityType: 'customer',
        entityId: customerId,
        entityLabel: labelOf(customer),
        before: { frozen: frozen ? { at: wallet.frozenAt.toISOString(), reason: wallet.frozenReason } : null },
        after: { frozen: null, reason, ...(frozen ? {} : { alreadyUnfrozen: true }) },
      });
      return this.adminView(tx, customerId, policy);
    });
  }

  /**
   * A cheap look at the balance and the hold, for a friendly refusal before a balance payment posts.
   *
   * @param tx the caller's transaction
   * @param customerId the customer
   * @returns the balance (zero without a wallet) and whether it is frozen
   */
  async peek(tx: DbExecutor, customerId: number): Promise<WalletPeek> {
    const wallet = await readCustomerWallet(tx, customerId);
    return { balance: Money.of(wallet?.balance ?? '0'), frozen: wallet?.frozenAt != null };
  }

  /**
   * The balance and what can be spent of it now, as a balance payment answers them.
   *
   * @param db the database or the caller's transaction
   * @param customerId the customer
   * @param policy the wallet policy read before the transaction
   * @returns the balance and the available amount (zero while frozen, switched off or not positive)
   */
  async figuresOf(
    db: DbExecutor,
    customerId: number,
    policy: CustomerWalletPolicy,
  ): Promise<{ balance: string; available: string }> {
    const { balance, frozen } = await this.peek(db, customerId);
    return { balance: balance.toWire(), available: availableOf({ balance, frozen, enabled: policy.enabled }).toWire() };
  }

  /**
   * Refuses to anonymize a customer while money is on or on its way to the balance, and voids the top-ups nobody can pay any more.
   *
   * Why: O12 and risk K11: a balance is never stranded on an anonymized customer. It runs as the last step of the anonymize transaction
   * (it locks the wallet row, which must come after every other row: plan § 5.7). Money is on its way to the balance while a top-up waits,
   * while an order paid from the balance is still open (its rejection refunds to the balance, plan § 5.6.7) and while a refund of a
   * balance payment waits for staff; the orders module tells which orders are open (`StorefrontOrderPort.openAmong`).
   *
   * Side effects: locks the wallet row; voids the customer's open top-ups that have no payment.
   *
   * @param tx the anonymize transaction
   * @param customerId the customer
   * @throws {AppError} `CONFLICT` while the balance is not zero, a top-up payment is pending, a top-up dispute is open, an order paid
   *   from the balance is open or a refund to the balance is `requested` or `processing`
   */
  async closeForErasure(tx: DbExecutor, customerId: number): Promise<void> {
    const wallet = await readCustomerWallet(tx, customerId, true);
    if (wallet && !Money.of(wallet.balance).isZero()) {
      throw new AppError('CONFLICT', {
        detail: `The customer has a store balance of ${wallet.balance} USD. Bring it to zero with an adjustment first.`,
      });
    }
    if (await hasPendingTopUpPayment(tx, customerId)) {
      throw new AppError('CONFLICT', {
        detail: 'A top-up of this customer waits for review. Approve or reject it first.',
      });
    }
    if ((await countOpenTopUpDisputes(tx, customerId)) > 0) {
      throw new AppError('CONFLICT', { detail: 'A dispute of this customer’s top-up is still open.' });
    }
    const paidFromBalance = await balancePaidOrderIds(tx, customerId);
    // Only a customer with a balance-paid order asks the orders module, so a process without it never reaches the port.
    const [openOrderId] = paidFromBalance.length === 0 ? [] : await this.orders.get().openAmong(tx, paidFromBalance);
    if (openOrderId !== undefined) {
      throw new AppError('CONFLICT', {
        detail: `Order ORD-${openOrderId} of this customer was paid from the store balance and is still open. Complete or reject it first.`,
      });
    }
    const openRefundId = await openBalanceRefundId(tx, customerId);
    if (openRefundId !== undefined) {
      throw new AppError('CONFLICT', {
        detail: `Refund RF-${openRefundId} to this customer’s store balance is still open. Approve or decline it first.`,
      });
    }
    await voidUnpaidTopUps(tx, customerId, this.clock.now());
  }

  /**
   * The wallet part of a customer's data export.
   *
   * Why: plan 21 § 5.6.10: the access right covers the balance and its history; the memos are the customer's (staff reasons hidden).
   *
   * @param tx the export transaction
   * @param customerId the customer
   * @returns the currency, the balance and up to 10,000 lines, oldest first
   */
  async exportOf(tx: DbExecutor, customerId: number): Promise<WalletExport> {
    const wallet = await readCustomerWallet(tx, customerId);
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
   * The staff view of a wallet, read with the given executor.
   *
   * @param db the database or the use case's transaction
   * @param customerId the customer (already checked)
   * @param policy the wallet policy
   * @returns the staff view
   */
  async adminView(db: DbExecutor, customerId: number, policy: CustomerWalletPolicy): Promise<AdminWallet> {
    // One after the other: `db` may be a transaction, whose single connection runs one query at a time.
    const wallet = await readCustomerWallet(db, customerId);
    const figures = await readTopUpFigures(db, customerId, this.clock.now());
    const openDisputes = await countOpenTopUpDisputes(db, customerId);
    const balance = Money.of(wallet?.balance ?? '0');
    return {
      enabled: policy.enabled,
      currency: BASE_CURRENCY,
      balance: balance.toWire(),
      reserved: Money.zero().toWire(),
      creditLimit: Money.zero().toWire(),
      available: availableOf({ balance, frozen: wallet?.frozenAt != null, enabled: policy.enabled }).toWire(),
      frozen: frozenOf(wallet),
      pendingTopUps: { count: figures.pendingCount, amount: figures.pendingNet },
      openDisputes,
      adjustApprovalLimit: policy.adjustApprovalLimit.toWire(),
    };
  }

  private async entriesOf(customerId: number, query: ParsedListQuery<'createdAt'>) {
    const wallet = await readCustomerWallet(this.db.db, customerId);
    if (!wallet) return { rows: [], total: 0 };
    return listWalletEntries(this.db.db, wallet.id, {
      order: query.sort[0]?.order ?? 'desc',
      range: query.range,
      ...windowOf(query.filters),
    });
  }

  private async applyFreeze(
    tx: DbExecutor,
    customerId: number,
    wallet: CustomerWalletRow,
    reason: string,
  ): Promise<{ changed: boolean }> {
    const customer = await findWalletCustomer(tx, customerId);
    const already = wallet.frozenAt !== null;
    const at = this.clock.now();
    if (!already) await writeWalletFreeze(tx, wallet.id, { at, reason }, at);
    await this.audit.record(tx, {
      action: 'froze wallet of',
      entityType: 'customer',
      entityId: customerId,
      entityLabel: customer ? labelOf(customer) : `customer ${customerId}`,
      before: { frozen: already ? { at: wallet.frozenAt.toISOString(), reason: wallet.frozenReason } : null },
      after: already
        ? { frozen: { at: wallet.frozenAt.toISOString(), reason: wallet.frozenReason }, alreadyFrozen: true, reason }
        : { frozen: { at: at.toISOString(), reason } },
    });
    if (!already) await this.mails.frozen(tx, { customerId, frozenAt: at });
    return { changed: !already };
  }

  /** A key reused for a different adjustment is a client bug: refuse it instead of answering the first one. */
  private async assertSameAdjustment(
    tx: DbExecutor,
    posted: PostedTransaction,
    memo: string,
    direction: 'credit' | 'debit',
    amount: Money,
  ): Promise<void> {
    const first = await findJournal(tx, posted.id);
    const walletLine = first?.entries.find((entry) => entry.account.kind === 'customer_wallet');
    // The wallet line is signed debit positive: a credit to the wallet is negative.
    const expected = direction === 'credit' ? amount.neg() : amount;
    if (first?.memo !== memo || !walletLine || !Money.of(walletLine.amount).eq(expected)) {
      throw new AppError('IDEMPOTENCY_KEY_REUSED', {
        detail: 'This Idempotency-Key was already used for a different adjustment.',
      });
    }
  }
}
