// postTransaction(): the only writer of ledger rows (decision 024; map money events). It validates a posting, replays an
// idempotency key, locks the accounts in id order, checks the wallet's credit limit and writes header, entries and balances in
// the caller's transaction. LedgerPoster is the injectable form that reads the posting time from the Clock (decision 031).
import { Inject, Injectable, Optional } from '@nestjs/common';
import { CLOCK, type Clock } from '../../../common/clock';
import { AppError } from '../../../common/errors';
import { Money } from '../../../common/money';
import type { DbExecutor } from '../../../infra/db';
import type { LedgerAccountKind, LedgerActorType, LedgerOwnerType, LedgerRefType } from '../db/schema';
import { balanceDelta } from '../domain/accounts';
import { type LedgerLine, assertBalanced } from '../domain/ledger-lines';
import {
  type AccountIdentity,
  type LockedAccount,
  lockAccountsByIdentity,
  openAccounts,
  writeBalances,
} from '../infra/ledger-accounts.repository';
import { findHeaderByKey, insertEntries, insertHeader } from '../infra/ledger-writer.repository';
import { WalletLowBalanceWatch } from './wallet-low-balance-watch';

/** What a posting needs. Spread a money event builder (`deposit(...)`) into it and add the rest. */
export interface PostTransactionInput {
  /** The ledger kind (`deposit`, `order_hold`, `adjustment`, ...); see `MONEY_EVENT_KINDS`. */
  readonly kind: string;
  readonly refType: LedgerRefType;
  /** The record the posting is about; `0` only for `system` (resolution money-6). */
  readonly refId: number;
  /** A deterministic key per business occurrence; a replay returns the first transaction and posts nothing. */
  readonly idempotencyKey: string;
  /** The currency of every account of the posting. */
  readonly currency: string;
  readonly lines: readonly LedgerLine[];
  readonly memo?: string;
  readonly createdBy: { readonly type: LedgerActorType; readonly id: number | null };
}

/** What a posting did to one account. */
export interface PostedAccount {
  readonly accountId: number;
  readonly kind: LedgerAccountKind;
  readonly ownerType: LedgerOwnerType | null;
  readonly ownerId: number | null;
  /** The balance before the posting, in the account's normal sign (read under the account lock). */
  readonly before: string;
  /** The balance after the posting, in the account's normal sign. */
  readonly after: string;
  /** The credit limit of the account (`0` unless it is a merchant wallet), read under the account lock. */
  readonly overdraftLimit: string;
}

/** The result of a posting. */
export interface PostedTransaction {
  /** `ledger_transactions.id` (the number the console shows as `JRN-<id>`). */
  readonly id: number;
  /** True when the idempotency key was used before: nothing was written and `id` is the first transaction's. */
  readonly replayed: boolean;
  /** The accounts the posting changed, with their balances; empty for a replay. */
  readonly touched: readonly PostedAccount[];
}

/** A programming error: a posting that points at no record (resolution money-6). Never shown to a client. */
export class LedgerRefRequiredError extends RangeError {
  /** The catalog-style name of the refusal. */
  readonly code = 'LEDGER_REF_REQUIRED';

  constructor(refType: LedgerRefType) {
    super(
      `LEDGER_REF_REQUIRED: a ${refType} posting needs the id of the record it is about (ref_id 0 is for system only).`,
    );
    this.name = 'LedgerRefRequiredError';
  }
}

const MAX_KEY_LENGTH = 200;

function checkInput(input: PostTransactionInput): void {
  if (!Number.isSafeInteger(input.refId) || input.refId < 0) {
    throw new RangeError(`A ledger posting's refId must be a whole number from 0 (got ${input.refId}).`);
  }
  if (input.refId === 0 && input.refType !== 'system') throw new LedgerRefRequiredError(input.refType);
  if (input.idempotencyKey.trim() === '' || input.idempotencyKey.length > MAX_KEY_LENGTH) {
    throw new RangeError(`A ledger idempotency key must be 1-${MAX_KEY_LENGTH} characters.`);
  }
  if ((input.createdBy.type === 'system') !== (input.createdBy.id === null)) {
    throw new RangeError('A system posting has no actor id; every other actor needs one.');
  }
  assertBalanced(input.lines, input.currency);
}

function identityOf(line: LedgerLine, currency: string): AccountIdentity {
  return {
    kind: line.account.kind,
    ownerType: line.account.ownerType,
    ownerId: line.account.ownerId,
    currency: line.account.currency ?? currency,
  };
}

/** The identity of an account as a string, equal for an account reference and for the row found for it. */
function identityKey(account: {
  kind: string;
  ownerType?: string | null;
  ownerId?: number | null;
  currency: string;
}): string {
  return `${account.kind}|${account.ownerType ?? ''}|${account.ownerId ?? ''}|${account.currency}`;
}

/** Locks the posting's accounts in id order, opening the ones that do not exist yet, and returns them by line key. */
async function lockPostingAccounts(
  tx: DbExecutor,
  lines: readonly LedgerLine[],
  currency: string,
): Promise<Map<string, LockedAccount>> {
  const wanted = new Map<string, AccountIdentity>();
  for (const line of lines) {
    const identity = identityOf(line, currency);
    wanted.set(identityKey(identity), identity);
  }
  const identities = [...wanted.values()];
  let locked = await lockAccountsByIdentity(tx, identities);
  if (locked.length < identities.length) {
    const have = new Set(locked.map(identityKey));
    await openAccounts(
      tx,
      identities.filter((identity) => !have.has(identityKey(identity))),
    );
    // Locking again takes every account in id order in one statement; the ones locked before are ours already.
    locked = await lockAccountsByIdentity(tx, identities);
  }
  return new Map(locked.map((row) => [identityKey(row), row]));
}

/**
 * Posts one balanced journal entry.
 *
 * Why: decision 024: all money moves through this function, always inside the caller's transaction. The steps are the
 * decision's: validate, header with the unique idempotency key (a conflict returns the first transaction), lock every
 * affected account `FOR UPDATE` in id order, refuse a wallet that would end below `-overdraft_limit`, insert the entries with
 * `balance_after`, update balances and versions. A deferred trigger re-checks the zero sum at commit.
 *
 * Side effects: inserts one `ledger_transactions` row and its `ledger_entries`; updates `ledger_accounts.balance` and
 * `version`; opens the accounts it needs when they are missing (system accounts of a fresh database, a merchant's wallet if
 * it was never opened).
 *
 * @param tx the caller's transaction (never the bare pool: the posting must commit or roll back with the caller's work)
 * @param input the posting
 * @param now the posting time, from the injected clock (the seed passes the demo's time)
 * @returns the transaction id and whether the key was a replay
 * @throws {AppError} `LEDGER_UNBALANCED` for lines that are not a balanced set of at least two positive sides in one
 *   currency; `INSUFFICIENT_FUNDS` when a debit would take a `client_wallet` below `-overdraft_limit`
 * @throws {RangeError} `LEDGER_REF_REQUIRED` (a programming error) for `ref_id 0` on a non-system posting
 * @see docs/decisions/024-ledger.md
 */
export async function postTransaction(
  tx: DbExecutor,
  input: PostTransactionInput,
  now: Date,
): Promise<PostedTransaction> {
  checkInput(input);

  // The header comes first: a repeated key must return before any account lock is taken.
  const created = await insertHeader(tx, {
    kind: input.kind,
    refType: input.refType,
    refId: input.refId,
    memo: input.memo ?? '',
    idempotencyKey: input.idempotencyKey,
    createdByType: input.createdBy.type,
    createdById: input.createdBy.id,
    createdAt: now,
  });
  if (created === undefined) {
    const first = await findHeaderByKey(tx, input.idempotencyKey);
    if (!first) throw new Error(`Ledger idempotency key ${input.idempotencyKey} conflicted but no transaction has it.`);
    return { id: first.id, replayed: true, touched: [] };
  }

  const accounts = await lockPostingAccounts(tx, input.lines, input.currency);
  const locked = new Map<number, LockedAccount>([...accounts.values()].map((row) => [row.id, row]));

  // Running balances in each account's normal sign; a transaction may touch one account in several lines.
  const running = new Map<number, Money>([...locked].map(([id, row]) => [id, Money.of(row.balance)]));
  const entries = input.lines.map((line) => {
    const row = accounts.get(identityKey(identityOf(line, input.currency)));
    if (!row) throw new Error(`Ledger account ${line.account.kind} could not be resolved.`);
    const signed = line.debit.sub(line.credit);
    const balanceAfter = running.get(row.id)!.add(balanceDelta(row.kind, signed));
    running.set(row.id, balanceAfter);
    return {
      transactionId: created,
      accountId: row.id,
      amount: signed.toWire(),
      balanceAfter: balanceAfter.toWire(),
      createdAt: now,
    };
  });

  // Decision 024 step 4: a wallet may end below zero only down to its credit limit; credits always pass.
  for (const account of locked.values()) {
    if (account.kind !== 'client_wallet') continue;
    const before = Money.of(account.balance);
    const after = running.get(account.id)!;
    if (after.cmp(before) < 0 && after.cmp(Money.of(account.overdraftLimit).neg()) < 0) {
      throw new AppError('INSUFFICIENT_FUNDS', {
        detail: `The wallet would end at ${after.toWire()}, below its credit limit of ${Money.of(account.overdraftLimit).toWire()}.`,
      });
    }
  }

  await insertEntries(tx, entries);
  // Every touched account counts the posting in its version, even when the lines net to zero on it.
  await writeBalances(
    tx,
    [...locked.values()].map((account) => ({ id: account.id, balance: running.get(account.id)! })),
    now,
  );
  const touched = [...locked.values()].map((account) => ({
    accountId: account.id,
    kind: account.kind,
    ownerType: account.ownerType,
    ownerId: account.ownerId,
    before: account.balance,
    after: running.get(account.id)!.toWire(),
    overdraftLimit: account.overdraftLimit,
  }));
  return { id: created, replayed: false, touched };
}

/**
 * The injectable ledger writer: {@link postTransaction} with the posting time read from the Clock.
 *
 * Why: decision 031: time decisions go through the injected Clock, so a test posts on controlled time. Other modules call
 * `post` with the `tx` of their use case (orders hold and settle, billing deposits, refunds).
 */
@Injectable()
export class LedgerPoster {
  constructor(
    @Inject(CLOCK) private readonly clock: Clock,
    @Optional() private readonly lowBalance?: WalletLowBalanceWatch,
  ) {}

  /**
   * Posts one balanced journal entry in the caller's transaction, then writes the `wallet.low_balance` outbox event of every
   * merchant wallet the posting took under its alert threshold ({@link WalletLowBalanceWatch}; the same transaction).
   *
   * @param tx the caller's transaction
   * @param input the posting (spread a money event builder into it)
   * @returns the transaction id and whether the idempotency key was a replay
   * @throws {AppError} `LEDGER_UNBALANCED` or `INSUFFICIENT_FUNDS`, as {@link postTransaction}
   */
  async post(tx: DbExecutor, input: PostTransactionInput): Promise<PostedTransaction> {
    const posted = await postTransaction(tx, input, this.clock.now());
    // The alert is written in the same transaction; a replayed posting changed nothing and alerts nothing.
    if (!posted.replayed) await this.lowBalance?.afterPosting(tx, input.currency, posted);
    return posted;
  }
}
