// Opens a merchant's ledger accounts (decision 024; resolution identity-platform-1, user decision): written by the lead
// before Phase 3 wave 1 because feature 2a (POST /admin/clients) calls it while
// feature 3, which owns the money module, is built in parallel.
import { Injectable } from '@nestjs/common';
import { Money } from '../../../common/money';
import type { DbExecutor } from '../../../infra/db';
import { AppError } from '../../../common/errors';
import { ledgerAccounts } from '../db/schema';
import { ACCOUNT_OWNER_TYPE } from '../domain/accounts';
import {
  ADJUST_WINDOW_MS,
  adjustmentNeedsOwner,
  checkCreditLimit,
  creditSumRefusalDetail,
} from '../domain/wallet-rules';
import { lockStaffAdjustments, recordCreditLimitRaise, staffMerchantCreditSince } from '../infra/adjustment.repository';

/**
 * The staff member who gives a new merchant its credit limit at an invitation, with what the 24-hour sum is judged against.
 *
 * Why: decision 049: the limit given at an invitation counts in the same 24-hour sum as the staff member's credit adjustments and
 * credit-limit raises.
 */
export interface CreditLimitGrant {
  /** The staff member who invites. */
  readonly staffId: number;
  /** The staff member is an Owner (holds `*`): not limited. */
  readonly owner: boolean;
  /** `wallet.adjust_approval_limit`. */
  readonly approvalLimit: Money;
  /** The clock's time. */
  readonly at: Date;
}

/** What {@link MerchantAccounts.open} needs. */
export interface OpenMerchantAccountsInput {
  /** The account (`clients.id`; a merchant keeps its old number as its account id) the wallet and hold belong to. */
  readonly clientId: number;
  /** ISO currency code of the wallet (a `currencies.code`); merchants hold USD today. */
  readonly currency: string;
  /** The credit limit (wire `Money`, `'0.0000'` for none); stored as the wallet's `overdraft_limit`. */
  readonly creditLimit: string;
  /** `client_groups.overdraft_allowed` of the merchant's group. */
  readonly overdraftAllowed: boolean;
  /** The staff member who gives the credit limit at an invitation; absent for a safety open. */
  readonly grant?: CreditLimitGrant | undefined;
}

/** The wallet view a freshly opened merchant shows (all wire `Money`). */
export interface OpenedWallet {
  readonly balance: string;
  readonly reserved: string;
  readonly creditLimit: string;
  readonly available: string;
}

/**
 * Opens the `client_wallet` and `client_hold` accounts of a merchant-rank account inside the caller's transaction.
 *
 * Why: the user decided that creating a merchant creates its wallet in the same transaction, so a credit limit given at
 * creation is stored at once (resolution identity-platform-1); user rule 2 refuses a limit above zero on a group
 * without overdraft. No ledger transaction is posted: a new wallet has no money yet. Both accounts are owned by `('account', id)`
 * (decision 064). A retail account has no wallet here: its store balance opens with its first posting or freeze.
 */
@Injectable()
export class MerchantAccounts {
  /**
   * Takes the lock under which one staff member's credits, credit-limit raises and receipt approvals are judged, until the transaction
   * ends.
   *
   * Why: decision 049: an invitation with a credit limit is judged against the inviting staff member's 24-hour sum; taking the lock as
   * the first step of the invitation keeps the lock order of the adjustments (this lock before any row lock).
   *
   * Side effects: takes the staff member's adjustment lock (`pg_advisory_xact_lock`).
   *
   * @param tx the invitation's transaction
   * @param staffId the staff member who invites
   */
  async lockStaffCredit(tx: DbExecutor, staffId: number): Promise<void> {
    await lockStaffAdjustments(tx, staffId);
  }

  /**
   * Opens both accounts; running it again for the same merchant and currency changes nothing.
   *
   * Why (grant): decision 049: a credit limit given by a staff member at an invitation counts in that staff member's 24-hour sum of
   * credits to merchant wallets; above the approval limit it needs an Owner.
   *
   * Side effects: inserts up to two `ledger_accounts` rows (`ON CONFLICT DO NOTHING` on the account identity); with a `grant` and a
   * limit above zero, takes the staff member's adjustment lock and records the limit in `credit_limit_raises` when the wallet is new.
   *
   * @param tx the caller's transaction (or the database)
   * @param input merchant, currency, credit limit, whether its group allows overdraft and who gives the limit
   * @returns the wallet view: zero balance and reserve, the credit limit as available money
   * @throws {AppError} `VALIDATION_FAILED` on `creditLimit` when it is negative, or above zero on a group without
   *   overdraft (user rule 2); `FORBIDDEN` (403) when a staff member who is not an Owner gives a limit that takes their 24-hour sum
   *   above the approval limit (decision 049)
   */
  async open(tx: DbExecutor, input: OpenMerchantAccountsInput): Promise<OpenedWallet> {
    // User rule 2 lives in one function, shared with PATCH /admin/clients/:id/credit-limit (resolution ip-3).
    const limit = checkCreditLimit(input.creditLimit, input.overdraftAllowed);
    const grant = limit.isPositive() ? input.grant : undefined;
    if (grant) await this.judgeGrant(tx, grant, limit);
    const owner = { ownerType: ACCOUNT_OWNER_TYPE, ownerId: input.clientId, currency: input.currency };
    const opened = await tx
      .insert(ledgerAccounts)
      .values([
        { ...owner, kind: 'client_wallet', overdraftLimit: limit.toWire() },
        { ...owner, kind: 'client_hold', overdraftLimit: '0.0000' },
      ])
      .onConflictDoNothing()
      .returning({ kind: ledgerAccounts.kind });
    // A new wallet starts at this limit: the whole limit is the raise (an open that changed nothing records nothing).
    if (grant && opened.some((row) => row.kind === 'client_wallet')) {
      await recordCreditLimitRaise(tx, {
        clientId: input.clientId,
        staffId: grant.staffId,
        amount: limit,
        at: grant.at,
      });
    }
    const zero = Money.zero().toWire();
    return { balance: zero, reserved: zero, creditLimit: limit.toWire(), available: limit.toWire() };
  }

  /** Refuses a limit that takes the 24-hour sum of a staff member who is not an Owner above the approval limit; read under their lock. */
  private async judgeGrant(tx: DbExecutor, grant: CreditLimitGrant, limit: Money): Promise<void> {
    // Re-entrant: the invitation took this lock first (`lockStaffCredit`); taking it again here keeps the sum under the lock either way.
    await lockStaffAdjustments(tx, grant.staffId);
    if (grant.owner) return;
    const given = await staffMerchantCreditSince(tx, grant.staffId, new Date(grant.at.getTime() - ADJUST_WINDOW_MS));
    const facts = { direction: 'credit' as const, amount: limit, creditedInWindow: given, limit: grant.approvalLimit };
    if (adjustmentNeedsOwner({ ...facts, owner: false })) {
      // The refusal of identity's `requireOwner`: the caller is known not to be an Owner here.
      throw new AppError('FORBIDDEN', { detail: creditSumRefusalDetail(grant.approvalLimit, given.add(limit)) });
    }
  }
}
