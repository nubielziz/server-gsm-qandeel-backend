// The customers module's part of erasing the notification center's data about a customer (feature 23, plan section 9.7).
import { Injectable, type OnModuleInit } from '@nestjs/common';
import type { DbExecutor } from '../../../infra/db';
import { NotificationPrivacy } from '../../platform';
import { type CustomerErasureHook, CustomerErasureHooks } from '../application/customer-erasure-hooks';

/**
 * Deletes a customer's inbox items and empties their log payloads when the customer is anonymized.
 *
 * Why: `POST /admin/customers/:id/anonymize` must leave no way back to the customer's data; the inbox repeats orders and announcements
 * and a log row's payload holds the customer's name. Registered with the hook list at boot, so the anonymization runs it in its own
 * transaction (a failure rolls the whole anonymization back).
 *
 * Side effects: deletes `notification_inbox` rows and updates `notifications.payload` on the anonymization's transaction.
 */
@Injectable()
export class CustomerInboxErasure implements CustomerErasureHook, OnModuleInit {
  constructor(
    private readonly hooks: CustomerErasureHooks,
    private readonly privacy: NotificationPrivacy,
  ) {}

  /** Adds this hook to the customers module's list. */
  onModuleInit(): void {
    this.hooks.add(this);
  }

  /**
   * Erases one customer's notification data.
   *
   * @param tx the anonymization's transaction
   * @param customerId the customer
   */
  async eraseCustomer(tx: DbExecutor, customerId: number): Promise<void> {
    await this.privacy.eraseRecipient(tx, 'customer', customerId);
  }
}
