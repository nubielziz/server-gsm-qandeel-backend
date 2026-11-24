// AccountErasureHooks: the leaf through which other modules clear what they hold about an account when the account is anonymized, inside the
// anonymization's own transaction, without the customers module importing them (decision 032; feature 17's ticket token; decision 064).
import { Injectable } from '@nestjs/common';
import type { DbExecutor } from '../../../infra/db';

/** Someone who holds personal data of an account and must let go of it when the account is anonymized. */
export interface AccountErasureHook {
  /**
   * Called after the account row was anonymized, in the same transaction. Throwing rolls the whole anonymization back.
   *
   * @param tx the anonymization's transaction
   * @param accountId the account (the guest row of a proven email is erased with the same call: it is an account row too)
   */
  eraseAccount(tx: DbExecutor, accountId: number): Promise<void>;
}

/**
 * The list of hooks run by `POST /admin/clients/:id/anonymize`.
 *
 * Why: the support feature keeps a ticket token (a capability link) for the tickets of an account and the inbox keeps its messages; both are
 * personal data that must go with the account. The modules that hold them register their hook at boot; the customers module only calls the
 * list, once for the account and once more for the guest row of its proven email.
 *
 * Side effects: none of its own; each hook writes on the anonymization's transaction.
 */
@Injectable()
export class AccountErasureHooks {
  private readonly hooks: AccountErasureHook[] = [];

  /**
   * Adds a hook (called once at boot by the module that holds the data).
   *
   * @param hook who to tell
   */
  add(hook: AccountErasureHook): void {
    this.hooks.push(hook);
  }

  /**
   * Runs every hook for an account.
   *
   * @param tx the anonymization's transaction
   * @param accountId the account
   * @throws whatever a hook throws (the anonymization rolls back)
   */
  async run(tx: DbExecutor, accountId: number): Promise<void> {
    for (const hook of this.hooks) await hook.eraseAccount(tx, accountId);
  }
}
