// The customers module's part of erasing the notification center's data about an account (feature 23, plan section 9.7; decision 064).
import { Injectable, type OnModuleInit } from '@nestjs/common';
import type { DbExecutor } from '../../../infra/db';
import { NotificationPrivacy } from '../../platform';
import { type AccountErasureHook, AccountErasureHooks } from '../application/customer-erasure-hooks';

/**
 * Deletes an account's inbox items and empties its log payloads when the account is anonymized.
 *
 * Why: `POST /admin/clients/:id/anonymize` must leave no way back to the account's data (any rank, and the guest row of its proven email, which
 * the hook list is called for too): the inbox repeats orders and announcements and a log row's payload holds the account's name. Registered
 * with the hook list at boot, so the anonymization runs it in its own transaction (a failure rolls the whole anonymization back). The class
 * keeps its old name so the module that provides it needs no change; it serves every rank now.
 *
 * Side effects: deletes `notification_inbox` rows and updates `notifications.payload` on the anonymization's transaction.
 *
 * @see POST /admin/clients/:id/anonymize
 */
@Injectable()
export class CustomerInboxErasure implements AccountErasureHook, OnModuleInit {
  constructor(
    private readonly hooks: AccountErasureHooks,
    private readonly privacy: NotificationPrivacy,
  ) {}

  /** Adds this hook to the customers module's list. */
  onModuleInit(): void {
    this.hooks.add(this);
  }

  /**
   * Erases one account's notification data.
   *
   * @param tx the anonymization's transaction
   * @param accountId the account
   */
  async eraseAccount(tx: DbExecutor, accountId: number): Promise<void> {
    await this.privacy.eraseRecipient(tx, 'account', accountId);
  }
}
