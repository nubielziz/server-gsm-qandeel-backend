// ImeiErasure: erases the IMEI of one customer's stored checks (feature 18, POST /admin/customers/:id/anonymize, RESOLUTIONS b2c-4).
import { Inject, Injectable } from '@nestjs/common';
import { CLOCK, type Clock } from '../../../common/clock';
import type { DbExecutor } from '../../../infra/db';
import { eraseChecksOfCustomer } from '../infra/imei-check-admin.repository';

/**
 * Erases a customer's IMEI checks.
 *
 * Why: anonymizing a customer cuts every stored IMEI the same way the retention job does: `imei_enc`, `imei_hash` and `cached_until`
 * are set to NULL together (so the row no longer matches a lookup), and the address of the check goes too. The customers module calls
 * this inside its own transaction; the risk module owns `imei_checks`.
 *
 * Side effects: updates `imei_checks` on the caller's transaction.
 */
@Injectable()
export class ImeiErasure {
  constructor(@Inject(CLOCK) private readonly clock: Clock) {}

  /**
   * Erases the checks a customer made, or made from a checkout session of theirs.
   *
   * @param tx the caller's transaction
   * @param customerId the customer
   * @returns how many checks were changed
   */
  forCustomer(tx: DbExecutor, customerId: number): Promise<number> {
    return eraseChecksOfCustomer(tx, customerId, this.clock.now());
  }
}
