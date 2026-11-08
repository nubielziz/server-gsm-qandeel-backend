// CustomerOrderPlacement: creates the order of a storefront customer after its payment was confirmed (feature 16, scenario b2c-paid step 7).
// It is OrderPlacement's counterpart for a customer: no wallet hold, the price and tax come from the checkout session, the order is delivered
// from stock at once when the codes are there, and the dispatch job is queued otherwise.
import { Inject, Injectable } from '@nestjs/common';
import { Decimal } from 'decimal.js';
import { CLOCK, type Clock } from '../../../common/clock';
import { Money } from '../../../common/money';
import type { DbExecutor } from '../../../infra/db';
import { InventoryStock } from '../../catalog';
import type { Order } from '../db/schema';
import { mainInputOf } from '../domain/main-input';
import { placementDispatchState } from '../domain/order-machine';
import { type TimelineLine, SYSTEM_ACTOR, createdLine, manualReviewLine } from '../domain/order-timeline';
import { STOCK_DELIVERY_FROM, stockDeliveryLines } from '../domain/stock-delivery';
import { hasActiveSupplierLink, serviceFieldsOf, storefrontServiceOf } from '../infra/foreign-reads.repository';
import { insertEvents, insertOrder } from '../infra/order.repository';
import { OrderLedger } from './order-ledger';
import { OrderOutbox } from './order-outbox';

/** What the capture of a paid checkout gives placement. */
export interface CustomerPlacementRequest {
  readonly customerId: number;
  readonly checkoutSessionId: number;
  readonly serviceId: number;
  readonly quantity: number;
  /** The IMEI the buyer gave (already decrypted), for an IMEI service. */
  readonly imei: string | undefined;
  /** The order field values by field key. */
  readonly inputs: Readonly<Record<string, string>>;
  /** The whole order's net price and its VAT, USD 4-decimal texts, as the session locked them. */
  readonly net: string;
  readonly tax: string;
  readonly taxCountry: string | null;
  /** The tracking link token the buyer gets (decision 010). */
  readonly publicToken: string;
  /** What the pricing snapshot keeps: the locked currency, rate and tax rate. */
  readonly snapshot: Readonly<Record<string, string>>;
  /** The line that says the payment arrived (`Payment of $4.79 received (Visa •••• 4242)`). */
  readonly paidMessage: string;
}

const CURRENCY = 'USD';

/**
 * Places the order of a paid checkout.
 *
 * Why: scenario b2c-paid step 7: in the capture's transaction the order exists with `customer_id` and a tracking token instead of a
 * merchant, the payment is posted, and an automatic order is queued for dispatch ("B2C never dispatches before payment", CLAUDE.md).
 * Codes in stock are delivered at once like a merchant's order (RULES orders 10). The customer already paid the locked price, so
 * nothing here refuses: a service switched off since is still delivered or worked by hand. The risk hold of feature 18 plugs in at
 * `placementDispatchState({ held })`.
 *
 * Side effects (on the caller's transaction): inserts `orders` and `order_events`; claims and sells stock codes; posts the settlement
 * of a stock delivery; inserts `outbox_events` (`order.dispatch_requested`, or `order.status_changed` for a stock delivery).
 *
 * @see docs/decisions/025-order-state-machine.md
 */
@Injectable()
export class CustomerOrderPlacement {
  constructor(
    private readonly ledger: OrderLedger,
    private readonly outbox: OrderOutbox,
    private readonly stock: InventoryStock,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  /**
   * Places the order.
   *
   * @param tx the capture's transaction
   * @param request the paid session's data
   * @param onInserted runs right after the order row exists and before any delivery: the payment is posted here, so the journal order
   *   is payment first, settlement after
   * @returns the stored order (completed when its codes came from stock)
   */
  async place(
    tx: DbExecutor,
    request: CustomerPlacementRequest,
    onInserted: (order: Order) => Promise<void>,
  ): Promise<Order> {
    const service = await storefrontServiceOf(tx, request.serviceId);
    if (!service) throw new Error(`The paid checkout names service ${request.serviceId}, which does not exist.`);
    const fields = await serviceFieldsOf(tx, service.id);
    const mainInput = mainInputOf({
      type: service.type,
      imei: request.imei,
      inputs:
        request.imei !== undefined && fields.some((field) => field.key === 'imei')
          ? { imei: request.imei, ...request.inputs }
          : request.inputs,
      fields,
      fileName: undefined,
    });
    const hasLink = await hasActiveSupplierLink(tx, service.id);
    const manualService = service.fulfillment === 'manual';
    const claim = await this.stock.claim(tx, service.id, request.quantity);
    const begin = placementDispatchState({
      held: false,
      deliveredFromInventory: claim !== null,
      manualService,
      hasActiveSupplierLink: hasLink,
    });
    const now = this.clock.now();
    const net = Money.of(request.net);
    const unitPrice = Money.of(new Decimal(request.net).div(request.quantity).toDecimalPlaces(4).toFixed(4));
    const unitCost = Money.of(service.effectiveCost);
    const order = await insertOrder(tx, {
      customerId: request.customerId,
      clientId: null,
      serviceId: service.id,
      type: service.type,
      source: 'store',
      status: begin.status,
      dispatchState: begin.dispatchState,
      placedAt: now,
      createdAt: now,
      ...(claim ? { resultCode: claim.codes.join('\n'), completedAt: now } : {}),
      imei: mainInput,
      quantity: request.quantity,
      inputs: { ...request.inputs },
      unitPrice: unitPrice.toWire(),
      totalPrice: net.toWire(),
      unitCost: unitCost.toWire(),
      totalCost: unitCost.mul(request.quantity).toWire(),
      currency: CURRENCY,
      pricingSnapshot: { source: 'storefront', ...request.snapshot },
      publicToken: request.publicToken,
      checkoutSessionId: request.checkoutSessionId,
      taxAmount: Money.of(request.tax).toWire(),
      taxCountry: request.taxCountry,
    });
    const lines: TimelineLine[] = [
      createdLine('store', SYSTEM_ACTOR),
      {
        type: 'paid',
        actor: SYSTEM_ACTOR,
        fromStatus: null,
        toStatus: null,
        data: { message: request.paidMessage },
      },
      ...(begin.dispatchState === 'manual' ? [manualReviewLine()] : []),
    ];
    await insertEvents(tx, rows(order.id, lines));
    await onInserted(order);

    if (claim) {
      await this.stock.sell(tx, claim, order.id);
      const moved = await this.ledger.move(tx, order, 'b2c_deliver', {
        actor: { type: 'system', id: null },
        completedBefore: 0,
        costBooked: false,
      });
      await insertEvents(tx, rows(order.id, stockDeliveryLines(claim.codes.length, moved)));
      await this.outbox.statusChanged(tx, {
        orderId: order.id,
        clientId: null,
        fromStatus: STOCK_DELIVERY_FROM,
        toStatus: order.status,
      });
    }
    if (begin.enqueueDispatch) await this.outbox.dispatchRequested(tx, order.id);
    return order;
  }
}

function rows(orderId: number, lines: readonly TimelineLine[]) {
  return lines.map((line) => ({
    orderId,
    type: line.type,
    fromStatus: line.fromStatus,
    toStatus: line.toStatus,
    actorType: line.actor.type,
    actorId: line.actor.id,
    data: line.data,
  }));
}
