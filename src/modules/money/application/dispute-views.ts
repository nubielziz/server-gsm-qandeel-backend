// DisputeViews: turns stored disputes into the rows the console's Refunds page reads (feature 16) and builds the evidence pack of a dispute
// from the payment, the order, the consents, the buyer's history and their support contacts.
import { Injectable } from '@nestjs/common';
import type { ResultOf } from '../../../common/contract';
import { type CustomerContact, customerEmailIn, customerNameForStaff } from '../../../common/customer-contact';
import { Money } from '../../../common/money';
import type { DbExecutor } from '../../../infra/db';
import type { Dispute } from '../db/schema';
import { toUsd, wireUsd } from '../domain/b2c-money';
import { type EvidencePack, buildEvidencePack, disputeNote } from '../domain/dispute-rules';
import { wholeCents } from '../domain/refund-rules';
import { loadEvidenceFacts, loadOrderFacts, loadSessionMoney } from '../infra/b2c-reads.repository';
import { loadBillingMerchants } from '../infra/foreign-directory.repository';
import { loadOrderPayments } from '../infra/order-payment.repository';
import type { getDispute } from '../contracts/disputes.contracts';

/** One dispute as the routes answer. */
export type WireDispute = ResultOf<typeof getDispute>;

/**
 * Builds the wire rows of disputes and their evidence packs.
 *
 * Why: B84 and ANSWERS refunds Q5 and Q8: the note is derived from the reason code, the fee is the dispute's own, `fx` is the rate locked
 * on the checkout the order came from; money is USD at that rate (B111). The list leaves the pack out; the single read carries it.
 *
 * Side effects: none (reads only).
 */
@Injectable()
export class DisputeViews {
  /**
   * Builds the evidence pack of a dispute.
   *
   * @param db the database or a transaction
   * @param dispute the dispute
   * @param contact how the checkout's address is written into the delivery line (decision 047): `masked` is the pack staff read;
   *   `full` is the text sent to the gateway, which must name the buyer
   * @returns the six lines and how strong the case is
   */
  async pack(db: DbExecutor, dispute: Dispute, contact: CustomerContact = 'masked'): Promise<EvidencePack> {
    const [payment] = [...(await loadOrderPayments(db, [dispute.paymentId])).values()];
    const orderId = dispute.orderId ?? payment?.orderId ?? null;
    const order = orderId === null ? undefined : (await loadOrderFacts(db, [orderId])).get(orderId);
    const session = orderId === null ? undefined : (await loadSessionMoney(db, [orderId])).get(orderId);
    // The buyer is the dispute's account, of any rank (decision 064; `disputes.account_id` is never empty): the history is its own.
    const facts = order
      ? await loadEvidenceFacts(db, {
          id: order.id,
          accountId: dispute.accountId,
          sessionId: order.checkoutSessionId,
          placedAt: order.placedAt,
        })
      : { consents: [], priorPaidOrders: 0, tickets: [] };
    return buildEvidencePack({
      payment: {
        brand: payment?.brand ?? '',
        paid: `$${wholeCents(Money.of(session?.grossAmount ?? '0'))}`,
        capturedAt: payment?.capturedAt ?? null,
        reference: payment?.gatewayTxnId ?? '',
        threeDs: payment?.threeDs ?? false,
      },
      order: {
        deliveredAt: order?.status === 'completed' ? order.completedAt : null,
        resultCode: order?.resultCode ?? null,
        email: customerEmailIn(contact, session?.email ?? ''),
      },
      consents: facts.consents.map((consent) => ({
        purpose: consent.purpose,
        documentType: consent.documentType,
        version: consent.version,
        ip: consent.ip,
      })),
      priorPaidOrders: facts.priorPaidOrders,
      tickets: facts.tickets,
    });
  }

  /**
   * Builds the rows.
   *
   * @param db the database or a transaction
   * @param disputes the stored disputes
   * @param withPack true for the single read: each row then carries `evidence` and `strength`
   * @returns the wire rows in the same order
   */
  async build(db: DbExecutor, disputes: readonly Dispute[], withPack: boolean): Promise<WireDispute[]> {
    if (disputes.length === 0) return [];
    const orderIds = disputes.flatMap((dispute) => (dispute.orderId === null ? [] : [dispute.orderId]));
    // One after the other: `db` can be an open transaction, which runs one statement at a time.
    const sessions = await loadSessionMoney(db, orderIds);
    const buyers = await loadBillingMerchants(
      db,
      disputes.map((dispute) => dispute.accountId),
    );
    const payments = await loadOrderPayments(
      db,
      disputes.map((dispute) => dispute.paymentId),
    );
    const rows: WireDispute[] = [];
    for (const dispute of disputes) {
      const session = dispute.orderId === null ? undefined : sessions.get(dispute.orderId);
      const payment = payments.get(dispute.paymentId);
      const fx = session?.fxRate ?? '1';
      const whole = payment && session ? { amount: payment.amount, grossUsd: session.grossAmount } : undefined;
      const buyer = buyers.get(dispute.accountId);
      // The pack staff read shows the address masked (rule B); the pack sent to the gateway keeps it in full (`submitEvidence`).
      const pack = withPack ? await this.pack(db, dispute, 'masked') : undefined;
      rows.push({
        id: dispute.id,
        orderId: dispute.orderId ?? 0,
        amount: wireUsd(Money.of(dispute.amount), whole, fx).toWire(),
        fee: toUsd(Money.of(dispute.fee), fx).toWire(),
        reasonCode: dispute.reasonCode,
        note: disputeNote(dispute.reasonCode),
        status: dispute.status,
        currency: dispute.currency,
        fx,
        // Decision 047, rule B: an account without a name is labelled by the masked address, for every caller. The wire calls the buyer
        // `customer`; its id is the account id.
        customer: buyer ? { id: buyer.id, name: customerNameForStaff(buyer.name, buyer.email) } : null,
        evidenceDueAt: dispute.evidenceDueAt.toISOString(),
        submittedAt: dispute.submittedAt?.toISOString() ?? null,
        resolvedAt: dispute.resolvedAt?.toISOString() ?? null,
        createdAt: dispute.createdAt.toISOString(),
        ...(pack ? { strength: pack.strength, evidence: pack.items.map((item) => ({ ...item })) } : {}),
      });
    }
    return rows;
  }
}
