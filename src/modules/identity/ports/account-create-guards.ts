// The registry of the checks a staff create of an account runs before it writes (decision 064). Complete here: the modules add their checks at boot.
import { Injectable } from '@nestjs/common';
import type { Transaction } from '../../../infra/db';
import type { RankKind } from './rank-kind';

/** What a create check sees: the email as normalised and the kind of the rank the account is created with. */
export interface AccountCreateFacts {
  readonly email: string;
  readonly rankKind: RankKind;
}

/**
 * A check of the create: it throws the refusal (an `AppError`) or returns.
 *
 * @param tx the create's transaction
 * @param facts the email and the rank kind
 */
export type AccountCreateCheck = (tx: Transaction, facts: AccountCreateFacts) => Promise<void>;

/**
 * The checks of the staff create of an account, registered by the modules that own the rule.
 *
 * Why: identity creates accounts but must not know every rule about who may be created: the customers module owns the blocklist check
 * (a blocked email cannot get an account), and a later rule joins by registering, not by editing the create. The create calls `run` before
 * it writes anything.
 *
 * Side effects: none of its own; a registered check may read the database.
 */
@Injectable()
export class AccountCreateGuards {
  private readonly checks = new Map<string, AccountCreateCheck>();

  /**
   * Adds a check.
   *
   * @param name the name of the check, unique (it names the owner in a boot error)
   * @param check the check
   * @throws {Error} when the name is already registered (a boot-time programming error)
   */
  register(name: string, check: AccountCreateCheck): void {
    if (this.checks.has(name)) throw new Error(`An account create check named "${name}" is already registered`);
    this.checks.set(name, check);
  }

  /**
   * Runs every check, in registration order, and stops at the first refusal.
   *
   * @param tx the create's transaction
   * @param facts the email and the rank kind
   * @throws {AppError} whatever the first refusing check throws (nothing is written then: the create has not started)
   */
  async run(tx: Transaction, facts: AccountCreateFacts): Promise<void> {
    for (const check of this.checks.values()) await check(tx, facts);
  }

  /**
   * Lists the registered names.
   *
   * @returns the names in registration order (the wiring test reads it)
   */
  names(): readonly string[] {
    return [...this.checks.keys()];
  }
}
