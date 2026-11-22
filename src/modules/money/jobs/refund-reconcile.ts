// RefundReconcilePass: the lost-work pass of storefront refunds whose `refund.process` job was lost (money module, decision 055).
import { Injectable, type OnModuleInit } from '@nestjs/common';
import { DbService } from '../../../infra/db';
import {
  LOST_AFTER_MS,
  type LostWorkApplied,
  type LostWorkContext,
  type LostWorkItem,
  type LostWorkPass,
  type LostWorkPlan,
  LostWorkRegistry,
  applyLostWorkItems,
  lostWorkAction,
} from '../../platform';
import { REFUND_PROCESS_EVENT, RefundOutbox } from '../application/refund-outbox';
import { RefundSettlement } from '../application/refund-settlement';
import { lockRefund, refundsAwaitingSend } from '../infra/refund.repository';

/**
 * How long after the start of its current send a lost refund may still be sent again automatically.
 *
 * Why: decision 055: the gateway keeps an idempotency key 24 hours; a send after that could refund twice, so past 20 hours the refund is
 * failed for staff instead.
 */
export const REFUND_RESEND_WINDOW_MS = 20 * 60 * 60_000;

/**
 * The note of a refund the reconcile gave up on.
 *
 * Why: decision 055: the gateway may have made the refund although nothing recorded it; staff check before they press retry.
 */
export const REFUND_SEND_LOST_NOTE =
  'The refund was approved, but its send to the payment gateway was not confirmed. Check the payment at the gateway before you send it again.';

/** Refunds one run looks at. */
const REFUND_RECONCILE_BATCH = 200;
const AGGREGATE = 'refunds';

/**
 * Asks again for the gateway call of a refund whose job was lost, and gives up for staff when that is not safe.
 *
 * Why: decision 055 and scenario b2c-refund step 6: a refund `processing` with no gateway reference waits for its `refund.process`
 * job; when that job is gone (no live request for 10 minutes) a new request goes out, at most three times. Then, or once the current
 * send started more than 20 hours ago, the refund is failed with {@link REFUND_SEND_LOST_NOTE}, as a failure whose outcome is unknown: the
 * idempotency key is kept, so the console's retry sends under the same key and the gateway cannot refund twice.
 *
 * Side effects: `apply` inserts `refund.process` outbox rows (`reconcile: true`) under the refund's lock, or fails refunds (with the order
 * timeline line `RefundSettlement` writes).
 */
@Injectable()
export class RefundReconcilePass implements LostWorkPass, OnModuleInit {
  readonly kind = 'refunds';

  constructor(
    private readonly db: DbService,
    private readonly outbox: RefundOutbox,
    private readonly settlement: RefundSettlement,
    private readonly registry: LostWorkRegistry,
  ) {}

  /** Registers the pass with the platform's reconcile. */
  onModuleInit(): void {
    this.registry.register(this);
  }

  /**
   * Finds the refunds whose send was lost.
   *
   * @param context the run's time and the reader of outbox requests
   * @returns the refunds to ask for again or to give up on; writes nothing
   */
  async plan({ now, requests }: LostWorkContext): Promise<LostWorkPlan> {
    const db = this.db.db;
    const rows = await refundsAwaitingSend(db, new Date(now.getTime() - LOST_AFTER_MS), REFUND_RECONCILE_BATCH);
    const items: LostWorkItem[] = [];
    let unknown = 0;
    for (const row of rows) {
      const info = await requests.inspect(db, REFUND_PROCESS_EVENT, AGGREGATE, row.id);
      let action = lostWorkAction({ ...info, now });
      if (action === 'request' && now.getTime() - row.updatedAt.getTime() > REFUND_RESEND_WINDOW_MS) action = 'give_up';
      if (action === 'unknown') unknown += 1;
      else if (action === 'request' || action === 'give_up') {
        items.push({ action, id: row.id, data: { sendAttempt: row.sendAttempt } });
      }
    }
    // A refund that was given up is failed and leaves the list, so none is ever left "exhausted".
    return { checked: rows.length, unknown, exhausted: 0, items };
  }

  /**
   * Asks again or gives up, each refund in its own transaction after a re-check.
   *
   * @param plan what {@link RefundReconcilePass.plan} found
   * @param context the run's time and the reader of outbox requests
   * @returns how many refunds were asked for again and how many were failed
   * @throws {Error} after every item was tried, when one of them threw
   */
  apply(plan: LostWorkPlan, { requests }: LostWorkContext): Promise<LostWorkApplied> {
    return applyLostWorkItems(plan.items, async (item) => {
      if (item.action === 'give_up') {
        // Re-checked first: a request that became live in the meantime is waited for instead.
        if ((await requests.inspect(this.db.db, REFUND_PROCESS_EVENT, AGGREGATE, item.id)).state !== 'none') {
          return 'skipped';
        }
        const sendAttempt = item.data?.sendAttempt;
        const failed = await this.settlement.settle(item.id, {
          kind: 'failed',
          note: REFUND_SEND_LOST_NOTE,
          attempt: typeof sendAttempt === 'number' ? sendAttempt : null,
        });
        return failed ? 'gave_up' : 'skipped';
      }
      const asked = await this.db.runInTransaction(async ({ tx }) => {
        const locked = await lockRefund(tx, item.id);
        if (!locked || locked.status !== 'processing' || locked.gatewayRefundId !== null) return false;
        // Under the row lock: a parallel run (a manual one beside the schedule) that asked first left a live request.
        if ((await requests.inspect(tx, REFUND_PROCESS_EVENT, AGGREGATE, item.id)).state !== 'none') return false;
        await this.outbox.refundAgain(tx, item.id);
        return true;
      });
      return asked ? 'requested' : 'skipped';
    });
  }
}
