// AccountWalletAdmin: the wallet of an account at one address for staff (decision 064): the live wallet of either kind, its statement,
// the manual adjustment, the credit limit, the hold and its lifting. It reads the rank kind only after it holds the account row, so a write that
// races a rank change lands on the wallet that is live after it.
import { Inject, Injectable } from '@nestjs/common';
import type { z } from 'zod';
import { CLOCK, type Clock } from '../../../common/clock';
import type { ParsedListQuery } from '../../../common/contract';
import { AppError } from '../../../common/errors';
import { Money } from '../../../common/money';
import { TokenService } from '../../../infra/crypto';
import { type DbExecutor, DbService, isUniqueViolation } from '../../../infra/db';
import {
  type AccountRecord,
  AccountDirectory,
  LegacyAccounts,
  type StaffPrincipal,
  isOwner,
  requireOwner,
} from '../../identity';
import { AuditService, SettingsReader } from '../../platform';
import type { StatementRowSchema } from '../contracts/wallet.contracts';
import { BASE_CURRENCY } from '../domain/accounts';
import { customerAdjust } from '../domain/customer-wallet-events';
import { customerWalletPolicy } from '../domain/customer-wallet-policy';
import { adjust } from '../domain/money-events';
import {
  ADJUST_APPROVAL_LIMIT_KEY,
  ADJUST_WINDOW_MS,
  type StatementWallet,
  type WalletActionName,
  type WalletPool,
  accountLabelOf,
  adjustmentKeyOf,
  adjustmentNeedsOwner,
  adjustmentRefusalDetail,
  approvalLimitOf,
  checkCreditLimit,
  creditLimitNeedsOwner,
  creditLimitOwnerDetail,
  creditLimitRaise,
  creditSumRefusalDetail,
  emptyAccountWallet,
  isSameAdjustment,
  legacyAdjustmentKeysOf,
  poolOfRank,
  statementLedgerKindOf,
  statementWindowOf,
  storeCreditLimitRefusal,
  storeCreditRefusal,
  unfreezeRefusal,
  walletActionRequestOf,
} from '../domain/wallet-rules';
import {
  type LiveWalletRow,
  countOpenWalletDisputes,
  lockStaffAdjustments,
  readWalletRow,
  recordCreditLimitRaise,
  staffCreditsSince,
  staffMerchantCreditSince,
  writeWalletHold,
} from '../infra/adjustment.repository';
import { listWalletStatement } from '../infra/client-statement.repository';
import { type MerchantRecord, findMerchant } from '../infra/foreign-directory.repository';
import { findJournal, readWalletAccounts, writeCreditLimit } from '../infra/ledger-read.repository';
import { openAccounts } from '../infra/ledger-accounts.repository';
import { findHeaderByKey } from '../infra/ledger-writer.repository';
import { findWalletActionKey, insertWalletActionKey } from '../infra/wallet-action-keys.repository';
import { type AccountWalletView, AccountWallets } from '../ports/account-wallets';
import { CustomerWalletMails } from './customer-wallet-mails';
import { MerchantAccounts } from './merchant-accounts';
import { LedgerPoster } from './post-transaction';

/** A statement line on the wire (the staff statement adds the order the line is about). */
export type AccountStatementLine = z.output<typeof StatementRowSchema>;

/** What a manual adjustment asks for. */
export interface AccountAdjustInput {
  readonly amount: string;
  readonly direction: 'credit' | 'debit';
  readonly reason: string;
  /** The required `Idempotency-Key` (required for both wallet kinds). */
  readonly idempotencyKey: string;
}

/** The answer of an adjustment. */
export interface AccountAdjustAnswer {
  readonly transactionId: number;
  readonly wallet: AccountWalletView;
  /** True when the key was used before: nothing was posted and the first journal is answered. */
  readonly replayed: boolean;
}

/** The answer of a freeze, an unfreeze or a credit-limit change. */
export interface AccountWalletAnswer {
  readonly wallet: AccountWalletView;
  /** True when the key was stored before: nothing was applied and the first answer is replayed. */
  readonly replayed: boolean;
}

/** The part of a statement request the page reads: paging, sort, the posting-time window and the `wallet` parameter. */
export type AccountStatementQuery = Pick<
  ParsedListQuery<'createdAt', { readonly wallet?: StatementWallet | undefined }>,
  'sort' | 'range' | 'filters' | 'extra'
>;

const notFound = () => new AppError('NOT_FOUND', { detail: 'No account with this id.' });

/** The audit action of a replayed staff wallet action (a replay changes nothing, but staff sent it and got an answer). */
const REPEATED_ACTION: Readonly<Record<WalletActionName, string>> = {
  freeze: 'repeated wallet freeze of',
  unfreeze: 'repeated wallet unfreeze of',
  credit_limit: 'repeated credit limit change of',
};

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

/**
 * The staff use cases of the wallet of one account, whatever its rank.
 *
 * Why: decision 064: an account has one live wallet, of the kind of its rank (a merchant wallet with a hold and a credit limit, or
 * a store balance that pays first), and staff reach it at one address. The use case locks the account row `FOR KEY SHARE` first, then reads the
 * rank kind, then locks the wallet row as before, so it can never act on the inactive wallet of an account that is crossing ranks.
 * The approval pools follow the wallet kind. A freeze, an unfreeze and a credit limit carry a required `Idempotency-Key` that is looked up and
 * written in `wallet_action_keys` in the transaction of the change; an adjustment's key is the ledger's own idempotency key, with the
 * pre-release store form looked up before posting. Balances are never cached (decision 022).
 *
 * Side effects: `adjust` posts one ledger transaction (kind `adjustment`), writes an audit row and, for a store balance, a `wallet.adjusted` mail;
 * `setCreditLimit` updates the merchant wallet account, may record a raise in `credit_limit_raises` and writes an audit row; `freeze` and
 * `unfreeze` update the wallet row and write an audit row (a store freeze also writes a `wallet.frozen` mail); the three keyed actions write one
 * `wallet_action_keys` row. No cache key.
 *
 * @see GET /admin/clients/:id/wallet, GET /admin/clients/:id/statement, POST /admin/clients/:id/wallet/adjust,
 *   PATCH /admin/clients/:id/credit-limit, POST /admin/clients/:id/wallet/freeze, POST /admin/clients/:id/wallet/unfreeze
 */
@Injectable()
export class AccountWalletAdmin {
  constructor(
    private readonly db: DbService,
    private readonly accounts: AccountDirectory,
    private readonly legacy: LegacyAccounts,
    private readonly wallets: AccountWallets,
    private readonly poster: LedgerPoster,
    private readonly merchantAccounts: MerchantAccounts,
    private readonly mails: CustomerWalletMails,
    private readonly audit: AuditService,
    private readonly settings: SettingsReader,
    private readonly tokens: TokenService,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  /**
   * The live wallet of an account.
   *
   * @param accountId the account (any rank, a guest included)
   * @returns the wallet view of its kind; zeros while it has no wallet
   * @throws {AppError} `NOT_FOUND` when there is no account with this id
   */
  async show(accountId: number): Promise<AccountWalletView> {
    const account = await this.accounts.findById(this.db.db, accountId);
    if (!account) throw notFound();
    return this.viewOf(this.db.db, account);
  }

  /**
   * A page of the statement of a wallet of the account.
   *
   * Why: the statement lists the live wallet; `wallet=merchant` or `wallet=store` reads the history of the wallet a rank change left behind.
   * Staff see the full memo, the reason of an adjustment included.
   *
   * @param accountId the account
   * @param query the paging, the sort, the posting-time window (`createdAt_gte`, `createdAt_lte`) and the `wallet` parameter
   * @returns the lines (account side: a credit to the wallet is positive) and the number of lines in the window
   * @throws {AppError} `NOT_FOUND` when there is no account with this id
   */
  async statement(
    accountId: number,
    query: AccountStatementQuery,
  ): Promise<{ rows: AccountStatementLine[]; total: number }> {
    const db = this.db.db;
    const account = await this.accounts.findById(db, accountId);
    if (!account) throw notFound();
    const kind = statementLedgerKindOf(query.extra.wallet, poolOfRank(account.rankKind).ledgerKind);
    const wallet = await readWalletRow(db, accountId, kind);
    if (!wallet) return { rows: [], total: 0 };
    const page = await listWalletStatement(db, wallet.id, {
      order: query.sort[0]?.order ?? 'desc',
      range: query.range,
      ...statementWindowOf(query.filters),
    });
    return {
      total: page.total,
      rows: page.rows.map((row) => ({
        id: row.id,
        transactionId: row.transactionId,
        kind: row.kind,
        memo: row.memo,
        orderId: row.orderId,
        amount: Money.of(row.amount).neg().toWire(),
        balanceAfter: row.balanceAfter,
        createdAt: row.createdAt.toISOString(),
      })),
    };
  }

  /**
   * Adds to or deducts from the live wallet of an account by hand.
   *
   * Why: one route for both kinds, the header required for both. The ledger key is `adjust:<accountId>:<Idempotency-Key>`; a store
   * adjustment made before the release carries `adjust:customer:<oldId>:<key>`, which the legacy map finds before anything is posted. A retry
   * of an accepted adjustment is not judged again (decision 049). Above the approval limit of the wallet kind (merchant: `wallet.adjust_approval_limit`,
   * counted with the staff member's credit-limit raises; store: `wallet.customer.adjust_approval_limit`) the server refuses: a staff member's credits
   * to wallets of one kind count together over a rolling 24 hours, a debit counts alone, an Owner is not limited. A store credit needs an account
   * that can sign in and is not anonymized. Lock order: the staff member's adjustment lock, the account row `FOR KEY SHARE`, then the posting.
   * Allowed while the wallet is on hold, for any account status.
   *
   * Side effects: one ledger transaction (kind `adjustment`, reference type `account`), the wallet balance, one audit row, one `wallet.adjusted`
   * mail for a store balance (not on a replay); may open the merchant accounts. Takes the staff member's adjustment lock until the commit.
   *
   * @param caller the staff member who adjusts
   * @param accountId the account
   * @param input the amount, the direction, the reason and the required idempotency key
   * @returns the journal id, the wallet after posting and whether it was a replay
   * @throws {AppError} `VALIDATION_FAILED` on `amount`, `NOT_FOUND`, `ANONYMIZED` or `NO_ACCOUNT` (a store credit), `APPROVAL_REQUIRED` (409,
   *   decision 049), `CREDIT_LIMIT_EXCEEDED` (a merchant debit below the limit), `INSUFFICIENT_FUNDS` (a store debit below zero),
   *   `IDEMPOTENCY_KEY_REUSED` (the key was used for another adjustment)
   */
  async adjust(caller: StaffPrincipal, accountId: number, input: AccountAdjustInput): Promise<AccountAdjustAnswer> {
    const amount = parsePositiveAmount(input.amount);
    const merchantLimit = approvalLimitOf(await this.settings.get(ADJUST_APPROVAL_LIMIT_KEY));
    const storeLimit = customerWalletPolicy(await this.settings.all()).adjustApprovalLimit;
    const owner = isOwner(caller);
    const key = adjustmentKeyOf(accountId, input.idempotencyKey);
    const memo = `Manual ${input.direction}: ${input.reason}`;
    return this.db.runInTransaction(async ({ tx }) => {
      // Lock order: this staff member's adjustment lock first, then the account row, then (inside the posting) the ledger accounts in id order.
      await lockStaffAdjustments(tx, caller.staffId);
      const account = await this.accounts.lockForKeyShare(tx, accountId);
      if (!account) throw notFound();
      const { pool, ledgerKind } = poolOfRank(account.rankKind);

      // A retry of an accepted adjustment replays it: it is already part of the sum it would be judged against (decision 049).
      const earlier = await this.findAdjustment(tx, accountId, input.idempotencyKey, key);
      if (earlier) return this.replayedAdjustment(tx, account, earlier, { memo, amount, input });

      const refusal = pool === 'store' ? storeCreditRefusal(account, input.direction) : undefined;
      if (refusal === 'ANONYMIZED') throw new AppError('ANONYMIZED');
      if (refusal === 'NO_ACCOUNT') {
        throw new AppError('NO_ACCOUNT', { detail: 'Only an account that can sign in can hold a store balance.' });
      }
      if (!owner) {
        const since = new Date(this.clock.nowMs() - ADJUST_WINDOW_MS);
        const creditedInWindow =
          input.direction === 'credit'
            ? pool === 'merchant'
              ? await staffMerchantCreditSince(tx, caller.staffId, since)
              : await staffCreditsSince(tx, caller.staffId, 'store', since)
            : Money.zero();
        const facts = {
          direction: input.direction,
          amount,
          creditedInWindow,
          limit: pool === 'merchant' ? merchantLimit : storeLimit,
        };
        if (adjustmentNeedsOwner({ ...facts, owner: false })) {
          throw new AppError('APPROVAL_REQUIRED', { detail: adjustmentRefusalDetail(facts) });
        }
      }
      if (pool === 'merchant') {
        const merchant = await findMerchant(tx, accountId);
        if (!merchant) throw notFound();
        await this.ensureMerchantAccounts(tx, merchant);
      }
      const posted = await this.postAdjustment(tx, caller.staffId, accountId, pool, { ...input, key, memo }, amount);
      if (posted.replayed) return this.replayedAdjustment(tx, account, { id: posted.id }, { memo, amount, input });

      // The wallet row is locked by the posting until commit, so these figures are the posting's own.
      const wallet = await this.viewOf(tx, account);
      const touched = posted.touched.find((entry) => entry.kind === ledgerKind);
      await this.audit.record(tx, {
        action: 'adjusted wallet of',
        entityType: 'account',
        entityId: accountId,
        entityLabel: accountLabelOf(account),
        before: { kind: pool, balance: touched?.before ?? wallet.balance },
        after: {
          kind: pool,
          ...figuresOf(wallet),
          transactionId: posted.id,
          amount: amount.toWire(),
          direction: input.direction,
          reason: input.reason,
        },
      });
      if (pool === 'store') {
        await this.mails.adjusted(tx, {
          customerId: accountId,
          transactionId: posted.id,
          amount: amount.toWire(),
          direction: input.direction,
          balance: wallet.balance,
        });
      }
      return { transactionId: posted.id, wallet, replayed: false };
    });
  }

  /**
   * Sets the credit limit of a merchant wallet.
   *
   * Why: user rule 2: lowering below the credit in use is allowed (new orders are refused until a top-up); a limit above zero needs a rank with
   * `overdraft_allowed` (the same check as `MerchantAccounts.open`); a store balance has no credit limit. Raising a limit above the approval
   * limit of adjustments (`wallet.adjust_approval_limit`) is an Owner's decision; lowering one never is (decision 049). The raised part counts in
   * the caller's 24-hour sum of credits to merchant wallets, and a raise that takes that sum above the approval limit needs an Owner too. A
   * wallet on hold takes no raise. The account row is locked first, so a rank change of the same account and this change wait for each
   * other. No money moves, so no ledger entry. The `Idempotency-Key` is stored and replayed.
   *
   * Side effects: updates `ledger_accounts.overdraft_limit` and `version`; opens the merchant accounts when missing; records a raise in
   * `credit_limit_raises`; one audit row; one `wallet_action_keys` row. Takes the staff member's adjustment lock until the commit.
   *
   * @param caller the staff member who sets it
   * @param accountId the account
   * @param creditLimit the new limit as wire `Money`
   * @param idempotencyKey the required `Idempotency-Key`
   * @returns the wallet after the change and whether the key was a replay
   * @throws {AppError} `NOT_FOUND`; `VALIDATION_FAILED` on `creditLimit` (negative, above zero on a rank without credit, or any limit on a store
   *   balance); `FORBIDDEN` (403: above the approval limit and higher than the current limit, or a raise that takes the caller's 24-hour sum above
   *   it, and the caller is not an Owner; decision 049); `WALLET_FROZEN` (a raise on a wallet on hold); `IDEMPOTENCY_KEY_REUSED`
   */
  async setCreditLimit(
    caller: StaffPrincipal,
    accountId: number,
    creditLimit: string,
    idempotencyKey: string,
  ): Promise<AccountWalletAnswer> {
    const ceiling = approvalLimitOf(await this.settings.get(ADJUST_APPROVAL_LIMIT_KEY));
    return this.keyed(
      caller,
      accountId,
      'credit_limit',
      { creditLimit },
      idempotencyKey,
      async (tx, account) => {
        if (poolOfRank(account.rankKind).pool === 'store') throw storeCreditLimitRefusal();
        const merchant = await findMerchant(tx, accountId);
        if (!merchant) throw notFound();
        const limit = checkCreditLimit(creditLimit, merchant.overdraftAllowed);
        await this.ensureMerchantAccounts(tx, merchant);
        // The wallet and hold rows in id order (a posting locks them the same way).
        const before = await readWalletAccounts(tx, accountId, BASE_CURRENCY, true);
        const current = Money.of(before.creditLimit);
        const now = this.clock.now();
        const raised = creditLimitRaise(limit, current);
        const held = (await readWalletRow(tx, accountId, 'client_wallet'))?.frozenAt;
        if (raised.isPositive() && held) throw new AppError('WALLET_FROZEN');
        // Decision 049: raising a credit limit above the approval limit of adjustments is an Owner's decision; lowering one never is.
        if (creditLimitNeedsOwner(limit, current, ceiling)) requireOwner(caller, creditLimitOwnerDetail(ceiling));
        if (raised.isPositive() && !isOwner(caller)) {
          // Decision 049: the raised part counts with the caller's credits and raises of the last 24 hours, read under the staff lock.
          const given = await staffMerchantCreditSince(tx, caller.staffId, new Date(now.getTime() - ADJUST_WINDOW_MS));
          const facts = { direction: 'credit' as const, amount: raised, creditedInWindow: given, limit: ceiling };
          if (adjustmentNeedsOwner({ ...facts, owner: false })) {
            requireOwner(caller, creditSumRefusalDetail(ceiling, given.add(raised)));
          }
        }
        if (before.walletId === undefined) {
          throw new Error(`Account ${accountId} has no merchant wallet after opening its accounts.`);
        }
        await writeCreditLimit(tx, before.walletId, limit.toWire(), now);
        if (raised.isPositive()) {
          await recordCreditLimitRaise(tx, { clientId: accountId, staffId: caller.staffId, amount: raised, at: now });
        }
        const wallet = await this.viewOf(tx, account);
        await this.audit.record(tx, {
          action: 'changed credit limit of',
          entityType: 'account',
          entityId: accountId,
          entityLabel: accountLabelOf(account),
          before: { creditLimit: before.creditLimit },
          after: { creditLimit: wallet.creditLimit },
        });
        return wallet;
      },
      { staffLock: true },
    );
  }

  /**
   * Puts the live wallet of an account on hold.
   *
   * Why: freezing works on the wallet of either kind, read after the account row lock. A merchant wallet on hold takes no new
   * hold (409 `WALLET_FROZEN`) and no credit-limit raise, while settlement and release of holds that exist, credits and staff debits still
   * post; a store balance stops paying from the balance and card top-ups. Freezing a wallet that is on hold changes nothing and answers the same
   * view (still audited, `alreadyFrozen`).
   *
   * Side effects: may open the wallet; sets `frozen_at` and `frozen_reason` on the locked wallet row; one audit row; one `wallet.frozen` mail
   * for a store balance when it changed; one `wallet_action_keys` row.
   *
   * @param caller the staff member who freezes
   * @param accountId the account
   * @param reason the staff note
   * @param idempotencyKey the required `Idempotency-Key`
   * @returns the wallet after the change and whether the key was a replay
   * @throws {AppError} `NOT_FOUND`; `IDEMPOTENCY_KEY_REUSED`
   */
  async freeze(
    caller: StaffPrincipal,
    accountId: number,
    reason: string,
    idempotencyKey: string,
  ): Promise<AccountWalletAnswer> {
    return this.keyed(caller, accountId, 'freeze', { reason }, idempotencyKey, async (tx, account) => {
      const { pool, ledgerKind } = poolOfRank(account.rankKind);
      if (pool === 'merchant') {
        const merchant = await findMerchant(tx, accountId);
        if (!merchant) throw notFound();
        await this.ensureMerchantAccounts(tx, merchant);
      }
      const row = await this.lockedWallet(tx, accountId, ledgerKind);
      const already = row.frozenAt !== null;
      const at = this.clock.now();
      if (!already) await writeWalletHold(tx, row.id, { at, reason }, at);
      await this.audit.record(tx, {
        action: 'froze wallet of',
        entityType: 'account',
        entityId: accountId,
        entityLabel: accountLabelOf(account),
        before: {
          kind: pool,
          frozen: row.frozenAt ? { at: row.frozenAt.toISOString(), reason: row.frozenReason } : null,
        },
        after:
          row.frozenAt !== null
            ? {
                kind: pool,
                frozen: { at: row.frozenAt.toISOString(), reason: row.frozenReason },
                alreadyFrozen: true,
                reason,
              }
            : { kind: pool, frozen: { at: at.toISOString(), reason } },
      });
      if (!already && pool === 'store') await this.mails.frozen(tx, { customerId: accountId, frozenAt: at });
      return this.viewOf(tx, account);
    });
  }

  /**
   * Lifts the hold on the live wallet of an account.
   *
   * Why: a person decides; a store balance below zero stays on hold until the balance is brought back (the database also refuses
   * it at commit), and so does any wallet with an open top-up dispute. Unfreezing a wallet that is not on hold changes nothing.
   *
   * Side effects: clears `frozen_at` and `frozen_reason` on the locked wallet row; one audit row; one `wallet_action_keys` row.
   *
   * @param caller the staff member who lifts it
   * @param accountId the account
   * @param reason the staff note
   * @param idempotencyKey the required `Idempotency-Key`
   * @returns the wallet after the change and whether the key was a replay
   * @throws {AppError} `NOT_FOUND`, `CONFLICT` (a store balance below zero), `OPEN_DISPUTE`, `IDEMPOTENCY_KEY_REUSED`
   */
  async unfreeze(
    caller: StaffPrincipal,
    accountId: number,
    reason: string,
    idempotencyKey: string,
  ): Promise<AccountWalletAnswer> {
    return this.keyed(caller, accountId, 'unfreeze', { reason }, idempotencyKey, async (tx, account) => {
      const { pool, ledgerKind } = poolOfRank(account.rankKind);
      const row = await readWalletRow(tx, accountId, ledgerKind, true);
      const held = row?.frozenAt ?? null;
      if (row && held) {
        const refusal = unfreezeRefusal({
          kind: pool,
          balance: Money.of(row.balance),
          openDisputes: await countOpenWalletDisputes(tx, accountId),
        });
        if (refusal === 'negative_balance') {
          throw new AppError('CONFLICT', { detail: 'Bring the balance to zero or above first.' });
        }
        if (refusal === 'open_dispute') throw new AppError('OPEN_DISPUTE');
        await writeWalletHold(tx, row.id, null, this.clock.now());
      }
      await this.audit.record(tx, {
        action: 'unfroze wallet of',
        entityType: 'account',
        entityId: accountId,
        entityLabel: accountLabelOf(account),
        before: { kind: pool, frozen: row && held ? { at: held.toISOString(), reason: row.frozenReason } : null },
        after: { kind: pool, frozen: null, reason, ...(held ? {} : { alreadyUnfrozen: true }) },
      });
      return this.viewOf(tx, account);
    });
  }

  /**
   * Runs one keyed staff action: lock the account, replay a stored key, or apply the change and store the key with its answer.
   *
   * Why: the key, the change and the answer exist together or not at all, and the same key never applies a change twice. Two requests
   * that carry one new key at once both pass the lookup; the unique index lets the first commit and refuses the second, which runs once more
   * and replays. A refusal stores nothing, so the key may be tried again. A replay writes one audit row of its own ("repeated ... of", as a
   * replayed adjustment does): every staff write is audited, and the row shows that the answer was the stored one.
   */
  private async keyed(
    caller: StaffPrincipal,
    accountId: number,
    action: WalletActionName,
    body: Readonly<Record<string, unknown>>,
    idempotencyKey: string,
    apply: (tx: DbExecutor, account: AccountRecord) => Promise<AccountWalletView>,
    options: { readonly staffLock?: boolean } = {},
  ): Promise<AccountWalletAnswer> {
    const requestHash = this.tokens.lookupHash(walletActionRequestOf(action, body));
    const once = (): Promise<AccountWalletAnswer> =>
      this.db.runInTransaction(async ({ tx }) => {
        if (options.staffLock) await lockStaffAdjustments(tx, caller.staffId);
        const account = await this.accounts.lockForKeyShare(tx, accountId);
        if (!account) throw notFound();
        const stored = await findWalletActionKey(tx, accountId, idempotencyKey);
        if (stored) {
          if (stored.action !== action || stored.requestHash !== requestHash) {
            throw new AppError('IDEMPOTENCY_KEY_REUSED', {
              detail: 'This Idempotency-Key was already used for a different request.',
            });
          }
          const replayed = stored.response as unknown as AccountWalletView;
          await this.audit.record(tx, {
            action: REPEATED_ACTION[action],
            entityType: 'account',
            entityId: accountId,
            entityLabel: accountLabelOf(account),
            after: { kind: replayed.kind, firstAnsweredAt: stored.createdAt.toISOString() },
          });
          return { wallet: replayed, replayed: true };
        }
        const wallet = await apply(tx, account);
        await insertWalletActionKey(tx, {
          accountId,
          action,
          idempotencyKey,
          requestHash,
          response: wallet as unknown as Record<string, unknown>,
          staffId: caller.staffId,
        });
        return { wallet, replayed: false };
      });
    try {
      return await once();
    } catch (error) {
      if (isUniqueViolation(error, 'wallet_action_keys_key_uq')) return once();
      throw error;
    }
  }

  /** The wallet view of the account's live wallet, read with the use case's executor; zeros while there is no wallet. */
  private async viewOf(db: DbExecutor, account: AccountRecord): Promise<AccountWalletView> {
    const found = (await this.wallets.viewsOf(db, [account.id])).get(account.id);
    if (found) return found;
    const { pool } = poolOfRank(account.rankKind);
    if (pool === 'merchant') {
      const merchant = await findMerchant(db, account.id);
      return emptyAccountWallet({
        kind: 'merchant',
        creditAllowed: merchant?.overdraftAllowed ?? false,
        enabled: true,
        adjustApprovalLimit: approvalLimitOf(await this.settings.get(ADJUST_APPROVAL_LIMIT_KEY)),
      });
    }
    const policy = customerWalletPolicy(await this.settings.all());
    return emptyAccountWallet({
      kind: 'store',
      creditAllowed: false,
      enabled: policy.enabled,
      adjustApprovalLimit: policy.adjustApprovalLimit,
    });
  }

  /** Finds the journal of an adjustment under its key, or under the key of the same request before the accounts merged. */
  private async findAdjustment(
    tx: DbExecutor,
    accountId: number,
    idempotencyKey: string,
    key: string,
  ): Promise<{ id: number } | undefined> {
    const current = await findHeaderByKey(tx, key);
    if (current) return current;
    const old = legacyAdjustmentKeysOf(await this.legacy.legacyIdsOf(tx, accountId), idempotencyKey);
    for (const oldKey of old) {
      const header = await findHeaderByKey(tx, oldKey);
      if (header) return header;
    }
    return undefined;
  }

  /** Answers an adjustment whose key was used before: the journal must be the same adjustment; nothing is posted and no mail is sent. */
  private async replayedAdjustment(
    tx: DbExecutor,
    account: AccountRecord,
    first: { readonly id: number },
    request: { readonly memo: string; readonly amount: Money; readonly input: AccountAdjustInput },
  ): Promise<AccountAdjustAnswer> {
    const journal = await findJournal(tx, first.id);
    if (!journal || !isSameAdjustment(journal, request.memo, request.input.direction, request.amount)) {
      throw new AppError('IDEMPOTENCY_KEY_REUSED', {
        detail: 'This Idempotency-Key was already used for a different adjustment.',
      });
    }
    const wallet = await this.viewOf(tx, account);
    const { pool } = poolOfRank(account.rankKind);
    await this.audit.record(tx, {
      action: 'repeated wallet adjustment of',
      entityType: 'account',
      entityId: account.id,
      entityLabel: accountLabelOf(account),
      before: { kind: pool, ...figuresOf(wallet) },
      after: {
        kind: pool,
        ...figuresOf(wallet),
        transactionId: first.id,
        amount: request.amount.toWire(),
        direction: request.input.direction,
        reason: request.input.reason,
      },
    });
    return { transactionId: first.id, wallet, replayed: true };
  }

  private async postAdjustment(
    tx: DbExecutor,
    staffId: number,
    accountId: number,
    pool: WalletPool,
    input: AccountAdjustInput & { readonly key: string; readonly memo: string },
    amount: Money,
  ) {
    const event =
      pool === 'merchant'
        ? adjust({ clientId: accountId, amount, direction: input.direction })
        : customerAdjust({ customerId: accountId, amount, direction: input.direction });
    try {
      return await this.poster.post(tx, {
        ...event,
        refId: accountId,
        idempotencyKey: input.key,
        currency: BASE_CURRENCY,
        memo: input.memo,
        createdBy: { type: 'staff', id: staffId },
      });
    } catch (error) {
      if (pool === 'merchant' && error instanceof AppError && error.code === 'INSUFFICIENT_FUNDS') {
        // The poster's detail names the resulting balance and the credit limit.
        throw new AppError('CREDIT_LIMIT_EXCEEDED', { detail: error.detail });
      }
      throw error;
    }
  }

  /** Opens the merchant accounts of an account that has none (the safety fallback of resolution identity-platform-1). */
  private async ensureMerchantAccounts(tx: DbExecutor, merchant: MerchantRecord): Promise<void> {
    const found = await readWalletAccounts(tx, merchant.id, BASE_CURRENCY);
    if (found.walletId !== undefined) return;
    await this.merchantAccounts.open(tx, {
      clientId: merchant.id,
      currency: BASE_CURRENCY,
      creditLimit: '0.0000',
      overdraftAllowed: merchant.overdraftAllowed,
    });
  }

  /** Locks the wallet row of a kind, opening it first when the account has none (a hold may come before any money). */
  private async lockedWallet(
    tx: DbExecutor,
    accountId: number,
    kind: 'client_wallet' | 'customer_wallet',
  ): Promise<LiveWalletRow> {
    const found = await readWalletRow(tx, accountId, kind, true);
    if (found) return found;
    await openAccounts(tx, [{ kind, ownerType: 'account', ownerId: accountId, currency: BASE_CURRENCY }]);
    const opened = await readWalletRow(tx, accountId, kind, true);
    if (!opened) throw new Error(`The wallet of account ${accountId} could not be opened.`);
    return opened;
  }
}

/** The four figures an audit row keeps next to the kind. */
function figuresOf(wallet: AccountWalletView): {
  balance: string;
  reserved: string;
  creditLimit: string;
  available: string;
} {
  return {
    balance: wallet.balance,
    reserved: wallet.reserved,
    creditLimit: wallet.creditLimit,
    available: wallet.available,
  };
}
