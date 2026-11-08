// CustomerErasureHooks: the leaf through which other modules clear what they hold about a customer when the customer is anonymized,
// inside the anonymization's own transaction, without the customers module importing them (decision 032; feature 17's ticket token).
import { Injectable } from '@nestjs/common';
import type { DbExecutor } from '../../../infra/db';

/** Someone who holds personal data of a customer and must let go of it when the customer is anonymized. */
export interface CustomerErasureHook {
  /**
   * Called after the customer row was anonymized, in the same transaction. Throwing rolls the whole anonymization back.
   *
   * @param tx the anonymization's transaction
   * @param customerId the customer
   */
  eraseCustomer(tx: DbExecutor, customerId: number): Promise<void>;
}

/**
 * The list of hooks run by `POST /admin/customers/:id/anonymize`.
 *
 * Why: the support feature keeps a ticket token (a capability link) for a customer's tickets; the token is personal data that must go
 * with the customer. The support module registers its hook at boot; the customers module only calls the list.
 *
 * Side effects: none of its own; each hook writes on the anonymization's transaction.
 */
@Injectable()
export class CustomerErasureHooks {
  private readonly hooks: CustomerErasureHook[] = [];

  /**
   * Adds a hook (called once at boot by the module that holds the data).
   *
   * @param hook who to tell
   */
  add(hook: CustomerErasureHook): void {
    this.hooks.push(hook);
  }

  /**
   * Runs every hook for a customer.
   *
   * @param tx the anonymization's transaction
   * @param customerId the customer
   * @throws whatever a hook throws (the anonymization rolls back)
   */
  async run(tx: DbExecutor, customerId: number): Promise<void> {
    for (const hook of this.hooks) await hook.eraseCustomer(tx, customerId);
  }
}
