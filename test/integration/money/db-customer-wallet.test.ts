// Integration tests of the store balance schema (feature 21, plan § 6; decision 064): every CHECK and unique index, and the deferred "below
// zero is frozen" trigger, on real Postgres. Every wallet is owned by an account; an old owner word is refused.
import { afterAll, beforeEach, describe, expect, it } from 'bun:test';
import { closeTestDb, pgErrorOf, resetDb, testDb } from '../../support/db';
import { insertAnyService } from '../../support/customers';
import { insertUsd } from '../../support/fixtures';
import { insertCustomer } from '../../support/support';

beforeEach(resetDb);
afterAll(closeTestDb);

async function run(text: string, params: unknown[] = []) {
  const { pool } = await testDb();
  return (await pool.query(text, params)).rows as Array<Record<string, unknown>>;
}

async function refuses(text: string, params: unknown[], constraint: string, code = '23514'): Promise<void> {
  const { pool } = await testDb();
  const error = await pgErrorOf(pool.query(text, params));
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

async function world() {
  const { db } = await testDb();
  await insertUsd(db);
  const customer = await insertCustomer(db, { hasAccount: true });
  const [gateway] = await run(
    `insert into payment_gateways (code, driver, name) values ('g', 'manual', 'G') returning id`,
  );
  return { db, customer, gatewayId: Number(gateway!.id) };
}

describe('ledger_accounts', () => {
  it('opens a store balance only with an account owner, and no other kind with an account owner', async () => {
    const { customer } = await world();
    await run(
      `insert into ledger_accounts (kind, owner_type, owner_id, currency) values ('customer_wallet', 'account', $1, 'USD')`,
      [customer.id],
    );
    await refuses(
      `insert into ledger_accounts (kind, currency) values ('customer_wallet', 'USD')`,
      [],
      'ledger_accounts_kind_owner_check',
    );
    await refuses(
      `insert into ledger_accounts (kind, owner_type, owner_id, currency) values ('customer_wallet', 'supplier', 1, 'USD')`,
      [],
      'ledger_accounts_kind_owner_check',
    );
    await refuses(
      `insert into ledger_accounts (kind, owner_type, owner_id, currency) values ('bank', 'account', 1, 'USD')`,
      [],
      'ledger_accounts_kind_owner_check',
    );
  });

  it('refuses the old owner words customer and client for any wallet', async () => {
    await world();
    for (const [kind, word] of [
      ['customer_wallet', 'customer'],
      ['client_wallet', 'client'],
    ]) {
      const text = `insert into ledger_accounts (kind, owner_type, owner_id, currency) values ('${kind}', '${word}', 1, 'USD')`;
      await refuses(text, [], 'ledger_accounts_kind_owner_check');
      await ownerWordRefuses(text);
    }
  });

  it('freezes only a wallet (of either kind) and gives a credit limit only to a merchant wallet', async () => {
    await world();
    await refuses(
      `insert into ledger_accounts (kind, owner_type, owner_id, currency, frozen_at) values ('client_hold', 'account', 1, 'USD', now())`,
      [],
      'ledger_accounts_frozen_check',
    );
    await run(
      `insert into ledger_accounts (kind, owner_type, owner_id, currency, frozen_at, frozen_reason) values ('client_wallet', 'account', 1, 'USD', now(), 'x')`,
    );
    await refuses(
      `insert into ledger_accounts (kind, owner_type, owner_id, currency, overdraft_limit) values ('customer_wallet', 'account', 1, 'USD', 5)`,
      [],
      'ledger_accounts_overdraft_kind_check',
    );
    const [row] = await run(
      `insert into ledger_accounts (kind, owner_type, owner_id, currency) values ('customer_wallet', 'account', 1, 'USD') returning frozen_at, frozen_reason`,
    );
    expect(row).toEqual({ frozen_at: null, frozen_reason: '' });
  });

  it('refuses at commit a customer wallet below zero that is not frozen, and accepts it frozen in the same transaction', async () => {
    const { customer } = await world();
    const { pool } = await testDb();
    const failure = await pgErrorOf(
      pool.query(
        `insert into ledger_accounts (kind, owner_type, owner_id, currency, balance) values ('customer_wallet', 'account', $1, 'USD', -1)`,
        [customer.id],
      ),
    );
    expect(failure.constraint).toBe('ledger_accounts_negative_customer_wallet_frozen');
    const client = await pool.connect();
    try {
      await client.query('begin');
      await client.query(
        `insert into ledger_accounts (kind, owner_type, owner_id, currency, balance) values ('customer_wallet', 'account', $1, 'USD', -1)`,
        [customer.id],
      );
      await client.query(
        `update ledger_accounts set frozen_at = now(), frozen_reason = 'x' where kind = 'customer_wallet'`,
      );
      await client.query('commit');
    } finally {
      client.release();
    }
    await refuses(
      `update ledger_accounts set frozen_at = null where kind = 'customer_wallet'`,
      [],
      'ledger_accounts_negative_customer_wallet_frozen',
    );
  });

  it('lets a merchant wallet go below zero without a freeze', async () => {
    await world();
    await run(
      `insert into ledger_accounts (kind, owner_type, owner_id, currency, balance, overdraft_limit) values ('client_wallet', 'account', 1, 'USD', -5, 10)`,
    );
  });
});

describe('ledger_transactions', () => {
  it('accepts the reference type account in a new row', async () => {
    await world();
    await run(
      `insert into ledger_transactions (kind, ref_type, ref_id, idempotency_key, created_by_type) values ('adjustment', 'account', 1, 'k', 'system')`,
    );
  });

  it('refuses the old reference type customer in a new row (the journal keeps the old rows, never writes new ones)', async () => {
    await world();
    await refuses(
      `insert into ledger_transactions (kind, ref_type, ref_id, idempotency_key, created_by_type) values ('adjustment', 'customer', 1, 'k', 'system')`,
      [],
      'ledger_transactions_ref_type_current_check',
    );
  });
});

describe('payments', () => {
  const pay = (accountId: number, gatewayId: number | null, method: string, sessionId: number | null = null) =>
    run(
      `insert into payments (account_id, purpose, gateway_id, amount, currency, status, method_type, checkout_session_id)
       values ($1, 'order', $2, 10, 'USD', 'captured', $3, $4) returning id`,
      [accountId, gatewayId, method, sessionId],
    );

  it('needs a gateway on every payment but a balance payment, which has none', async () => {
    const { customer, gatewayId } = await world();
    await pay(customer.id, null, 'balance');
    await pay(customer.id, gatewayId, 'card');
    await refuses(
      `insert into payments (account_id, purpose, gateway_id, amount, currency, status, method_type) values (${customer.id}, 'order', null, 10, 'USD', 'captured', 'card')`,
      [],
      'payments_gateway_check',
    );
    await refuses(
      `insert into payments (account_id, purpose, gateway_id, amount, currency, status, method_type) values (${customer.id}, 'order', ${gatewayId}, 10, 'USD', 'captured', 'balance')`,
      [],
      'payments_gateway_check',
    );
    await refuses(
      `insert into payments (account_id, purpose, gateway_id, amount, currency, status, method_type) values (${customer.id}, 'topup', null, 10, 'USD', 'pending', 'balance')`,
      [],
      'payments_method_type_check',
    );
  });

  it('allows one balance payment per checkout session', async () => {
    const { db, customer, gatewayId } = await world();
    const serviceId = await insertAnyService(db);
    const [session] = await run(
      `insert into checkout_sessions (token, account_id, email, service_id, currency, net_amount, gross_amount, expires_at)
       values ('t', $1, 'a@b.c', $2, 'USD', 10, 10, now() + interval '1 hour') returning id, opened_signed_in`,
      [customer.id, serviceId],
    );
    expect(session!.opened_signed_in).toBe(false);
    const sessionId = Number(session!.id);
    await pay(customer.id, null, 'balance', sessionId);
    await pay(customer.id, gatewayId, 'card', sessionId);
    await refuses(
      `insert into payments (account_id, purpose, amount, currency, status, method_type, checkout_session_id) values (${customer.id}, 'order', 10, 'USD', 'captured', 'balance', ${sessionId})`,
      [],
      'payments_balance_session_uq',
      '23505',
    );
  });
});

describe('invoices', () => {
  it('keeps one top-up per account and Idempotency-Key', async () => {
    const { customer } = await world();
    const insert = (number: string, accountId: number, key: string | null) =>
      run(
        `insert into invoices (number, account_id, wallet_kind, kind, amount, net_amount, total, currency, idempotency_key, request_fingerprint)
         values ($1, $2, 'customer_wallet', 'topup', 10, 10, 10, 'USD', $3, 'f')`,
        [number, accountId, key],
      );
    await insert('INV-1', customer.id, 'K');
    await insert('INV-2', customer.id, null);
    await insert('INV-3', customer.id, null);
    await refuses(
      `insert into invoices (number, account_id, wallet_kind, kind, amount, net_amount, total, currency, idempotency_key) values ('INV-4', ${customer.id}, 'customer_wallet', 'topup', 10, 10, 10, 'USD', 'K')`,
      [],
      'invoices_account_key_uq',
      '23505',
    );
  });

  it('names the wallet kind of a top-up and of nothing else', async () => {
    const { customer } = await world();
    await refuses(
      `insert into invoices (number, account_id, kind, amount, net_amount, total, currency) values ('INV-5', ${customer.id}, 'topup', 10, 10, 10, 'USD')`,
      [],
      'invoices_wallet_kind_check',
    );
    await refuses(
      `insert into invoices (number, account_id, wallet_kind, kind, amount, net_amount, total, currency) values ('INV-6', ${customer.id}, 'customer_wallet', 'manual', 10, 10, 10, 'USD')`,
      [],
      'invoices_wallet_kind_check',
    );
  });
});
