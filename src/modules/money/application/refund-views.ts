// RefundViews: turns stored refunds into the rows the console's Refunds page reads (feature 16): the customer, the order and the payment as
// joined summaries, the amounts in USD, and the revenue and VAT parts of the posted journal.
import { Injectable } from '@nestjs/common';
import type { ResultOf } from '../../../common/contract';
import { Money } from '../../../common/money';
import type { DbExecutor } from '../../../infra/db';
import type { Refund } from '../db/schema';
import { b2cPaymentMethod, wireUsd } from '../domain/b2c-money';
import { ledgerPartsOf, ledgerTxIdsByKeys, loadOrderFacts, loadSessionMoney } from '../infra/b2c-reads.repository';
import { loadActorNames, loadBillingCustomers, ownerKey } from '../infra/foreign-directory.repository';
import { loadOrderPayments } from '../infra/order-payment.repository';
import type { getRefund } from '../contracts/refunds.contracts';

/** One refund as the routes answer. */
export type WireRefund = ResultOf<typeof getRefund>;

/**
 * Builds the wire rows of refunds.
 *
 * Why: RESOLUTIONS money-4 and money-12: the row joins the customer, the order (delivered when it completed, its supplier cost) and the
 * payment (method, brand, USD amount, the VAT of the whole payment from its own journal), shows `note` as null when empty, and reads
 * `netAmount` and `taxAmount` from the refund's posted journal. Money is USD at the checkout's locked rate (B111); a refund whose
 * journal exists shows the journal's gateway amount, so a refund that closed a payment shows exactly what was posted.
 *
 * Side effects: none (reads only).
 */
@Injectable()
export class RefundViews {
  /**
   * Builds the rows.
   *
   * @param db the database or a transaction
   * @param refunds the stored refunds (storefront ones)
   * @returns the wire rows in the same order
   */
  async build(db: DbExecutor, refunds: readonly Refund[]): Promise<WireRefund[]> {
    if (refunds.length === 0) return [];
    const orderIds = refunds.flatMap((refund) => (refund.orderId === null ? [] : [refund.orderId]));
    // One after the other: `db` can be an open transaction, which runs one statement at a time.
    const payments = await loadOrderPayments(
      db,
      refunds.flatMap((refund) => (refund.paymentId === null ? [] : [refund.paymentId])),
    );
    const orders = await loadOrderFacts(db, orderIds);
    const sessions = await loadSessionMoney(db, orderIds);
    const customers = await loadBillingCustomers(
      db,
      refunds.flatMap((refund) => (refund.customerId === null ? [] : [refund.customerId])),
    );
    const journalIds = await ledgerTxIdsByKeys(
      db,
      refunds.flatMap((refund) => (refund.paymentId === null ? [] : [`payment:${refund.paymentId}:capture`])),
    );
    const parts = await ledgerPartsOf(db, [
      ...refunds.flatMap((refund) => (refund.ledgerTxId === null ? [] : [refund.ledgerTxId])),
      ...journalIds.values(),
    ]);
    const staff = [
      ...new Set(
        refunds.flatMap((refund) => [
          refund.approvedBy,
          refund.requestedByType === 'staff' ? refund.requestedById : null,
        ]),
      ),
    ]
      .filter((id): id is number => id !== null)
      .map((id) => ({ type: 'staff' as const, id }));
    const names = await loadActorNames(db, staff);

    return refunds.map((refund): WireRefund => {
      const payment = refund.paymentId === null ? undefined : payments.get(refund.paymentId);
      const order = refund.orderId === null ? undefined : orders.get(refund.orderId);
      const session = refund.orderId === null ? undefined : sessions.get(refund.orderId);
      const fx = session?.fxRate ?? '1';
      const posted = refund.ledgerTxId === null ? undefined : parts.get(refund.ledgerTxId);
      const paymentJournal =
        payment === undefined ? undefined : parts.get(journalIds.get(`payment:${payment.id}:capture`) ?? 0);
      const customer = refund.customerId === null ? undefined : customers.get(refund.customerId);
      const requestedName =
        refund.requestedByType === 'staff' && refund.requestedById !== null
          ? (names.get(ownerKey('staff', refund.requestedById)) ?? null)
          : refund.requestedByType === 'system'
            ? 'System'
            : null;
      return {
        id: refund.id,
        orderId: refund.orderId ?? 0,
        amount: posted
          ? Money.of(posted.gross).toWire()
          : wireUsd(
              Money.of(refund.amount),
              payment && session ? { amount: payment.amount, grossUsd: session.grossAmount } : undefined,
              fx,
            ).toWire(),
        reason: refund.reason,
        status: refund.status,
        method: refund.method,
        currency: refund.currency,
        fx,
        partial: payment ? Money.of(refund.amount).cmp(Money.of(payment.amount)) < 0 : false,
        gatewayRefundId: refund.gatewayRefundId,
        note: refund.note === '' ? null : refund.note,
        requestedBy: { type: refund.requestedByType, name: requestedName },
        approvedBy:
          refund.approvedBy === null
            ? null
            : { id: refund.approvedBy, name: names.get(ownerKey('staff', refund.approvedBy)) ?? '' },
        customer: customer ? { id: customer.id, name: customer.name || customer.email } : null,
        order: {
          id: refund.orderId ?? 0,
          deliveredAt: order?.status === 'completed' && order.completedAt ? order.completedAt.toISOString() : null,
          cost: Money.of(order?.totalCost ?? '0').toWire(),
        },
        payment: {
          id: payment?.id ?? 0,
          method: b2cPaymentMethod(payment?.methodType ?? 'card'),
          brand: payment?.brand ?? '',
          amount: Money.of(session?.grossAmount ?? payment?.amount ?? '0').toWire(),
          taxAmount: Money.of(paymentJournal?.vat ?? session?.taxAmount ?? '0').toWire(),
        },
        netAmount: posted ? Money.of(posted.net).toWire() : null,
        taxAmount: posted ? Money.of(posted.vat).toWire() : null,
        completedAt: refund.completedAt?.toISOString() ?? null,
        createdAt: refund.createdAt.toISOString(),
      };
    });
  }
}
