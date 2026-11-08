// The support module's part of customer anonymization (feature 18, B175): it clears the ticket page links of the customer being erased.
// Registered with the customers module's hook list at boot, so the customers module never imports support.
import { Injectable, Module, type OnModuleInit } from '@nestjs/common';
import type { DbExecutor } from '../../infra/db';
import { type CustomerErasureHook, CustomerErasureHooks, CustomerErasureModule } from '../customers';
import { clearTicketTokensOfCustomer } from './infra/ticket.repository';

/**
 * Sets the token of a customer's tickets to NULL when the customer is anonymized.
 *
 * Why: `POST /admin/customers/:id/anonymize` must leave no way back to the customer's data. A ticket's capability token (decision 010) is
 * mailed to the customer and opens the thread without any account, so it is personal data that outlives the account. After the hook
 * `GET /store/v1/tickets/:token` answers 404 for the old link. The tickets and messages themselves stay (staff history); a ticket of a
 * merchant is not touched.
 *
 * Side effects: updates `support_tickets.token` on the anonymization's transaction; a failure rolls the whole anonymization back.
 */
@Injectable()
export class SupportCustomerErasure implements CustomerErasureHook, OnModuleInit {
  constructor(private readonly hooks: CustomerErasureHooks) {}

  /** Adds this hook to the customers module's list. */
  onModuleInit(): void {
    this.hooks.add(this);
  }

  /**
   * Clears the ticket links of one customer.
   *
   * @param tx the anonymization's transaction
   * @param customerId the customer
   */
  async eraseCustomer(tx: DbExecutor, customerId: number): Promise<void> {
    await clearTicketTokensOfCustomer(tx, customerId);
  }
}

/**
 * Provides {@link SupportCustomerErasure}.
 *
 * Why: it needs only the hook list (a global leaf of the customers module) and writes through the transaction it is given, so it needs
 * no database provider of its own and a test app built without a database can load it.
 */
@Module({ imports: [CustomerErasureModule], providers: [SupportCustomerErasure] })
export class SupportErasureModule {}
