// OrderSettlements: finds the settlement of an order that a reopen or a B2B refund must reverse (decision 024, decision 025). Read
// only; the orders module posts the reversal with the key `reverse:<settlement id>` that MerchantSpend recognises.
import { Injectable } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import type { DbExecutor } from '../../../infra/db';
import { ledgerTransactions } from '../db/schema';

/** The settlement of an order that is still in force. */
export interface Settlement {
  /** `ledger_transactions.id`. */
  readonly id: number;
}

/** The ledger kind a completed order posts (money events `complete` and `b2c_deliver`). */
const SETTLE_KIND = 'order_settle';

/**
 * Reads an order's settlement from the ledger.
 *
 * Why: reopening a completed order and refunding it both reverse the revenue that its settlement recognised. The reversal's
 * idempotency key is `reverse:<settlement id>` (decision 024), which is also how `MerchantSpend` knows a settlement no longer
 * counts, so the orders module needs the id of the one settlement still in force. The orders module may not read ledger tables,
 * and the demo seed's settlements carry the order as `ref_type order` and `ref_id`, never a key the orders module could guess,
 * so this reads by reference.
 *
 * Side effects: none (reads only; never cached, decision 022).
 */
@Injectable()
export class OrderSettlements {
  /**
   * Finds the settlement of an order that has not been reversed.
   *
   * @param db the caller's transaction (the order row is already locked by its guarded update)
   * @param orderId the order
   * @returns the newest settlement without a reversing transaction, or `undefined` when the order was never settled or every
   *   settlement was reversed
   */
  async liveOf(db: DbExecutor, orderId: number): Promise<Settlement | undefined> {
    const result = await db.execute<{ id: string }>(sql`
      select tx.id
      from ${ledgerTransactions} tx
      where tx.ref_type = 'order'
        and tx.ref_id = ${orderId}
        and tx.kind = ${SETTLE_KIND}
        and not exists (
          select 1 from ${ledgerTransactions} reversal where reversal.idempotency_key = 'reverse:' || tx.id::text
        )
      order by tx.id desc
      limit 1`);
    const row = result.rows[0];
    return row ? { id: Number(row.id) } : undefined;
  }
}
