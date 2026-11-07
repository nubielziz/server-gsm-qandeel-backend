// MerchantSpend: the cumulative completed-order spend of merchants in USD, read from the ledger. Used by the nightly group
// promotion job of the identity module (user rule 1); read-only.
import { Injectable } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { Money } from '../../../common/money';
import type { DbExecutor } from '../../../infra/db';
import { ledgerAccounts, ledgerEntries, ledgerTransactions } from '../db/schema';

/** The currency of a merchant's hold account today (decision 011). */
const SPEND_CURRENCY = 'USD';
/** The ledger kind a completed order posts (money events `complete` and `b2c_deliver`, decision 024). */
const SETTLE_KIND = 'order_settle';

/** The most merchants one query looks at; a longer list is read in several queries. */
const CHUNK = 1000;

/**
 * Reads what merchants have spent on completed orders.
 *
 * Why: user rule 1 (ANSWERS merchants Q7): a merchant is promoted by cumulative completed-order spend in USD since the account
 * was created. The ledger is the source of truth (decision 024), so the figure is the sum of the `order_settle` debits on the
 * merchant's `client_hold` account (the `complete` event moves the order price from the hold to revenue), minus the settlements
 * that were reversed. A settlement is reversed when a transaction with the idempotency key `reverse:<its id>` exists (decision
 * 024: reopening an order and a B2B refund post such a reversing transaction), so a reopened or refunded order counts for
 * nothing. Until feature 5 settles orders every merchant reads as zero.
 *
 * Side effects: none (reads only; the figure is never cached, decision 022).
 */
@Injectable()
export class MerchantSpend {
  /**
   * Sums the completed spend of several merchants.
   *
   * @param db the database or the caller's transaction
   * @param clientIds the merchants
   * @returns the spend of every merchant in `clientIds` (zero for a merchant with no settled order)
   */
  async completedSpend(db: DbExecutor, clientIds: readonly number[]): Promise<Map<number, Money>> {
    const spend = new Map<number, Money>(clientIds.map((id) => [id, Money.zero()]));
    for (let start = 0; start < clientIds.length; start += CHUNK) {
      const ids = clientIds.slice(start, start + CHUNK);
      const result = await db.execute<{ client_id: string; spend: string }>(sql`
        select hold.owner_id as client_id, sum(entry.amount) as spend
        from ${ledgerEntries} entry
        join ${ledgerTransactions} tx on tx.id = entry.transaction_id
        join ${ledgerAccounts} hold on hold.id = entry.account_id
        where hold.kind = 'client_hold'
          and hold.owner_type = 'client'
          and hold.currency = ${SPEND_CURRENCY}
          and hold.owner_id in (${sql.join(
            ids.map((id) => sql`${id}`),
            sql`, `,
          )})
          and tx.kind = ${SETTLE_KIND}
          and entry.amount > 0
          and not exists (
            select 1 from ${ledgerTransactions} reversal where reversal.idempotency_key = 'reverse:' || tx.id::text
          )
        group by hold.owner_id`);
      for (const row of result.rows) spend.set(Number(row.client_id), Money.fromWire(row.spend));
    }
    return spend;
  }
}
