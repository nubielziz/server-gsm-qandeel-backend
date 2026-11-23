// The seam the orders module keeps for the customers module, which sits above it in the import graph (decision 032): whether the customer of
// an order was anonymized, so the order's tracking link opens nothing after the erasure. Orders cannot import customers (customers imports
// orders), so the customers module registers its implementation at boot, like money's storefront ports.
import { Injectable } from '@nestjs/common';
import type { DbExecutor } from '../../../infra/db';

/**
 * What the orders module asks of the customers module about the customer of a storefront order.
 *
 * Why: after staff anonymize a customer, the tracking link of the customer's orders (the status, the result and the receipt) answers as an
 * unknown link. The customer's status is the customers module's table.
 */
export interface TrackingCustomerPort {
  /**
   * Tells whether a customer is anonymized or gone.
   *
   * @param db the database or the caller's transaction
   * @param customerId the customer of the order
   * @returns true when the customer was anonymized or no longer exists
   */
  isErased(db: DbExecutor, customerId: number): Promise<boolean>;
}

/**
 * The slot the customers module fills with its {@link TrackingCustomerPort}.
 *
 * Why: one per process (a static field), not one per Nest module instance, like money's `StorefrontOrderPorts`: every copy of the
 * tracking providers must find the implementation the customers module registered.
 */
@Injectable()
export class TrackingCustomerPorts {
  private static port: TrackingCustomerPort | undefined;

  /**
   * Registers the implementation (the customers module, at boot).
   *
   * @param port what orders may ask of customers
   */
  set(port: TrackingCustomerPort): void {
    TrackingCustomerPorts.port = port;
  }

  /**
   * Reads the implementation.
   *
   * @returns the registered port
   * @throws {Error} when the customers module is not loaded in this process (a wiring bug, never a client error)
   */
  get(): TrackingCustomerPort {
    if (!TrackingCustomerPorts.port) {
      throw new Error('The customers module has not registered its tracking customer port in this process.');
    }
    return TrackingCustomerPorts.port;
  }
}
