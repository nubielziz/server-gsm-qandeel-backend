// The 13 money events of the map (reference/gsm-map system.mjs `moneyEvents`, decision 024) as pure builders: each returns
// the journal lines exactly as the map writes them, plus the ledger kind and the reference type the posting carries.
import { Money } from '../../../common/money';
import type { LedgerRefType } from '../db/schema';
import { type AccountRef, type LedgerLine, creditLine, debitLine } from './ledger-lines';

/** The ids of the map's 13 money events. */
export const MONEY_EVENT_IDS = [
  'deposit',
  'order',
  'complete',
  'reject',
  'topup',
  'commission',
  'adjust',
  'b2c_pay',
  'b2c_fee',
  'b2c_deliver',
  'b2c_refund',
  'b2c_chargeback',
  'payout',
] as const;

/** One value of {@link MONEY_EVENT_IDS}. */
export type MoneyEventId = (typeof MONEY_EVENT_IDS)[number];

/**
 * The ledger `kind` each money event posts with, in the console's vocabulary.
 *
 * Why: the console labels entries by kind (`LEDGER_KIND_LABEL`: deposit, order_hold, order_settle, order_release, adjustment,
 * commission, supplier_topup, settlement, b2c_payment, gateway_fee, refund, chargeback); the statement doc quotes the same
 * words. A B2C delivery recognises revenue like a B2B completion, so both post `order_settle`.
 */
export const MONEY_EVENT_KINDS: Readonly<Record<MoneyEventId, string>> = {
  deposit: 'deposit',
  order: 'order_hold',
  complete: 'order_settle',
  reject: 'order_release',
  topup: 'supplier_topup',
  commission: 'commission',
  adjust: 'adjustment',
  b2c_pay: 'b2c_payment',
  b2c_fee: 'gateway_fee',
  b2c_deliver: 'order_settle',
  b2c_refund: 'refund',
  b2c_chargeback: 'chargeback',
  payout: 'settlement',
};

/**
 * What a builder returns: spread it into the input of `postTransaction` and add the record id, key, memo and actor.
 *
 * Why: keeping `kind`, `refType` and `lines` together means a caller cannot post an event under the wrong reference type
 * (B2C events post `order`, never `payment`, resolution money-2).
 */
export interface MoneyEventPosting {
  readonly event: MoneyEventId;
  readonly kind: string;
  readonly refType: LedgerRefType;
  readonly lines: readonly LedgerLine[];
}

const SYSTEM = (kind: AccountRef['kind']): AccountRef => ({ kind });
const wallet = (clientId: number): AccountRef => ({ kind: 'client_wallet', ownerType: 'client', ownerId: clientId });
const hold = (clientId: number): AccountRef => ({ kind: 'client_hold', ownerType: 'client', ownerId: clientId });
const prepaid = (supplierId: number): AccountRef => ({
  kind: 'supplier_prepaid',
  ownerType: 'supplier',
  ownerId: supplierId,
});

function posting(event: MoneyEventId, refType: LedgerRefType, ...groups: LedgerLine[][]): MoneyEventPosting {
  return { event, kind: MONEY_EVENT_KINDS[event], refType, lines: groups.flat() };
}

/** The supplier account a cost is booked against; a cost needs one. */
function costLines(cost: Money, supplierId: number | undefined): { cogs: LedgerLine[]; supplier: LedgerLine[] } {
  if (cost.isZero()) return { cogs: [], supplier: [] };
  if (supplierId === undefined) throw new RangeError('A supplier cost needs the supplier it is booked against.');
  return { cogs: debitLine(SYSTEM('cogs'), cost), supplier: creditLine(prepaid(supplierId), cost) };
}

/** Input of {@link deposit}. */
export interface DepositInput {
  readonly clientId: number;
  /** What the wallet receives (the map: 100). */
  readonly amount: Money;
  /** The fee the merchant pays on top (the map: 3); zero drops the fee line. */
  readonly fee?: Money;
  /** The account the money comes from: `gateway_clearing` (automatic gateways) or `bank` (manual gateways, user rule 4). */
  readonly from?: 'gateway_clearing' | 'bank';
}

/**
 * Event `deposit`: a merchant tops up the wallet; the fee is income.
 *
 * Why: the map's "شحن 100$": the merchant pays 103, the wallet gets 100 and the fee 3 is `fee_income`. A manual gateway
 * (bank, Wise) debits `bank` instead of `gateway_clearing` (user rule 4, decision 024).
 *
 * @param input merchant, amount, fee and source account
 * @returns Dr from (amount + fee) / Cr client_wallet amount / Cr fee_income fee; reference type `payment`
 * @throws {RangeError} when an amount is negative
 */
export function deposit(input: DepositInput): MoneyEventPosting {
  const fee = input.fee ?? Money.zero();
  return posting(
    'deposit',
    'payment',
    debitLine(SYSTEM(input.from ?? 'gateway_clearing'), input.amount.add(fee)),
    creditLine(wallet(input.clientId), input.amount),
    creditLine(SYSTEM('fee_income'), fee),
  );
}

/**
 * Event `order`: the order price moves from the wallet to the hold.
 *
 * Why: the map's "طلب 5$": "the balance is held and not spent yet".
 *
 * @param input merchant and price
 * @returns Dr client_wallet / Cr client_hold; reference type `order`
 */
export function order(input: { clientId: number; amount: Money }): MoneyEventPosting {
  return posting(
    'order',
    'order',
    debitLine(wallet(input.clientId), input.amount),
    creditLine(hold(input.clientId), input.amount),
  );
}

/**
 * Event `complete`: the supplier finished the order; the hold becomes revenue and the cost is booked.
 *
 * Why: the map's "اكتمال الطلب": revenue 5, cost 3, so the profit is 2. A zero cost (no supplier cost) drops the cost lines.
 *
 * @param input merchant, price, cost and the supplier the cost is booked against
 * @returns Dr client_hold price / Dr cogs cost / Cr revenue price / Cr supplier_prepaid cost; reference type `order`
 * @throws {RangeError} when the cost is above zero and no supplier is given
 */
export function complete(input: {
  clientId: number;
  price: Money;
  cost?: Money;
  supplierId?: number;
}): MoneyEventPosting {
  const { cogs, supplier } = costLines(input.cost ?? Money.zero(), input.supplierId);
  return posting(
    'complete',
    'order',
    debitLine(hold(input.clientId), input.price),
    cogs,
    creditLine(SYSTEM('revenue'), input.price),
    supplier,
  );
}

/**
 * Event `reject`: the supplier rejected the order; the hold returns to the wallet in full.
 *
 * Why: the map's "رفض الطلب": "the amount returns to the wallet in full".
 *
 * @param input merchant and held amount
 * @returns Dr client_hold / Cr client_wallet; reference type `order`
 */
export function reject(input: { clientId: number; amount: Money }): MoneyEventPosting {
  return posting(
    'reject',
    'order',
    debitLine(hold(input.clientId), input.amount),
    creditLine(wallet(input.clientId), input.amount),
  );
}

/**
 * Event `topup`: money moves from the bank to a supplier's prepaid balance.
 *
 * Why: the map's "شحن رصيد المورد 50$": "a transfer from your bank to buy credit".
 *
 * @param input supplier and amount
 * @returns Dr supplier_prepaid / Cr bank; reference type `supplier`
 */
export function topup(input: { supplierId: number; amount: Money }): MoneyEventPosting {
  return posting(
    'topup',
    'supplier',
    debitLine(prepaid(input.supplierId), input.amount),
    creditLine(SYSTEM('bank'), input.amount),
  );
}

/**
 * Event `commission`: a referral commission is paid into the referrer's wallet.
 *
 * Why: the map's "عمولة إحالة 0.20$": "paid to the referring merchant's wallet".
 *
 * @param input the agent merchant and the commission
 * @returns Dr commission_expense / Cr client_wallet; reference type `accrual`
 */
export function commission(input: { clientId: number; amount: Money }): MoneyEventPosting {
  return posting(
    'commission',
    'accrual',
    debitLine(SYSTEM('commission_expense'), input.amount),
    creditLine(wallet(input.clientId), input.amount),
  );
}

/**
 * Event `adjust`: staff add to or deduct from a wallet by hand.
 *
 * Why: the map's "تعديل يدوي 10$" shows the credit; a debit is its exact mirror (B30). The posting keeps `ref_type client`
 * (the merchant is the reference, B34); the wire sends it as `system` (resolution money-1).
 *
 * @param input merchant, amount and direction
 * @returns credit: Dr adjustments / Cr client_wallet; debit: Dr client_wallet / Cr adjustments; reference type `client`
 */
export function adjust(input: { clientId: number; amount: Money; direction: 'credit' | 'debit' }): MoneyEventPosting {
  return input.direction === 'credit'
    ? posting(
        'adjust',
        'client',
        debitLine(SYSTEM('adjustments'), input.amount),
        creditLine(wallet(input.clientId), input.amount),
      )
    : posting(
        'adjust',
        'client',
        debitLine(wallet(input.clientId), input.amount),
        creditLine(SYSTEM('adjustments'), input.amount),
      );
}

/**
 * Event `b2c_pay`: a storefront customer paid; the net is customer funds and the VAT is owed.
 *
 * Why: the map's "دفع طلب 14.99$": net 12.49 and VAT 2.50 (20%), received through the gateway.
 *
 * @param input the net amount and the VAT (their sum is what the gateway collected)
 * @returns Dr gateway_clearing net + vat / Cr customer_funds net / Cr vat_payable vat; reference type `order`
 */
export function b2cPay(input: { net: Money; vat: Money }): MoneyEventPosting {
  return posting(
    'b2c_pay',
    'order',
    debitLine(SYSTEM('gateway_clearing'), input.net.add(input.vat)),
    creditLine(SYSTEM('customer_funds'), input.net),
    creditLine(SYSTEM('vat_payable'), input.vat),
  );
}

/**
 * Event `b2c_fee`: the payment gateway's fee on a payment.
 *
 * Why: the map's "رسوم البوابة 0.73$": "an expense on every payment".
 *
 * @param input the fee
 * @returns Dr gateway_fees / Cr gateway_clearing; reference type `order`
 */
export function b2cFee(input: { fee: Money }): MoneyEventPosting {
  return posting(
    'b2c_fee',
    'order',
    debitLine(SYSTEM('gateway_fees'), input.fee),
    creditLine(SYSTEM('gateway_clearing'), input.fee),
  );
}

/**
 * Event `b2c_deliver`: a storefront order was delivered; customer funds become revenue and the cost is booked.
 *
 * Why: the map's "تسليم الطلب": revenue 12.49 and cost 7.20.
 *
 * @param input the net amount, the cost and the supplier the cost is booked against
 * @returns Dr customer_funds net / Dr cogs cost / Cr revenue net / Cr supplier_prepaid cost; reference type `order`
 * @throws {RangeError} when the cost is above zero and no supplier is given
 */
export function b2cDeliver(input: { net: Money; cost?: Money; supplierId?: number }): MoneyEventPosting {
  const { cogs, supplier } = costLines(input.cost ?? Money.zero(), input.supplierId);
  return posting(
    'b2c_deliver',
    'order',
    debitLine(SYSTEM('customer_funds'), input.net),
    cogs,
    creditLine(SYSTEM('revenue'), input.net),
    supplier,
  );
}

/**
 * Event `b2c_refund`: a storefront order is refunded before delivery, in full.
 *
 * Why: the map's "استرداد قبل التسليم": the whole 14.99 goes back to the card.
 *
 * @param input the net amount and the VAT paid
 * @returns Dr customer_funds net / Dr vat_payable vat / Cr gateway_clearing net + vat; reference type `order`
 */
export function b2cRefund(input: { net: Money; vat: Money }): MoneyEventPosting {
  return posting(
    'b2c_refund',
    'order',
    debitLine(SYSTEM('customer_funds'), input.net),
    debitLine(SYSTEM('vat_payable'), input.vat),
    creditLine(SYSTEM('gateway_clearing'), input.net.add(input.vat)),
  );
}

/**
 * Event `b2c_chargeback`: a card dispute was lost; the payment and the dispute fee are taken from what the gateway owes us.
 *
 * Why: the map's "نزاع خسرناه": 14.99 and the 15 dispute fee, 29.99 in all.
 *
 * @param input the disputed amount and the dispute fee
 * @returns Dr chargeback_loss amount + fee / Cr gateway_clearing amount + fee; reference type `order`
 */
export function b2cChargeback(input: { amount: Money; fee: Money }): MoneyEventPosting {
  const total = input.amount.add(input.fee);
  return posting(
    'b2c_chargeback',
    'order',
    debitLine(SYSTEM('chargeback_loss'), total),
    creditLine(SYSTEM('gateway_clearing'), total),
  );
}

/**
 * Event `payout`: the gateway pays what it owes into the bank.
 *
 * Why: the map's "تحويل البوابة للبنك 14.26$": "the payment after the fee". It has no record behind it, so it posts
 * `ref_type system` with `ref_id 0` (resolution money-6).
 *
 * @param input the amount
 * @returns Dr bank / Cr gateway_clearing; reference type `system`
 */
export function payout(input: { amount: Money }): MoneyEventPosting {
  return posting(
    'payout',
    'system',
    debitLine(SYSTEM('bank'), input.amount),
    creditLine(SYSTEM('gateway_clearing'), input.amount),
  );
}

/** The reversals the order engine posts beyond the map's 13 events (decision 024, decision 025). */
export const REVERSAL_EVENT_IDS = ['reopen', 'refund'] as const;

/** One value of {@link REVERSAL_EVENT_IDS}. */
export type ReversalEventId = (typeof REVERSAL_EVENT_IDS)[number];

/**
 * The ledger `kind` each reversal posts with, in the console's vocabulary.
 *
 * Why: the console labels entries by kind (`LEDGER_KIND_LABEL`) and has no word for a reopen: its own mock posts it as
 * `adjustment`, a B2B refund as `refund`, so the ledger filters keep working.
 */
export const REVERSAL_KINDS: Readonly<Record<ReversalEventId, string>> = { reopen: 'adjustment', refund: 'refund' };

/**
 * What a reversal builder returns: spread it into the input of `postTransaction` like a {@link MoneyEventPosting}.
 *
 * Why: reopen and the B2B refund are not among the map's 13 events (decision 024 lists them as "rules beyond the 13"), so they
 * have their own id type; the posting still carries the reference type of the record it reverses (resolution money-1).
 */
export interface ReversalPosting {
  readonly event: ReversalEventId;
  readonly kind: string;
  readonly refType: LedgerRefType;
  readonly lines: readonly LedgerLine[];
}

/**
 * Event `reopen` (B2B): a completed order goes back to processing; the revenue returns to the hold, the cost stays booked.
 *
 * Why: decision 024 and MISMATCHES B17: "reopen reverses revenue only; cogs stays". A later completion books the revenue again
 * and books the cost again only for a new supplier charge.
 *
 * @param input merchant and the order price that was recognised
 * @returns Dr revenue / Cr client_hold; reference type `order`
 */
export function reopen(input: { clientId: number; amount: Money }): ReversalPosting {
  return {
    event: 'reopen',
    kind: REVERSAL_KINDS.reopen,
    refType: 'order',
    lines: [...debitLine(SYSTEM('revenue'), input.amount), ...creditLine(hold(input.clientId), input.amount)],
  };
}

/**
 * Event `reopen` (B2C): a delivered storefront order goes back to processing; the revenue returns to customer funds.
 *
 * @param input the net amount that was recognised
 * @returns Dr revenue / Cr customer_funds; reference type `order`
 */
export function reopenB2c(input: { net: Money }): ReversalPosting {
  return {
    event: 'reopen',
    kind: REVERSAL_KINDS.reopen,
    refType: 'order',
    lines: [...debitLine(SYSTEM('revenue'), input.net), ...creditLine(SYSTEM('customer_funds'), input.net)],
  };
}

/**
 * Event `refund` (B2B): a completed merchant order is refunded; the revenue goes straight back to the wallet, the cost stays.
 *
 * Why: the map's refund is "reopen, then reject" in one step (decision 024): the hold is not touched because the order price is
 * no longer on it. "A refund after delivery loses the supplier cost" (the console's own words, OrderFooter).
 *
 * @param input merchant and the order price that was recognised
 * @returns Dr revenue / Cr client_wallet; reference type `order`
 */
export function refund(input: { clientId: number; amount: Money }): ReversalPosting {
  return {
    event: 'refund',
    kind: REVERSAL_KINDS.refund,
    refType: 'order',
    lines: [...debitLine(SYSTEM('revenue'), input.amount), ...creditLine(wallet(input.clientId), input.amount)],
  };
}

/**
 * What {@link commissionReversal} returns: spread it into the input of `postTransaction` and add the accrual id, key, memo and actor.
 *
 * Why: like the order reversals it is a rule beyond the map's 13 events (user rule 5), so it has its own event word and keeps the
 * reference type of the record it reverses (`accrual`).
 */
export interface CommissionReversalPosting {
  readonly event: 'commission_reversal';
  readonly kind: string;
  readonly refType: LedgerRefType;
  readonly lines: readonly LedgerLine[];
}

/**
 * Reversal of a paid commission: the agent's wallet gives the commission back.
 *
 * Why: user rule 5 (ANSWERS commissions Q8): an order refunded or reopened after its commission was approved keeps the accrual
 * `approved` and posts the mirror of the `commission` event. It keeps the ledger kind `commission`, so the agent's statement shows
 * the commission and its reversal as lines of the same kind; the memo and the key (`reverse:accrual:<id>`) say it is a reversal.
 * The debit may take the wallet below its credit limit: the caller posts it with `allowBelowCreditLimit`.
 *
 * @param input the agent merchant and the commission that was paid
 * @returns Dr client_wallet / Cr commission_expense; reference type `accrual`
 */
export function commissionReversal(input: { clientId: number; amount: Money }): CommissionReversalPosting {
  return {
    event: 'commission_reversal',
    kind: MONEY_EVENT_KINDS.commission,
    refType: 'accrual',
    lines: [
      ...debitLine(wallet(input.clientId), input.amount),
      ...creditLine(SYSTEM('commission_expense'), input.amount),
    ],
  };
}
