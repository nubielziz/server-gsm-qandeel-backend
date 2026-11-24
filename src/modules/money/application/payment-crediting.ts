// PaymentCrediting: credits a pending wallet top-up in the caller's transaction: the `deposit` money event, the payment and invoice
// statuses, the `invoice.paid` outbox row and the audit entry. Staff approval and the automatic credit job both end here. The top-up is
// credited to the live wallet of its account, whatever the rank kind (decision 064): a merchant wallet through the `deposit` event, a
// store balance through `customer_topup` with its own email and no merchant outbox row or PDF.
import { Inject, Injectable } from '@nestjs/common';
import { CLOCK, type Clock } from '../../../common/clock';
import { AppError } from '../../../common/errors';
import { Money } from '../../../common/money';
import type { DbExecutor } from '../../../infra/db';
import { AccountDirectory, type AccountRecord } from '../../identity';
import { AuditService } from '../../platform';
import type { Invoice, Payment, PaymentGateway } from '../db/schema';
import { customerTopup } from '../domain/customer-wallet-events';
import { METHOD_LABELS } from '../domain/gateway-rules';
import { paymentRef } from '../domain/invoice-rules';
import { deposit } from '../domain/money-events';
import { accountLabel, confirmationMismatch, creditPlan } from '../domain/payment-rules';
import { walletKindOfRank } from '../domain/wallet-kinds';
import { driverFor } from '../infra/gateway-drivers/drivers';
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

/** What the credit of either wallet kind needs. */
interface CreditInput {
  readonly payment: Payment;
  readonly gateway: PaymentGateway;
  readonly reviewer: Reviewer;
  readonly invoice: Invoice;
  /** The account that owns the invoice, read under its row lock. */
  readonly account: AccountRecord;
  readonly net: Money;
  readonly fee: Money;
  readonly now: Date;
  /** What the audit row adds when the invoice named the other wallet kind than the live one (decision 064). */
  readonly crossing: Readonly<Record<string, string>>;
}

/**
 * Credits a top-up.
 *
 * Why: user rules 3, 4 and 6 and RESOLUTIONS money-3: approving a deposit posts the map event `deposit` (Dr `bank` for a manual
 * gateway and Dr `gateway_clearing` for an automatic one, Cr `client_wallet` net, Cr `fee_income` fee), under the idempotency key
 * `deposit:payment:<id>`, so a staff approval and the job racing for the same payment post once; the caller has already locked the
 * payment row and checked it is pending, and this class locks the invoice next, then the account row `FOR KEY SHARE` (lock order:
 * payment, invoice, account, ledger accounts: decision 064). The kind of the live wallet is read under that lock, so a rank change that
 * races this credit either commits first (the credit lands on the new wallet) or waits for it; a credit is never refused for the kind. It
 * marks the payment approved and the invoice paid, queues `invoice.paid` and audits the credit.
 *
 * Side effects: posts one ledger transaction; updates `payments` and `invoices`; inserts one `outbox_events` and one `audit_logs`
 * row (a merchant wallet) or one `wallet.topup_credited` notification (a store balance); after the commit renders the paid invoice PDF
 * (a merchant wallet).
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
    private readonly accounts: AccountDirectory,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  /**
   * Credits the live wallet of a pending top-up's account and pays its invoice.
   *
   * @param work the transaction and its after-commit hook
   * @param payment the payment, already locked and checked to be pending
   * @param gateway the gateway it came through
   * @param reviewer who decided
   * @throws {AppError} `CONFLICT` when the payment has no open top-up invoice to pay, no positive net amount, or its gateway
   *   event says another amount or currency was paid than the invoice asked for (money that never arrived is never credited);
   *   `INSUFFICIENT_FUNDS` cannot happen for a credit
   */
  async credit(work: CreditWork, payment: Payment, gateway: PaymentGateway, reviewer: Reviewer): Promise<void> {
    const { tx } = work;
    const ref = paymentRef(payment.id);
    const invoice = payment.invoiceId === null ? undefined : await findInvoice(tx, payment.invoiceId, true);
    // A top-up or manual invoice names the wallet it fills; a receipt or a statement names none and is never paid by a top-up.
    if (!invoice || invoice.walletKind === null) {
      throw new AppError('CONFLICT', { detail: `${ref} has no top-up invoice to credit.` });
    }
    if (invoice.status !== 'open') {
      throw new AppError('CONFLICT', { detail: `The invoice of ${ref} is already ${invoice.status}.` });
    }
    const mismatch = this.reportedMismatch(payment, gateway, invoice);
    if (mismatch) {
      throw new AppError('CONFLICT', {
        detail: `${ref} cannot be credited: ${mismatch} Reject it, then adjust the account's wallet by hand for what really arrived.`,
      });
    }
    const fee = Money.of(payment.feeAmount);
    const net = Money.of(payment.amount).sub(fee);
    if (!net.isPositive()) throw new AppError('CONFLICT', { detail: `${ref} does not cover its fee.` });

    // The account row after the payment and the invoice (the named exception of the lock order): the rank change and the status writers
    // never lock these rows, so no cycle can form. The rank kind is read only now that the lock is held.
    const account = await this.accounts.lockForKeyShare(tx, invoice.accountId);
    if (!account) throw new AppError('CONFLICT', { detail: `The account of ${ref} no longer exists.` });
    const plan = creditPlan(walletKindOfRank(account.rankKind), invoice.walletKind);
    const input: CreditInput = {
      payment,
      gateway,
      reviewer,
      invoice,
      account,
      net,
      fee,
      now: this.clock.now(),
      crossing: plan.crossed ? { invoiceWallet: invoice.walletKind, creditedWallet: plan.wallet } : {},
    };
    if (plan.wallet === 'client_wallet') await this.creditMerchantWallet(work, input);
    else await this.creditStoreBalance(tx, input);
  }

  /**
   * Credits a merchant wallet.
   *
   * Why: the map's `deposit` event; the invoice is paid, `invoice.paid` tells the account and the PDF of the paid invoice renders after
   * the commit.
   *
   * Side effects: posts one ledger transaction; updates `payments` and `invoices`; one `outbox_events` and one `audit_logs` row; the PDF
   * after the commit.
   */
  private async creditMerchantWallet(work: CreditWork, input: CreditInput): Promise<void> {
    const { tx } = work;
    const { payment, gateway, reviewer, invoice, account, net, fee } = input;
    const ref = paymentRef(payment.id);
    const method = payment.methodType as keyof typeof METHOD_LABELS;
    await this.poster.post(tx, {
      ...deposit({
        clientId: account.id,
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
    await this.markPaid(tx, input);
    await this.outbox.paid(tx, { invoiceId: invoice.id, clientId: account.id });
    await this.audit.record(tx, {
      action: reviewer.kind === 'staff' ? 'approved deposit of' : 'credited deposit of',
      entityType: 'payment',
      entityId: payment.id,
      entityLabel: `${net.toWire()} ${payment.currency} from ${account.name || `merchant ${account.id}`}`,
      before: { status: 'pending', invoice: invoice.number },
      after: {
        status: 'approved',
        invoice: invoice.number,
        netAmount: net.toWire(),
        feeAmount: fee.toWire(),
        ...input.crossing,
      },
    });
    work.afterCommit(() => this.documents.render(invoice.id));
  }

  /**
   * Credits an account's store balance.
   *
   * Why: plan 21 § 5.6.5: the same lock order and idempotency key as a merchant deposit (`deposit:payment:<id>`, payment ids are global),
   * the `customer_topup` event (kind `deposit`); no `invoice.paid` (a merchant event) and no PDF (P5: stored value is not a taxable
   * sale). A credit is never refused, frozen wallet or switch off (plan § 5.1 invariant 4).
   *
   * Side effects: posts one ledger transaction (opening the wallet on its first credit); updates `payments` and `invoices`; one audit row;
   * one `wallet.topup_credited` mail.
   */
  private async creditStoreBalance(tx: DbExecutor, input: CreditInput): Promise<void> {
    const { payment, gateway, reviewer, invoice, account, net, fee } = input;
    const ref = paymentRef(payment.id);
    const method = payment.methodType as keyof typeof METHOD_LABELS;
    const posted = await this.poster.post(tx, {
      ...customerTopup({
        customerId: account.id,
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
    await this.markPaid(tx, input);
    await this.audit.record(tx, {
      action: reviewer.kind === 'staff' ? 'approved deposit of' : 'credited deposit of',
      entityType: 'payment',
      entityId: payment.id,
      entityLabel: `${net.toWire()} ${payment.currency} from ${accountLabel(account, account.id)}`,
      before: { status: 'pending', invoice: invoice.number },
      after: {
        status: 'approved',
        invoice: invoice.number,
        netAmount: net.toWire(),
        feeAmount: fee.toWire(),
        ...input.crossing,
      },
    });
    const wallet = posted.touched.find((line) => line.kind === 'customer_wallet');
    if (!posted.replayed && wallet) {
      await this.walletMails.topUpCredited(tx, {
        customerId: account.id,
        paymentId: payment.id,
        amount: net.toWire(),
        balance: wallet.after,
      });
    }
  }

  /** Marks the payment approved and its invoice paid (the same two writes for either wallet kind). */
  private async markPaid(tx: DbExecutor, input: CreditInput): Promise<void> {
    const { payment, reviewer, invoice, now } = input;
    await updatePayment(tx, payment.id, {
      status: 'approved',
      capturedAt: payment.capturedAt ?? now,
      reviewedBy: reviewer.kind === 'staff' ? reviewer.staffId : null,
      reviewedAt: now,
      autoCreditAt: null,
      updatedAt: now,
    });
    await updateInvoice(tx, invoice.id, { status: 'paid', paidAt: now, updatedAt: now });
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
