// Journal lines and the checks every posting passes before it touches the database (decision 024 step 1): at least two
// lines, each a positive debit or credit, debits equal credits, one currency.
import { AppError } from '../../../common/errors';
import { Money } from '../../../common/money';
import type { LedgerAccountKind, LedgerOwnerType } from '../db/schema';

/**
 * Which ledger account a line is about: a kind, and the owner for the per-owner kinds.
 *
 * Why: system accounts are found by kind and currency, merchant wallets and holds by merchant, supplier prepaid accounts by
 * supplier (decision 024: unique identity `(kind, owner_type, owner_id, currency)`).
 */
export interface AccountRef {
  readonly kind: LedgerAccountKind;
  /** `client` for `client_wallet` and `client_hold`, `supplier` for `supplier_prepaid`; absent for system accounts. */
  readonly ownerType?: LedgerOwnerType;
  readonly ownerId?: number;
  /** Only to assert one currency; defaults to the transaction's currency. */
  readonly currency?: string;
}

/**
 * One journal line: exactly one of `debit` and `credit` is above zero.
 *
 * Why: the map writes every money event as `[account, debit, credit]` lines (decision 024); the builders return them in that
 * shape and `postTransaction` turns them into signed entries.
 */
export interface LedgerLine {
  readonly account: AccountRef;
  readonly debit: Money;
  readonly credit: Money;
}

/**
 * A debit line, or nothing for a zero amount.
 *
 * Why: "a zero-amount line (no supplier cost) is dropped" (decision 024).
 *
 * @param account the account debited
 * @param amount the amount (not negative)
 * @returns the line, or an empty list when the amount is zero
 * @throws {RangeError} when the amount is negative
 */
export function debitLine(account: AccountRef, amount: Money): LedgerLine[] {
  return sideLine(account, amount, 'debit');
}

/**
 * A credit line, or nothing for a zero amount.
 *
 * @param account the account credited
 * @param amount the amount (not negative)
 * @returns the line, or an empty list when the amount is zero
 * @throws {RangeError} when the amount is negative
 */
export function creditLine(account: AccountRef, amount: Money): LedgerLine[] {
  return sideLine(account, amount, 'credit');
}

function sideLine(account: AccountRef, amount: Money, side: 'debit' | 'credit'): LedgerLine[] {
  if (amount.isNegative()) throw new RangeError(`A ${side} amount cannot be negative (got ${amount.toWire()})`);
  if (amount.isZero()) return [];
  const zero = Money.zero();
  return [{ account, debit: side === 'debit' ? amount : zero, credit: side === 'credit' ? amount : zero }];
}

/**
 * Checks the lines of a posting.
 *
 * Why: decision 024 step 1: "validate: >= 2 lines, each a positive debit or credit, sum of debits = sum of credits, one
 * currency (`LEDGER_UNBALANCED`)". It runs before any SQL, so a bad posting never opens a transaction's locks.
 *
 * @param lines the journal lines
 * @param currency the transaction's currency
 * @throws {AppError} `LEDGER_UNBALANCED` for fewer than two lines, a line that is not exactly one positive side, debits that
 *   differ from credits, or an account in another currency
 */
export function assertBalanced(lines: readonly LedgerLine[], currency: string): void {
  if (lines.length < 2) throw unbalanced(`A posting needs at least two lines (got ${lines.length}).`);
  let debits = Money.zero();
  let credits = Money.zero();
  for (const line of lines) {
    const hasDebit = line.debit.isPositive();
    const hasCredit = line.credit.isPositive();
    if (hasDebit === hasCredit || line.debit.isNegative() || line.credit.isNegative()) {
      throw unbalanced(`A line must be exactly one positive debit or credit (account ${line.account.kind}).`);
    }
    if ((line.account.currency ?? currency) !== currency) {
      throw unbalanced(
        `A posting uses one currency; ${line.account.kind} is in ${line.account.currency}, not ${currency}.`,
      );
    }
    debits = debits.add(line.debit);
    credits = credits.add(line.credit);
  }
  if (!debits.eq(credits)) {
    throw unbalanced(`Debits ${debits.toWire()} differ from credits ${credits.toWire()}.`);
  }
}

function unbalanced(detail: string): AppError {
  return new AppError('LEDGER_UNBALANCED', { detail });
}
