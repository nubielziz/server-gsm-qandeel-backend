// CustomerDirectory as a module of its own: the support module imports it for its guest customers. It needs only the clock, so a test app
// built without a database keeps it, like the legal documents of the storefront module. The API and the worker load it: it fills the
// slots of orders and money at boot.
import { Injectable, Module, type OnModuleInit } from '@nestjs/common';
import { ReceiptBuyerPorts } from '../money';
import { TrackingCustomerPorts } from '../orders';
import { CustomerDirectory } from './application/customer-directory';

/**
 * Puts {@link CustomerDirectory} in the slots of the orders module (`TrackingCustomerPorts`: the tracking link of an anonymized customer
 * opens nothing) and the money module (`ReceiptBuyerPorts`: whom a receipt names).
 *
 * Why: orders and money cannot import the customers module (decision 032), so the owner of `customers` and `checkout_sessions` registers.
 * The slots keep one implementation per process, so the copies this module lists are the same slots the tracking and receipt providers read.
 *
 * Side effects: registers the directory in both slots at boot.
 */
@Injectable()
export class CustomerDirectoryRegistration implements OnModuleInit {
  constructor(
    private readonly directory: CustomerDirectory,
    private readonly trackingCustomers: TrackingCustomerPorts,
    private readonly receiptBuyers: ReceiptBuyerPorts,
  ) {}

  /** Fills the slots of the orders and money modules. */
  onModuleInit(): void {
    this.trackingCustomers.set(this.directory);
    this.receiptBuyers.set(this.directory);
  }
}

/**
 * Provides and exports {@link CustomerDirectory}, and registers it with the slots of orders and money.
 *
 * Why: `customers` belongs to this module, so support reaches it through this public service (decision 016); a separate module lets
 * support import the directory without the checkout or the sign-in routes.
 */
@Module({
  providers: [CustomerDirectory, CustomerDirectoryRegistration, TrackingCustomerPorts, ReceiptBuyerPorts],
  exports: [CustomerDirectory],
})
export class CustomerDirectoryModule {}
