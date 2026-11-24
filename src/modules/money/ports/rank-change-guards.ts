// The registry of the checks that can block a rank change (decision 064). Complete here: the orders and customers modules register
// their checks at boot; the money module's own blockers join them in the rank change use case.
import { Injectable } from '@nestjs/common';
import type { Transaction } from '../../../infra/db';

/**
 * The reasons a rank change can be blocked, as the 409 answer names them (`errors[].code`).
 *
 * Why: staff see every blocker at once and fix them in one go, so the codes are a closed list the console words.
 */
export type RankBlockerCode =
  | 'guest'
  | 'open_hold'
  | 'live_order'
  | 'open_topup'
  | 'open_dispute'
  | 'open_refund'
  | 'open_checkout'
  | 'frozen'
  | 'negative_balance'
  | 'credit_limit';

/**
 * A check of the rank change: it reads and returns the codes that apply, or an empty list.
 *
 * @param tx the rank change's transaction, after the account and its ledger accounts are locked
 * @param accountId the account
 * @returns the blocker codes the module finds for the account
 */
export type RankChangeCheck = (tx: Transaction, accountId: number) => Promise<RankBlockerCode[]>;

/**
 * The blocker checks of the rank change, registered by the modules that own the data.
 *
 * Why: a rank change moves money and ends sessions, so it must not run while an order is live or a checkout is open; money does not
 * read other modules' tables (decision 016), so the orders module registers `live_order` and the customers module `open_checkout`. The
 * rank change collects every blocker before it writes anything.
 *
 * Side effects: none of its own; a registered check reads the database.
 *
 * @see POST /admin/clients/:id/rank
 */
@Injectable()
export class RankChangeGuards {
  private readonly checks = new Map<string, RankChangeCheck>();

  /**
   * Adds a check.
   *
   * @param name the name of the check, unique (it names the owner in a boot error)
   * @param check the check
   * @throws {Error} when the name is already registered (a boot-time programming error)
   */
  register(name: string, check: RankChangeCheck): void {
    if (this.checks.has(name)) throw new Error(`A rank change check named "${name}" is already registered`);
    this.checks.set(name, check);
  }

  /**
   * Runs every check, in registration order, and collects what they find.
   *
   * @param tx the rank change's transaction
   * @param accountId the account
   * @returns every blocker code found, each once, in the order found
   */
  async blockersOf(tx: Transaction, accountId: number): Promise<RankBlockerCode[]> {
    const found = new Set<RankBlockerCode>();
    for (const check of this.checks.values()) for (const code of await check(tx, accountId)) found.add(code);
    return [...found];
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
