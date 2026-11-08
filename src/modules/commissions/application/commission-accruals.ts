// CommissionAccruals: the commission engine. It listens to order completions and reversals (the completion hook of orders) and, in the
// completion's own transaction, creates the accruals a completed order earns and reverses them when it is reopened or refunded.
import { Inject, Injectable, type OnModuleInit } from '@nestjs/common';
import { CLOCK, type Clock } from '../../../common/clock';
import { Money } from '../../../common/money';
import type { DbExecutor } from '../../../infra/db';
import { BASE_CURRENCY, LedgerPoster, commissionReversal } from '../../money';
import {
  type LedgerActor,
  type Order,
  type OrderCompletionListener,
  OrderCompletionListeners,
  type OrderReversalReason,
} from '../../orders';
import { accruingPlans } from '../domain/accrual-rules';
import { accrualAmount, periodOf } from '../domain/commission-math';
import { insertAccrualOnce, lockLiveAccrualsOfOrder, markPaidBack, markReversed } from '../infra/accrual.repository';
import { currentPlansOf } from '../infra/assignment.repository';
import { findMerchants } from '../infra/foreign-reads.repository';

/**
 * Accrues and reverses commissions as orders complete and are refunded.
 *
 * Why: RULES commissions 1 and user rule 5 (ANSWERS commissions Q8). When a merchant order completes (a staff reply, a supplier's
 * result, a stock delivery at placement) every beneficiary with a current, active plan accrues: a `referral` plan pays the merchant
 * in `clients.referred_by_id` of the order's merchant, a `rebate` plan pays the order's own merchant. The accrual keeps the order's
 * `total_price` as its basis, the plan's rate at that moment and `amount = basis x percent / 100` (4 decimals, half up); an order
 * accrues once per beneficiary (the unique index), a storefront order (no merchant) accrues nothing, and an amount that rounds to
 * zero is not worth an accrual. When the order is reopened or refunded, an accrual not yet approved becomes `reversed`; an approved
 * one stays `approved` and the agent's wallet gives the commission back with a reversing entry (key `reverse:accrual:<id>`), which
 * may take the wallet below its credit limit (`allowBelowCreditLimit`, the one place that uses it). Both run inside the order's
 * transaction, so a commission exists if and only if the completion committed.
 *
 * Side effects (on the order transition's transaction): inserts and updates `commission_accruals`; a reversal after approval inserts a
 * `ledger_transactions` row with its entries and changes the agent's wallet and `commission_expense` balances. Registers itself with
 * {@link OrderCompletionListeners} at boot, in the API and in the worker.
 *
 * @see docs/contract/RULES.md (commissions 1, 4), docs/contract/ANSWERS.md (commissions Q8)
 */
@Injectable()
export class CommissionAccruals implements OrderCompletionListener, OnModuleInit {
  constructor(
    private readonly listeners: OrderCompletionListeners,
    private readonly poster: LedgerPoster,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  /** Registers with the order completion hook. */
  onModuleInit(): void {
    this.listeners.add(this);
  }

  /**
   * Creates the accruals of a completed order.
   *
   * @param tx the completion's transaction
   * @param order the order after the update
   * @param _actor who completed it (an accrual keeps no actor)
   */
  async orderCompleted(tx: DbExecutor, order: Order, _actor: LedgerActor): Promise<void> {
    if (order.clientId === null) return;
    const basis = Money.of(order.totalPrice);
    if (!basis.isPositive()) return;
    const merchant = (await findMerchants(tx, [order.clientId])).get(order.clientId);
    const referrerId = merchant?.referredById ?? null;
    const beneficiaries = referrerId === null ? [order.clientId] : [order.clientId, referrerId];
    const plans = accruingPlans(order.clientId, referrerId, await currentPlansOf(tx, beneficiaries));
    if (plans.length === 0) return;

    const now = this.clock.now();
    const period = periodOf(order.completedAt ?? now);
    for (const plan of plans) {
      const amount = accrualAmount(basis, plan.percent);
      if (!amount.isPositive()) continue;
      await insertAccrualOnce(tx, {
        planId: plan.planId,
        beneficiaryId: plan.beneficiaryId,
        orderId: order.id,
        period,
        basisAmount: basis.toWire(),
        percent: plan.percent,
        amount: amount.toWire(),
        status: 'accrued',
        createdAt: now,
      });
    }
  }

  /**
   * Locks the live accruals of an order that is about to be reopened or refunded, before the ledger locks any wallet.
   *
   * Why: lock order. An approval locks accruals and then the agent's wallet; this reversal used to lock the order merchant's wallet
   * first (the ledger move) and the accruals after. With a rebate plan the merchant is its own agent, so the two could deadlock
   * (Postgres 40P01: the losing request is rolled back and answers a retryable 409). Taking the accruals first makes both paths lock accruals, then wallets.
   *
   * @param tx the transition's transaction
   * @param order the order after the update
   */
  async lockForReversal(tx: DbExecutor, order: Order): Promise<void> {
    await lockLiveAccrualsOfOrder(tx, order.id);
  }

  /**
   * Reverses the accruals of an order that was reopened or refunded.
   *
   * @param tx the transition's transaction
   * @param order the order after the update
   * @param _reason `reopen` or `refund` (both reverse the same way)
   * @param actor who reopened or refunded it: the reversing entry is posted in their name
   */
  async orderReversed(tx: DbExecutor, order: Order, _reason: OrderReversalReason, actor: LedgerActor): Promise<void> {
    const live = await lockLiveAccrualsOfOrder(tx, order.id);
    if (live.length === 0) return;
    const now = this.clock.now();
    for (const accrual of live) {
      if (accrual.status === 'accrued') {
        await markReversed(tx, accrual.id, now);
        continue;
      }
      // Approved: the agent was paid, so the wallet gives it back. The mark is guarded, so a replay posts nothing twice.
      if (!(await markPaidBack(tx, accrual.id, now))) continue;
      await this.poster.post(tx, {
        ...commissionReversal({ clientId: accrual.beneficiaryId, amount: Money.of(accrual.amount) }),
        refId: accrual.id,
        idempotencyKey: `reverse:accrual:${accrual.id}`,
        currency: BASE_CURRENCY,
        memo: `Reversal of commission JRN-${accrual.ledgerTxId ?? 0} for ORD-${order.id}`,
        createdBy: actor,
        allowBelowCreditLimit: true,
      });
    }
  }
}
