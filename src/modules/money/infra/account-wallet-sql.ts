// The SQL fragment the staff list of accounts takes from the money module (decision 064): the balance of an account's live wallet. The
// list sorts by it (`_sort=balance`, `wallet:read` only); the application's wiring registers it with `AccountListSql.registerWalletBalance`.
import { type SQL, sql } from 'drizzle-orm';
import type { WalletBalanceSql } from '../../identity';
import { BASE_CURRENCY } from '../domain/accounts';

/**
 * The one stored group kind that carries merchant rights (`rankKindOf` of the identity module says the same: only `b2b` is a merchant).
 *
 * Why: the fragment reads the rank's kind in SQL, so the word is repeated here; a new group kind gives retail rights, so the live wallet of
 * every other kind is the store balance.
 */
const MERCHANT_GROUP_KIND = 'b2b';

/**
 * Builds the SQL of the balance of an account's live wallet.
 *
 * Why: the list of accounts sorts and filters by the balance in one query. The live wallet is the one of the kind of the
 * account's rank: `client_wallet` for a merchant rank, `customer_wallet` for any other; a wallet of the other kind that a rank change left
 * behind holds zero and is not shown. An account with no wallet reads as zero, so it sorts with the zero balances. The balance is the one
 * stored on the account, in its own sign (positive is the account's money), read from the ledger and never cached (decision 022).
 *
 * @param accountIdColumn the column that holds the account id in the list query (for example `clients.id`)
 * @returns a scalar numeric expression: a correlated subquery that is never null
 * @see GET /admin/clients
 */
export const walletBalanceSql: WalletBalanceSql = (accountIdColumn: SQL): SQL => sql`coalesce(
  (select wallet.balance
     from ledger_accounts wallet
    where wallet.owner_type = 'account'
      and wallet.owner_id = ${accountIdColumn}
      and wallet.currency = ${BASE_CURRENCY}
      and wallet.kind = (
        select case when rank_group.kind = ${MERCHANT_GROUP_KIND} then 'client_wallet' else 'customer_wallet' end
          from clients rank_owner
          join client_groups rank_group on rank_group.id = rank_owner.group_id
         where rank_owner.id = ${accountIdColumn})),
  0::numeric)`;
