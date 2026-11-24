// OpenCheckoutGuard: the `open_checkout` blocker of the rank change (decision 064), registered with money's
// `RankChangeGuards` when the module starts.
import { Inject, Injectable, type OnModuleInit } from '@nestjs/common';
import { CLOCK, type Clock } from '../../../common/clock';
import type { Transaction } from '../../../infra/db';
import { type RankBlockerCode, RankChangeGuards } from '../../money';
import { hasOpenSignedInCheckout } from '../infra/checkout.repository';

/** The name the check is registered under (a repeated name is a boot error). */
export const OPEN_CHECKOUT_GUARD = 'open_checkout';

/**
 * Blocks a rank change while the account has a checkout it opened signed in that is neither paid nor expired.
 *
 * Why: decision 064. Such a session may be paid from the store balance, and the balance belongs to the retail rank; a crossing to the
 * merchant kind while it lives would leave a session that cannot be paid the way it was opened. Money cannot read the checkout tables
 * (decision 016), so the customers module registers the check at boot and the rank change runs it after it holds the account row
 * `FOR UPDATE`: an open that started earlier holds the row `FOR KEY SHARE` and is seen here, one that starts later finds the new rank and
 * refuses (`CheckoutSessionService.open`). A guest checkout never counts: it was not opened by the account, and a guest row has no rank
 * to change. Judged on the injected clock (decision 031).
 *
 * Side effects: none of its own; it reads `checkout_sessions`.
 *
 * @see POST /admin/clients/:id/rank
 */
@Injectable()
export class OpenCheckoutGuard implements OnModuleInit {
  constructor(
    private readonly guards: RankChangeGuards,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  /** Registers the check with the rank change. */
  onModuleInit(): void {
    this.guards.register(OPEN_CHECKOUT_GUARD, (tx, accountId) => this.check(tx, accountId));
  }

  /**
   * Looks for an open checkout of one account.
   *
   * @param tx the rank change's transaction, after the account row is locked
   * @param accountId the account
   * @returns `['open_checkout']` when the account has a signed-in checkout that is neither paid nor expired, else an empty list
   */
  async check(tx: Transaction, accountId: number): Promise<RankBlockerCode[]> {
    return (await hasOpenSignedInCheckout(tx, accountId, this.clock.now())) ? ['open_checkout'] : [];
  }
}
