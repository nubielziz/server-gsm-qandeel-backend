// The two seams money keeps for the modules that sit above it in the import graph (decision 032): the orders module cancels and annotates
// storefront orders for a refund or a dispute, and the customers module turns a confirmed payment into an order. Money cannot import
// either (orders and customers import money), so each registers its implementation at boot, like the webhook verifiers of identity.
import { Injectable } from '@nestjs/common';
import type { DbExecutor } from '../../../infra/db';
import type { Order } from '../../orders';
import type { Payment, PaymentGateway } from '../db/schema';
import type { PaymentEvent } from '../infra/gateway-drivers/driver';

/** Who acts on an order: the timeline and the ledger record the same actor. */
export interface PortActor {
  readonly type: 'staff' | 'system';
  readonly id: number | null;
}

/** One line a storefront refund or dispute adds to the order timeline. */
export interface PortTimelineLine {
  readonly type: 'refund' | 'dispute' | 'note';
  readonly message: string;
  /** Extra ids and amounts for the line; never personal data. */
  readonly data?: Record<string, string | number | boolean | null>;
}

/**
 * What money asks of the orders module for a storefront refund or dispute.
 *
 * Why: approving a refund of an order that was not delivered cancels the order through the state machine (decision 025), and every
 * refund and dispute writes a line on the order's timeline; both are orders' tables and rules.
 */
export interface StorefrontOrderPort {
  /**
   * Cancels an open storefront order because staff approved its refund (the order becomes `rejected`, its money posts through the
   * refund the caller names).
   *
   * @param tx the approval's transaction
   * @param input the order, who approved, the refund that is being paid out and the reason the buyer sees
   * @throws {AppError} `ORDER_NOT_OPEN` when the order is closed by now, `INVALID_TRANSITION` when another request moved it first
   */
  cancelForRefund(
    tx: DbExecutor,
    input: { orderId: number; actor: PortActor; refundId: number; reason: string },
  ): Promise<void>;
  /**
   * Adds a line to an order's timeline.
   *
   * @param tx the caller's transaction
   * @param orderId the order
   * @param actor who caused it
   * @param line the line
   */
  addTimeline(tx: DbExecutor, orderId: number, actor: PortActor, line: PortTimelineLine): Promise<void>;
}

/**
 * The slot the orders module fills with its {@link StorefrontOrderPort}.
 *
 * Why: the slot is one per process (a static field), not one per Nest module instance: the worker and the API build several copies of the
 * money providers (a module that cannot import another builds its own), and every copy must find the implementation the orders module
 * registered.
 */
@Injectable()
export class StorefrontOrderPorts {
  private static port: StorefrontOrderPort | undefined;

  /**
   * Registers the implementation (the orders module, at boot).
   *
   * @param port what money may ask of orders
   */
  set(port: StorefrontOrderPort): void {
    StorefrontOrderPorts.port = port;
  }

  /**
   * Reads the implementation.
   *
   * @returns the registered port
   * @throws {Error} when the orders module is not loaded in this process (a wiring bug, never a client error)
   */
  get(): StorefrontOrderPort {
    if (!StorefrontOrderPorts.port) {
      throw new Error('The orders module has not registered its storefront port in this process.');
    }
    return StorefrontOrderPorts.port;
  }
}

/** A confirmed storefront payment, as the capture needs it. */
export interface CaptureRequest {
  /** The pending order payment the confirmation names, locked by the caller. */
  readonly payment: Payment;
  /** The gateway it came through. */
  readonly gateway: PaymentGateway;
  /** What the driver read from the signed event. */
  readonly event: PaymentEvent;
}

/** What the capture did. */
export interface CaptureOutcome {
  /** `captured` created the order; `duplicate` means the session was already paid and the money was refunded; `held` left the payment for review. */
  readonly result: 'captured' | 'duplicate' | 'held';
  readonly orderId: number | null;
}

/**
 * What money asks of the customers module when a payment is confirmed: turn the paid checkout into an order.
 *
 * Why: scenario b2c-paid steps 6 to 8: in one transaction the payment is captured, the checkout session is paid, the order exists, and
 * the payment is posted. The session and its consents are the customers module's; the order is orders'; money posts and records.
 */
export interface StorefrontCapture {
  /**
   * Captures a confirmed payment.
   *
   * @param tx the webhook's transaction
   * @param request the payment, its gateway and the event
   * @returns what happened
   */
  capture(tx: DbExecutor, request: CaptureRequest): Promise<CaptureOutcome>;
}

/** The slot the customers module fills with its {@link StorefrontCapture} (one per process, like {@link StorefrontOrderPorts}). */
@Injectable()
export class StorefrontCaptures {
  private static capture: StorefrontCapture | undefined;

  /**
   * Registers the implementation (the customers module, at boot).
   *
   * @param capture what money may ask of customers
   */
  set(capture: StorefrontCapture): void {
    StorefrontCaptures.capture = capture;
  }

  /**
   * Reads the implementation.
   *
   * @returns the registered capture
   * @throws {Error} when the customers module is not loaded in this process (a wiring bug, never a client error)
   */
  get(): StorefrontCapture {
    if (!StorefrontCaptures.capture) {
      throw new Error('The customers module has not registered its storefront capture in this process.');
    }
    return StorefrontCaptures.capture;
  }
}

/** The order columns money reads while it refunds: kept narrow so the port types stay free of the orders module. */
export type RefundedOrder = Pick<Order, 'id' | 'customerId' | 'totalPrice' | 'taxAmount' | 'status' | 'currency'>;
