// Merchant wallets (map domain E, stage 3): the wallet view, the statement, manual adjustments and the credit limit. Used by
// the admin console routes and by the merchant portal's own wallet routes.
import { Inject, Injectable } from '@nestjs/common';
import type { z } from 'zod';
import { CLOCK, type Clock } from '../../../common/clock';
import type { ParsedListQuery } from '../../../common/contract';
import { AppError } from '../../../common/errors';
import { Money } from '../../../common/money';
import { DbService } from '../../../infra/db';
import { AuditService } from '../../platform';
import { SettingsReader } from '../../platform';
import type { StatementRowSchema } from '../contracts/wallet.contracts';
import { BASE_CURRENCY, type WalletView, walletViewOf } from '../domain/accounts';
import { adjust } from '../domain/money-events';
import {
  ADJUST_APPROVAL_LIMIT_KEY,
  approvalLimitOf,
  checkCreditLimit,
  needsSecondApprover,
} from '../domain/wallet-rules';
import { findMerchant, type MerchantRecord } from '../infra/foreign-directory.repository';
import {
  type WalletAccounts,
  findJournal,
  listAccountEntries,
  readWalletAccounts,
  writeCreditLimit,
} from '../infra/ledger-read.repository';
import { MerchantAccounts } from './merchant-accounts';
import { LedgerPoster, type PostedTransaction } from './post-transaction';
import type { DbExecutor } from '../../../infra/db';

/** A statement line on the wire. */
export type StatementLine = z.output<typeof StatementRowSchema>;

/** The most lines a CSV export holds. */
export const STATEMENT_EXPORT_LIMIT = 10_000;

/** What a manual adjustment asks for. */
export interface AdjustInput {
  readonly amount: string;
  readonly direction: 'credit' | 'debit';
  readonly reason: string;
  /** The caller's `Idempotency-Key`, if any. */
  readonly idempotencyKey?: string;
}

function viewOf(accounts: WalletAccounts): WalletView {
  return walletViewOf({
    balance: Money.of(accounts.walletBalance),
    reserved: Money.of(accounts.holdBalance),
    creditLimit: Money.of(accounts.creditLimit),
  });
}

const notFound = () => new AppError('NOT_FOUND', { detail: 'No merchant with this id.' });

/** `$10,000` for a whole-dollar limit, `$10,000.50` otherwise. */
function dollars(amount: Money): string {
  const [whole = '0', cents = '00'] = amount.toWire().split('.');
  const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return /^0+$/.test(cents) ? `$${grouped}` : `$${grouped}.${cents.slice(0, 2)}`;
}

/**
 * Reads and changes merchant wallets.
 *
 * Why: the console's merchant page shows the four wallet figures and a paged statement, lets staff adjust the wallet with a
 * reason and set the credit limit (RULES merchants 5-6); the portal shows the merchant its own. Balances are never cached
 * (decision 022): every call reads the ledger accounts.
 *
 * Side effects: `adjust` posts a ledger transaction and writes an audit row; `setCreditLimit` updates the wallet account and
 * writes an audit row.
 */
@Injectable()
export class WalletService {
  constructor(
    private readonly db: DbService,
    private readonly poster: LedgerPoster,
    private readonly audit: AuditService,
    private readonly settings: SettingsReader,
    private readonly accounts: MerchantAccounts,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  /**
   * The wallet view of a merchant, for staff.
   *
   * @param clientId the merchant
   * @returns the four figures; all zero while the merchant has no accounts
   * @throws {AppError} `NOT_FOUND` when there is no merchant with this id
   */
  async viewForStaff(clientId: number): Promise<WalletView> {
    if (!(await findMerchant(this.db.db, clientId))) throw notFound();
    return this.viewOf(this.db.db, clientId);
  }

  /**
   * The signed-in merchant's own wallet view.
   *
   * @param clientId the authenticated merchant
   * @returns the four figures; all zero while the merchant has no accounts
   */
  viewForMerchant(clientId: number): Promise<WalletView> {
    return this.viewOf(this.db.db, clientId);
  }

  /**
   * The wallet view of a merchant, without the existence check.
   *
   * @param executor the database or a transaction
   * @param clientId the merchant (already authenticated or checked)
   * @returns the four figures; all zero while the merchant has no accounts
   */
  async viewOf(executor: DbExecutor, clientId: number): Promise<WalletView> {
    const accounts = await readWalletAccounts(executor, clientId, BASE_CURRENCY);
    return viewOf(accounts);
  }

  /**
   * A page of a merchant's statement, for staff.
   *
   * @param clientId the merchant
   * @param query the parsed list request (`createdAt` sort and range)
   * @returns the lines and the number of lines on the wallet
   * @throws {AppError} `NOT_FOUND` when there is no merchant with this id
   */
  async statementForStaff(
    clientId: number,
    query: ParsedListQuery<'createdAt'>,
  ): Promise<{ rows: StatementLine[]; total: number }> {
    if (!(await findMerchant(this.db.db, clientId))) throw notFound();
    return this.statementOf(clientId, query.sort[0]?.order ?? 'desc', query.range);
  }

  /**
   * A merchant's statement lines, newest first by default.
   *
   * Why: `amount` is signed from the merchant side (a deposit is positive, an order hold negative), the wallet being
   * credit-normal; `balanceAfter` is the wallet balance after the line, which is already the merchant's side (ANSWERS
   * merchants Q3).
   *
   * @param clientId the merchant (already authenticated or checked)
   * @param order the direction of `createdAt`
   * @param range where the page starts and how many lines it holds
   * @returns the lines and the number of lines on the wallet
   */
  async statementOf(
    clientId: number,
    order: 'asc' | 'desc',
    range: { readonly start: number; readonly limit: number },
  ): Promise<{ rows: StatementLine[]; total: number }> {
    const { walletId } = await readWalletAccounts(this.db.db, clientId, BASE_CURRENCY);
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

  /**
   * Adds to or deducts from a merchant wallet by hand.
   *
   * Why: the map's `adjust` money event (B30): credit is Dr adjustments / Cr client_wallet and debit is its mirror, with the
   * reason in the memo, ref type `client`, and the staff member as author. Above the single-approver limit the server only
   * refuses (ANSWERS merchants Q4). Allowed for any merchant status.
   *
   * Side effects: one ledger transaction (kind `adjustment`), the wallet balance, one audit row; opens the merchant's
   * accounts when they are missing (the safety fallback of resolution identity-platform-1).
   *
   * @param staffId the staff member who adjusts
   * @param clientId the merchant
   * @param input amount, direction, reason and the optional idempotency key
   * @returns the journal id and the wallet after posting
   * @throws {AppError} `VALIDATION_FAILED` on `amount` (not above zero), `NOT_FOUND`, `APPROVAL_REQUIRED` (above the limit),
   *   `CREDIT_LIMIT_EXCEEDED` (a debit below the credit limit), `IDEMPOTENCY_KEY_REUSED` (the key was used for another
   *   adjustment)
   */
  async adjust(
    staffId: number,
    clientId: number,
    input: AdjustInput,
  ): Promise<{ transactionId: number; wallet: WalletView }> {
    const amount = parsePositiveAmount(input.amount);
    const limit = approvalLimitOf(await this.settings.get(ADJUST_APPROVAL_LIMIT_KEY));
    return this.db.runInTransaction(async ({ tx }) => {
      const merchant = await findMerchant(tx, clientId);
      if (!merchant) throw notFound();
      if (needsSecondApprover(amount, limit)) {
        throw new AppError('APPROVAL_REQUIRED', {
          detail: `Adjustments over ${dollars(limit)} need a second approver. Split it or ask Finance.`,
        });
      }
      await this.ensureAccounts(tx, merchant);
      const key =
        input.idempotencyKey === undefined
          ? `adjust:${clientId}:${crypto.randomUUID()}`
          : `adjust:${clientId}:${input.idempotencyKey}`;
      const posted = await this.postAdjustment(tx, staffId, clientId, { ...input, key }, amount);
      // The wallet row is locked by the posting until commit, so these figures are the posting's own.
      const after = viewOf(await readWalletAccounts(tx, clientId, BASE_CURRENCY));
      const wallet = posted.touched.find((account) => account.kind === 'client_wallet');
      await this.audit.record(tx, {
        action: posted.replayed
          ? 'Repeated a wallet adjustment (same idempotency key)'
          : input.direction === 'credit'
            ? 'Credited a merchant wallet'
            : 'Debited a merchant wallet',
        entityType: 'merchant',
        entityId: clientId,
        entityLabel: merchant.name,
        before: { ...after, balance: wallet?.before ?? after.balance },
        after: {
          ...after,
          transactionId: posted.id,
          amount: amount.toWire(),
          direction: input.direction,
          reason: input.reason,
        },
      });
      return { transactionId: posted.id, wallet: after };
    });
  }

  /**
   * Sets the credit limit of a merchant wallet.
   *
   * Why: user rule 2: lowering below the credit in use is allowed (new orders are refused until a top-up); a limit above
   * zero needs a group with `overdraft_allowed` (the same check as `MerchantAccounts.open`). No money moves, so no ledger
   * entry.
   *
   * Side effects: updates `ledger_accounts.overdraft_limit` and `version`; opens the merchant's accounts when missing; one
   * audit row.
   *
   * @param clientId the merchant
   * @param creditLimit the new limit as wire `Money`
   * @returns the wallet after the change
   * @throws {AppError} `NOT_FOUND`; `VALIDATION_FAILED` on `creditLimit` (negative, or above zero on a group without credit)
   */
  async setCreditLimit(clientId: number, creditLimit: string): Promise<WalletView> {
    return this.db.runInTransaction(async ({ tx }) => {
      const merchant = await findMerchant(tx, clientId);
      if (!merchant) throw notFound();
      const limit = checkCreditLimit(creditLimit, merchant.overdraftAllowed);
      const before = await this.lockedWallet(tx, merchant);
      const walletId = before.walletId;
      if (walletId === undefined) throw new Error(`Merchant ${clientId} has no wallet account after opening them.`);
      await writeCreditLimit(tx, walletId, limit.toWire(), this.clock.now());
      const after = viewOf(await readWalletAccounts(tx, clientId, BASE_CURRENCY));
      await this.audit.record(tx, {
        action: 'Changed a merchant credit limit',
        entityType: 'merchant',
        entityId: clientId,
        entityLabel: merchant.name,
        before: { creditLimit: before.creditLimit },
        after: { creditLimit: after.creditLimit },
      });
      return after;
    });
  }

  /** Opens the merchant's accounts when they are missing (the safety fallback of resolution identity-platform-1). */
  private async ensureAccounts(tx: DbExecutor, merchant: MerchantRecord): Promise<WalletAccounts> {
    const found = await readWalletAccounts(tx, merchant.id, BASE_CURRENCY);
    if (found.walletId !== undefined) return found;
    await this.accounts.open(tx, {
      clientId: merchant.id,
      currency: BASE_CURRENCY,
      creditLimit: '0.0000',
      overdraftAllowed: merchant.overdraftAllowed,
    });
    return readWalletAccounts(tx, merchant.id, BASE_CURRENCY);
  }

  /** Opens the accounts if needed, then locks the wallet and hold rows (in id order) and reads them. */
  private async lockedWallet(tx: DbExecutor, merchant: MerchantRecord): Promise<WalletAccounts> {
    await this.ensureAccounts(tx, merchant);
    return readWalletAccounts(tx, merchant.id, BASE_CURRENCY, true);
  }

  private async postAdjustment(
    tx: DbExecutor,
    staffId: number,
    clientId: number,
    input: AdjustInput & { key: string },
    amount: Money,
  ): Promise<PostedTransaction> {
    const memo = `Manual ${input.direction}: ${input.reason}`;
    try {
      const posted = await this.poster.post(tx, {
        ...adjust({ clientId, amount, direction: input.direction }),
        refId: clientId,
        idempotencyKey: input.key,
        currency: BASE_CURRENCY,
        memo,
        createdBy: { type: 'staff', id: staffId },
      });
      if (posted.replayed) await this.assertSameAdjustment(tx, posted.id, memo, input.direction, amount);
      return posted;
    } catch (error) {
      if (error instanceof AppError && error.code === 'INSUFFICIENT_FUNDS') {
        // The poster's detail names the resulting balance and the credit limit.
        throw new AppError('CREDIT_LIMIT_EXCEEDED', { detail: error.detail });
      }
      throw error;
    }
  }

  /** A key reused for a different adjustment is a client bug: refuse it instead of answering the first one. */
  private async assertSameAdjustment(
    tx: DbExecutor,
    transactionId: number,
    memo: string,
    direction: 'credit' | 'debit',
    amount: Money,
  ): Promise<void> {
    const first = await findJournal(tx, transactionId);
    const walletLine = first?.entries.find((entry) => entry.account.kind === 'client_wallet');
    // The wallet line is signed debit positive: a credit to the wallet is negative.
    const expected = direction === 'credit' ? amount.neg() : amount;
    if (first?.memo !== memo || !walletLine || !Money.of(walletLine.amount).eq(expected)) {
      throw new AppError('IDEMPOTENCY_KEY_REUSED', {
        detail: 'This Idempotency-Key was already used for a different adjustment.',
      });
    }
  }
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
