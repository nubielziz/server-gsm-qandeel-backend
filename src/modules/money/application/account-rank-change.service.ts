// The rank change (decision 064): the one use case that gives an account another rank. It locks the account, finds every blocker, moves the
// balance between the two wallet kinds in one journal, writes the rank, ends what the old kind allowed, and keeps the history of the change.
import { Inject, Injectable } from '@nestjs/common';
import type { z } from 'zod';
import { CLOCK, type Clock } from '../../../common/clock';
import { AppError } from '../../../common/errors';
import { Money } from '../../../common/money';
import { DbService, type Transaction, type TransactionContext } from '../../../infra/db';
import { ClientGroupDirectory, RankGroupReads } from '../../catalog';
import {
  AccountAccessEffects,
  AccountDirectory,
  AccountRanks,
  type AccountRecord,
  type RankKind,
  type StaffPrincipal,
  assertMayChangeRank,
  rankKindOf,
} from '../../identity';
import { AuditService } from '../../platform';
import type { RankChangeResultSchema } from '../contracts/account-rank.contracts';
import type { AccountRankChange as StoredRankChange } from '../db/schema';
import { BASE_CURRENCY } from '../domain/accounts';
import {
  type RankMovePlan,
  type RankMoneyFacts,
  blockerErrors,
  crossesKinds,
  isSameRequest,
  moneyBlockers,
  planRankMove,
  rankMoveKey,
  rankMoveLines,
  rankMoveMemo,
  sameKindRefusal,
} from '../domain/rank-change';
import { lockAccountTopUps } from '../infra/topup-lock.repository';
import {
  clearCreditLimit,
  findRankChange,
  hasOpenBalanceRefund,
  hasOpenTopUp,
  hasOpenTopUpDispute,
  insertRankChange,
  lockWalletAccounts,
  openWalletAccounts,
  readCreditLimit,
} from '../infra/rank-change.repository';
import { AccountWallets } from '../ports/account-wallets';
import { RankChangeGuards, type RankBlockerCode } from '../ports/rank-change-guards';
import { postTransaction } from './post-transaction';

/** The answer of the rank change, as the route sends it. */
export type RankChangeResult = z.output<typeof RankChangeResultSchema>;

/** What {@link AccountRankChange.change} hands the controller. */
export interface RankChangeOutcome {
  /** True when the key was already used for the same change: nothing was written and `result` is the recorded change. */
  readonly replayed: boolean;
  readonly result: RankChangeResult;
}

/** A `422` on the field `groupId`. */
function invalidRank(code: 'unknown_rank' | 'same_rank', message: string): AppError {
  return new AppError('VALIDATION_FAILED', { errors: [{ field: 'groupId', code, message }] });
}

/** The `409` that lists every reason the change cannot be made now. */
function blocked(codes: readonly RankBlockerCode[]): AppError {
  return new AppError('RANK_CHANGE_BLOCKED', {
    detail: 'The rank cannot change until everything listed is finished.',
    errors: blockerErrors(codes),
  });
}

/** What moving the wallets did. */
interface MoveOutcome {
  readonly moved: Money;
  readonly transactionId: number | null;
}

/**
 * Changes the rank of an account.
 *
 * Why: decision 064: merchants and shop customers are one account type told apart by the rank. A change between the two kinds is the only
 * moment money changes wallet (the store balance and the merchant wallet are different ledger accounts), so it is one staff action, the
 * Owner's, with a required key: it checks that nothing is in flight, moves the balance, ends the sessions and keys that belong to the old
 * kind and leaves a history row. Lock order: the account row (`FOR UPDATE`), the account's ledger accounts in id order, then `topup:<accountId>`
 * (no path that holds the top-up lock waits for the account row or its ledger accounts, so no cycle can form).
 *
 * Side effects: writes one `account_rank_changes` row and one audit row; across kinds also opens the missing wallet accounts, posts one
 * `wallet_transfer` journal, sets the credit limit of a merchant wallet that is left to zero, ends every session, revokes the live API keys of
 * an account that leaves the merchant kind and may queue an invitation (through `AccountAccessEffects`); the cached session and key views are
 * dropped after the commit.
 *
 * @see POST /admin/clients/:id/rank
 */
@Injectable()
export class AccountRankChange {
  constructor(
    private readonly db: DbService,
    private readonly audit: AuditService,
    private readonly accounts: AccountDirectory,
    private readonly ranks: AccountRanks,
    private readonly groups: RankGroupReads,
    private readonly groupDirectory: ClientGroupDirectory,
    private readonly effects: AccountAccessEffects,
    private readonly guards: RankChangeGuards,
    private readonly wallets: AccountWallets,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  /**
   * Gives an account another rank.
   *
   * @param staff the signed-in staff member; only an Owner may change a rank
   * @param accountId the account
   * @param groupId the rank to move to
   * @param idempotencyKey the request's `Idempotency-Key` (unique per account): a repeat of the same change replays it
   * @returns the rank now held, the live wallet, the amount moved, the journal and the counts of what ended, and whether it was a replay
   * @throws {AppError} `FORBIDDEN` (403: not an Owner), `NOT_FOUND` (404), `ANONYMIZED` (409), `IDEMPOTENCY_KEY_REUSED` (the key was used for
   *   another rank), `VALIDATION_FAILED` (422 on `groupId`: no such rank, or the account already has it), `RANK_CHANGE_BLOCKED` (409 with one
   *   `errors[]` entry per blocker, or `credit_limit` inside the merchant kind)
   */
  async change(
    staff: StaffPrincipal,
    accountId: number,
    groupId: number,
    idempotencyKey: string,
  ): Promise<RankChangeOutcome> {
    // The Owner's strict check comes before anything is read for writing.
    assertMayChangeRank(staff);
    return this.db.runInTransaction((work) => this.changeIn(work, staff, accountId, groupId, idempotencyKey));
  }

  /** The use case inside its transaction: the account row first, a replay of the key, the blockers and the move, the new rank, the record and the audit row (decision 064). */
  private async changeIn(
    work: TransactionContext,
    staff: StaffPrincipal,
    accountId: number,
    groupId: number,
    idempotencyKey: string,
  ): Promise<RankChangeOutcome> {
    const { tx } = work;
    const account = await this.accounts.lockForUpdate(tx, accountId);
    if (!account) throw new AppError('NOT_FOUND', { detail: 'No account with this id.' });
    if (account.status === 'anonymized') throw new AppError('ANONYMIZED');

    // A key already stored for this account replays its change; it is read before the target is judged, because the account already
    // holds the rank the replay names.
    const stored = await findRankChange(tx, accountId, idempotencyKey);
    if (stored) {
      if (!isSameRequest(stored, groupId)) {
        throw new AppError('IDEMPOTENCY_KEY_REUSED', {
          detail: 'This Idempotency-Key was used for a change to another rank.',
        });
      }
      const result = await this.recorded(tx, stored);
      // A replay changes nothing, and the staff request is still recorded (as every replayed staff write is): who asked again, and when.
      await this.audit.record(tx, {
        action: 'repeated rank change of',
        entityType: 'account',
        entityId: accountId,
        entityLabel: account.name,
        after: {
          rankId: stored.toGroupId,
          rank: stored.toGroupName,
          kind: stored.toKind,
          transactionId: stored.ledgerTransactionId,
        },
      });
      return { replayed: true, result };
    }

    const targetKind = await this.groups.kindOf(tx, groupId);
    const toName = await this.groups.nameOf(tx, groupId);
    if (targetKind === undefined || toName === undefined)
      throw invalidRank('unknown_rank', 'There is no rank with this id.');
    if (groupId === account.groupId) throw invalidRank('same_rank', 'The account already has this rank.');
    const fromName = (await this.groups.nameOf(tx, account.groupId)) ?? `Rank ${account.groupId}`;
    const fromKind = account.rankKind;
    const toKind = rankKindOf(targetKind);
    const now = this.clock.now();

    let move: MoveOutcome = { moved: Money.zero(), transactionId: null };
    if (crossesKinds(fromKind, toKind)) {
      move = await this.moveWallets(tx, staff, account, {
        plan: planRankMove(fromKind, toKind),
        toName,
        toKind,
        idempotencyKey,
        now,
      });
    } else {
      await this.assertCreditFits(tx, accountId, groupId);
    }

    await this.ranks.setRank(tx, accountId, groupId);
    if (crossesKinds(fromKind, toKind) && toKind === 'merchant') await this.ranks.ensureUsername(tx, accountId);
    const effects = await this.effects.rankChanged(work, { accountId, fromKind, toKind });

    const wallet = (await this.wallets.viewsOf(tx, [accountId])).get(accountId) ?? null;
    await insertRankChange(tx, {
      accountId,
      fromGroupId: account.groupId,
      fromGroupName: fromName,
      toGroupId: groupId,
      toGroupName: toName,
      fromKind,
      toKind,
      movedAmount: move.moved.toWire(),
      ledgerTransactionId: move.transactionId,
      idempotencyKey,
      sessionsEnded: effects.sessionsEnded,
      apiKeysRevoked: effects.keysRevoked,
      staffId: staff.staffId,
    });
    await this.audit.record(tx, {
      action: 'changed rank of',
      entityType: 'account',
      entityId: accountId,
      entityLabel: account.name,
      before: { rankId: account.groupId, rank: fromName, kind: fromKind },
      after: {
        rankId: groupId,
        rank: toName,
        kind: toKind,
        movedAmount: move.moved.toWire(),
        transactionId: move.transactionId,
        sessionsEnded: effects.sessionsEnded,
        apiKeysRevoked: effects.keysRevoked,
      },
    });
    return {
      replayed: false,
      result: {
        rank: { id: groupId, name: toName, kind: toKind },
        wallet,
        movedAmount: move.moved.toWire(),
        transactionId: move.transactionId,
        sessionsEnded: effects.sessionsEnded,
        apiKeysRevoked: effects.keysRevoked,
      },
    };
  }

  /** The recorded answer of a change that was made before: the stored rank and counts, with the wallet as it is now. */
  private async recorded(tx: Transaction, stored: StoredRankChange): Promise<RankChangeResult> {
    const wallet = (await this.wallets.viewsOf(tx, [stored.accountId])).get(stored.accountId) ?? null;
    return {
      rank: { id: stored.toGroupId, name: stored.toGroupName, kind: stored.toKind },
      wallet,
      movedAmount: stored.movedAmount,
      transactionId: stored.ledgerTransactionId,
      sessionsEnded: stored.sessionsEnded,
      apiKeysRevoked: stored.apiKeysRevoked,
    };
  }

  /**
   * Inside the merchant kind only the credit limit can stand in the way: the new rank must allow credit while the limit is above zero. The
   * target's row is read with a share lock, so a change of the rank's credit switch waits for this change (and the other way round).
   */
  private async assertCreditFits(tx: Transaction, accountId: number, groupId: number): Promise<void> {
    const target = await this.groupDirectory.find(tx, groupId, { lock: 'share' });
    if (!target) throw invalidRank('unknown_rank', 'There is no rank with this id.');
    const refusal = sameKindRefusal({
      targetAllowsCredit: target.overdraftAllowed,
      creditLimit: Money.of(await readCreditLimit(tx, accountId, BASE_CURRENCY)),
    });
    if (refusal !== undefined) throw blocked([refusal]);
  }

  /**
   * A change across kinds: opens the missing wallets, locks them, finds every blocker, then moves the balance and drops the credit limit.
   *
   * Lock order: the account row (held by the caller), the account's ledger accounts `FOR UPDATE` in id order, then `topup:<accountId>`. The
   * journal is posted with `postTransaction` itself, not through the ledger poster: the wallet being closed must not raise a low-balance alert.
   */
  private async moveWallets(
    tx: Transaction,
    staff: StaffPrincipal,
    account: AccountRecord,
    change: { plan: RankMovePlan; toName: string; toKind: RankKind; idempotencyKey: string; now: Date },
  ): Promise<MoveOutcome> {
    const { plan, toName, toKind, idempotencyKey, now } = change;
    await openWalletAccounts(tx, account.id, plan.open, BASE_CURRENCY);
    const rows = await lockWalletAccounts(tx, account.id, BASE_CURRENCY);
    await lockAccountTopUps(tx, account.id);
    const balanceOf = (kind: string) => Money.of(rows.find((row) => row.kind === kind)?.balance ?? '0');

    const facts: RankMoneyFacts = {
      hasAccount: account.hasAccount,
      holdBalance: balanceOf('client_hold'),
      sourceBalance: balanceOf(plan.source),
      anyWalletFrozen: rows.some((row) => row.frozen),
      openTopUp: await hasOpenTopUp(tx, account.id, now),
      openDispute: await hasOpenTopUpDispute(tx, account.id),
      openBalanceRefund: await hasOpenBalanceRefund(tx, account.id),
    };
    // Every blocker is collected before anything is written: money's own, then the checks the orders and customers modules registered.
    const found = [...moneyBlockers(facts), ...(await this.guards.blockersOf(tx, account.id))];
    if (found.length > 0) throw blocked(found);

    const amount = facts.sourceBalance;
    let move: MoveOutcome = { moved: Money.zero(), transactionId: null };
    if (amount.isPositive()) {
      const posted = await postTransaction(
        tx,
        {
          kind: 'wallet_transfer',
          refType: 'account',
          refId: account.id,
          idempotencyKey: rankMoveKey(account.id, idempotencyKey),
          currency: BASE_CURRENCY,
          memo: rankMoveMemo(toName, toKind),
          createdBy: { type: 'staff', id: staff.staffId },
          lines: rankMoveLines(account.id, plan, amount),
        },
        now,
      );
      // The history row of this key does not exist yet, so a ledger key that is already used is a broken invariant, not a replay.
      if (posted.replayed)
        throw new Error(`The ledger key of the rank change of account ${account.id} was used without a history row.`);
      move = { moved: amount, transactionId: posted.id };
    }
    const source = rows.find((row) => row.kind === plan.source);
    if (plan.clearsCreditLimit && source && Money.of(source.overdraftLimit).isPositive()) {
      await clearCreditLimit(tx, source.id, now);
    }
    return move;
  }
}
