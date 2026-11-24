// The money side of the expand migration of one account type (backend decision 064) on the realistic fixture: the trial balance of
// each ledger kind is the same before and after, store wallets with entries are owned by the account with every entry and running
// balance unchanged, the wallet a top-up credits is recorded on each invoice (manual invoices included), every refund with a payment
// takes the account of that payment (an orderless return of a held payment included), the requester of a customer's refund names the
// account, and a merged pair whose store wallet still holds money or is frozen stops the migration with both ids.
import { afterAll, beforeAll, describe, expect, it, setDefaultTimeout } from 'bun:test';
import type { Pool } from 'pg';
import { migrateDatabase } from '@src/infra/db/migrate';
import { type FixtureIds, loadFixture } from '../../support/legacy-shapes';
import { ACCOUNTS_EXPAND_SUFFIX, ScratchDatabases, migrateUntil, poolOn } from '../../support/migration-files';

setDefaultTimeout(240_000);

const scratch = new ScratchDatabases('ammoney');
const pools: Pool[] = [];

afterAll(async () => {
  for (const pool of pools) await pool.end().catch(() => undefined);
  await scratch.dropAll();
});

/** A scratch database right before the expand migration, with the fixture. */
async function withFixture(): Promise<{ url: string; pool: Pool; ids: FixtureIds }> {
  const db = await scratch.create();
  await migrateUntil(db.url, ACCOUNTS_EXPAND_SUFFIX);
  const pool = poolOn(db.url);
  pools.push(pool);
  return { url: db.url, pool, ids: await loadFixture(pool, 'approved') };
}

/** The sum of the balances of each ledger kind. */
async function trialBalance(pool: Pool): Promise<Record<string, string>> {
  const { rows } = await pool.query<{ kind: string; total: string }>(
    'select kind, sum(balance)::text as total from ledger_accounts group by kind order by kind',
  );
  return Object.fromEntries(rows.map((row) => [row.kind, row.total]));
}

/** The message of a failed migration and of every error it wraps. */
async function failureOf(work: Promise<unknown>): Promise<{ constraint?: string; message: string }> {
  try {
    await work;
  } catch (error) {
    let current: unknown = error;
    for (let depth = 0; depth < 5 && current instanceof Error; depth++) {
      const pg = current as Error & { constraint?: string };
      if (pg.constraint !== undefined) return { constraint: pg.constraint, message: pg.message };
      current = (current as Error & { cause?: unknown }).cause;
    }
    return { message: String(error) };
  }
  throw new Error('Expected the migration to fail.');
}

describe('the realistic fixture', () => {
  let url = '';
  let pool: Pool;
  let ids: FixtureIds;
  let trial: Record<string, string>;
  let storeEntries: string[];
  let storeWallets: Map<number, string>;

  beforeAll(async () => {
    ({ url, pool, ids } = await withFixture());
    trial = await trialBalance(pool);
    storeEntries = (
      await pool.query<{ row: string }>(
        `select row_to_json(e)::text as row from ledger_entries e join ledger_accounts a on a.id = e.account_id
          where a.kind = 'customer_wallet' order by e.id`,
      )
    ).rows.map((row) => row.row);
    storeWallets = new Map(
      (
        await pool.query<{ id: string; owner_id: string }>(
          `select id, owner_id from ledger_accounts where kind = 'customer_wallet' and owner_type = 'customer'`,
        )
      ).rows.map((row) => [Number(row.id), row.owner_id]),
    );
    await migrateDatabase(url);
  });

  it('keeps the trial balance of every ledger kind', async () => {
    expect(await trialBalance(pool)).toEqual(trial);
  });

  it('gives each store wallet to the account of its old customer, its entries and running balances unchanged', async () => {
    const { rows } = await pool.query<{ id: string; owner_type: string; owner_id: string }>(
      `select id, owner_type, owner_id from ledger_accounts where kind = 'customer_wallet'`,
    );
    expect(rows).toHaveLength(storeWallets.size);
    for (const row of rows) {
      const customer = Number(storeWallets.get(Number(row.id)));
      const account = (
        await pool.query<{ account_id: string }>(
          `select account_id from account_legacy_ids where legacy_type = 'customer' and legacy_id = $1`,
          [customer],
        )
      ).rows[0]!.account_id;
      expect(row.owner_type).toBe('account');
      expect(row.owner_id).toBe(account);
    }
    const after = (
      await pool.query<{ row: string }>(
        `select row_to_json(e)::text as row from ledger_entries e join ledger_accounts a on a.id = e.account_id
          where a.kind = 'customer_wallet' order by e.id`,
      )
    ).rows.map((row) => row.row);
    expect(after).toEqual(storeEntries);
  });

  it('records the wallet each top-up and manual invoice credits, and none for a receipt', async () => {
    const { rows } = await pool.query<{ number: string; wallet_kind: string | null }>(
      `select number, wallet_kind from invoices where number like 'AMFX-%' order by number`,
    );
    expect(Object.fromEntries(rows.map((row) => [row.number, row.wallet_kind]))).toEqual({
      'AMFX-INV-CO': 'customer_wallet',
      'AMFX-INV-CP': 'customer_wallet',
      'AMFX-INV-MA': 'client_wallet',
      'AMFX-INV-MC': 'client_wallet',
      'AMFX-RCT-CO': null,
    });
  });

  it('gives every refund with a payment the account of that payment, the orderless return of a held payment included', async () => {
    const own = Number(
      (
        await pool.query<{ account_id: string }>(
          `select account_id from account_legacy_ids where legacy_type = 'customer' and legacy_id = $1`,
          [ids.co],
        )
      ).rows[0]!.account_id,
    );
    const { rows } = await pool.query<{ order_id: string | null; account_id: string }>(
      'select order_id, account_id from refunds order by id',
    );
    expect(rows.map((row) => [row.order_id === null, Number(row.account_id)])).toEqual([
      [false, own],
      [true, own],
    ]);
  });

  it('names the account as the requester of a refund a customer asked for', async () => {
    const own = Number(
      (
        await pool.query<{ account_id: string }>(
          `select account_id from account_legacy_ids where legacy_type = 'customer' and legacy_id = $1`,
          [ids.co],
        )
      ).rows[0]!.account_id,
    );
    const { rows } = await pool.query(
      'select requested_by_type, requested_by_id::int from refunds where order_id is not null',
    );
    expect(rows).toEqual([{ requested_by_type: 'account', requested_by_id: own }]);
  });

  it('refuses a refund with a payment and no account, and one with an account and no payment', async () => {
    const payment = (
      await pool.query<{ id: string; account_id: string }>('select id, account_id from payments limit 1')
    ).rows[0]!;
    const without = await failureOf(
      pool.query(
        `insert into refunds (payment_id, amount, currency, method, status, requested_by_type) values ($1, 1, 'USD', 'original', 'requested', 'system')`,
        [payment.id],
      ),
    );
    expect(without.constraint).toBe('refunds_account_refs_check');
    const orphan = await failureOf(
      pool.query(
        `insert into refunds (account_id, amount, currency, method, status, requested_by_type) values ($1, 1, 'USD', 'original', 'requested', 'system')`,
        [payment.account_id],
      ),
    );
    expect(orphan.constraint).toBe('refunds_account_refs_check');
  });

  it('lets a merchant wallet be frozen and refuses a credit limit on a store wallet', async () => {
    await pool.query(`update ledger_accounts set frozen_at = now() where kind = 'client_wallet' and owner_id = $1`, [
      ids.ma,
    ]);
    const limit = await failureOf(
      pool.query(`update ledger_accounts set overdraft_limit = 5 where kind = 'customer_wallet' and owner_id = $1`, [
        ids.mc,
      ]),
    );
    expect(limit.constraint).toBe('ledger_accounts_overdraft_kind_check');
  });

  it('changes nothing on a second run', async () => {
    const balances = await trialBalance(pool);
    expect(await migrateDatabase(url)).toBe(0);
    expect(await trialBalance(pool)).toEqual(balances);
  });
});

describe('the stops of the money checks', () => {
  it('stops for a merged pair whose store wallet still holds money, and for one whose store wallet is frozen, naming both ids', async () => {
    for (const change of [`balance = 3`, `frozen_at = now()`]) {
      const { url, pool, ids } = await withFixture();
      // The pair's store wallet ends at zero in the fixture; give it a balance or a freeze (a direct write: the stop reads the row).
      await pool.query(
        `update ledger_accounts set ${change} where kind = 'customer_wallet' and owner_type = 'customer' and owner_id = $1`,
        [ids.cp],
      );
      const stop = await failureOf(migrateDatabase(url));
      expect(stop.constraint).toBe('accounts_merge_preflight');
      expect(stop.message).toContain(`E1 client ${ids.mc} customer ${ids.cp}`);
    }
  });

  it('stops for a payment whose owner cannot be found', async () => {
    const { url, pool } = await withFixture();
    const { rows } = await pool.query<{ id: string }>(
      `insert into payments (purpose, gateway_id, amount, currency, status, method_type)
       values ('topup', (select id from payment_gateways where code = 'amfx-bank'), 7, 'USD', 'pending', 'bank') returning id`,
    );
    const stop = await failureOf(migrateDatabase(url));
    expect(stop.constraint).toBe('accounts_merge_preflight');
    expect(stop.message).toContain(`G4 payments ${rows[0]!.id}`);
  });
});

describe('an empty database', () => {
  it('runs the money phases with nothing to move', async () => {
    const db = await scratch.create();
    await migrateDatabase(db.url);
    const pool = poolOn(db.url);
    pools.push(pool);
    expect(
      (await pool.query('select count(*)::int as n from ledger_accounts where owner_type is not null')).rows[0]?.n,
    ).toBe(0);
  });
});
