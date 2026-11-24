// The money events of the store balance (feature 21, plan § 5.4) as pure builders, beyond the map's 13: top-up, balance payment,
// refund to the balance, staff adjustment and top-up chargeback. Ledger kinds reuse the console's words so labels and filters work unchanged.
// The balance belongs to an account (decision 064): every owner reference here is `('account', id)`, and the input keys that still say
// `customerId` carry an account id.
import { Decimal } from 'decimal.js';
import { Money } from '../../../common/money';
import type { CurrentLedgerRefType } from '../db/schema';
import { storeWalletAccountOf, walletAccountOf } from './accounts';
import { type AccountRef, type LedgerLine, creditLine, debitLine } from './ledger-lines';
import type { WalletLedgerKind } from './wallet-kinds';

/** The ids of the wallet money events. */
export const WALLET_EVENT_IDS = [
  'customer_topup',
  'b2c_wallet_pay',
  'b2c_wallet_refund',
  'customer_adjust',
  'topup_chargeback',
] as const;

/** One value of {@link WALLET_EVENT_IDS}. */
export type WalletEventId = (typeof WALLET_EVENT_IDS)[number];

/**
 * The ledger `kind` each wallet event posts with, in the console's vocabulary.
 *
 * Why: plan 21 § 5.4: the console labels entries by kind (`LEDGER_KIND_LABEL`), so a customer top-up is a `deposit`, a balance payment a
 * `b2c_payment`, and so on; the statements and ledger filters need no new word.
 */
export const WALLET_EVENT_KINDS: Readonly<Record<WalletEventId, string>> = {
  customer_topup: 'deposit',
  b2c_wallet_pay: 'b2c_payment',
  b2c_wallet_refund: 'refund',
  customer_adjust: 'adjustment',
  topup_chargeback: 'chargeback',
};

/**
 * What a wallet builder returns: spread it into the input of `postTransaction` and add the record id, key, memo and actor.
 *
 * Why: like the map's builders, keeping `kind`, `refType` and `lines` together stops a caller from posting under the wrong reference type.
 */
export interface WalletEventPosting {
  readonly event: WalletEventId;
  readonly kind: string;
  readonly refType: CurrentLedgerRefType;
  readonly lines: readonly LedgerLine[];
}

const SYSTEM = (kind: AccountRef['kind']): AccountRef => ({ kind });

/**
 * The ledger account of an account's store balance.
 *
 * Why: decision 024's identity `(kind, owner_type, owner_id, currency)` with the one owner word of decision 064: at most one USD
 * `customer_wallet` per account (plan 21 § 5.3), owned by `('account', accountId)`. An old customer number is never an account id; the
 * expand migration re-keyed every store balance through the legacy map before this reference is used.
 *
 * @param accountId the account that holds the store balance
 * @returns the account reference
 */
export function customerWalletAccount(accountId: number): AccountRef {
  return storeWalletAccountOf(accountId);
}

/**
 * Whose wallet a top-up credited: an account and the kind of wallet that top-up reached.
 *
 * Why: decision 064: both kinds of account are topped up, and a late credit or a chargeback hits the wallet that is live when it is
 * posted, so the owner is the account plus the ledger kind read under the account row lock (`client_wallet` or `customer_wallet`).
 */
export interface TopUpOwner {
  /** The account whose wallet it is. */
  readonly accountId: number;
  /** The ledger kind of the wallet: `client_wallet` for a merchant rank, `customer_wallet` for any other. */
  readonly kind: WalletLedgerKind;
}

const ownerWallet = (owner: TopUpOwner): AccountRef =>
  owner.kind === 'customer_wallet' ? customerWalletAccount(owner.accountId) : walletAccountOf(owner.accountId);

function posting(event: WalletEventId, refType: CurrentLedgerRefType, ...groups: LedgerLine[][]): WalletEventPosting {
  return { event, kind: WALLET_EVENT_KINDS[event], refType, lines: groups.flat() };
}

/**
 * Event `customer_topup`: a customer's top-up is credited; the fee is income.
 *
 * Why: the merchant `deposit` for a customer (plan 21 § 5.4): the customer paid `amount + fee`, the balance gets `amount`. A manual
 * gateway debits `bank`, an automatic one `gateway_clearing` (user rule 4). Top-ups carry no VAT (O9: VAT is due at spend).
 *
 * @param input customer, net amount credited, fee and source account
 * @returns Dr from (amount + fee) / Cr customer_wallet amount / Cr fee_income fee; kind `deposit`, reference type `payment`
 * @throws {RangeError} when an amount is negative
 */
export function customerTopup(input: {
  customerId: number;
  amount: Money;
  fee?: Money;
  from: 'gateway_clearing' | 'bank';
}): WalletEventPosting {
  const fee = input.fee ?? Money.zero();
  return posting(
    'customer_topup',
    'payment',
    debitLine(SYSTEM(input.from), input.amount.add(fee)),
    creditLine(customerWalletAccount(input.customerId), input.amount),
    creditLine(SYSTEM('fee_income'), fee),
  );
}

/**
 * Event `b2c_wallet_pay`: a storefront order is paid from the customer's store balance.
 *
 * Why: the map's `b2c_pay` with the store balance in place of the gateway (plan 21 § 5.4): the money sits in `customer_funds` exactly as
 * after a card capture, so delivery, reopen and refunds do not change; no gateway fee.
 *
 * @param input the customer, the net amount and the VAT locked on the checkout
 * @returns Dr customer_wallet net + vat / Cr customer_funds net / Cr vat_payable vat; kind `b2c_payment`, reference type `order`
 */
export function b2cWalletPay(input: { customerId: number; net: Money; vat: Money }): WalletEventPosting {
  return posting(
    'b2c_wallet_pay',
    'order',
    debitLine(customerWalletAccount(input.customerId), input.net.add(input.vat)),
    creditLine(SYSTEM('customer_funds'), input.net),
    creditLine(SYSTEM('vat_payable'), input.vat),
  );
}

/**
 * Event `b2c_wallet_refund`: an order paid from the balance is refunded to it.
 *
 * Why: the map's `b2c_refund` with the store balance in place of the gateway (plan 21 § 5.6.7, O10): before delivery the net leaves
 * `customer_funds`, after delivery `revenue`; the VAT share leaves `vat_payable` either way.
 *
 * Decision 064: a refund always credits the account's live wallet. An order paid from the balance of an account that has since become a
 * merchant is refunded to its `client_wallet` (`wallet: 'client_wallet'`); the refund key is the same either way.
 *
 * @param input the account (the key keeps its old name), the net and VAT paid back, where the net comes from and the live wallet kind
 *   (`customer_wallet` unless given)
 * @returns Dr customer_funds (or revenue) net / Dr vat_payable vat / Cr customer_wallet (or client_wallet) net + vat; kind `refund`,
 *   reference type `order`
 */
export function b2cWalletRefund(input: {
  customerId: number;
  net: Money;
  vat: Money;
  from?: 'customer_funds' | 'revenue';
  wallet?: WalletLedgerKind;
}): WalletEventPosting {
  const target =
    input.wallet === 'client_wallet' ? walletAccountOf(input.customerId) : customerWalletAccount(input.customerId);
  return posting(
    'b2c_wallet_refund',
    'order',
    debitLine(SYSTEM(input.from ?? 'customer_funds'), input.net),
    debitLine(SYSTEM('vat_payable'), input.vat),
    creditLine(target, input.net.add(input.vat)),
  );
}

/**
 * Event `customer_adjust`: staff add to or deduct from a customer's store balance by hand.
 *
 * Why: the map's `adjust` for a customer (plan 21 § 5.6.2). It posts the reference type `account` (decision 064: the account is the
 * reference, never `customer`), sent as `system` on the wire like the older `customer` and `client` rows.
 *
 * @param input the account (the key keeps its old name), amount and direction
 * @returns credit: Dr adjustments / Cr customer_wallet; debit: the mirror; kind `adjustment`, reference type `account`
 */
export function customerAdjust(input: {
  customerId: number;
  amount: Money;
  direction: 'credit' | 'debit';
}): WalletEventPosting {
  const wallet = customerWalletAccount(input.customerId);
  return input.direction === 'credit'
    ? posting(
        'customer_adjust',
        'account',
        debitLine(SYSTEM('adjustments'), input.amount),
        creditLine(wallet, input.amount),
      )
    : posting(
        'customer_adjust',
        'account',
        debitLine(wallet, input.amount),
        creditLine(SYSTEM('adjustments'), input.amount),
      );
}

/**
 * Event `topup_chargeback`: a top-up dispute was lost; the credited amount is taken back from the owner's wallet.
 *
 * Why: O11: the gateway takes the disputed money and its dispute fee from what it owes us; we claw back what the top-up credited (the
 * wallet may go below zero), reverse our fee income and book the dispute fee as a loss. Customers and merchants share it (plan § 5.6.9).
 *
 * @param input the wallet owner (the account and the kind of its live wallet), the net clawed back, the top-up fee reversed and the gateway's dispute fee
 * @returns Dr owner wallet net / Dr fee_income fee / Dr chargeback_loss disputeFee / Cr gateway_clearing net + fee + disputeFee; kind
 *   `chargeback`, reference type `dispute`
 */
export function topupChargeback(input: {
  owner: TopUpOwner;
  net: Money;
  fee: Money;
  disputeFee: Money;
}): WalletEventPosting {
  return posting(
    'topup_chargeback',
    'dispute',
    debitLine(ownerWallet(input.owner), input.net),
    debitLine(SYSTEM('fee_income'), input.fee),
    debitLine(SYSTEM('chargeback_loss'), input.disputeFee),
    creditLine(SYSTEM('gateway_clearing'), input.net.add(input.fee).add(input.disputeFee)),
  );
}

const D = Decimal.clone({ precision: 40, rounding: Decimal.ROUND_HALF_UP });

/**
 * Splits a disputed top-up amount into the wallet's share and the fee's share.
 *
 * Why: plan 21 § 5.4: with a top-up of gross `G` (what the payer paid), fee `F` and a disputed `D ≤ G`, the fee share is `F` when the
 * whole top-up is disputed, else `round(F × D / G, 4)`; the wallet gives back `D − fee`. A whole dispute returns exactly what was credited.
 *
 * @param input the top-up's gross and fee, and the disputed amount
 * @returns the net taken from the wallet and the fee income reversed
 * @throws {RangeError} when the gross is not positive or the disputed amount is negative
 */
export function clawbackSplit(input: { gross: Money; fee: Money; disputed: Money }): { net: Money; fee: Money } {
  if (!input.gross.isPositive()) throw new RangeError('A top-up gross must be above zero.');
  if (input.disputed.isNegative()) throw new RangeError('A disputed amount cannot be negative.');
  const disputed = input.disputed.cmp(input.gross) > 0 ? input.gross : input.disputed;
  const fee = disputed.eq(input.gross)
    ? input.fee
    : Money.of(
        new D(input.fee.toWire())
          .times(new D(disputed.toWire()))
          .div(new D(input.gross.toWire()))
          .toDecimalPlaces(4)
          .toFixed(4),
      );
  return { net: disputed.sub(fee), fee };
}
