// Unit tests of the wallet balance fragment of the account list: the SQL it renders, without a database (the integration test
// `account-wallet-admin.test.ts` runs it against the ledger). The list sorts by it, so it must never be null and must pick the wallet of the
// kind of the rank (decision 064).
import { describe, expect, it } from 'bun:test';
import { sql } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';
import { walletBalanceSql } from '@src/modules/money/infra/account-wallet-sql';

const render = (column = sql`c.id`) => new PgDialect().sqlToQuery(walletBalanceSql(column));

describe('walletBalanceSql', () => {
  it('reads the balance of the account wallet of the kind of its rank, owned by (account, id)', () => {
    const { sql: text, params } = render();
    expect(text).toContain("wallet.owner_type = 'account'");
    expect(text).toContain("'client_wallet'");
    expect(text).toContain("'customer_wallet'");
    expect(text).toContain('join client_groups rank_group on rank_group.id = rank_owner.group_id');
    // The currency and the one merchant group kind are bound values, never text of the statement.
    expect(params).toEqual(['USD', 'b2b']);
  });

  it('is never null, so a sort by it keeps the accounts without a wallet with the zero balances', () => {
    expect(render().sql.trim().startsWith('coalesce(')).toBe(true);
    expect(render().sql).toContain('0::numeric');
  });

  it('puts the account id column where the list says, twice (the wallet row and the rank row)', () => {
    const { sql: text } = render(sql`accounts.id`);
    expect(text.split('accounts.id')).toHaveLength(3);
  });
});
