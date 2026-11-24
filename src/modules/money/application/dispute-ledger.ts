// DisputeLedger: the outcomes of a dispute, shared by the staff's accept and the gateway's webhook (feature 16): a loss posts the one
// chargeback journal and marks the payment `chargeback`; a win returns the payment to the status its refunds and its other disputes leave
// it in. A dispute of a top-up (feature 21, accounts of either rank) claws the credited amount back from the live wallet of its account
// instead (decision 064).
import { Inject, Injectable, Logger } from '@nestjs/common';
import { CLOCK, type Clock } from '../../../common/clock';
import { Money } from '../../../common/money';
import type { DbExecutor } from '../../../infra/db';
import { AccountDirectory } from '../../identity';
import { AuditService } from '../../platform';
import type { Dispute, Payment } from '../db/schema';
import { BASE_CURRENCY } from '../domain/accounts';
import { statusAfterRefunds, toUsd, wireUsd } from '../domain/b2c-money';
import { clawbackSplit, topupChargeback } from '../domain/customer-wallet-events';
import {
  type ChargebackReturn,
  chargebackReturn,
  clawbackRulesOf,
  paymentStatusAfterDispute,
} from '../domain/dispute-rules';
import { paymentRef } from '../domain/invoice-rules';
import { b2cChargeback } from '../domain/money-events';
import { accountLabel } from '../domain/payment-rules';
import { CHARGEBACK_NOT_SENT_NOTE } from '../domain/refund-rules';
import { type WalletLedgerKind, walletKindOfRank } from '../domain/wallet-kinds';
import {
  type RefundOrderRow,
  ledgerPartsOf,
  ledgerTxIdsByKeys,
  loadSessionMoney,
  orderForRefund,
} from '../infra/b2c-reads.repository';
import { disputesOfPayment, updateDispute, updateDisputeIn } from '../infra/dispute.repository';
import { writeWalletFreeze } from '../infra/customer-wallet.repository';
import { findInvoice, updateInvoice } from '../infra/invoice.repository';
import { lockAccountsByIdentity, openAccounts } from '../infra/ledger-accounts.repository';
import { updatePayment } from '../infra/payment.repository';
import { updateOrderPayment } from '../infra/order-payment.repository';
import { takenRefundsOfPayment } from '../infra/refund.repository';
import { LedgerPoster } from './post-transaction';
import { B2cRefunds, type RefundActor } from './b2c-refunds';
import { chargebackReturnKey } from './chargeback-return';
import { CustomerWallets } from './customer-wallets';
import { StorefrontOrderPorts } from './storefront-ports';

/**
 * The account a top-up dispute touches and the wallet it takes from.
 *
 * Why: decision 064: the credit of a top-up went to the wallet of the account's rank kind, and a dispute of it freezes and claws back from
 * the wallet that is live when the dispute is handled, whatever its kind. The kind is read under the account row lock, never remembered.
 */
export interface LiveTopUpOwner {
  readonly accountId: number;
  /** The kind of the account's live wallet: `client_wallet` for a merchant rank, `customer_wallet` for any other. */
  readonly kind: WalletLedgerKind;
  /** How an audit row names the account: the name, else the address; an anonymized account by its number. */
  readonly label: string;
}

/**
 * The reason a top-up dispute writes on the wallet's hold (the staff's Wallet tab shows it).
 *
 * @param disputeId the dispute
 * @param paymentId the disputed top-up payment
 * @returns `Dispute DP-<id> on PAY-<id>`
 */
export function topUpDisputeHold(disputeId: number, paymentId: number): string {
  return `Dispute DP-${disputeId} on ${paymentRef(paymentId)}`;
}

/**
 * Settles disputes.
 *
 * Why: RESOLUTIONS money-5 and rule 8 of RULES refunds: a dispute lost, from the staff's accept or from the gateway's webhook, posts
 * exactly one `b2c_chargeback` journal (Dr chargeback_loss amount + fee, Cr gateway_clearing; key `dispute:<id>:chargeback`) and
 * keeps its id in `disputes.ledger_tx_id`, so whichever comes second posts nothing. The chargeback of an order that was never delivered
 * (`rejected`) gives back what its sale booked as owed to the buyer and as VAT, for the disputed share of what the refunds that went out
 * left ({@link chargebackReturn}: Dr customer_funds, Dr vat_payable), and only the rest and the dispute fee are a loss; a delivered order's
 * stays a loss. An order still open at the loss keeps the plain loss; when it ends rejected, its rejection gives the same share back
 * against the loss (`returnAfterChargeback`), and a later loss counts what that gave back. A dispute won sets the payment back to
 * `captured`, or to `partial_refund` or `refunded` when completed refunds exist, unless another dispute of the payment is lost
 * (`chargeback`) or still open (`disputed`). Decision 048: when a loss books the
 * chargeback, the payment's refunds that have not completed at the gateway are closed unsent and their journals reversed
 * ({@link B2cRefunds.closeNotSent}), each with a timeline line, so the books show the money leaving once.
 *
 * Side effects (on the caller's transaction): updates `disputes` and `payments`; writes one ledger transaction for a loss; for a loss,
 * updates `refunds`, writes one reversing ledger transaction per closed refund that was booked and one order timeline line per closed
 * refund.
 */
@Injectable()
export class DisputeLedger {
  private readonly logger = new Logger(DisputeLedger.name);

  constructor(
    private readonly poster: LedgerPoster,
    private readonly wallets: CustomerWallets,
    private readonly audit: AuditService,
    private readonly refunds: B2cRefunds,
    private readonly ports: StorefrontOrderPorts,
    private readonly accounts: AccountDirectory,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  /**
   * Reads whose wallet a top-up dispute touches, under the account row lock.
   *
   * Why: decision 064 (lock order): a dispute event holds its payment and dispute rows and takes the account row `FOR KEY SHARE` after them
   * (the rank change and the status writers never lock those rows, so no cycle can form); the kind of the live wallet is read only now,
   * so a rank change that races the dispute either commits first (the dispute meets the new wallet) or waits for it. The wallet is never
   * guessed from the payment or its invoice: both name the kind of a past moment.
   *
   * Side effects: a row lock on the account, held until the transaction ends.
   *
   * @param tx the caller's transaction (the payment, and the dispute once it exists, are locked)
   * @param payment the disputed top-up payment
   * @returns the account and the kind of its live wallet
   * @throws {Error} when the payment's account is gone (a foreign key makes it impossible)
   */
  async ownerOf(tx: DbExecutor, payment: Payment): Promise<LiveTopUpOwner> {
    const account = await this.accounts.lockForKeyShare(tx, payment.accountId);
    if (!account) throw new Error(`The account of ${paymentRef(payment.id)} does not exist.`);
    return {
      accountId: account.id,
      kind: walletKindOfRank(account.rankKind),
      label: accountLabel(account, account.id),
    };
  }

  /**
   * Puts the live wallet of an account on hold because a dispute of one of its top-ups opened (or closed with nothing credited).
   *
   * Why: decision 064 (the rule O11 of the store balance, widened to both kinds): paying from a store balance and card top-ups stop, and a merchant
   * wallet takes no new hold (`WALLET_FROZEN`); settlement and release of holds that exist, credits and staff debits still post. The
   * system freeze carries no `Idempotency-Key`: the dispute id is its guard, and holding a held wallet changes nothing (still audited,
   * `alreadyFrozen`).
   *
   * Side effects: may open the wallet; updates the locked wallet row; one audit row; for a store balance one `wallet.frozen` mail when
   * it changed.
   *
   * @param tx the caller's transaction (after {@link DisputeLedger.ownerOf})
   * @param owner the account and its live wallet kind
   * @param reason why, as the wallet's Wallet tab shows it ({@link topUpDisputeHold})
   */
  async holdWallet(tx: DbExecutor, owner: LiveTopUpOwner, reason: string): Promise<void> {
    if (owner.kind === 'customer_wallet') {
      await this.wallets.freezeInTx(tx, owner.accountId, reason);
      return;
    }
    const identity = {
      kind: 'client_wallet',
      ownerType: 'account',
      ownerId: owner.accountId,
      currency: BASE_CURRENCY,
    } as const;
    let [wallet] = await lockAccountsByIdentity(tx, [identity]);
    if (!wallet) {
      // A merchant's wallet is opened with its rank; this is the safety net of decision 024, for a freeze that comes before any money.
      await openAccounts(tx, [identity]);
      [wallet] = await lockAccountsByIdentity(tx, [identity]);
    }
    if (!wallet) throw new Error(`The merchant wallet of account ${owner.accountId} could not be opened.`);
    const heldSince = wallet.frozenAt;
    const at = this.clock.now();
    if (heldSince === null) await writeWalletFreeze(tx, wallet.id, { at, reason }, at);
    await this.audit.record(tx, {
      action: 'froze wallet of',
      entityType: 'account',
      entityId: owner.accountId,
      entityLabel: owner.label,
      before: { frozen: heldSince === null ? null : { at: heldSince.toISOString() } },
      after:
        heldSince === null
          ? { frozen: { at: at.toISOString(), reason } }
          : { frozen: { at: heldSince.toISOString() }, alreadyFrozen: true, reason },
    });
  }

  /**
   * Marks a dispute lost and posts the chargeback once; for an order that was never delivered (`rejected`) the disputed share of what its
   * sale booked as customer funds and VAT goes back instead of to the loss.
   *
   * @param tx the caller's transaction (the payment and the dispute are locked)
   * @param dispute the dispute (`needs_response`, `under_review` or already `lost`)
   * @param payment the disputed payment
   * @param actor who closed it (the staff member who accepted, or the system for the gateway's decision)
   * @returns the dispute after the change
   */
  async lose(tx: DbExecutor, dispute: Dispute, payment: Payment, actor: RefundActor): Promise<Dispute> {
    const now = this.clock.now();
    let ledgerTxId = dispute.ledgerTxId;
    if (ledgerTxId === null) {
      // The card network took the money back: a refund the gateway has not paid is closed and its journal reversed before the chargeback
      // posts (decision 048; lock order: the payment, each refund, the ledger accounts).
      const closed = await this.refunds.closeNotSent(tx, payment, actor);
      const session =
        dispute.orderId === null ? undefined : (await loadSessionMoney(tx, [dispute.orderId])).get(dispute.orderId);
      const fx = session?.fxRate ?? '1';
      const amount = wireUsd(
        Money.of(dispute.amount),
        session ? { amount: payment.amount, grossUsd: session.grossAmount } : undefined,
        fx,
      );
      // Read without a lock: an order's lock comes before its payment's (the lock order of every writer of an order's money) and the
      // payment is held here; a rejected order is final, so what this rule reads cannot change under it. An order read as open that is
      // rejected after this commits takes the payment's lock afterwards and books the give-back then (`returnAfterChargeback`).
      const order = dispute.orderId === null ? undefined : await orderForRefund(tx, dispute.orderId);
      const returned =
        order?.status === 'rejected' ? await this.returnedOf(tx, dispute, order, payment, amount) : undefined;
      const posting = b2cChargeback({ amount, fee: toUsd(Money.of(dispute.fee), fx), returned });
      const posted = await this.poster.post(tx, {
        kind: posting.kind,
        refType: posting.refType,
        refId: dispute.orderId ?? payment.orderId ?? payment.id,
        idempotencyKey: `dispute:${dispute.id}:chargeback`,
        currency: 'USD',
        lines: posting.lines,
        memo: `Chargeback DP-${dispute.id} on SF-${dispute.orderId ?? 0} (incl. dispute fee)`,
        createdBy: { type: actor.type, id: actor.id },
      });
      ledgerTxId = posted.id;
      const timelineActor =
        actor.type === 'staff' ? { type: 'staff' as const, id: actor.id } : { type: 'system' as const, id: null };
      for (const refund of closed) {
        if (refund.orderId === null) continue;
        await this.ports.get().addTimeline(tx, refund.orderId, timelineActor, {
          type: 'refund',
          message: CHARGEBACK_NOT_SENT_NOTE,
          data: { refundId: refund.id },
        });
      }
    }
    const lost =
      dispute.status === 'lost'
        ? await updateDispute(tx, dispute.id, { ledgerTxId, updatedAt: now })
        : (await updateDisputeIn(tx, dispute.id, ['needs_response', 'under_review'], {
            status: 'lost',
            resolvedAt: now,
            ledgerTxId,
            updatedAt: now,
          }))!;
    await updateOrderPayment(tx, payment.id, { status: 'chargeback', updatedAt: now });
    return lost;
  }

  /**
   * Marks a dispute won and restores the payment's status: the one its completed refunds leave, or `chargeback` / `disputed` while
   * another dispute of the payment is lost / still open.
   *
   * @param tx the caller's transaction (the payment and the dispute are locked)
   * @param dispute the dispute (`needs_response` or `under_review`)
   * @param payment the disputed payment
   * @returns the dispute after the change, or `undefined` when it was not open any more
   */
  async win(tx: DbExecutor, dispute: Dispute, payment: Payment): Promise<Dispute | undefined> {
    const now = this.clock.now();
    const won = await updateDisputeIn(tx, dispute.id, ['needs_response', 'under_review'], {
      status: 'won',
      resolvedAt: now,
      updatedAt: now,
    });
    if (!won) return undefined;
    const completed = (await takenRefundsOfPayment(tx, payment.id)).filter((refund) => refund.status === 'completed');
    const afterRefunds = statusAfterRefunds(
      Money.of(payment.amount),
      Money.sum(completed.map((refund) => Money.of(refund.amount))),
    );
    // Another dispute of the payment that was lost or is still open keeps the payment's dispute status.
    const others = (await disputesOfPayment(tx, payment.id)).filter((other) => other.id !== won.id);
    await updateOrderPayment(tx, payment.id, {
      status: paymentStatusAfterDispute(others, afterRefunds),
      updatedAt: now,
    });
    return won;
  }

  /**
   * What the chargeback of an order that was never delivered gives back from its sale's lines (see {@link chargebackReturn}): what the
   * refunds that went out left, less what earlier lost disputes of the payment already gave back, and less what the order's rejection gave
   * back after an earlier loss ({@link chargebackReturnKey}).
   *
   * @param tx the loss's transaction (after the refunds that were not sent are closed; the payment is locked)
   * @param dispute the dispute being lost
   * @param order the rejected order
   * @param payment the disputed payment
   * @param amount the disputed amount in USD
   * @returns the net and the VAT given back
   */
  private async returnedOf(
    tx: DbExecutor,
    dispute: Dispute,
    order: RefundOrderRow,
    payment: Payment,
    amount: Money,
  ): Promise<ChargebackReturn> {
    const left = await this.refunds.leftOn(tx, order, payment);
    const earlier = (await disputesOfPayment(tx, payment.id)).flatMap((other) =>
      other.id !== dispute.id && other.ledgerTxId !== null ? [other.ledgerTxId] : [],
    );
    const key = chargebackReturnKey(order.id);
    const back = (await ledgerTxIdsByKeys(tx, [key])).get(key);
    const given = [...(await ledgerPartsOf(tx, back === undefined ? earlier : [...earlier, back])).values()];
    const givenNet = Money.sum(given.map((part) => Money.of(part.net)));
    const givenVat = Money.sum(given.map((part) => Money.of(part.vat)));
    return chargebackReturn({
      disputed: amount,
      left: left.usd.sub(givenNet).sub(givenVat),
      paid: left.paidUsd,
      tax: left.taxUsd,
      vatTaken: left.vatTaken.add(givenVat),
    });
  }

  /**
   * Marks a top-up dispute lost and claws back what the top-up credited, once.
   *
   * Why: plan 21 § 5.6.9 and O11 (fixes merchants too, defect D4) and decision 064: the gateway took the disputed money and its dispute
   * fee, so the live wallet of the account, of either kind, gives back its share of the credit (`clawbackSplit`: the whole credit for a
   * whole dispute; it may go below zero), our fee income on that share is reversed and the dispute fee is booked as a loss:
   * `topup_chargeback`, key `dispute:<id>:chargeback`, ref `dispute`. The payment keeps `approved` (`payments_status_check` has no
   * chargeback word for a top-up). A merchant wallet may pass its credit limit (it was held when the dispute opened); a store balance may
   * go below zero and is frozen after the posting, on the row lock the posting took (plan § 5.7), because the deferred trigger checks at
   * commit that a wallet below zero is frozen ({@link clawbackRulesOf}). A payment that was never credited (pending or rejected) posts
   * nothing: there is nothing to take back; a pending one is rejected and its invoice voided, so neither staff nor the automatic credit
   * can credit money the gateway already took back. A dispute reported in another currency than the top-up takes the whole top-up back and
   * books no dispute fee (it cannot be converted reliably): logged for staff.
   *
   * Side effects (on the caller's transaction): one ledger transaction (when credited), the wallet's hold, the dispute row, one audit row
   * (`charged back deposit of`, entity `payment`, actor from the request context: the system for a webhook).
   *
   * @param tx the caller's transaction (the payment, then the dispute, then the account row, are locked)
   * @param dispute the dispute (`needs_response` or `under_review`)
   * @param payment the disputed top-up payment
   * @param owner the account and the kind of its live wallet ({@link DisputeLedger.ownerOf}), read under the account row lock
   * @returns the dispute after the change
   */
  async loseTopUp(tx: DbExecutor, dispute: Dispute, payment: Payment, owner: LiveTopUpOwner): Promise<Dispute> {
    const now = this.clock.now();
    let ledgerTxId = dispute.ledgerTxId;
    let clawedBack = Money.zero();
    if (ledgerTxId === null && payment.status === 'approved') {
      const gross = Money.of(payment.amount);
      const sameCurrency = dispute.currency === payment.currency;
      if (!sameCurrency) {
        this.logger.warn(
          `Dispute ${dispute.id} is in ${dispute.currency}, its top-up ${paymentRef(payment.id)} in ${payment.currency}: the whole top-up is taken back, no dispute fee is booked.`,
        );
      }
      const disputed = sameCurrency ? minMoney(Money.of(dispute.amount), gross) : gross;
      const split = clawbackSplit({ gross, fee: Money.of(payment.feeAmount), disputed });
      const posting = topupChargeback({
        owner: { accountId: owner.accountId, kind: owner.kind },
        net: split.net,
        fee: split.fee,
        disputeFee: sameCurrency ? Money.of(dispute.fee) : Money.zero(),
      });
      const rules = clawbackRulesOf(owner.kind);
      const posted = await this.poster.post(tx, {
        kind: posting.kind,
        refType: posting.refType,
        refId: dispute.id,
        idempotencyKey: `dispute:${dispute.id}:chargeback`,
        currency: payment.currency,
        lines: posting.lines,
        memo: `Chargeback DP-${dispute.id} on top-up ${paymentRef(payment.id)} (incl. dispute fee)`,
        createdBy: { type: 'system', id: null },
        // The one path that may take a wallet below its floor (plan § 5.1 invariant 2); a store balance is frozen below.
        ...(rules.allowNegativeCustomerWallet ? { allowNegativeCustomerWallet: true } : {}),
        ...(rules.allowBelowCreditLimit ? { allowBelowCreditLimit: true } : {}),
      });
      ledgerTxId = posted.id;
      clawedBack = split.net;
      const wallet = posted.touched.find((account) => account.kind === 'customer_wallet');
      if (rules.freezeAfterPosting && wallet && !wallet.frozen) {
        await this.wallets.freezeAfterPosting(tx, owner.accountId, topUpDisputeHold(dispute.id, payment.id));
      }
    } else if (ledgerTxId === null) {
      // Never credited: nothing to take back. A payment still pending must never be credited later (the gateway took the money): it
      // is rejected and its invoice voided, under the payment lock already held (lock order: payment → invoice, as a credit).
      if (payment.status === 'pending') {
        await updatePayment(tx, payment.id, {
          status: 'rejected',
          reviewedBy: null,
          reviewedAt: now,
          reviewNote: `Charged back (DP-${dispute.id}) before it was credited.`,
          autoCreditAt: null,
          updatedAt: now,
        });
        const invoice = payment.invoiceId === null ? undefined : await findInvoice(tx, payment.invoiceId, true);
        if (invoice?.status === 'open') await updateInvoice(tx, invoice.id, { status: 'void', updatedAt: now });
      }
      // The hold the dispute put on the account's wallet stays (no posting follows this lock).
      await this.holdWallet(tx, owner, topUpDisputeHold(dispute.id, payment.id));
    }
    const lost = (await updateDisputeIn(tx, dispute.id, ['needs_response', 'under_review'], {
      status: 'lost',
      resolvedAt: now,
      ledgerTxId,
      updatedAt: now,
    }))!;
    await this.audit.record(tx, {
      action: 'charged back deposit of',
      entityType: 'payment',
      entityId: payment.id,
      entityLabel: `${paymentRef(payment.id)}, dispute DP-${dispute.id}`,
      before: { dispute: dispute.status, paymentStatus: payment.status },
      after: {
        dispute: 'lost',
        transactionId: ledgerTxId,
        clawedBack: clawedBack.toWire(),
        currency: payment.currency,
        owner: { accountId: owner.accountId, wallet: owner.kind },
      },
    });
    return lost;
  }

  /**
   * Marks a top-up dispute won.
   *
   * Why: plan 21 P2: the money stays where it is; the account's wallet stays frozen until staff lift the hold (a person looks first).
   *
   * @param tx the caller's transaction (the payment and the dispute are locked)
   * @param dispute the dispute
   * @returns the dispute after the change, or `undefined` when it was not open any more
   */
  async winTopUp(tx: DbExecutor, dispute: Dispute): Promise<Dispute | undefined> {
    const now = this.clock.now();
    return updateDisputeIn(tx, dispute.id, ['needs_response', 'under_review'], {
      status: 'won',
      resolvedAt: now,
      updatedAt: now,
    });
  }
}

/** The smaller of two amounts. */
function minMoney(a: Money, b: Money): Money {
  return a.cmp(b) <= 0 ? a : b;
}
