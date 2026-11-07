// PaymentReviewService: the staff routes on wallet top-ups (map routes /admin/payments*): list, read, approve and reject.
import { Inject, Injectable } from '@nestjs/common';
import { CLOCK, type Clock } from '../../../common/clock';
import type { ParsedListQuery } from '../../../common/contract';
import { AppError } from '../../../common/errors';
import { Money } from '../../../common/money';
import { DbService } from '../../../infra/db';
import { AuditService } from '../../platform';
import { paymentRef } from '../domain/invoice-rules';
import { reviewRefusal } from '../domain/payment-rules';
import { loadBillingMerchants } from '../infra/foreign-directory.repository';
import { findGateway } from '../infra/gateway.repository';
import { findInvoice, updateInvoice } from '../infra/invoice.repository';
import {
  type PaymentSortField,
  findTopupPayment,
  listPaymentRows,
  lockTopupPayment,
  updatePayment,
} from '../infra/payment.repository';
import type { WirePayment } from './billing-wire';
import { PaymentCrediting } from './payment-crediting';
import { PaymentViews } from './payment-views';

/** The longest rejection reason (what the merchant is shown). */
export const MAX_REJECT_REASON = 500;

const notFound = () => new AppError('NOT_FOUND', { detail: 'No top-up payment has this id.' });

/**
 * Lists, reads, approves and rejects wallet top-ups.
 *
 * Why: manual gateways (bank, Wise) keep staff review (user rule 4) and an automatic gateway's payment that the job or risk sent to
 * review (user rule 6) waits here too. Both decisions lock the payment row first and re-check it under the lock (RESOLUTIONS
 * money-3), so a staff decision racing the automatic credit or another staff member changes nothing: the loser gets
 * `409 PAYMENT_ALREADY_REVIEWED`. An order (storefront) payment is not served here (money-2).
 *
 * Side effects: `approve` posts the deposit and writes payment, invoice, outbox and audit rows (see {@link PaymentCrediting});
 * `reject` updates the payment, voids a top-up invoice and writes an audit row.
 *
 * @see docs/contract/endpoints/money.md (GET /admin/payments, POST /admin/payments/:id/approve|reject)
 */
@Injectable()
export class PaymentReviewService {
  constructor(
    private readonly db: DbService,
    private readonly views: PaymentViews,
    private readonly crediting: PaymentCrediting,
    private readonly audit: AuditService,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  /**
   * Lists top-ups.
   *
   * @param query the parsed list request
   * @returns the page and the number matching the filters
   */
  async list(query: ParsedListQuery<PaymentSortField>): Promise<{ rows: WirePayment[]; total: number }> {
    const { rows, total } = await listPaymentRows(this.db.db, query);
    return { rows: await this.views.build(this.db.db, rows), total };
  }

  /**
   * Reads one top-up.
   *
   * @param id the payment id
   * @returns the payment
   * @throws {AppError} `NOT_FOUND` for an unknown id or an order payment
   */
  async get(id: number): Promise<WirePayment> {
    const row = await findTopupPayment(this.db.db, id);
    if (!row) throw notFound();
    return (await this.views.build(this.db.db, [row]))[0]!;
  }

  /**
   * Approves a top-up and credits the wallet.
   *
   * @param staffId the staff member who decides
   * @param id the payment id
   * @returns the payment after the decision, with the wallet balance that already includes the credit
   * @throws {AppError} `NOT_FOUND`; `PAYMENT_ALREADY_REVIEWED` when it is not pending; `PAYMENT_AUTO_CREDIT_PENDING` when its
   *   gateway is automatic and it was not sent to review; `CONFLICT` when its invoice is no longer open
   */
  async approve(staffId: number, id: number): Promise<WirePayment> {
    await this.db.runInTransaction(async (work) => {
      const { payment, gateway } = await this.lockForReview(work.tx, id);
      await this.crediting.credit(work, payment, gateway, { kind: 'staff', staffId });
    });
    return this.get(id);
  }

  /**
   * Rejects a top-up with the reason the merchant sees.
   *
   * @param staffId the staff member who decides
   * @param id the payment id
   * @param reason why, as the merchant reads it
   * @returns the payment after the decision (its note is the reason)
   * @throws {AppError} `VALIDATION_FAILED` for an empty or too long reason; `NOT_FOUND`; `PAYMENT_ALREADY_REVIEWED`;
   *   `PAYMENT_AUTO_CREDIT_PENDING`
   */
  async reject(staffId: number, id: number, reason: string): Promise<WirePayment> {
    if (reason === '' || reason.length > MAX_REJECT_REASON) {
      throw new AppError('VALIDATION_FAILED', {
        errors: [
          {
            field: 'reason',
            code: reason === '' ? 'required' : 'length',
            message:
              reason === '' ? 'Enter the reason.' : `Keep the reason to ${MAX_REJECT_REASON} characters or fewer.`,
          },
        ],
      });
    }
    await this.db.runInTransaction(async ({ tx }) => {
      const { payment } = await this.lockForReview(tx, id);
      const now = this.clock.now();
      await updatePayment(tx, id, {
        status: 'rejected',
        reviewNote: reason,
        reviewedBy: staffId,
        reviewedAt: now,
        autoCreditAt: null,
        updatedAt: now,
      });
      const invoice = payment.invoiceId === null ? undefined : await findInvoice(tx, payment.invoiceId, true);
      // A top-up invoice dies with its rejected payment; a staff-issued invoice stays open for another receipt.
      if (invoice && invoice.status === 'open' && invoice.kind === 'topup') {
        await updateInvoice(tx, invoice.id, { status: 'void', updatedAt: now });
      }
      const merchant = invoice?.clientId
        ? (await loadBillingMerchants(tx, [invoice.clientId])).get(invoice.clientId)
        : undefined;
      await this.audit.record(tx, {
        action: 'rejected deposit of',
        entityType: 'payment',
        entityId: id,
        entityLabel: `${Money.of(payment.amount).toWire()} ${payment.currency} from ${merchant?.name ?? 'a merchant'}`,
        before: { status: 'pending' },
        after: { status: 'rejected', reason },
      });
    });
    return this.get(id);
  }

  /** Locks a top-up and refuses a decision that is not allowed now (not pending; automatic and not sent to review). */
  private async lockForReview(tx: Parameters<typeof lockTopupPayment>[0], id: number) {
    const payment = await lockTopupPayment(tx, id);
    if (!payment) throw notFound();
    const gateway = await findGateway(tx, payment.gatewayId);
    if (!gateway) throw new Error(`Payment ${paymentRef(id)} points at a gateway that does not exist.`);
    const refusal = reviewRefusal(payment, gateway);
    if (refusal) throw new AppError(refusal.code, { detail: refusal.detail });
    return { payment, gateway };
  }
}
