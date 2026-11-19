// Integration tests of the customer wallet schema (feature 21, plan § 6): every new CHECK and unique index, and the deferred "below zero
// is frozen" trigger, on real Postgres.
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
  it('opens a customer wallet only with a customer owner, and no other kind with a customer owner', async () => {
    const { customer } = await world();
    await run(
      `insert into ledger_accounts (kind, owner_type, owner_id, currency) values ('customer_wallet', 'customer', $1, 'USD')`,
      [customer.id],
    );
    await refuses(
      `insert into ledger_accounts (kind, currency) values ('customer_wallet', 'USD')`,
      [],
      'ledger_accounts_kind_owner_check',
    );
    await refuses(
      `insert into ledger_accounts (kind, owner_type, owner_id, currency) values ('client_wallet', 'customer', 1, 'USD')`,
      [],
      'ledger_accounts_kind_owner_check',
    );
    await refuses(
      `insert into ledger_accounts (kind, owner_type, owner_id, currency) values ('customer_wallet', 'client', 1, 'USD')`,
      [],
      'ledger_accounts_kind_owner_check',
    );
  });

  it('freezes only a customer wallet and gives a credit limit only to a merchant wallet', async () => {
    await world();
    await refuses(
      `insert into ledger_accounts (kind, owner_type, owner_id, currency, frozen_at) values ('client_wallet', 'client', 1, 'USD', now())`,
      [],
      'ledger_accounts_frozen_check',
    );
    await refuses(
      `insert into ledger_accounts (kind, owner_type, owner_id, currency, overdraft_limit) values ('customer_wallet', 'customer', 1, 'USD', 5)`,
      [],
      'ledger_accounts_overdraft_kind_check',
    );
    const [row] = await run(
      `insert into ledger_accounts (kind, owner_type, owner_id, currency) values ('customer_wallet', 'customer', 1, 'USD') returning frozen_at, frozen_reason`,
    );
    expect(row).toEqual({ frozen_at: null, frozen_reason: '' });
  });

  it('refuses at commit a customer wallet below zero that is not frozen, and accepts it frozen in the same transaction', async () => {
    const { customer } = await world();
    const { pool } = await testDb();
    const failure = await pgErrorOf(
      pool.query(
        `insert into ledger_accounts (kind, owner_type, owner_id, currency, balance) values ('customer_wallet', 'customer', $1, 'USD', -1)`,
        [customer.id],
      ),
    );
    expect(failure.constraint).toBe('ledger_accounts_negative_customer_wallet_frozen');
    const client = await pool.connect();
    try {
      await client.query('begin');
      await client.query(
        `insert into ledger_accounts (kind, owner_type, owner_id, currency, balance) values ('customer_wallet', 'customer', $1, 'USD', -1)`,
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
      `insert into ledger_accounts (kind, owner_type, owner_id, currency, balance, overdraft_limit) values ('client_wallet', 'client', 1, 'USD', -5, 10)`,
    );
  });
});

describe('ledger_transactions', () => {
  it('accepts the stored reference type customer', async () => {
    await world();
    await run(
      `insert into ledger_transactions (kind, ref_type, ref_id, idempotency_key, created_by_type) values ('adjustment', 'customer', 1, 'k', 'system')`,
    );
  });
});

describe('payments', () => {
  const pay = (gatewayId: number | null, method: string, sessionId: number | null = null) =>
    run(
      `insert into payments (purpose, gateway_id, amount, currency, status, method_type, checkout_session_id)
       values ('order', $1, 10, 'USD', 'captured', $2, $3) returning id`,
      [gatewayId, method, sessionId],
    );

  it('needs a gateway on every payment but a balance payment, which has none', async () => {
    const { gatewayId } = await world();
    await pay(null, 'balance');
    await pay(gatewayId, 'card');
    await refuses(
      `insert into payments (purpose, gateway_id, amount, currency, status, method_type) values ('order', null, 10, 'USD', 'captured', 'card')`,
      [],
      'payments_gateway_check',
    );
    await refuses(
      `insert into payments (purpose, gateway_id, amount, currency, status, method_type) values ('order', ${gatewayId}, 10, 'USD', 'captured', 'balance')`,
      [],
      'payments_gateway_check',
    );
    await refuses(
      `insert into payments (purpose, gateway_id, amount, currency, status, method_type) values ('topup', null, 10, 'USD', 'pending', 'balance')`,
      [],
      'payments_method_type_check',
    );
  });

  it('allows one balance payment per checkout session', async () => {
    const { db, customer, gatewayId } = await world();
    const serviceId = await insertAnyService(db);
    const [session] = await run(
      `insert into checkout_sessions (token, customer_id, email, service_id, currency, net_amount, gross_amount, expires_at)
       values ('t', $1, 'a@b.c', $2, 'USD', 10, 10, now() + interval '1 hour') returning id, opened_signed_in`,
      [customer.id, serviceId],
    );
    expect(session!.opened_signed_in).toBe(false);
    const sessionId = Number(session!.id);
    await pay(null, 'balance', sessionId);
    await pay(gatewayId, 'card', sessionId);
    await refuses(
      `insert into payments (purpose, amount, currency, status, method_type, checkout_session_id) values ('order', 10, 'USD', 'captured', 'balance', ${sessionId})`,
      [],
      'payments_balance_session_uq',
      '23505',
    );
  });
});

describe('invoices', () => {
  it('keeps one top-up per customer and Idempotency-Key', async () => {
    const { customer } = await world();
    const insert = (number: string, customerId: number | null, key: string | null) =>
      run(
        `insert into invoices (number, customer_id, kind, amount, net_amount, total, currency, idempotency_key, request_fingerprint)
         values ($1, $2, 'topup', 10, 10, 10, 'USD', $3, 'f')`,
        [number, customerId, key],
      );
    await insert('INV-1', customer.id, 'K');
    await insert('INV-2', customer.id, null);
    await insert('INV-3', customer.id, null);
    await refuses(
      `insert into invoices (number, customer_id, kind, amount, net_amount, total, currency, idempotency_key) values ('INV-4', ${customer.id}, 'topup', 10, 10, 10, 'USD', 'K')`,
      [],
      'invoices_customer_key_uq',
      '23505',
    );
  });
});
