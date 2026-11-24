// LiveOrdersGuard: the `live_order` check of the rank change (decision 064), registered with the money module's
// `RankChangeGuards` when the module starts.
import { Injectable, type OnModuleInit } from '@nestjs/common';
import type { Transaction } from '../../../infra/db';
import { RankChangeGuards, type RankBlockerCode } from '../../money';
import { hasLiveOrder } from '../infra/buyer.repository';

/** The name the check is registered under (a repeated name is a boot error). */
export const LIVE_ORDERS_GUARD = 'live_order';

/**
 * Blocks a rank change while the account has an order in flight.
 *
 * Why: a rank change moves the balance from one wallet kind to the other and ends every session. An order that is open (pending or
 * processing), or completed with a verification request still open, has its money on the old kind's path (the merchant hold, or customer
 * funds), so it must finish first: staff then change the rank with nothing live. The money module cannot read the orders table (module
 * ownership), so the orders module registers the rule at boot and the rank change runs it after it locked the account row and its ledger
 * accounts, together with every other blocker. Any door counts: the orders of a guest row that shares an email with the account belong to
 * another account and are not seen.
 *
 * Side effects: none of its own; it reads `orders`.
 *
 * @see POST /admin/clients/:id/rank
 */
@Injectable()
export class LiveOrdersGuard implements OnModuleInit {
  constructor(private readonly guards: RankChangeGuards) {}

  /** Registers the check with the rank change. */
  onModuleInit(): void {
    this.guards.register(LIVE_ORDERS_GUARD, (tx, accountId) => this.blockersOf(tx, accountId));
  }

  /**
   * Looks for an order in flight.
   *
   * @param tx the rank change's transaction
   * @param accountId the account
   * @returns `['live_order']` when the account has one, otherwise an empty list
   */
  async blockersOf(tx: Transaction, accountId: number): Promise<RankBlockerCode[]> {
    return (await hasLiveOrder(tx, accountId)) ? ['live_order'] : [];
  }
}
