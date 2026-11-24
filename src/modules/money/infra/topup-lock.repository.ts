// The advisory lock that serialises the top-ups of one account (decision 064): both top-up creates, both receipt uploads and the rank change take it.
import { sql } from 'drizzle-orm';
import type { DbExecutor } from '../../../infra/db';

/**
 * Takes the transaction-scoped advisory lock of one account's top-ups.
 *
 * Why: the limit checks of a top-up read the account's recent top-ups and then insert one, so two creates of one account must not both pass
 * the checks; the rank change takes the same lock so that no top-up is created while the wallet kind changes. The lock waits, ends with the
 * transaction and is taken after the account row (key share) and before the ledger accounts, in the lock order of money paths. No network
 * call and no posting happens while it is held.
 *
 * Side effects: holds `pg_advisory_xact_lock(hashtextextended('topup:<accountId>', 0))` until the transaction ends.
 *
 * @param tx the transaction
 * @param accountId the account
 */
export async function lockAccountTopUps(tx: DbExecutor, accountId: number): Promise<void> {
  await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`topup:${accountId}`}, 0))`);
}
