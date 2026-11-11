// PaymentCrediting: credits a pending wallet top-up in the caller's transaction: the `deposit` money event, the payment and invoice
// statuses, the `invoice.paid` outbox row and the audit entry. Staff approval and the automatic credit job both end here. A storefront
// customer's top-up (feature 21) credits the customer's store balance instead, with its own email and no merchant outbox row or PDF.
import { Inject, Injectable } from '@nestjs/common';
import { CLOCK, type Clock } from '../../../common/clock';
import { AppError } from '../../../common/errors';
import { Money } from '../../../common/money';
import type { DbExecutor } from '../../../infra/db';
import { AuditService } from '../../platform';
import type { Invoice, Payment, PaymentGateway } from '../db/schema';
import { customerTopup } from '../domain/customer-wallet-events';
import { METHOD_LABELS } from '../domain/gateway-rules';
import { paymentRef } from '../domain/invoice-rules';
import { confirmationMismatch } from '../domain/payment-rules';
import { deposit } from '../domain/money-events';
import { driverFor } from '../infra/gateway-drivers/drivers';
import { findWalletCustomer, loadBillingMerchants } from '../infra/foreign-directory.repository';
import { findInvoice, updateInvoice } from '../infra/invoice.repository';
import { updatePayment } from '../infra/payment.repository';
import { CustomerWalletMails } from './customer-wallet-mails';
import { LedgerPoster } from './post-transaction';
import { InvoiceDocuments } from './invoice-documents';
import { InvoiceOutbox } from './invoice-outbox';

/** Who decided a payment: a staff member, or the system (the automatic credit job). */
export type Reviewer = { readonly kind: 'staff'; readonly staffId: number } | { readonly kind: 'system' };

/** The transaction context a use case passes in. */
export interface CreditWork {
  readonly tx: DbExecutor;
  afterCommit(callback: () => void | Promise<void>): void;
}

/**
 * Credits a top-up.
 *
 * Why: user rules 3, 4 and 6 and RESOLUTIONS money-3: approving a deposit posts the map event `deposit` (Dr `bank` for a manual
 * gateway and Dr `gateway_clearing` for an automatic one, Cr `client_wallet` net, Cr `fee_income` fee), under the idempotency key
 * `deposit:payment:<id>`, so a staff approval and the job racing for the same payment post once; the caller has already locked the
 * payment row and checked it is pending, and this class locks the invoice next (lock order: payment, invoice, ledger accounts). It
 * marks the payment approved and the invoice paid, queues `invoice.paid` and audits the credit.
 *
 * Side effects: posts one ledger transaction; updates `payments` and `invoices`; inserts one `outbox_events` and one `audit_logs`
 * row; after the commit renders the paid invoice PDF.
 *
 * @see docs/contract/endpoints/money.md (POST /admin/payments/:id/approve)
 */
@Injectable()
export class PaymentCrediting {
  constructor(
    private readonly poster: LedgerPoster,
    private readonly audit: AuditService,
    private readonly outbox: InvoiceOutbox,
    private readonly documents: InvoiceDocuments,
    private readonly walletMails: CustomerWalletMails,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  /**
   * Credits the wallet of a pending top-up and pays its invoice.
   *
   * @param work the transaction and its after-commit hook
   * @param payment the payment, already locked and checked to be pending
   * @param gateway the gateway it came through
   * @param reviewer who decided
   * @throws {AppError} `CONFLICT` when the payment has no open merchant or customer invoice to pay, no positive net amount, or its gateway
   *   event says another amount or currency was paid than the invoice asked for (money that never arrived is never credited);
   *   `INSUFFICIENT_FUNDS` cannot happen for a credit
   */
  async credit(work: CreditWork, payment: Payment, gateway: PaymentGateway, reviewer: Reviewer): Promise<void> {
    const { tx } = work;
    const ref = paymentRef(payment.id);
    const invoice = payment.invoiceId === null ? undefined : await findInvoice(tx, payment.invoiceId, true);
    if (!invoice || (invoice.clientId === null && invoice.customerId === null)) {
      throw new AppError('CONFLICT', { detail: `${ref} has no merchant or customer invoice to credit.` });
    }
    if (invoice.status !== 'open') {
      throw new AppError('CONFLICT', { detail: `The invoice of ${ref} is already ${invoice.status}.` });
    }
    const mismatch = this.reportedMismatch(payment, gateway, invoice);
    if (mismatch) {
      throw new AppError('CONFLICT', {
        detail: `${ref} cannot be credited: ${mismatch} Reject it, then adjust the merchant's wallet by hand for what really arrived.`,
      });
    }
    const fee = Money.of(payment.feeAmount);
    const net = Money.of(payment.amount).sub(fee);
    if (!net.isPositive()) throw new AppError('CONFLICT', { detail: `${ref} does not cover its fee.` });

    const now = this.clock.now();
    const method = payment.methodType as keyof typeof METHOD_LABELS;
    if (invoice.clientId === null) {
      await this.creditCustomer(tx, { payment, gateway, reviewer, invoice, net, fee, now });
      return;
    }
    await this.poster.post(tx, {
      ...deposit({
        clientId: invoice.clientId,
        amount: net,
        fee,
        from: gateway.isManual ? 'bank' : 'gateway_clearing',
      }),
      refId: payment.id,
      idempotencyKey: `deposit:payment:${payment.id}`,
      currency: payment.currency,
      memo: `Deposit ${ref} (${METHOD_LABELS[method] ?? payment.methodType})`,
      createdBy: reviewer.kind === 'staff' ? { type: 'staff', id: reviewer.staffId } : { type: 'system', id: null },
    });
    await updatePayment(tx, payment.id, {
      status: 'approved',
      capturedAt: payment.capturedAt ?? now,
      reviewedBy: reviewer.kind === 'staff' ? reviewer.staffId : null,
      reviewedAt: now,
      autoCreditAt: null,
      updatedAt: now,
    });
    await updateInvoice(tx, invoice.id, { status: 'paid', paidAt: now, updatedAt: now });
    await this.outbox.paid(tx, { invoiceId: invoice.id, clientId: invoice.clientId });

    const merchant = (await loadBillingMerchants(tx, [invoice.clientId])).get(invoice.clientId);
    await this.audit.record(tx, {
      action: reviewer.kind === 'staff' ? 'approved deposit of' : 'credited deposit of',
      entityType: 'payment',
      entityId: payment.id,
      entityLabel: `${net.toWire()} ${payment.currency} from ${merchant?.name ?? `merchant ${invoice.clientId}`}`,
      before: { status: 'pending', invoice: invoice.number },
      after: { status: 'approved', invoice: invoice.number, netAmount: net.toWire(), feeAmount: fee.toWire() },
    });
    work.afterCommit(() => this.documents.render(invoice.id));
  }

  /**
   * Credits a storefront customer's top-up to the store balance.
   *
   * Why: plan 21 § 5.6.5: the same lock order and idempotency key as a merchant deposit (`deposit:payment:<id>`, payment ids are global),
   * the `customer_topup` event (kind `deposit`); no `invoice.paid` (a merchant webhook event) and no PDF (P5: stored value is not a taxable
   * sale). A credit is never refused, frozen wallet or switch off (plan § 5.1 invariant 4).
   *
   * Side effects: posts one ledger transaction (opening the wallet on its first credit); updates `payments` and `invoices`; one audit row;
   * one `wallet.topup_credited` mail.
   */
  private async creditCustomer(
    tx: DbExecutor,
    input: {
      payment: Payment;
      gateway: PaymentGateway;
      reviewer: Reviewer;
      invoice: Invoice;
      net: Money;
      fee: Money;
      now: Date;
    },
  ): Promise<void> {
    const { payment, gateway, reviewer, invoice, net, fee, now } = input;
    const customerId = invoice.customerId!;
    const ref = paymentRef(payment.id);
    const method = payment.methodType as keyof typeof METHOD_LABELS;
    const posted = await this.poster.post(tx, {
      ...customerTopup({ customerId, amount: net, fee, from: gateway.isManual ? 'bank' : 'gateway_clearing' }),
      refId: payment.id,
      idempotencyKey: `deposit:payment:${payment.id}`,
      currency: payment.currency,
      memo: `Deposit ${ref} (${METHOD_LABELS[method] ?? payment.methodType})`,
      createdBy: reviewer.kind === 'staff' ? { type: 'staff', id: reviewer.staffId } : { type: 'system', id: null },
    });
    await updatePayment(tx, payment.id, {
      status: 'approved',
      capturedAt: payment.capturedAt ?? now,
      reviewedBy: reviewer.kind === 'staff' ? reviewer.staffId : null,
      reviewedAt: now,
      autoCreditAt: null,
      updatedAt: now,
    });
    await updateInvoice(tx, invoice.id, { status: 'paid', paidAt: now, updatedAt: now });
    const customer = await findWalletCustomer(tx, customerId);
    await this.audit.record(tx, {
      action: reviewer.kind === 'staff' ? 'approved deposit of' : 'credited deposit of',
      entityType: 'payment',
      entityId: payment.id,
      entityLabel: `${net.toWire()} ${payment.currency} from ${customerLabel(customer, customerId)}`,
      before: { status: 'pending', invoice: invoice.number },
      after: { status: 'approved', invoice: invoice.number, netAmount: net.toWire(), feeAmount: fee.toWire() },
    });
    const wallet = posted.touched.find((account) => account.kind === 'customer_wallet');
    if (!posted.replayed && wallet) {
      await this.walletMails.topUpCredited(tx, {
        customerId,
        paymentId: payment.id,
        amount: net.toWire(),
        balance: wallet.after,
      });
    }
  }

  /**
   * Checks the stored gateway event of a payment against its invoice.
   *
   * Why: a payment row carries its invoice's amount and fee, so what the gateway really reported lives only in the stored event
   * (`raw`). A payment without one (a bank receipt: `raw` is empty) has nothing to check; an event the gateway's code can no
   * longer read counts as a mismatch, because the amount cannot be vouched for.
   *
   * @returns the reason the payment does not match its invoice, or `undefined`
   */
  private reportedMismatch(
    payment: Payment,
    gateway: PaymentGateway,
    invoice: { readonly amount: string; readonly currency: string },
  ): string | undefined {
    if (Object.keys(payment.raw).length === 0) return undefined;
    const event = driverFor(gateway.driver)?.parse(payment.raw);
    if (!event) return 'The gateway event of this payment can no longer be read, so its amount cannot be checked.';
    return confirmationMismatch(event, invoice);
  }
}

/**
 * How a deposit's audit label names a storefront customer: the name, else the email, else the number.
 *
 * @param customer the customer row, if it exists
 * @param id the customer id
 * @returns the label
 */
export function customerLabel(
  customer: { name: string; email: string; status: string } | undefined,
  id: number,
): string {
  if (!customer || customer.status === 'anonymized') return `customer ${id}`;
  return customer.name.trim() || customer.email;
}
