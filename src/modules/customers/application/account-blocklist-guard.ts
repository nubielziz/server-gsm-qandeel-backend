// AccountBlocklistGuard: the blocklist check of the staff create of an account (decision 064), registered with identity's
// `AccountCreateGuards` when the module starts.
import { Injectable, type OnModuleInit } from '@nestjs/common';
import type { Transaction } from '../../../infra/db';
import { AccountCreateGuards, type AccountCreateFacts } from '../../identity';
import { Blocklist } from '../../risk';
import { emailBlocked } from './customer-errors';

/** The name the check is registered under (a repeated name is a boot error). */
export const ACCOUNT_BLOCKLIST_GUARD = 'blocklist';

/**
 * Refuses to create an account for an email that is on the blocklist.
 *
 * Why: a blocked person must not get a new account by a staff member typing the address again (B46, b2c-16): `422` on `email` with the
 * blocklist's own words. Identity creates accounts but cannot read the blocklist (the risk module owns it), so the customers module
 * registers the rule at boot and the create runs it before it writes anything. The old merchant create had no such check; the one create
 * serves every rank now, so a merchant rank is refused too.
 *
 * Side effects: none of its own; it reads `blocklist_entries`.
 *
 * @see POST /admin/clients
 */
@Injectable()
export class AccountBlocklistGuard implements OnModuleInit {
  constructor(
    private readonly guards: AccountCreateGuards,
    private readonly blocklist: Blocklist,
  ) {}

  /** Registers the check with the create. */
  onModuleInit(): void {
    this.guards.register(ACCOUNT_BLOCKLIST_GUARD, (tx, facts) => this.check(tx, facts));
  }

  /**
   * Checks one email.
   *
   * @param tx the create's transaction
   * @param facts the email as normalised and the kind of the rank the account is created with
   * @throws {AppError} `VALIDATION_FAILED` (422) on `email` when the address is blocked
   */
  async check(tx: Transaction, facts: AccountCreateFacts): Promise<void> {
    if (await this.blocklist.isEmailBlocked(tx, facts.email)) throw emailBlocked();
  }
}
