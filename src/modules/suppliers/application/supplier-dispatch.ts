// SupplierDispatch: the logic of the `supplier-dispatch` job (stage 6, resolutions orders-suppliers-11 and -12, decision 025, scenarios
// success, reject and timeout): send one order to its supplier exactly once and record what the supplier answered.
import { Inject, Injectable, Logger } from '@nestjs/common';
import { CLOCK, type Clock } from '../../../common/clock';
import { isMainInputKey, resolvedSupplierKey } from '../../../common/dhru';
import { AppError } from '../../../common/errors';
import { Money } from '../../../common/money';
import { DbService } from '../../../infra/db';
import { ErrorReporter } from '../../../infra/observability';
import { ORDER_OUTBOX_EVENTS, OrderSupplierMoves, isOpen } from '../../orders';
import type { LateAcceptanceCause, Order, SupplierMoveAction } from '../../orders';
import type { Supplier } from '../db/schema';
import { linkUnitCost, pickLink } from '../domain/link-selection';
import { serviceFieldMaps } from '../infra/foreign-reads.repository';
import { dispatchTarget, routingLinks } from '../infra/supplier-catalogue.repository';
import { findSupplier } from '../infra/supplier.repository';
import { SupplierClient, SupplierThrottle } from './supplier-client';
import type { PlaceOrderInput } from './supplier-driver';
import { writeCallLog } from './supplier-sync';

/** What one run of the dispatch job did. */
export type DispatchOutcome =
  | { readonly status: 'sent'; readonly reference: string }
  | { readonly status: 'needs_attention'; readonly reason: string }
  | { readonly status: 'skipped'; readonly reason: 'not_found' | 'not_pending' | 'claimed_elsewhere' | 'moved_on' };

/** The system as the actor of the events a job writes. */
const SYSTEM = { type: 'system', id: null } as const;

/** Where an error of this job is reported from (the context of every report the job makes). */
const REPORT_CONTEXT = {
  process: 'worker',
  queue: 'supplier-dispatch',
  job: ORDER_OUTBOX_EVENTS.dispatchRequested,
} as const;

/**
 * The reason written when a send was started and its answer was never recorded.
 *
 * Why: decisions 025 and 044: the supplier may hold the order, so nothing is sent again automatically; staff check it first. The dispatch
 * job (a claim of an earlier release) and the dispatch sweep (a claim whose answer never came) write the same sentence.
 */
export const ANSWER_NOT_RECORDED_REASON =
  'A send was started but its answer was not recorded. Check the supplier, then fetch or send the order again.';

/** True for the two errors that say the order changed since the job read it (staff or the sweep acted, or a newer claim exists). */
function isMovedOn(error: unknown): boolean {
  return error instanceof AppError && (error.code === 'INVALID_TRANSITION' || error.code === 'ORDER_NOT_OPEN');
}

/** A supplier that cannot take the call right now: the job is retried by the queue (or fails the order over on its last try). */
export class SupplierBusyError extends Error {
  constructor(supplierName: string, reason: string) {
    super(`${supplierName} is not ready for another call (${reason}); trying again later.`);
    this.name = 'SupplierBusyError';
  }
}

/**
 * Sends orders to suppliers.
 *
 * Why: orders-suppliers-11, CLAUDE.md "Orders" and decision 044: the job re-reads the order and picks the first active link by priority
 * that is eligible (supplier active, service still listed, cost not above the charged price: B117 (6), never a costlier failover); an
 * order that already names a supplier service (a staff choice) goes there as it is. It claims the order with a guarded update BEFORE the
 * call (`dispatch_state = 'pending' AND sent_at IS NULL`; the claim sets `dispatching` and `sent_at`), so a second run never sends
 * twice, then calls `placeimeiorder` outside any transaction. A REFERENCEID moves the order to `sent` (status `processing`, the
 * reference stored once); an explicit refusal or a timeout moves it to `needs_attention` with the reason, the hold kept and nothing
 * re-sent. The answer applies only to its own claim (`sent_at` unchanged): an answer that finds the order moved on is not applied, and
 * a supplier's acceptance is recorded on its own (the reference where the order has none, a `review` line, a waiting order to
 * `needs_attention`, an error report). A log row that cannot be written is logged and reported and never stops the answer from being
 * recorded; when the answer's own transaction fails for another reason and the supplier accepted, the acceptance is kept the same way (the
 * reference, a `review` line saying the answer could not be recorded; the order keeps its claim and the sweep moves it later) and the
 * original error then ends the job, so no retry sends again. No eligible link, or a supplier too busy on the last attempt, stops a waiting order in
 * `needs_attention`; a cache Redis error in the call limits counts as busy (the queue retries, the last attempt stops the order). A
 * run that finds a claim of an earlier release (`pending` with `sent_at` set) does not send again: it moves the order to
 * `needs_attention`. The supplier's main box travels as `IMEI`: the IMEI of an IMEI order, else the value of the field whose supplier
 * key is `IMEI` (decision 042).
 *
 * Side effects: one `supplier_api_logs` row per call (an error log line and an error report when it cannot be written), the claim
 * (`orders.sent_at`, `dispatching`, supplier columns, a `dispatch` event), the result (`sent` or `needs_attention` with its event,
 * `order.status_changed` outbox row), a lease in the supplier's semaphore; for a late acceptance an error log line and an error report.
 *
 * @see docs/decisions/044-dispatch-state.md
 */
@Injectable()
export class SupplierDispatch {
  private readonly logger = new Logger(SupplierDispatch.name);

  constructor(
    private readonly db: DbService,
    private readonly orders: OrderSupplierMoves,
    private readonly client: SupplierClient,
    private readonly throttle: SupplierThrottle,
    private readonly reporter: ErrorReporter,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  /**
   * Runs the dispatch of one order.
   *
   * @param orderId the order
   * @param options `lastAttempt`: the queue will not retry, so a busy supplier (or limits that cannot be read) sends the order to
   *   `needs_attention` instead of failing
   * @returns what happened
   * @throws {SupplierBusyError} when the supplier's limits are full or cannot be read and the queue may retry
   * @throws {Error} whatever ended the answer's transaction other than "the order moved on" (after an accepted answer was kept as a late
   *   acceptance)
   */
  async run(orderId: number, options: { lastAttempt: boolean }): Promise<DispatchOutcome> {
    const order = await this.orders.find(this.db.db, orderId);
    if (!order) return { status: 'skipped', reason: 'not_found' };
    if (order.dispatchState !== 'pending' || !isOpen(order.status)) return { status: 'skipped', reason: 'not_pending' };
    if (order.sentAt !== null) {
      // A claim of an earlier release kept `pending` and set `sent_at`: it may have reached the supplier, so it is never sent again.
      return this.failClaim(order.id, order.sentAt);
    }

    const target = await this.targetOf(order);
    if (!target.ok) return this.stop(order.id, target.reason);
    const { supplier, remoteId, unitCost, fieldMap } = target;

    const admission = await this.throttle.admit(supplier);
    if (!admission.ok) {
      if (options.lastAttempt) {
        return this.stop(
          order.id,
          admission.reason === 'unavailable'
            ? `The call limits of ${supplier.name} could not be checked. Send the order again later.`
            : `${supplier.name} was too busy to take the order. Send it again later.`,
        );
      }
      throw new SupplierBusyError(supplier.name, admission.reason);
    }
    try {
      // The input is built before the claim (the claim changes no field it reads), so only the call itself can fail between the two.
      const input = await this.placeInput(order, remoteId, fieldMap);
      const at = this.clock.now();
      const claimed = await this.db.runInTransaction(({ tx }) =>
        this.orders.claim(
          tx,
          {
            orderId: order.id,
            supplierId: supplier.id,
            supplierServiceId: target.supplierServiceId,
            unitCost: unitCost.toWire(),
            at,
          },
          supplier.name,
        ),
      );
      if (!claimed) return { status: 'skipped', reason: 'claimed_elsewhere' };
      // The claim always sets `sent_at`: the answer of the call belongs to this claim and to no other.
      const claimedAt = claimed.sentAt ?? at;

      const call = await this.client.placeOrder(supplier, input);
      // The call is made and cannot be undone: a log row that cannot be written never stands in the way of recording the answer.
      try {
        await writeCallLog(this.db.db, supplier.id, order.id, call.record, this.clock.now());
      } catch (error) {
        this.logger.error(`Order ${order.id}: the call to ${supplier.name} could not be logged.`);
        this.reporter.capture(error, REPORT_CONTEXT);
      }
      try {
        return await this.db.runInTransaction(async ({ tx }) => {
          if (call.ok) {
            await this.orders.move(tx, {
              orderId: order.id,
              action: { kind: 'dispatchResult', result: 'sent' },
              actor: { type: 'supplier', id: supplier.id },
              claimedAt,
              columns: { supplierRef: call.value.reference },
              data: {
                message: `Accepted by ${supplier.name}, ref ${call.value.reference}`,
                ref: call.value.reference,
                supplier: supplier.name,
              },
            });
            return { status: 'sent', reference: call.value.reference } as const;
          }
          const reason = this.reasonOf(supplier, call.kind, call.message);
          await this.orders.move(tx, {
            orderId: order.id,
            action: { kind: 'dispatchResult', result: 'failed' },
            actor: SYSTEM,
            claimedAt,
            data: { message: reason, reason },
          });
          return { status: 'needs_attention', reason } as const;
        });
      } catch (error) {
        // The order moved on while the supplier was called (staff or the sweep acted): the answer is not applied to it. An acceptance
        // is recorded on its own, so the supplier's reference is never left only in the call log.
        if (isMovedOn(error)) {
          if (call.ok) await this.recordLate(order.id, supplier, call.value.reference, 'moved_on');
          return { status: 'skipped', reason: 'moved_on' };
        }
        // The answer could not be recorded for another reason: when the supplier accepted, its reference is kept on its own (it never
        // throws), then the error ends the job as before. The order keeps its claim; no retry sends again, and the sweep moves it.
        if (call.ok) await this.recordLate(order.id, supplier, call.value.reference, 'not_recorded');
        throw error;
      }
    } finally {
      await this.throttle.release(admission.lease);
    }
  }

  /** Stops a waiting order in `needs_attention` with a reason, without calling the supplier. */
  private async stop(orderId: number, reason: string): Promise<DispatchOutcome> {
    return this.settleWithoutCall(orderId, reason, { kind: 'dispatchBlocked' });
  }

  /** Moves a claim of an earlier release to `needs_attention`: its answer was never recorded and it is not sent again. */
  private async failClaim(orderId: number, sentAt: Date): Promise<DispatchOutcome> {
    return this.settleWithoutCall(
      orderId,
      ANSWER_NOT_RECORDED_REASON,
      { kind: 'dispatchResult', result: 'failed' },
      sentAt,
    );
  }

  private async settleWithoutCall(
    orderId: number,
    reason: string,
    action: SupplierMoveAction,
    claimedAt?: Date,
  ): Promise<DispatchOutcome> {
    try {
      await this.db.runInTransaction(({ tx }) =>
        this.orders.move(tx, {
          orderId,
          action,
          actor: SYSTEM,
          ...(claimedAt === undefined ? {} : { claimedAt }),
          data: { message: reason, reason },
        }),
      );
    } catch (error) {
      if (isMovedOn(error)) return { status: 'skipped', reason: 'moved_on' };
      throw error;
    }
    return { status: 'needs_attention', reason };
  }

  /**
   * Records a supplier's acceptance that the order's own answer did not record, in its own transaction, then tells the owner.
   *
   * The failure of this step never reaches the job: a retry could not learn the reference again, so the error is logged and reported.
   */
  private async recordLate(
    orderId: number,
    supplier: Pick<Supplier, 'id' | 'name'>,
    reference: string,
    cause: LateAcceptanceCause,
  ): Promise<void> {
    try {
      const late = await this.db.runInTransaction(({ tx }) =>
        this.orders.recordLateAcceptance(tx, {
          orderId,
          supplierId: supplier.id,
          supplierName: supplier.name,
          reference,
          cause,
        }),
      );
      const text = `Order ${orderId}: ${supplier.name} accepted it ${
        cause === 'not_recorded' ? 'but the answer could not be recorded' : 'after it had moved on'
      } (${late?.stored === true ? 'reference stored on the order' : 'reference kept on the timeline'}).`;
      this.logger.error(text);
      this.reporter.capture(new Error(text), REPORT_CONTEXT);
    } catch (error) {
      // The reference is written here because this line may be its only copy on our side.
      this.logger.error(
        `Order ${orderId}: the late acceptance of ${supplier.name} (reference ${reference}) could not be recorded.`,
      );
      this.reporter.capture(error, REPORT_CONTEXT);
    }
  }

  /** The supplier service the order goes to: the one it was given, else the first eligible link (B117 (6)). */
  private async targetOf(order: Order): Promise<
    | {
        ok: true;
        supplier: Supplier;
        supplierServiceId: number;
        remoteId: string;
        unitCost: Money;
        fieldMap: Record<string, unknown>;
      }
    | { ok: false; reason: string }
  > {
    const db = this.db.db;
    if (order.supplierServiceId !== null) {
      const chosen = await dispatchTarget(db, order.serviceId, order.supplierServiceId);
      const supplier = chosen ? await findSupplier(db, chosen.supplierId) : undefined;
      if (!chosen || !supplier)
        return { ok: false, reason: 'The supplier service of this order no longer exists. Change the supplier.' };
      if (supplier.status !== 'active') {
        return {
          ok: false,
          reason: `${supplier.name} is ${supplier.status}: change the supplier or enable it, then send the order again.`,
        };
      }
      return {
        ok: true,
        supplier,
        supplierServiceId: chosen.supplierServiceId,
        remoteId: chosen.remoteId,
        unitCost: linkUnitCost({ credit: chosen.credit, creditRate: supplier.creditRate }),
        fieldMap: chosen.fieldMap,
      };
    }
    const choice = pickLink(await routingLinks(db, order.serviceId), Money.of(order.unitPrice));
    if (!choice.ok) return { ok: false, reason: choice.message };
    const supplier = await findSupplier(db, choice.link.supplierId);
    const chosen = await dispatchTarget(db, order.serviceId, choice.link.supplierServiceId);
    if (!supplier || !chosen)
      return { ok: false, reason: 'The chosen supplier service no longer exists. Change the supplier.' };
    return {
      ok: true,
      supplier,
      supplierServiceId: chosen.supplierServiceId,
      remoteId: chosen.remoteId,
      unitCost: choice.unitCost,
      fieldMap: chosen.fieldMap,
    };
  }

  /**
   * What `placeimeiorder` is sent: the main input (the IMEI of an IMEI order, else the value of the field whose supplier key is `IMEI`)
   * and the other custom fields under the supplier's own names.
   */
  private async placeInput(
    order: Order,
    remoteId: string,
    fieldMap: Record<string, unknown>,
  ): Promise<PlaceOrderInput> {
    const maps = await serviceFieldMaps(this.db.db, order.serviceId);
    const customFields: Record<string, string> = {};
    // Decision 042: a value whose supplier key is `IMEI` (any case, after the link's field map) is the supplier's main box: it travels
    // as the `IMEI` parameter, never inside CUSTOMFIELD. With several, the first by the service's field order wins.
    let main: { rank: number; value: string } | null = null;
    for (const [key, value] of Object.entries(order.inputs)) {
      if (typeof value !== 'string' || value.trim() === '') continue;
      const supplierKey = resolvedSupplierKey(
        maps.find((field) => field.key === key) ?? { key, supplierKey: '' },
        fieldMap[key],
      );
      if (isMainInputKey(supplierKey)) {
        const found = maps.findIndex((field) => field.key === key);
        const rank = found === -1 ? maps.length : found;
        if (main === null || rank < main.rank) main = { rank, value: value.trim() };
        continue;
      }
      customFields[supplierKey] = value;
    }
    const ownImei = order.type === 'imei' && order.imei !== null && order.imei !== '' ? order.imei : null;
    return {
      remoteServiceId: remoteId,
      input: ownImei ?? main?.value ?? null,
      quantity: order.quantity,
      customFields,
    };
  }

  /** The sentence staff read on the review queue for a failed call; a timeout says the supplier may have the order. */
  private reasonOf(supplier: Pick<Supplier, 'name' | 'timeoutMs'>, kind: string, message: string): string {
    if (kind === 'refused') return `${supplier.name} refused the order: ${message}`;
    if (kind === 'timeout') {
      return `${supplier.name} did not answer within ${supplier.timeoutMs} ms. It may have taken the order: check with the supplier before sending it again.`;
    }
    return `${supplier.name} could not take the order: ${message}`;
  }
}
