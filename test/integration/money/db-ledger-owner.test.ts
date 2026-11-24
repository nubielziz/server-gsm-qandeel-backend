// The owner rules of the ledger accounts that the database enforces after the one account type (decision 064): every wallet and hold
// belongs to ('account', id), so a store balance can never be opened for an old customer number, an account holds at most one wallet of each
// kind, and the journal refuses the old words `client` and `customer` in a new row. Real Postgres, raw SQL, no application.
import { afterAll, beforeEach, describe, expect, it } from 'bun:test';
import { closeTestDb, pgErrorOf, resetDb, testDb } from '../../support/db';
import { insertUsd } from '../../support/fixtures';

beforeEach(resetDb);
afterAll(closeTestDb);

async function run(text: string, params: unknown[] = []) {
  const { pool } = await testDb();
  return (await pool.query(text, params)).rows as Array<Record<string, unknown>>;
}

async function refuses(text: string, constraint: string, code = '23514'): Promise<void> {
  const { pool } = await testDb();
  const error = await pgErrorOf(pool.query(text));
  expect(error.constraint, error.message).toBe(constraint);
  expect(error.code).toBe(code);
}

/**
 * Asserts that the owner word check alone refuses an insert. Both owner checks refuse a row with an old owner word, and Postgres tests CHECK
 * constraints in name order, so the kind check answers first; here it is set aside in a transaction that is rolled back.
 */
async function ownerWordRefuses(text: string, params: unknown[] = []): Promise<void> {
  const { pool } = await testDb();
  const client = await pool.connect();
  try {
    await client.query('begin');
    await client.query('alter table ledger_accounts drop constraint ledger_accounts_kind_owner_check');
    const error = await pgErrorOf(client.query(text, params));
    expect(error.constraint, error.message).toBe('ledger_accounts_owner_type_check');
    expect(error.code).toBe('23514');
  } finally {
    await client.query('rollback');
    client.release();
  }
}

/** The insert of one ledger account in USD, with one more column (name and SQL value) when a case needs it. */
function open(kind: string, ownerType: string, ownerId: number, more?: { column: string; value: string }): string {
  const columns = more ? `, ${more.column}` : '';
  const values = more ? `, ${more.value}` : '';
  return `insert into ledger_accounts (kind, owner_type, owner_id, currency${columns}) values ('${kind}', '${ownerType}', ${ownerId}, 'USD'${values})`;
}

const credit = (value: string) => ({ column: 'overdraft_limit', value });
const onHold = { column: 'frozen_at', value: 'now()' };

describe('ledger_accounts owner', () => {
  beforeEach(async () => {
    const { db } = await testDb();
    await insertUsd(db);
  });

  it('accepts a store balance, a merchant wallet and a hold owned by an account', async () => {
    await run(open('customer_wallet', 'account', 7));
    await run(open('client_wallet', 'account', 8));
    await run(open('client_hold', 'account', 8));
    const rows = await run(`select kind, owner_type from ledger_accounts order by id`);
    expect(rows.map((row) => row.owner_type)).toEqual(['account', 'account', 'account']);
  });

  it('refuses to open a store balance for a customer: the old owner word is gone from new rows', async () => {
    for (const text of [
      open('customer_wallet', 'customer', 7),
      open('client_wallet', 'customer', 7),
      open('client_hold', 'client', 7),
    ]) {
      await refuses(text, 'ledger_accounts_kind_owner_check');
      await ownerWordRefuses(text);
    }
  });

  it('refuses a store balance without an owner, and a wallet owned by a supplier', async () => {
    await refuses(
      `insert into ledger_accounts (kind, currency) values ('customer_wallet', 'USD')`,
      'ledger_accounts_kind_owner_check',
    );
    await refuses(open('customer_wallet', 'supplier', 7), 'ledger_accounts_kind_owner_check');
    await refuses(open('client_wallet', 'supplier', 7), 'ledger_accounts_kind_owner_check');
    await refuses(open('supplier_prepaid', 'account', 7), 'ledger_accounts_kind_owner_check');
  });

  it('lets one account hold a wallet of each kind, as a rank crossing leaves it, and refuses a second wallet of one kind', async () => {
    await run(open('customer_wallet', 'account', 7));
    await run(open('client_wallet', 'account', 7));
    await run(open('client_hold', 'account', 7));
    await refuses(open('customer_wallet', 'account', 7), 'ledger_accounts_identity_uq', '23505');
    await refuses(open('client_wallet', 'account', 7), 'ledger_accounts_identity_uq', '23505');
  });

  it('gives a credit limit only to a merchant wallet and lets either wallet kind be put on hold', async () => {
    await refuses(open('customer_wallet', 'account', 7, credit('5')), 'ledger_accounts_overdraft_kind_check');
    await refuses(open('client_hold', 'account', 7, onHold), 'ledger_accounts_frozen_check');
    await run(open('client_wallet', 'account', 7, credit('5')));
    await run(open('customer_wallet', 'account', 8, onHold));
    await run(open('client_wallet', 'account', 9, onHold));
    const frozen = await run(`select kind from ledger_accounts where frozen_at is not null order by kind`);
    expect(frozen.map((row) => row.kind)).toEqual(['client_wallet', 'customer_wallet']);
  });
});

describe('ledger_transactions words', () => {
  const header = (refType: string, createdByType: string, key: string) =>
    `insert into ledger_transactions (kind, ref_type, ref_id, idempotency_key, created_by_type, created_by_id)
     values ('adjustment', '${refType}', 1, '${key}', '${createdByType}', ${createdByType === 'system' ? 'null' : '1'})`;

  it('accepts the account word for the reference and for the actor', async () => {
    await run(header('account', 'account', 'owner:1'));
  });

  it('refuses the old words client and customer in a new row, for the reference and for the actor', async () => {
    await refuses(header('client', 'account', 'owner:2'), 'ledger_transactions_ref_type_current_check');
    await refuses(header('customer', 'account', 'owner:3'), 'ledger_transactions_ref_type_current_check');
    await refuses(header('account', 'client', 'owner:4'), 'ledger_transactions_created_by_type_current_check');
    await refuses(header('account', 'customer', 'owner:5'), 'ledger_transactions_created_by_type_current_check');
  });
});
