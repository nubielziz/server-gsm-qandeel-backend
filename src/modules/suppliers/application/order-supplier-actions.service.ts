// OrderSupplierActions: the three staff actions on an order that involve a supplier (stage 6; the routes belong to the order engine, the
// use cases need the supplier tables): force a send, fetch the result now and change the supplier (resolutions orders-suppliers-11, -12,
// -17, -19). Every rule about the state is the machine's; this service adds the supplier checks.
import { Injectable } from '@nestjs/common';
import { AppError } from '../../../common/errors';
import { Money } from '../../../common/money';
import { DbService, type DbExecutor } from '../../../infra/db';
import { OrderSupplierMoves, decideOrderAction, isOpen, refusalError } from '../../orders';
import { AuditService } from '../../platform';
import type { Order } from '../../orders';
import { linkUnitCost, type RoutingLink } from '../domain/link-selection';
import { routingLinks } from '../infra/supplier-catalogue.repository';
import { findSupplier, findSuppliers } from '../infra/supplier.repository';
import { SupplierPoll } from './supplier-poll';

/** The audit verb phrases of the demo's style: the console prints `<actor> <action> <entityLabel>`. */
export const ORDER_SUPPLIER_AUDIT = {
  dispatch: 'dispatched order',
  changeSupplier: 'changed supplier of',
} as const;

/** The body of `POST /admin/orders/:id/change-supplier`. */
export interface ChangeSupplierInput {
  readonly supplierId?: number | undefined;
  readonly resetReference?: boolean | undefined;
  readonly dispatch?: boolean | undefined;
}

const notFound = () => new AppError('NOT_FOUND', { detail: 'No order with this id.' });

function invalid(field: string, message: string, code = 'invalid'): AppError {
  return new AppError('VALIDATION_FAILED', { errors: [{ field, code, message }] });
}

/** What the machine needs to know about an order (a supplier action never depends on an earlier completion). */
const stateOf = (order: Order) => ({
  status: order.status,
  dispatchState: order.dispatchState,
  verificationStatus: order.verificationStatus,
  channel: order.clientId === null ? ('b2c' as const) : ('b2b' as const),
  completedBefore: false,
});

/** The cost columns of an order for a link: `unit_cost = credit x credit_rate`, `total_cost = unit_cost x quantity`. */
function costColumns(order: Order, link: Pick<RoutingLink, 'credit' | 'creditRate'>) {
  const unit = linkUnitCost(link);
  return { unitCost: unit.toWire(), totalCost: unit.mul(order.quantity).toWire(), unit };
}

/**
 * Runs the supplier actions of staff on one order.
 *
 * Why: scenario timeout step 10 and the order drawer: after a supplier timeout staff first fetch (when a reference exists) or send again
 * by hand once they checked with the supplier; the reroute dialog changes the supplier and sends. The automatic dispatch limit of user
 * rule 9 (never a costlier link) does not bind a person: a staff change or dispatch may use a costlier link, and the event records
 * `costAbovePrice` so the loss shows in reports.
 *
 * Side effects: each action is one transaction that updates `orders`, appends an `order_events` row, writes the outbox rows the move
 * calls for (`order.dispatch_requested`, `order.status_changed`) and one `audit_logs` row; `fetch` also calls the supplier and writes
 * its log row.
 */
@Injectable()
export class OrderSupplierActions {
  constructor(
    private readonly db: DbService,
    private readonly orders: OrderSupplierMoves,
    private readonly poll: SupplierPoll,
    private readonly audit: AuditService,
  ) {}

  /**
   * Sends the order to its supplier now (queues the dispatch job).
   *
   * @param staffId the staff member
   * @param orderId the order
   * @throws {AppError} `NOT_FOUND`; the machine's `ORDER_NOT_OPEN`, `ORDER_HELD`, `ALREADY_SENT`; `NO_SUPPLIER` (no active link and no
   *   supplier service); `SUPPLIER_DISABLED` (the order's supplier, or every linked supplier, is paused or disabled)
   */
  async dispatch(staffId: number, orderId: number): Promise<void> {
    await this.db.runInTransaction(async ({ tx }) => {
      const order = await this.orders.find(tx, orderId);
      if (!order) throw notFound();
      const decision = decideOrderAction(stateOf(order), { kind: 'staffDispatch' });
      if (!decision.ok) throw refusalError(decision.refusal);
      // Already waiting for the dispatch job: nothing to change and nothing to check, but the press of the button is audited.
      if (decision.noop) {
        await this.recordNoop(tx, order, ORDER_SUPPLIER_AUDIT.dispatch);
        return;
      }
      let columns: Parameters<OrderSupplierMoves['move']>[1]['columns'] = { sentAt: null };
      let supplierName: string;
      if (order.supplierServiceId !== null && order.supplierId !== null) {
        const supplier = await findSupplier(tx, order.supplierId);
        if (!supplier || supplier.status !== 'active') {
          throw new AppError('SUPPLIER_DISABLED', {
            detail: `${supplier?.name ?? 'The supplier of this order'} is ${supplier?.status ?? 'gone'}: change the supplier or enable it first.`,
          });
        }
        supplierName = supplier.name;
      } else {
        const links = await routingLinks(tx, order.serviceId);
        if (links.length === 0) {
          throw new AppError('NO_SUPPLIER', {
            detail: 'This service has no active supplier link and the order has no supplier.',
          });
        }
        const link = links.find((candidate) => candidate.supplierStatus === 'active' && candidate.available);
        if (!link) {
          throw new AppError('SUPPLIER_DISABLED', {
            detail: 'Every supplier linked to this service is paused or disabled, or no longer offers it.',
          });
        }
        const cost = costColumns(order, link);
        columns = {
          sentAt: null,
          supplierId: link.supplierId,
          supplierServiceId: link.supplierServiceId,
          unitCost: cost.unitCost,
          totalCost: cost.totalCost,
        };
        supplierName = link.supplierName;
      }
      await this.orders.move(tx, {
        orderId,
        action: { kind: 'staffDispatch' },
        actor: { type: 'staff', id: staffId },
        columns,
        data: { message: `Sent to ${supplierName} again`, supplier: supplierName },
        audit: ORDER_SUPPLIER_AUDIT.dispatch,
      });
    });
  }

  /**
   * Asks the supplier for the result now.
   *
   * @param staffId the staff member
   * @param orderId the order
   * @throws {AppError} `NOT_FOUND`; `ORDER_NOT_OPEN`; `NO_REFERENCE` (nothing was ever accepted by a supplier); `SUPPLIER_UNAVAILABLE`
   *   (the supplier could not be reached or did not answer); `INVALID_TRANSITION` (the order is not in a state a supplier result
   *   applies to, or it changed while the supplier was asked)
   */
  async fetch(staffId: number, orderId: number): Promise<void> {
    const order = await this.orders.find(this.db.db, orderId);
    if (!order) throw notFound();
    if (!isOpen(order.status)) throw refusalError('ORDER_NOT_OPEN');
    if (order.supplierRef === null || order.supplierId === null) {
      throw new AppError('NO_REFERENCE', {
        detail:
          'No supplier accepted this order yet, so there is nothing to fetch. Send it, or check with the supplier.',
      });
    }
    const outcome = await this.poll.check(orderId, { type: 'staff', id: staffId });
    if (outcome.kind === 'unreachable') throw new AppError('SUPPLIER_UNAVAILABLE', { detail: outcome.message });
    if (outcome.kind === 'skipped') {
      throw outcome.reason === 'not_found'
        ? notFound()
        : new AppError('INVALID_TRANSITION', {
            detail:
              outcome.reason === 'moved_on'
                ? 'Another request changed this order first. Reload it and try again.'
                : 'This order is not waiting for a supplier result.',
          });
    }
  }

  /**
   * Changes the supplier of an order and/or forgets its supplier reference.
   *
   * @param staffId the staff member
   * @param orderId the order
   * @param input the target supplier, whether to reset the reference and whether to queue the dispatch at once
   * @throws {AppError} `NOT_FOUND`; `ORDER_NOT_OPEN`, `ORDER_HELD` (with `dispatch`); `SUPPLIER_DISABLED` (the target is paused or
   *   disabled); `VALIDATION_FAILED` (422 on `supplierId`: nothing to do, an unknown supplier, or no active link of the order's
   *   service to it)
   */
  async changeSupplier(staffId: number, orderId: number, input: ChangeSupplierInput): Promise<void> {
    const reset = input.resetReference === true;
    const dispatch = input.dispatch === true;
    if (input.supplierId === undefined && !reset) {
      throw invalid('supplierId', 'Choose a supplier or reset the reference.', 'required');
    }
    await this.db.runInTransaction(async ({ tx }) => {
      const order = await this.orders.find(tx, orderId);
      if (!order) throw notFound();
      const action = { kind: 'changeSupplier', resetReference: reset, dispatch } as const;
      const decision = decideOrderAction(stateOf(order), action);
      if (!decision.ok) throw refusalError(decision.refusal);

      let columns: NonNullable<Parameters<OrderSupplierMoves['move']>[1]['columns']> = {};
      let toSupplierId = order.supplierId;
      let costAbovePrice = false;
      if (input.supplierId !== undefined) {
        const target = await findSupplier(tx, input.supplierId);
        if (!target) throw invalid('supplierId', 'No supplier has this id.', 'unknown');
        if (target.status !== 'active') {
          throw new AppError('SUPPLIER_DISABLED', {
            detail: `${target.name} is ${target.status}: choose another supplier.`,
          });
        }
        const link = (await routingLinks(tx, order.serviceId)).find((candidate) => candidate.supplierId === target.id);
        if (!link) {
          throw invalid('supplierId', `This service has no active link to ${target.name}. Link it first.`, 'no_link');
        }
        const cost = costColumns(order, link);
        costAbovePrice = cost.unit.cmp(Money.of(order.unitPrice)) > 0;
        toSupplierId = target.id;
        // The same supplier and supplier service without a reset changes nothing (unless the dispatch is asked for).
        const same = order.supplierId === target.id && order.supplierServiceId === link.supplierServiceId;
        if (same && !reset && !dispatch) {
          await this.recordNoop(tx, order, ORDER_SUPPLIER_AUDIT.changeSupplier);
          return;
        }
        columns = {
          supplierId: target.id,
          supplierServiceId: link.supplierServiceId,
          unitCost: cost.unitCost,
          totalCost: cost.totalCost,
        };
      }
      if (reset) columns = { ...columns, supplierRef: null };
      // A new send needs a fresh claim.
      if (dispatch) columns = { ...columns, sentAt: null };

      const names = await findSuppliers(
        tx,
        [order.supplierId, toSupplierId].filter((id): id is number => id !== null),
      );
      const from =
        order.supplierId === null ? 'none' : (names.get(order.supplierId)?.name ?? `supplier ${order.supplierId}`);
      const to = toSupplierId === null ? 'none' : (names.get(toSupplierId)?.name ?? `supplier ${toSupplierId}`);
      await this.orders.move(tx, {
        orderId,
        action,
        actor: { type: 'staff', id: staffId },
        columns,
        data: {
          message: `Supplier changed from ${from} to ${to}${reset ? ' (reference reset)' : ''}`,
          fromSupplierId: order.supplierId,
          toSupplierId,
          resetReference: reset,
          costAbovePrice,
        },
        audit: ORDER_SUPPLIER_AUDIT.changeSupplier,
      });
    });
  }

  /** The audit row of a staff action that found nothing to change (the staff write rule: every press is recorded). */
  private async recordNoop(tx: DbExecutor, order: Order, action: string): Promise<void> {
    await this.audit.record(tx, {
      action,
      entityType: 'order',
      entityId: order.id,
      entityLabel: `ORD-${order.id}`,
      before: { dispatchState: order.dispatchState },
      after: { dispatchState: order.dispatchState },
    });
  }
}
