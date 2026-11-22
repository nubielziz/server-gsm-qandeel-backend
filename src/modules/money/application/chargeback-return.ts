// The give-back of an order rejected after its payment was charged back: the share of what its sale booked as customer funds and VAT that
// the lost disputes took goes back against the chargeback loss, once per order, and no refund is opened (feature 16, decision 048).
import { Money } from '../../../common/money';
import type { DbExecutor } from '../../../infra/db';
import type { Payment } from '../db/schema';
import { wireUsd } from '../domain/b2c-money';
import { chargebackReturn } from '../domain/dispute-rules';
import { b2cChargebackReturn } from '../domain/money-events';
import { ledgerPartsOf, loadSessionMoney } from '../infra/b2c-reads.repository';
import { disputesOfPayment } from '../infra/dispute.repository';
import type { RefundActor, RefundLeft, RefundPosting } from './b2c-refunds';
import type { LedgerPoster } from './post-transaction';
import type { RefundedOrder } from './storefront-ports';

/**
 * The idempotency key of the give-back journal of an order rejected after its payment was charged back.
 *
 * Why: an order ends rejected once; the key makes a second booking of its give-back impossible, and the loss of a later dispute of the
 * payment finds what was already given back by it.
 *
 * @param orderId the order
 * @returns `order:<id>:chargeback-return`
 */
export function chargebackReturnKey(orderId: number): string {
  return `order:${orderId}:chargeback-return`;
}

/**
 * Books what a rejected order of a charged-back payment gives back, instead of a refund.
 *
 * Why: a dispute lost while the order was still open booked the plain loss (`DisputeLedger.lose`). When that order then ends rejected (a
 * staff reject, a supplier's rejection, a risk refund) it was never delivered, so what its sale booked as owed to the buyer and as VAT must
 * leave the books; nothing can be refunded on a charged-back payment (the card network already returned the money), so no refund row is
 * opened. The share is worked out as the loss of a rejected order works it out ({@link chargebackReturn}): the disputed amounts of the
 * payment's lost disputes, never more than the refunds that went out left, less what their chargeback journals already gave back. It is
 * posted as the give-back part of `b2c_chargeback` (Dr customer_funds, Dr vat_payable / Cr chargeback_loss) under
 * {@link chargebackReturnKey}; the VAT report and the payments report read those lines.
 *
 * Side effects (on the caller's transaction): one ledger transaction, when there is anything to give back.
 *
 * @param tx the transition's transaction (lock order: the order, the payment, which the caller holds, then the ledger accounts)
 * @param poster the ledger writer
 * @param input the rejected order, its charged-back payment (locked), what is left on the payment after its refunds, and who rejected it
 * @returns the posting, with `chargedBack` set and no refund row
 */
export async function returnAfterChargeback(
  tx: DbExecutor,
  poster: LedgerPoster,
  input: { order: RefundedOrder; payment: Payment; left: RefundLeft; actor: RefundActor },
): Promise<RefundPosting> {
  const { order, payment, left, actor } = input;
  // Read under the payment's lock: every writer of the payment's disputes takes it first.
  const lost = (await disputesOfPayment(tx, payment.id)).filter(
    (dispute) => dispute.status === 'lost' && dispute.ledgerTxId !== null,
  );
  const session = (await loadSessionMoney(tx, [order.id])).get(order.id);
  const fx = session?.fxRate ?? '1';
  const whole = session ? { amount: payment.amount, grossUsd: session.grossAmount } : undefined;
  const disputed = Money.sum(lost.map((dispute) => wireUsd(Money.of(dispute.amount), whole, fx)));
  const journals = lost.flatMap((dispute) => (dispute.ledgerTxId === null ? [] : [dispute.ledgerTxId]));
  const given = [...(await ledgerPartsOf(tx, journals)).values()];
  const givenNet = Money.sum(given.map((part) => Money.of(part.net)));
  const givenVat = Money.sum(given.map((part) => Money.of(part.vat)));
  const returned = chargebackReturn({
    disputed: disputed.sub(givenNet).sub(givenVat),
    left: left.usd.sub(givenNet).sub(givenVat),
    paid: left.paidUsd,
    tax: left.taxUsd,
    vatTaken: left.vatTaken.add(givenVat),
  });
  const total = returned.net.add(returned.vat);
  const outcome = { refundId: null, requested: false, disputed: false, chargedBack: true } as const;
  if (!total.isPositive()) return { ...outcome, posted: false, amount: Money.zero().toWire(), ledgerTxId: null };
  const posting = b2cChargebackReturn(returned);
  const posted = await poster.post(tx, {
    kind: posting.kind,
    refType: posting.refType,
    refId: order.id,
    idempotencyKey: chargebackReturnKey(order.id),
    currency: 'USD',
    lines: posting.lines,
    memo: `Chargeback of SF-${order.id}: the order was rejected, what its sale booked goes back from the loss`,
    createdBy: { type: actor.type, id: actor.id },
  });
  return { ...outcome, posted: true, amount: total.toWire(), ledgerTxId: posted.id };
}
