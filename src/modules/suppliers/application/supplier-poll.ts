// SupplierPoll: the logic of the `supplier-poll` jobs (stage 6, scenarios success and reject, decision 025): ask a supplier for the status
// of one order and settle it, and the tick that finds the sent orders due for a poll. The staff's `fetch` runs the same check.
import { Inject, Injectable } from '@nestjs/common';
import { CLOCK, type Clock } from '../../../common/clock';
import { AppError } from '../../../common/errors';
import { DbService } from '../../../infra/db';
import { QueuesService, queueJobId } from '../../../infra/queues';
import { OrderSupplierMoves, isOpen } from '../../orders';
import { SettingsReader } from '../../platform';
import { DEFAULT_POLL_SLOW_AFTER_HOURS, pollIntervalMs } from '../domain/poll-schedule';
import { findSupplier } from '../infra/supplier.repository';
import { SupplierClient, SupplierThrottle } from './supplier-client';
import { writeCallLog } from './supplier-sync';

/** The job name of one status poll on the `supplier-poll` queue. */
export const SUPPLIER_POLL_JOB = 'poll';
/** The job name of the tick that finds the orders due for a poll. */
export const SUPPLIER_POLL_TICK_JOB = 'supplier_poll_tick';
/** The setting that says when the polls slow down to every 30 minutes (default 24 hours). */
export const POLL_SLOW_AFTER_KEY = 'orders.poll_slow_after_hours';

/** The data of a poll job: the order, ids only. */
export interface SupplierPollJobData {
  readonly orderId: number;
}

/** Who asked for the check: the poll job, or a staff member's `fetch`. */
export type CheckedBy = { readonly type: 'system' } | { readonly type: 'staff'; readonly id: number };

/** What a check found. */
export type CheckOutcome =
  | { readonly kind: 'completed' }
  | { readonly kind: 'rejected' }
  | { readonly kind: 'running' }
  | { readonly kind: 'unreachable'; readonly message: string }
  | { readonly kind: 'busy' }
  | { readonly kind: 'skipped'; readonly reason: 'not_found' | 'not_polled' | 'moved_on' };

/** The most orders one tick hands to the poll queue. */
export const POLL_TICK_BATCH = 500;

/** The audit verb phrase of a staff fetch. */
export const FETCH_AUDIT_ACTION = 'fetched supplier result of';

/**
 * Polls suppliers for the result of sent orders.
 *
 * Why: scenario success step 8: `getimeiorder` every minute in the first hour, every five minutes after, every thirty after
 * `orders.poll_slow_after_hours`; STATUS 4 completes the order (the CODE becomes its result), STATUS 3 rejects it (the supplier's text
 * is the reason). The tick keeps no state of its own: the order's `sent_at` and the newest `getimeiorder` log row tell what is due, so
 * a lost job or a restart loses nothing. A poll never changes an order that moved on, and an unreachable supplier leaves it as it is
 * for the next round.
 *
 * Side effects: one `supplier_api_logs` row per call; a completion or rejection settles the order (ledger, events, outbox);
 * the tick adds `poll` jobs with the id `order-poll-<order>-<minute>`.
 */
@Injectable()
export class SupplierPoll {
  constructor(
    private readonly db: DbService,
    private readonly orders: OrderSupplierMoves,
    private readonly client: SupplierClient,
    private readonly throttle: SupplierThrottle,
    private readonly queues: QueuesService,
    private readonly settings: SettingsReader,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  /**
   * Finds the sent orders that are due for a poll and queues a job for each.
   *
   * @returns how many orders were due and how many jobs were queued
   */
  async tick(): Promise<{ due: number; queued: number }> {
    const slowAfter = await this.settings.integer(POLL_SLOW_AFTER_KEY, DEFAULT_POLL_SLOW_AFTER_HOURS, {
      min: 1,
      max: 24 * 365,
    });
    const now = this.clock.nowMs();
    const candidates = await this.orders.pollCandidates(this.db.db, POLL_TICK_BATCH);
    const due = candidates.filter((candidate) => {
      const last = candidate.lastPolledAt ?? candidate.sentAt;
      return now - last.getTime() >= pollIntervalMs(now - candidate.sentAt.getTime(), slowAfter);
    });
    const minute = Math.floor(now / 60_000);
    let queued = 0;
    for (const candidate of due) {
      await this.queues.add(
        'supplier-poll',
        SUPPLIER_POLL_JOB,
        { orderId: candidate.orderId } satisfies SupplierPollJobData,
        { jobId: queueJobId('order-poll', candidate.orderId, minute) },
      );
      queued += 1;
    }
    return { due: due.length, queued };
  }

  /**
   * Asks the supplier about one order and applies the answer.
   *
   * @param orderId the order
   * @param by who asked (a staff fetch is audited and not held back by the supplier's call limits)
   * @returns what the supplier said, or why nothing was asked
   */
  async check(orderId: number, by: CheckedBy): Promise<CheckOutcome> {
    const order = await this.orders.find(this.db.db, orderId);
    if (!order) return { kind: 'skipped', reason: 'not_found' };
    if (
      !isOpen(order.status) ||
      order.supplierRef === null ||
      order.supplierId === null ||
      !['sent', 'needs_attention'].includes(order.dispatchState)
    ) {
      return { kind: 'skipped', reason: 'not_polled' };
    }
    const supplier = await findSupplier(this.db.db, order.supplierId);
    if (!supplier) return { kind: 'skipped', reason: 'not_polled' };

    const admission = by.type === 'system' ? await this.throttle.admit(supplier) : undefined;
    if (admission && !admission.ok) return { kind: 'busy' };
    try {
      const call = await this.client.getOrder(supplier, order.supplierRef);
      await writeCallLog(this.db.db, supplier.id, order.id, call.record, this.clock.now());
      if (!call.ok) return { kind: 'unreachable', message: `${supplier.name}: ${call.message}` };
      const audit = by.type === 'staff' ? { audit: FETCH_AUDIT_ACTION } : {};
      const actor = by.type === 'staff' ? { type: 'staff' as const, id: by.id } : { type: 'system' as const, id: null };
      try {
        await this.db.runInTransaction(async ({ tx }) => {
          if (call.value.state === 'running') {
            await this.orders.move(tx, {
              orderId: order.id,
              action: { kind: 'supplierResult', result: 'running' },
              actor,
              // An automatic poll that finds the order still running writes nothing; a staff fetch leaves a line.
              ...(by.type === 'staff'
                ? { data: { message: 'Supplier has not finished yet' }, writeOnNoop: true, ...audit }
                : { data: { message: 'Supplier has not finished yet' } }),
            });
            return;
          }
          await this.orders.settle(tx, {
            orderId: order.id,
            result: call.value.state,
            supplierId: supplier.id,
            text: call.value.code,
            ...audit,
          });
        });
      } catch (error) {
        if (error instanceof AppError && (error.code === 'INVALID_TRANSITION' || error.code === 'ORDER_NOT_OPEN')) {
          return { kind: 'skipped', reason: 'moved_on' };
        }
        throw error;
      }
      return { kind: call.value.state };
    } finally {
      if (admission?.ok) await this.throttle.release(admission.lease);
    }
  }
}
