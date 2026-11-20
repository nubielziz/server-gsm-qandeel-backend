// DispatchSweep: the minute sweep of the supplier sends (suppliers module, decision 044): claims whose answer never came, and requests that were lost.
import { Inject, Injectable } from '@nestjs/common';
import { CLOCK, type Clock } from '../../../common/clock';
import { AppError } from '../../../common/errors';
import { DbService } from '../../../infra/db';
import { OrderSupplierMoves } from '../../orders';
import {
  DISPATCH_ANSWER_MARGIN_MS,
  DISPATCH_REQUEUE_AFTER_MS,
  DISPATCH_SWEEP_BATCH,
  REQUEUED_MESSAGE,
  REQUEUE_LIMIT_REASON,
  REQUEUE_TOO_OLD_REASON,
  lostRequestAction,
} from '../domain/dispatch-sweep-rules';
import { DispatchRequests } from './dispatch-requests';
import { ANSWER_NOT_RECORDED_REASON } from './supplier-dispatch';

/** What one sweep did, in counts. */
export interface DispatchSweepResult {
  /** Claims whose answer never came, moved to `needs_attention`. */
  readonly unanswered: number;
  /** Pending orders whose send was asked for again. */
  readonly requeued: number;
  /** Pending orders stopped in `needs_attention` (three automatic requests, or a request older than 24 hours). */
  readonly stopped: number;
  /** Orders that changed before the sweep could move them. */
  readonly movedOn: number;
  /** Pending orders whose jobs could not be read (the queue Redis did not answer): left for the next run. */
  readonly unknown: number;
}

/** A sweep that did nothing. */
export const EMPTY_SWEEP: DispatchSweepResult = { unanswered: 0, requeued: 0, stopped: 0, movedOn: 0, unknown: 0 };

/** One move the sweep will make. */
export type SweepItem =
  | { readonly kind: 'unanswered'; readonly orderId: number; readonly sentAt: Date }
  | { readonly kind: 'requeue'; readonly orderId: number }
  | { readonly kind: 'stop'; readonly orderId: number; readonly reason: string };

/** What the sweep found, before it moves anything. */
export interface SweepPlan {
  readonly items: readonly SweepItem[];
  /** Pending orders whose jobs could not be read. */
  readonly unknown: number;
}

/** The system as the actor of the lines the sweep writes. */
const SYSTEM = { type: 'system', id: null } as const;

/** The longest piece of an error's message the sweep's own error carries. */
const FAILURE_TEXT_MAX = 200;

/**
 * Describes a failed move in one short line for the sweep's error.
 *
 * Why: the run is recorded with this text; the first line of the message is enough to find the cause, and a query error's further lines
 * carry the statement's parameters, which stay out of the record.
 */
function describeFailure(error: unknown): string {
  if (error instanceof AppError) return error.code;
  const message = error instanceof Error ? error.message : String(error);
  return (message.split('\n')[0] ?? '').slice(0, FAILURE_TEXT_MAX);
}

/**
 * Sweeps the supplier sends.
 *
 * Why: decision 044 and scenario timeout: (a) an order `dispatching` for longer than its supplier's
 * timeout plus a margin, or claimed by an earlier release, goes to `needs_attention` ("answer not recorded"): it is never sent again
 * automatically and the hold stays; (b) a `pending` order nobody claimed whose newest dispatch request is old and has no live job gets
 * a new request through the outbox (at most three times, never once the newest request is older than 24 hours: then it goes to
 * `needs_attention` with the reason); an order that never had a dispatch request is left alone. It plans read-only, then moves each
 * order in its own transaction through the state machine, so a repeat or a parallel run changes nothing twice. A move that fails does not
 * stop the others: after the loop the sweep throws one error with the counts, so the run is recorded as failed and the next tick tries again.
 *
 * Side effects: updates `orders`; inserts `order_events` and `outbox_events` rows; reads the job states on the queue Redis.
 *
 * @see docs/decisions/044-dispatch-state.md
 */
@Injectable()
export class DispatchSweep {
  constructor(
    private readonly db: DbService,
    private readonly orders: OrderSupplierMoves,
    private readonly requests: DispatchRequests,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  /**
   * Finds what the sweep would move, without moving anything.
   *
   * @returns the moves and how many orders could not be judged
   */
  async plan(): Promise<SweepPlan> {
    const db = this.db.db;
    const items: SweepItem[] = [];
    for (const claim of await this.orders.unansweredClaims(db, DISPATCH_ANSWER_MARGIN_MS, DISPATCH_SWEEP_BATCH)) {
      items.push({ kind: 'unanswered', orderId: claim.orderId, sentAt: claim.sentAt });
    }
    let unknown = 0;
    for (const order of await this.orders.unclaimedPending(db, DISPATCH_REQUEUE_AFTER_MS, DISPATCH_SWEEP_BATCH)) {
      const info = await this.requests.inspect(db, order.orderId);
      if (info.state === 'unknown') {
        unknown += 1;
        continue;
      }
      const action = lostRequestAction({
        requests: info.state,
        lastRequestedAt: info.lastRequestedAt,
        // The count only matters once the order has a request and none of them is live.
        automaticRequeues:
          info.state === 'none' && info.lastRequestedAt !== null
            ? await this.orders.automaticRequeues(db, order.orderId)
            : 0,
        now: this.clock.now(),
      });
      if (action === 'requeue') items.push({ kind: 'requeue', orderId: order.orderId });
      else if (action === 'stop_old')
        items.push({ kind: 'stop', orderId: order.orderId, reason: REQUEUE_TOO_OLD_REASON });
      else if (action === 'stop_repeated') {
        items.push({ kind: 'stop', orderId: order.orderId, reason: REQUEUE_LIMIT_REASON });
      }
    }
    return { items, unknown };
  }

  /**
   * Makes the moves of a plan, each in its own transaction.
   *
   * @param plan what {@link DispatchSweep.plan} found
   * @returns the counts
   * @throws {Error} when a move threw anything other than "the order changed first": the other orders are still moved, and one error
   *   at the end says how many were moved and how many failed, with the first failure's message (each finished move is committed and
   *   guarded, so the next run is safe)
   */
  async apply(plan: SweepPlan): Promise<DispatchSweepResult> {
    let unanswered = 0;
    let requeued = 0;
    let stopped = 0;
    let movedOn = 0;
    let failed = 0;
    let firstFailure: unknown;
    for (const item of plan.items) {
      try {
        await this.db.runInTransaction(({ tx }) => {
          switch (item.kind) {
            case 'unanswered':
              return this.orders.move(tx, {
                orderId: item.orderId,
                action: { kind: 'dispatchResult', result: 'failed' },
                actor: SYSTEM,
                claimedAt: item.sentAt,
                data: { message: ANSWER_NOT_RECORDED_REASON, reason: ANSWER_NOT_RECORDED_REASON },
              });
            case 'requeue':
              return this.orders.move(tx, {
                orderId: item.orderId,
                action: { kind: 'requeueDispatch' },
                actor: SYSTEM,
                data: { message: REQUEUED_MESSAGE },
              });
            case 'stop':
              return this.orders.move(tx, {
                orderId: item.orderId,
                action: { kind: 'dispatchBlocked' },
                actor: SYSTEM,
                data: { message: item.reason, reason: item.reason },
              });
          }
        });
        if (item.kind === 'unanswered') unanswered += 1;
        else if (item.kind === 'requeue') requeued += 1;
        else stopped += 1;
      } catch (error) {
        if (error instanceof AppError && (error.code === 'INVALID_TRANSITION' || error.code === 'ORDER_NOT_OPEN')) {
          movedOn += 1;
          continue;
        }
        // One order must not stop the others: count it, keep the first failure and go on (the guarded moves make the next run safe).
        if (failed === 0) firstFailure = error;
        failed += 1;
      }
    }
    if (failed > 0) {
      throw new Error(
        `Dispatch sweep: moved ${unanswered + requeued + stopped}, failed ${failed}; first failure: ${describeFailure(firstFailure)}`,
      );
    }
    return { unanswered, requeued, stopped, movedOn, unknown: plan.unknown };
  }

  /**
   * Plans and applies one sweep (tests and manual use).
   *
   * @returns the counts
   * @throws {Error} as {@link DispatchSweep.apply}
   */
  async run(): Promise<DispatchSweepResult> {
    return this.apply(await this.plan());
  }
}
