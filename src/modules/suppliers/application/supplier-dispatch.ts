// SupplierDispatch: the logic of the `supplier-dispatch` job (stage 6, resolutions orders-suppliers-11 and -12, decision 025, scenarios
// success, reject and timeout): send one order to its supplier exactly once and record what the supplier answered.
import { Inject, Injectable } from '@nestjs/common';
import { CLOCK, type Clock } from '../../../common/clock';
import { AppError } from '../../../common/errors';
import { Money } from '../../../common/money';
import { DbService } from '../../../infra/db';
import { OrderSupplierMoves, isOpen } from '../../orders';
import type { Order } from '../../orders';
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
 * Why: orders-suppliers-11 and CLAUDE.md "Orders": the job re-reads the order and picks the first active link by priority that is
 * eligible (supplier active, service still listed, cost not above the charged price: B117 (6), never a costlier failover); an order that
 * already names a supplier service (a staff choice) goes there as it is. It claims the order with a guarded update BEFORE the call
 * (`dispatch_state = 'pending' AND sent_at IS NULL`), so a second run never sends twice, then calls `placeimeiorder` outside any
 * transaction. A REFERENCEID moves the order to `sent` (status `processing`, the reference stored once); an explicit refusal, a timeout,
 * any other failure or no eligible link moves it to `needs_attention` with the reason, the hold kept and nothing re-sent. A run that
 * finds a claim whose answer was never recorded does not send again: it moves the order to `needs_attention`.
 *
 * Side effects: one `supplier_api_logs` row per call, the claim (`orders.sent_at`, supplier columns, a `dispatch` event), the result
 * (`sent` or `needs_attention` with its event, `order.status_changed` outbox row), a lease in the supplier's semaphore.
 */
@Injectable()
export class SupplierDispatch {
  constructor(
    private readonly db: DbService,
    private readonly orders: OrderSupplierMoves,
    private readonly client: SupplierClient,
    private readonly throttle: SupplierThrottle,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  /**
   * Runs the dispatch of one order.
   *
   * @param orderId the order
   * @param options `lastAttempt`: the queue will not retry, so a busy supplier sends the order to `needs_attention` instead of failing
   * @returns what happened
   * @throws {SupplierBusyError} when the supplier's limits are full and the queue may retry
   */
  async run(orderId: number, options: { lastAttempt: boolean }): Promise<DispatchOutcome> {
    const order = await this.orders.find(this.db.db, orderId);
    if (!order) return { status: 'skipped', reason: 'not_found' };
    if (order.dispatchState !== 'pending' || !isOpen(order.status)) return { status: 'skipped', reason: 'not_pending' };
    if (order.sentAt !== null) {
      // An earlier run claimed the order and never recorded the supplier's answer: it may have reached the supplier.
      return this.fail(
        order.id,
        'A send was started but its answer was not recorded. Check the supplier, then fetch or send the order again.',
      );
    }

    const target = await this.targetOf(order);
    if (!target.ok) return this.fail(order.id, target.reason);
    const { supplier, remoteId, unitCost, fieldMap } = target;

    const admission = await this.throttle.admit(supplier);
    if (!admission.ok) {
      if (options.lastAttempt)
        return this.fail(order.id, `${supplier.name} was too busy to take the order. Send it again later.`);
      throw new SupplierBusyError(supplier.name, admission.reason);
    }
    try {
      const claimed = await this.db.runInTransaction(({ tx }) =>
        this.orders.claim(
          tx,
          {
            orderId: order.id,
            supplierId: supplier.id,
            supplierServiceId: target.supplierServiceId,
            unitCost: unitCost.toWire(),
            at: this.clock.now(),
          },
          supplier.name,
        ),
      );
      if (!claimed) return { status: 'skipped', reason: 'claimed_elsewhere' };

      const call = await this.client.placeOrder(supplier, await this.placeInput(claimed, remoteId, fieldMap));
      await writeCallLog(this.db.db, supplier.id, order.id, call.record, this.clock.now());
      try {
        return await this.db.runInTransaction(async ({ tx }) => {
          if (call.ok) {
            await this.orders.move(tx, {
              orderId: order.id,
              action: { kind: 'dispatchResult', result: 'sent' },
              actor: { type: 'supplier', id: supplier.id },
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
            data: { message: reason, reason },
          });
          return { status: 'needs_attention', reason } as const;
        });
      } catch (error) {
        // The order moved on while the supplier was called (staff replied or rejected it): the answer stays in the call log.
        if (error instanceof AppError && (error.code === 'INVALID_TRANSITION' || error.code === 'ORDER_NOT_OPEN')) {
          return { status: 'skipped', reason: 'moved_on' };
        }
        throw error;
      }
    } finally {
      await this.throttle.release(admission.lease);
    }
  }

  /** Moves the order to `needs_attention` with a reason, without calling the supplier. */
  private async fail(orderId: number, reason: string): Promise<DispatchOutcome> {
    try {
      await this.db.runInTransaction(({ tx }) =>
        this.orders.move(tx, {
          orderId,
          action: { kind: 'dispatchResult', result: 'failed' },
          actor: SYSTEM,
          data: { message: reason, reason },
        }),
      );
    } catch (error) {
      if (error instanceof AppError && (error.code === 'INVALID_TRANSITION' || error.code === 'ORDER_NOT_OPEN')) {
        return { status: 'skipped', reason: 'moved_on' };
      }
      throw error;
    }
    return { status: 'needs_attention', reason };
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

  /** What `placeimeiorder` is sent: the main input for an IMEI service, the custom fields under the supplier's own names. */
  private async placeInput(
    order: Order,
    remoteId: string,
    fieldMap: Record<string, unknown>,
  ): Promise<PlaceOrderInput> {
    const maps = await serviceFieldMaps(this.db.db, order.serviceId);
    const customFields: Record<string, string> = {};
    for (const [key, value] of Object.entries(order.inputs)) {
      if (typeof value !== 'string' || value.trim() === '') continue;
      const mapped = fieldMap[key];
      const supplierKey =
        typeof mapped === 'string' && mapped !== ''
          ? mapped
          : maps.find((field) => field.key === key)?.supplierKey || key;
      customFields[supplierKey] = value;
    }
    return {
      remoteServiceId: remoteId,
      input: order.type === 'imei' && order.imei !== null && order.imei !== '' ? order.imei : null,
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
