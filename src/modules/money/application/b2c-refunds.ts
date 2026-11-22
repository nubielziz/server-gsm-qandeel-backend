// B2cRefunds: the money side of every storefront refund (feature 16). It works out what can still go back on a payment, posts the
// `b2c_refund` journal (from customer funds before delivery, from revenue after it; to the store balance for a balance payment, feature
// 21), opens the refund the system creates when a paid order is rejected, and moves a refund to completed or failed. Used by the order
// engine (a rejection), the refund routes and the gateway's answers.
import { Inject, Injectable } from '@nestjs/common';
import { CLOCK, type Clock } from '../../../common/clock';
import { Money } from '../../../common/money';
import type { DbExecutor } from '../../../infra/db';
import type { OrderMethod, Payment, PaymentGateway, Refund, RefundStatus } from '../db/schema';
import { refundSplit, statusAfterRefunds, storedOrderMethod, toUsd } from '../domain/b2c-money';
import { b2cWalletRefund } from '../domain/customer-wallet-events';
import { type AccountRef, reversalLines } from '../domain/ledger-lines';
import { b2cRefund } from '../domain/money-events';
import {
  AUTO_REFUND_REASON,
  AUTO_RETURN_REASON,
  CHARGEBACK_NOT_SENT_NOTE,
  closesAtChargeback,
  refundRoute,
  settlesAtOnce,
} from '../domain/refund-rules';
import { type LedgerParts, ledgerPartsOf, loadSessionMoney } from '../infra/b2c-reads.repository';
import { findReversibleJournal } from '../infra/ledger-read.repository';
import { findCurrencyByCode } from '../infra/storefront-money.repository';
import { driverFor } from '../infra/gateway-drivers/drivers';
import { findGateway } from '../infra/gateway.repository';
import {
  findOrderPayment,
  findPaymentOfOrder,
  lockOrderPayment,
  updateOrderPayment,
} from '../infra/order-payment.repository';
import {
  failProcessingRefund,
  findRefund,
  insertRefund,
  lockRefund,
  refundsOfPayment,
  takenRefundsOfPayment,
  updateRefund,
  updateRefundIn,
} from '../infra/refund.repository';
import { LedgerPoster } from './post-transaction';
import { RefundOutbox } from './refund-outbox';
import type { RefundedOrder } from './storefront-ports';

/** Who causes a refund posting. */
export interface RefundActor {
  readonly type: 'staff' | 'client' | 'customer' | 'system';
  readonly id: number | null;
}

/** What {@link B2cRefunds.onOrderRefund} did, in the shape the order ledger reports a move. */
export interface RefundPosting {
  /** True when a journal was written. */
  readonly posted: boolean;
  /** What went back (gross, USD, 4 decimals). */
  readonly amount: string;
  /** The ledger transaction, when one was written. */
  readonly ledgerTxId: number | null;
  /** The refund row that carries it, when the order had a payment. */
  readonly refundId: number | null;
  /** True when no money went back and a refund request waits for staff instead (`mode: 'request'`); `amount` is what the request asks for. */
  readonly requested: boolean;
  /**
   * True when the payment is disputed or charged back with the card network: nothing went back and a refund request waits for staff
   * (decision 048).
   */
  readonly disputed: boolean;
}

/** What the system does with a rejected paid order: refund it now, or open a request for staff to approve. */
export type AutoRefundMode = 'refund' | 'request';

/** What can still go back on a payment, in its currency and in USD. */
export interface RefundLeft {
  readonly original: Money;
  readonly usd: Money;
  readonly paidUsd: Money;
  readonly taxUsd: Money;
  /** The VAT the earlier refunds already took back. */
  readonly vatTaken: Money;
  /** The locked rate (units of the payment currency per USD). */
  readonly fxRate: string;
}

const sumMoney = (values: Iterable<string>): Money => Money.sum([...values].map((value) => Money.of(value)));

/**
 * Posts and settles storefront refunds.
 *
 * Why: RESOLUTIONS money-4, money-5, money-11, money-12 and decision 024: one refund is one `b2c_refund` ledger transaction (key
 * `refund:<id>`, or `order:<id>:refund` for the one the system opens when it rejects a paid order), posted once at approval, never
 * at retry (B83); the gateway call is a job. A refund that takes everything left on a payment takes exactly the USD and the VAT that
 * are left, so rounding never leaves dust in customer funds or VAT payable. A payment's status follows its completed refunds.
 *
 * Side effects (on the caller's transaction): inserts and updates `refunds`, updates `payments`, writes ledger rows through
 * `LedgerPoster` and one `refund.process` outbox row for a refund the gateway must send.
 *
 * @see docs/contract/RESOLUTIONS.md (money-4, money-5, money-11, money-12)
 */
@Injectable()
export class B2cRefunds {
  constructor(
    private readonly poster: LedgerPoster,
    private readonly outbox: RefundOutbox,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  /**
   * Reverses the money of a storefront order that is being refunded through the order engine.
   *
   * Why: the order machine's `b2c_refund` move (a reject, a supplier rejection, a risk refund, an approved refund of an open order).
   * With a payment on record the whole of what is left goes back and a refund row records it; without one (an order that was not paid
   * through feature 16) only the journal is posted, as feature 5 did. The payment is the one the approved refund names; for a rejection
   * it is the one linked to the order's first receipt invoice, never a duplicate payment that was refunded when it arrived.
   * `mode: 'request'` is the `autoRefundFailed` switch off (RULES settings 5): the system rejected the order but sends nothing by itself, so a
   * refund request for everything that is left (`requested`, requested by the system) waits for staff and no journal is posted; approving it
   * later posts the journal from customer funds, as an automatic refund would have. Without a payment row the journal-only path stays (there
   * is no payment a request could name). Decision 048: a payment the buyer disputed with the card network (`disputed` or `chargeback`) is
   * never paid out by a rejection or a risk refund: the request mode runs whatever the caller asked, and the posting says `disputed`.
   *
   * @param tx the transition's transaction
   * @param input the order after the guarded update, who acts, the refund being paid out when an approval drives the move, and what the
   *   system does with a rejection (`refund` by default)
   * @returns what was posted, or the request that was opened
   */
  async onOrderRefund(
    tx: DbExecutor,
    input: { order: RefundedOrder; actor: RefundActor; refundId?: number | undefined; mode?: AutoRefundMode },
  ): Promise<RefundPosting> {
    const { order, actor } = input;
    // An approved refund names its own payment (an order can have a duplicate payment too); a rejection takes the one that paid the order.
    const named = input.refundId === undefined ? undefined : await findRefund(tx, input.refundId);
    if (input.refundId !== undefined && !named) throw new Error(`Refund ${input.refundId} does not exist.`);
    const namedPaymentId = named?.paymentId ?? null;
    const payment =
      namedPaymentId === null ? await findPaymentOfOrder(tx, order.id) : await findOrderPayment(tx, namedPaymentId);
    if (!payment) return this.legacy(tx, order, actor);
    // Lock order: the order (the transition's guarded update took it), then the payment, then the refund, then the ledger accounts.
    const locked = await lockOrderPayment(tx, payment.id);
    if (!locked) throw new Error(`Payment ${payment.id} does not exist.`);
    // Money the buyer disputed with the card network never goes back by itself; staff decide once the dispute is closed (decision 048).
    const disputed = locked.status === 'disputed' || locked.status === 'chargeback';
    if (input.refundId === undefined && (input.mode === 'request' || disputed)) {
      return this.openRequest(tx, order, locked, disputed);
    }
    let refund: Refund;
    if (input.refundId === undefined) {
      const opened = await this.openAutomatic(tx, order, locked, actor);
      if (!opened) {
        return {
          posted: false,
          amount: Money.zero().toWire(),
          ledgerTxId: null,
          refundId: null,
          requested: false,
          disputed: false,
        };
      }
      refund = opened;
    } else {
      const locked = await lockRefund(tx, input.refundId);
      if (!locked) throw new Error(`Refund ${input.refundId} does not exist.`);
      refund = locked;
    }
    const posted = await this.postLedger(tx, {
      order,
      payment: locked,
      refund,
      from: 'customer_funds',
      key: input.refundId === undefined ? `order:${order.id}:refund` : `refund:${refund.id}`,
      actor,
    });
    if (input.refundId === undefined) await this.dispatchAutomatic(tx, refund, locked);
    return {
      posted: true,
      amount: posted.gross,
      ledgerTxId: posted.id,
      refundId: refund.id,
      requested: false,
      disputed: false,
    };
  }

  /**
   * Tells whether a payment's money can go back through its gateway by itself.
   *
   * Why: decision 048: a held confirmation and a late payment are sent back at once only when the gateway can refund (a card or wallet
   * payment, refunds switched on, a driver that refunds); otherwise staff pay them back by hand.
   *
   * @param payment the payment
   * @param gateway its gateway row, if it still exists
   * @param method the payment's method as the confirmation shows it (`card`, `wallet` or `crypto`)
   * @returns true when the refund route is `original` through the gateway
   */
  sendsBack(payment: Payment, gateway: PaymentGateway | undefined, method: OrderMethod): boolean {
    return payment.methodType !== 'balance' && refundRoute(method, this.capability(gateway)).method === 'original';
  }

  /**
   * Sends a held storefront payment back in full through its gateway: a refund without an order.
   *
   * Why: decision 048: a confirmation that cannot pay its checkout (another amount or currency, no stated amount, no checkout) is money
   * that arrived without an order; when the gateway can refund it, it goes back at once. The row names the payment only (`order_id` and
   * `customer_id` stay empty, so the Refunds page and the reports leave it out); the refund job sends and settles it. No journal is posted:
   * the money never entered the books.
   *
   * Side effects: inserts one `refunds` row (`processing`, requested by the system) and one `refund.process` outbox row.
   *
   * @param tx the capture's transaction (the payment is locked)
   * @param input the payment, its gateway, its method, and the amount and currency the gateway's record says it collected
   * @returns the refund, or `undefined` when the payment cannot go back by itself, the amount is not above zero, the payment already has a
   *   refund or the currency is not one of the shop's
   */
  async openReturn(
    tx: DbExecutor,
    input: { payment: Payment; gateway: PaymentGateway; method: OrderMethod; amount: Money; currency: string },
  ): Promise<Refund | undefined> {
    const { payment } = input;
    if (!this.sendsBack(payment, input.gateway, input.method) || !input.amount.isPositive()) return undefined;
    if ((await refundsOfPayment(tx, payment.id)).length > 0) return undefined;
    if (!(await findCurrencyByCode(tx, input.currency))) return undefined;
    const now = this.clock.now();
    const refund = await insertRefund(tx, {
      paymentId: payment.id,
      orderId: null,
      customerId: null,
      amount: input.amount.toWire(),
      currency: input.currency,
      reason: AUTO_RETURN_REASON,
      method: 'original',
      status: 'processing',
      requestedByType: 'system',
      requestedById: null,
      createdAt: now,
      updatedAt: now,
    });
    await this.outbox.refund(tx, refund.id);
    return refund;
  }

  /**
   * Closes the refunds of a charged-back payment that the gateway has not paid, and reverses their journals.
   *
   * Why: decision 048: refunds of a disputed payment are not sent, so a refund can be booked while the card network takes the same money
   * back. When the chargeback is booked, every refund of the payment that has not completed at the gateway ({@link closesAtChargeback}:
   * `requested`, `processing` without a gateway id, or `failed`, also one whose last send got no answer) becomes `rejected` with the
   * note {@link CHARGEBACK_NOT_SENT_NOTE} (a guarded update under the refund's lock), and the journal it had posted is reversed in the
   * same transaction (append-only: a mirrored transaction, key `reverse:<journal id>`), so the books show the money leaving once. A refund
   * the gateway completed stays (the gateway paid both), and so does one the gateway has acknowledged and not answered yet (`processing`
   * with a gateway id): its result comes from the gateway.
   *
   * Lock order: the payment (the caller's), then only the refunds that qualify, in id order: they are read first without a lock, and each
   * is checked again under its lock; a refund this will not close is never locked. The refund settlement (`RefundSettlement.settle`) takes
   * the same order (the payment, then the refund) and closes, the same way, a refund the gateway fails after the chargeback. Should the
   * database still end one of the transactions (a deadlock), nothing of it is written and the gateway delivers its event again (the dispute
   * webhook answers `503 UNAVAILABLE` for it; a settlement from the refund job is retried by the queue).
   *
   * Side effects (on the caller's transaction): updates `refunds`; one ledger transaction per reversed journal.
   *
   * @param tx the chargeback's transaction (the payment is locked; lock order: the payment, each refund closed, the ledger accounts)
   * @param payment the charged-back payment
   * @param actor who booked the chargeback (staff accepting the loss, or the system for the gateway's decision)
   * @returns the refunds that were closed
   */
  async closeNotSent(tx: DbExecutor, payment: Payment, actor: RefundActor): Promise<Refund[]> {
    const closed: Refund[] = [];
    // Read first, then lock only what qualifies, in id order (`refundsOfPayment` is ordered by id); re-checked under each lock.
    const closing = (await refundsOfPayment(tx, payment.id)).filter(closesAtChargeback);
    for (const candidate of closing) {
      const refund = await lockRefund(tx, candidate.id);
      if (!refund || !closesAtChargeback(refund)) continue;
      const done = await this.closeUnsent(tx, refund, actor);
      if (done) closed.push(done);
    }
    return closed;
  }

  /**
   * Closes one refund of a charged-back payment unsent and reverses the journal it had posted.
   *
   * Why: decision 048: the card network returned the payment, so a refund the gateway has not paid would return the same money a second
   * time; the refund becomes `rejected` with {@link CHARGEBACK_NOT_SENT_NOTE} (a guarded update on the status it was read in) and its
   * journal is mirrored (key `reverse:<journal id>`), so the books show the money leaving once. Used by {@link B2cRefunds.closeNotSent} at
   * the chargeback, and by the refund settlement for a failure that arrives after it.
   *
   * Side effects (on the caller's transaction): updates `refunds`; one ledger transaction when the refund had a journal.
   *
   * @param tx the caller's transaction (the payment, then the refund, are locked; the ledger accounts are locked last)
   * @param refund the locked refund
   * @param actor who causes the close (the system for the gateway's answer)
   * @returns the closed refund, or `undefined` when its status changed first
   */
  async closeUnsent(tx: DbExecutor, refund: Refund, actor: RefundActor): Promise<Refund | undefined> {
    const done = await updateRefundIn(tx, refund.id, [refund.status], {
      status: 'rejected',
      note: CHARGEBACK_NOT_SENT_NOTE,
      updatedAt: this.clock.now(),
    });
    if (!done) return undefined;
    if (done.ledgerTxId !== null) await this.reverseJournal(tx, done, done.ledgerTxId, actor);
    return done;
  }

  /** Posts the mirror of a refund's journal (key `reverse:<journal id>`, so a replay posts nothing). */
  private async reverseJournal(tx: DbExecutor, refund: Refund, journalId: number, actor: RefundActor): Promise<void> {
    const journal = await findReversibleJournal(tx, journalId);
    if (!journal) throw new Error(`Journal ${journalId} of refund ${refund.id} does not exist.`);
    const accountOf = (account: (typeof journal.entries)[number]['account']): AccountRef => ({
      kind: account.kind,
      ...(account.ownerType === null ? {} : { ownerType: account.ownerType }),
      ...(account.ownerId === null ? {} : { ownerId: account.ownerId }),
    });
    await this.poster.post(tx, {
      kind: journal.kind,
      refType: journal.refType,
      refId: journal.refId,
      idempotencyKey: `reverse:${journal.id}`,
      currency: journal.currency,
      lines: reversalLines(
        journal.entries.map((entry) => ({ amount: Money.of(entry.amount), account: accountOf(entry.account) })),
      ),
      memo: `Reversal of refund RF-${refund.id}: not sent, the payment was charged back`,
      createdBy: { type: actor.type, id: actor.id },
    });
  }

  /**
   * Tells whether a storefront order has a captured payment on record (the one a rejection gives back).
   *
   * Why: decision 046: a staff reject that gives a payment back needs the refund permission as well; the payments are this module's,
   * so the orders module asks here.
   *
   * @param db the database or the transition's transaction
   * @param orderId the order
   * @returns true when `onOrderRefund` would find a payment to give back
   */
  async hasCapturedPayment(db: DbExecutor, orderId: number): Promise<boolean> {
    return (await findPaymentOfOrder(db, orderId)) !== undefined;
  }

  /**
   * Refunds a payment that arrived for a checkout that was already paid.
   *
   * Why: two payments can be open for one checkout (the buyer tried another method); when both confirm, the second has no order to pay
   * for: the money is received (it was posted like any payment) and goes straight back, in full, as an automatic refund.
   *
   * @param tx the capture's transaction (the payment is locked)
   * @param order the order the first payment created
   * @param payment the duplicate payment, already captured
   */
  async refundDuplicate(tx: DbExecutor, order: RefundedOrder, payment: Payment): Promise<void> {
    const system: RefundActor = { type: 'system', id: null };
    const refund = await this.openAutomatic(tx, order, payment, system);
    if (!refund) return;
    await this.postLedger(tx, {
      order,
      payment,
      refund,
      from: 'customer_funds',
      key: `refund:${refund.id}`,
      actor: system,
    });
    await this.dispatchAutomatic(tx, refund, payment);
  }

  /**
   * Reverses the revenue of a delivered storefront order for an approved refund.
   *
   * @param tx the approval's transaction
   * @param input the order, the payment, the approved refund and who approved
   * @returns the journal's id and what went back (gross, USD)
   */
  async postDelivered(
    tx: DbExecutor,
    input: { order: RefundedOrder; payment: Payment; refund: Refund; actor: RefundActor },
  ): Promise<{ id: number; gross: string; net: string; vat: string }> {
    return this.postLedger(tx, { ...input, from: 'revenue', key: `refund:${input.refund.id}` });
  }

  /**
   * Reverses the customer funds of a storefront order that was rejected without a refund, for an approved refund request.
   *
   * Why: with `autoRefundFailed` off a rejection opens a request and posts nothing, so the money is still in customer funds; the approval
   * posts the same journal the automatic refund would have (key `refund:<id>`), not a revenue reversal.
   *
   * @param tx the approval's transaction
   * @param input the order, the payment, the approved refund and who approved
   * @returns the journal's id and what went back (gross, USD)
   */
  async postRejected(
    tx: DbExecutor,
    input: { order: RefundedOrder; payment: Payment; refund: Refund; actor: RefundActor },
  ): Promise<{ id: number; gross: string; net: string; vat: string }> {
    return this.postLedger(tx, { ...input, from: 'customer_funds', key: `refund:${input.refund.id}` });
  }

  /**
   * What can still go back on a payment.
   *
   * @param tx the transaction
   * @param order the order the payment paid
   * @param payment the payment (locked by the caller)
   * @param exceptRefundId a refund to leave out (the one being decided)
   * @returns what is left in the payment currency and in USD, with the VAT already taken back (`processing`, `completed` and `failed`
   *   refunds all count: a failed one keeps its posted reversal and can be retried)
   */
  async leftOn(tx: DbExecutor, order: RefundedOrder, payment: Payment, exceptRefundId?: number): Promise<RefundLeft> {
    const prior = await takenRefundsOfPayment(tx, payment.id, exceptRefundId);
    const parts = await ledgerPartsOf(
      tx,
      prior.flatMap((refund) => (refund.ledgerTxId === null ? [] : [refund.ledgerTxId])),
    );
    const posted: LedgerParts[] = [...parts.values()];
    const paidUsd = Money.of(order.totalPrice).add(Money.of(order.taxAmount));
    const session = (await loadSessionMoney(tx, [order.id])).get(order.id);
    const originalLeft = Money.of(payment.amount).sub(sumMoney(prior.map((refund) => refund.amount)));
    return {
      original: originalLeft.isPositive() ? originalLeft : Money.zero(),
      usd: paidUsd.sub(sumMoney(posted.map((part) => part.gross))),
      paidUsd,
      taxUsd: Money.of(order.taxAmount),
      vatTaken: sumMoney(posted.map((part) => part.vat)),
      fxRate: session?.fxRate ?? '1',
    };
  }

  /**
   * Moves a refund to completed and the payment to its new status.
   *
   * Why: RESOLUTIONS money-5: refund completion sets the payment to `partial_refund` or `refunded` (completed refunds summed against
   * what was paid). Only a `processing` refund completes (or a `failed` one, when the gateway reports the success of a send whose failure
   * was not definite); a repeat does nothing.
   *
   * @param tx the transaction (the caller holds the payment's lock when the gateway's answer completes the refund)
   * @param refundId the refund
   * @param gatewayRefundId the gateway's id, when it has one
   * @param note a note to keep (the manual payout text)
   * @param from the statuses the refund may complete from (`processing` by default)
   * @returns the completed refund, or `undefined` when it was in none of them
   */
  async complete(
    tx: DbExecutor,
    refundId: number,
    gatewayRefundId: string | null,
    note?: string,
    from: readonly RefundStatus[] = ['processing'],
  ): Promise<Refund | undefined> {
    const now = this.clock.now();
    const done = await updateRefundIn(tx, refundId, from, {
      status: 'completed',
      completedAt: now,
      updatedAt: now,
      ...(gatewayRefundId === null ? {} : { gatewayRefundId }),
      ...(note === undefined ? {} : { note }),
    });
    if (!done || done.paymentId === null) return done;
    const payment = await findOrderPayment(tx, done.paymentId);
    if (
      payment &&
      (payment.status === 'captured' || payment.status === 'partial_refund' || payment.status === 'refunded')
    ) {
      const completed = (await takenRefundsOfPayment(tx, payment.id)).filter((refund) => refund.status === 'completed');
      const status = statusAfterRefunds(Money.of(payment.amount), sumMoney(completed.map((refund) => refund.amount)));
      await updateOrderPayment(tx, payment.id, { status, updatedAt: now });
    }
    return done;
  }

  /**
   * Moves a refund to failed with the gateway's reason.
   *
   * Why: a staff retry sends the refund again under a key that depends on how it failed (see `refunds.send_attempt`): `definite` moves the key
   * on because the gateway refused for good, and a failure whose outcome is unknown leaves it so the same key stops a second refund.
   *
   * @param tx the transaction
   * @param refundId the refund
   * @param note the gateway's failure text
   * @param gatewayRefundId the gateway's id, when it gave one
   * @param definite true when the gateway refused the refund for good (a 4xx, a failed refund object, a `refund.failed` event)
   * @param unanswered true when the failed send got no answer, so the gateway may have made the refund (`refunds.unanswered_send_at`)
   * @returns the failed refund, or `undefined` when it was not `processing`
   */
  async fail(
    tx: DbExecutor,
    refundId: number,
    note: string,
    gatewayRefundId: string | null = null,
    definite = false,
    unanswered = false,
  ): Promise<Refund | undefined> {
    return failProcessingRefund(
      tx,
      refundId,
      { note, updatedAt: this.clock.now(), ...(gatewayRefundId === null ? {} : { gatewayRefundId }) },
      definite,
      unanswered,
    );
  }

  /** The journal of an order paid without a payment row: the whole price and VAT go back, no refund row. */
  private async legacy(tx: DbExecutor, order: RefundedOrder, actor: RefundActor): Promise<RefundPosting> {
    const net = Money.of(order.totalPrice);
    const vat = Money.of(order.taxAmount);
    const posting = b2cRefund({ net, vat });
    if (posting.lines.length === 0) {
      return {
        posted: false,
        amount: Money.zero().toWire(),
        ledgerTxId: null,
        refundId: null,
        requested: false,
        disputed: false,
      };
    }
    const posted = await this.poster.post(tx, {
      kind: posting.kind,
      refType: posting.refType,
      refId: order.id,
      idempotencyKey: `order:${order.id}:refund`,
      currency: order.currency,
      lines: posting.lines,
      memo: `Refund ORD-${order.id}`,
      createdBy: { type: actor.type, id: actor.id },
    });
    return {
      posted: true,
      amount: net.add(vat).toWire(),
      ledgerTxId: posted.id,
      refundId: null,
      requested: false,
      disputed: false,
    };
  }

  /** Opens the refund the system creates when it rejects a paid order: everything that is left, approved by whoever rejected. */
  private async openAutomatic(
    tx: DbExecutor,
    order: RefundedOrder,
    payment: Payment,
    actor: RefundActor,
  ): Promise<Refund | undefined> {
    const left = await this.leftOn(tx, order, payment);
    if (!left.original.isPositive() || !left.usd.isPositive()) return undefined;
    const gateway = await findGateway(tx, payment.gatewayId);
    const route = refundRoute(storedOrderMethod(payment.methodType), this.capability(gateway));
    const now = this.clock.now();
    const staff = actor.type === 'staff' && actor.id !== null;
    return insertRefund(tx, {
      paymentId: payment.id,
      orderId: order.id,
      customerId: order.customerId,
      amount: left.original.toWire(),
      currency: payment.currency,
      reason: AUTO_REFUND_REASON,
      method: route.method,
      status: 'processing',
      requestedByType: staff ? 'staff' : 'system',
      requestedById: staff ? actor.id : null,
      approvedBy: staff ? actor.id : null,
      note: route.note,
      createdAt: now,
      updatedAt: now,
    });
  }

  /**
   * Opens the refund request of a rejected paid order (`autoRefundFailed` off): everything that is left, waiting for staff.
   *
   * It is a row like a customer's request (status `requested`), made by the system (no staff id), with no journal and no gateway job: the
   * approval route posts, sends and tells the customer. The method is only a first guess; the approval works it out again. `disputed` is
   * true when the request is opened because the payment is disputed (decision 048): the posting says so.
   */
  private async openRequest(
    tx: DbExecutor,
    order: RefundedOrder,
    payment: Payment,
    disputed: boolean,
  ): Promise<RefundPosting> {
    const left = await this.leftOn(tx, order, payment);
    if (!left.original.isPositive() || !left.usd.isPositive()) {
      return {
        posted: false,
        amount: Money.zero().toWire(),
        ledgerTxId: null,
        refundId: null,
        requested: false,
        disputed: false,
      };
    }
    const route = refundRoute(
      storedOrderMethod(payment.methodType),
      this.capability(await findGateway(tx, payment.gatewayId)),
    );
    const now = this.clock.now();
    const refund = await insertRefund(tx, {
      paymentId: payment.id,
      orderId: order.id,
      customerId: order.customerId,
      amount: left.original.toWire(),
      currency: payment.currency,
      reason: AUTO_REFUND_REASON,
      method: route.method,
      status: 'requested',
      requestedByType: 'system',
      requestedById: null,
      createdAt: now,
      updatedAt: now,
    });
    return {
      posted: false,
      amount: left.usd.toWire(),
      ledgerTxId: null,
      refundId: refund.id,
      requested: true,
      disputed,
    };
  }

  /**
   * After the journal of an automatic refund: a hand payout and a refund to the store balance complete at once (the posting was the
   * refund), a gateway refund goes to the job.
   */
  private async dispatchAutomatic(tx: DbExecutor, refund: Refund, payment: Payment): Promise<void> {
    if (settlesAtOnce(refund.method, payment.methodType)) await this.complete(tx, refund.id, null);
    else await this.outbox.refund(tx, refund.id);
  }

  /**
   * What the payment's gateway can do about a refund.
   *
   * @param gateway the payment's gateway row, if it still exists
   * @returns whether the gateway is set up for refunds and whether its driver can send one
   */
  capability(gateway: PaymentGateway | undefined): { supportsRefunds: boolean; driverRefunds: boolean } {
    return {
      supportsRefunds: gateway?.supportsRefunds ?? false,
      driverRefunds: gateway ? driverFor(gateway.driver)?.refund !== undefined : false,
    };
  }

  /**
   * The journal lines of one refund: back through the gateway (`b2c_refund`), or back to the store balance the payment came from
   * (`b2c_wallet_refund`, plan 21 § 5.6.7); the split, the closing rule and the keys are the same.
   */
  private refundPosting(payment: Payment, split: { net: Money; vat: Money }, from: 'customer_funds' | 'revenue') {
    if (payment.methodType !== 'balance') return b2cRefund({ net: split.net, vat: split.vat, from });
    if (payment.customerId === null) throw new Error(`Balance payment ${payment.id} has no customer.`);
    return b2cWalletRefund({ customerId: payment.customerId, net: split.net, vat: split.vat, from });
  }

  /** Posts the journal of one refund and links it to the refund row. */
  private async postLedger(
    tx: DbExecutor,
    input: {
      order: RefundedOrder;
      payment: Payment;
      refund: Refund;
      from: 'customer_funds' | 'revenue';
      key: string;
      actor: RefundActor;
    },
  ): Promise<{ id: number; gross: string; net: string; vat: string }> {
    const { order, payment, refund } = input;
    const left = await this.leftOn(tx, order, payment, refund.id);
    const amount = Money.of(refund.amount);
    // The refund that takes everything left takes exactly the USD and the VAT that are left (no rounding dust).
    const closing = amount.cmp(left.original) >= 0;
    const usd = closing ? left.usd : minMoney(toUsd(amount, left.fxRate), left.usd);
    const split = closing
      ? (() => {
          const vat = left.taxUsd.sub(left.vatTaken);
          const safeVat = vat.isNegative() ? Money.zero() : vat;
          return { net: usd.sub(safeVat), vat: safeVat, total: usd };
        })()
      : refundSplit(left.paidUsd, left.taxUsd, usd);
    const posting = this.refundPosting(payment, split, input.from);
    const posted = await this.poster.post(tx, {
      kind: posting.kind,
      refType: posting.refType,
      refId: order.id,
      idempotencyKey: input.key,
      currency: order.currency,
      lines: posting.lines,
      memo: `Refund RF-${refund.id} on SF-${order.id}`,
      createdBy: { type: input.actor.type, id: input.actor.id },
    });
    await updateRefund(tx, refund.id, { ledgerTxId: posted.id, updatedAt: this.clock.now() });
    return { id: posted.id, gross: split.total.toWire(), net: split.net.toWire(), vat: split.vat.toWire() };
  }
}

function minMoney(a: Money, b: Money): Money {
  return a.cmp(b) <= 0 ? a : b;
}

/**
 * The B2C method of a payment, for callers that only hold the stored row.
 *
 * @param payment the payment
 * @returns `card`, `wallet`, `crypto` or `balance`
 */
export function methodOf(payment: Pick<Payment, 'methodType'>): OrderMethod {
  return storedOrderMethod(payment.methodType);
}
