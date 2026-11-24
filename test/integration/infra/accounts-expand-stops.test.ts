// The preflight of the expand migration of one account type (backend decision 064): every code stops the migration before anything
// changes. One scratch database is held right before the migration and copied for each case (CREATE DATABASE ... TEMPLATE); each copy
// gets the rows of one case and is migrated: the migration raises with the constraint accounts_merge_preflight, names the code and the
// ids, holds no email, and the database keeps its schema (no legacy id table, the same migrations applied). The realistic fixture without
// its approval stops with E5, and the check script reads the same stop in a READ ONLY transaction, prints the approvals a database already
// holds, and migrates a rehearsal copy that it names while it refuses the live database.
import { afterAll, beforeAll, describe, expect, it, setDefaultTimeout, spyOn } from 'bun:test';
import { Client, type Pool } from 'pg';
import { migrateDatabase } from '@src/infra/db/migrate';
import {
  EXIT,
  approve,
  expandMigrationText,
  main,
  preflightBlockOf,
  runPreflight,
} from '../../../scripts/accounts-merge-check';
import { loadFixture } from '../../support/legacy-shapes';
import {
  ACCOUNTS_EXPAND_SUFFIX,
  ScratchDatabases,
  appliedCount,
  migrateUntil,
  poolOn,
} from '../../support/migration-files';

setDefaultTimeout(240_000);

const scratch = new ScratchDatabases('amstop');
const pools: Pool[] = [];
let template = '';

beforeAll(async () => {
  const base = await scratch.create();
  await migrateUntil(base.url, ACCOUNTS_EXPAND_SUFFIX);
  template = base.name;
});

afterAll(async () => {
  for (const pool of pools) await pool.end().catch(() => undefined);
  await scratch.dropAll();
});

/** The rows a case starts from: a staff member, a merchant rank, the retail rank (made by migration 0005), a service. */
interface Base {
  readonly staff: number;
  readonly group: number;
  readonly service: number;
}

/** A copy of the template with the base rows. */
async function caseDatabase(): Promise<{ url: string; pool: Pool; base: Base }> {
  const db = await scratch.create(template);
  const pool = poolOn(db.url);
  pools.push(pool);
  const id = async (text: string, params: unknown[] = []) =>
    Number((await pool.query<{ id: string }>(`${text} returning id`, params)).rows[0]!.id);
  await pool.query(`insert into currencies (code, name) values ('USD', 'US dollar') on conflict do nothing`);
  const role = await id(`insert into roles (name, permissions) values ('Stop owner', '{*}')`);
  const staff = await id(
    `insert into staff_users (email, name, role_id, status) values ('stop-staff@example.test', 'Staff', $1, 'active')`,
    [role],
  );
  const group = await id(`insert into client_groups (name, kind) values ('Stop merchants', 'b2b')`);
  const category = await id(`insert into service_categories (name, type) values ('Stop', 'imei')`);
  const service = await id(
    `insert into services (category_id, type, name, fulfillment, base_price, code, sla_minutes) values ($1, 'imei', 'Stop', 'manual', 5, 'STOP-1', 60)`,
    [category],
  );
  return { url: db.url, pool, base: { staff, group, service } };
}

/** A merchant; returns its id. */
async function merchant(pool: Pool, base: Base, email: string, status = 'active'): Promise<number> {
  const { rows } = await pool.query<{ id: string }>(
    `insert into clients (username, email, name, group_id, referral_code, status) values ($1, $2, 'M', $3, $1, $4) returning id`,
    [email.split('@')[0], email, base.group, status],
  );
  return Number(rows[0]!.id);
}

/** A customer; returns its id. */
async function customer(pool: Pool, email: string, hasAccount = true, status = 'active'): Promise<number> {
  const { rows } = await pool.query<{ id: string }>(
    `insert into customers (email, name, has_account, status) values ($1, 'C', $2, $3) returning id`,
    [email, hasAccount, status],
  );
  return Number(rows[0]!.id);
}

/** A merchant and a customer with a login that share an email, approved as one account. */
async function approvedPair(pool: Pool, base: Base, customerStatus = 'active'): Promise<{ m: number; c: number }> {
  const m = await merchant(pool, base, 'pair@example.test');
  const c = await customer(pool, 'PAIR@example.test', true, customerStatus);
  await pool.query(`insert into settings (key, value) values ('accountsMerge.approvedPairs', $1::jsonb)`, [
    JSON.stringify([{ clientId: m, customerId: c, action: 'one_account' }]),
  ]);
  return { m, c };
}

/** Migrates and returns the stop; fails when the migration passes. */
async function stopOf(url: string): Promise<{ code?: string; constraint?: string; message: string }> {
  try {
    await migrateDatabase(url);
  } catch (error) {
    let current: unknown = error;
    for (let depth = 0; depth < 5 && current instanceof Error; depth++) {
      const pg = current as Error & { code?: string; constraint?: string };
      if (pg.constraint === 'accounts_merge_preflight')
        return { code: pg.code, constraint: pg.constraint, message: pg.message };
      current = (current as Error & { cause?: unknown }).cause;
    }
    throw error;
  }
  throw new Error('Expected the preflight to stop the migration.');
}

/** Runs one case: the stop names the finding, holds no email, and changes nothing. */
async function expectStop(url: string, pool: Pool, finding: string): Promise<string> {
  const migrations = await appliedCount(pool);
  const stop = await stopOf(url);
  expect(stop.code).toBe('23514');
  expect(stop.message).toStartWith('accounts merge stopped, nothing changed: ');
  expect(stop.message).toContain(finding);
  expect(stop.message).not.toContain('@');
  expect((await pool.query(`select to_regclass('public.account_legacy_ids') as t`)).rows[0]?.t).toBeNull();
  expect(await appliedCount(pool)).toBe(migrations);
  return stop.message;
}

describe('the preflight codes', () => {
  it('E1: the customer of an approved pair holds a store balance', async () => {
    const { url, pool, base } = await caseDatabase();
    const { m, c } = await approvedPair(pool, base);
    await pool.query(
      `insert into ledger_accounts (kind, owner_type, owner_id, currency, balance) values ('customer_wallet', 'customer', $1, 'USD', 5)`,
      [c],
    );
    await expectStop(url, pool, `E1 client ${m} customer ${c}`);
  });

  it('E2: the customer of an approved pair has an open top-up', async () => {
    const { url, pool, base } = await caseDatabase();
    const { m, c } = await approvedPair(pool, base);
    await pool.query(
      `insert into invoices (number, customer_id, kind, amount, net_amount, total, currency, status) values ('STOP-I1', $1, 'topup', 5, 5, 5, 'USD', 'open')`,
      [c],
    );
    await expectStop(url, pool, `E2 client ${m} customer ${c}`);
  });

  it('E2: the customer of an approved pair has an order in progress, or one waiting for its verification', async () => {
    for (const [status, verification] of [
      ['pending', null],
      ['processing', null],
      ['completed', 'requested'],
    ] as const) {
      const { url, pool, base } = await caseDatabase();
      const { m, c } = await approvedPair(pool, base);
      await pool.query(
        `insert into orders (service_id, type, source, customer_id, unit_price, total_price, currency, status, verification_status)
         values ($1, 'imei', 'store', $2, 5, 5, 'USD', $3, $4)`,
        [base.service, c, status, verification],
      );
      await expectStop(url, pool, `E2 client ${m} customer ${c}`);
    }
  });

  it('E2: the customer of an approved pair has a checkout it opened signed in that is still open', async () => {
    const { url, pool, base } = await caseDatabase();
    const { m, c } = await approvedPair(pool, base);
    await pool.query(
      `insert into checkout_sessions (token, customer_id, email, service_id, currency, net_amount, gross_amount, expires_at, status, opened_signed_in)
       values ('stop-cs-open', $1, 'pair@example.test', $2, 'USD', 5, 5, now() + interval '1 hour', 'open', true)`,
      [c, base.service],
    );
    await expectStop(url, pool, `E2 client ${m} customer ${c}`);
  });

  it('E2 lets a finished order, an expired checkout and a guest checkout of the customer through', async () => {
    const { url, pool, base } = await caseDatabase();
    const { c } = await approvedPair(pool, base);
    await pool.query(
      `insert into orders (service_id, type, source, customer_id, unit_price, total_price, currency, status, verification_status)
       values ($1, 'imei', 'store', $2, 5, 5, 'USD', 'completed', 'accepted'), ($1, 'imei', 'store', $2, 5, 5, 'USD', 'rejected', null)`,
      [base.service, c],
    );
    await pool.query(
      `insert into checkout_sessions (token, customer_id, email, service_id, currency, net_amount, gross_amount, expires_at, status, opened_signed_in)
       values ('stop-cs-late', $1, 'pair@example.test', $2, 'USD', 5, 5, now() - interval '1 hour', 'open', true),
              ('stop-cs-guest', $1, 'pair@example.test', $2, 'USD', 5, 5, now() + interval '1 hour', 'open', false)`,
      [c, base.service],
    );
    const block = preflightBlockOf(expandMigrationText());
    const client = new Client({ connectionString: url });
    await client.connect();
    try {
      expect(await runPreflight(client, block)).toEqual({ clean: true, message: '', findings: [] });
    } finally {
      await client.end();
    }
  });

  it('E3: the two rows of an approved pair have different statuses', async () => {
    const { url, pool, base } = await caseDatabase();
    const { m, c } = await approvedPair(pool, base, 'suspended');
    await expectStop(url, pool, `E3 client ${m} customer ${c}`);
  });

  it('E4: the customer of an approved pair has an open data request', async () => {
    const { url, pool, base } = await caseDatabase();
    const { m, c } = await approvedPair(pool, base);
    await pool.query(
      `insert into data_requests (customer_id, kind, status, due_at) values ($1, 'export', 'open', now() + interval '30 days')`,
      [c],
    );
    await expectStop(url, pool, `E4 client ${m} customer ${c}`);
  });

  it('E5: a merchant and a customer with a login share an email and are not approved', async () => {
    const { url, pool, base } = await caseDatabase();
    const m = await merchant(pool, base, 'same@example.test');
    const c = await customer(pool, 'Same@Example.test');
    // A guest with a merchant's email is not a pair, and neither is an anonymized customer.
    await customer(pool, 'other@example.test', false);
    await merchant(pool, base, 'other@example.test');
    await expectStop(url, pool, `E5 client ${m} customer ${c}`);
  });

  it('E6: an approval whose customer has no login, and an approval entry of another shape', async () => {
    const { url, pool, base } = await caseDatabase();
    const m = await merchant(pool, base, 'guest@example.test');
    const c = await customer(pool, 'guest@example.test', false);
    await pool.query(`insert into settings (key, value) values ('accountsMerge.approvedPairs', $1::jsonb)`, [
      JSON.stringify([{ clientId: m, customerId: c, action: 'one_account' }, { clientId: 'x' }]),
    ]);
    const message = await expectStop(url, pool, `E6 client ${m} customer ${c}`);
    expect(message).toContain('E6 approval entry 2');
  });

  it('E7: the two rows of an approved pair used one idempotency key on an invoice', async () => {
    const { url, pool, base } = await caseDatabase();
    const { m, c } = await approvedPair(pool, base);
    await pool.query(
      `insert into invoices (number, client_id, kind, amount, net_amount, total, currency, status, idempotency_key)
       values ('STOP-A', $1, 'topup', 5, 5, 5, 'USD', 'paid', 'k-1'), ('STOP-B', null, 'topup', 5, 5, 5, 'USD', 'paid', 'k-1')`,
      [m],
    );
    await pool.query(`update invoices set customer_id = $1 where number = 'STOP-B'`, [c]);
    await expectStop(url, pool, `E7 client ${m} customer ${c}`);
  });

  it('G1: an event of the old customer family waits in the outbox', async () => {
    const { url, pool } = await caseDatabase();
    const { rows } = await pool.query<{ id: string }>(
      `insert into outbox_events (type, aggregate_type, aggregate_id, payload) values ('customer.created', 'customers', 1, '{}') returning id`,
    );
    await expectStop(url, pool, `G1 outbox_events ${rows[0]!.id}`);
  });

  it('G2: a session names a customer that does not exist, and a file an owner kind no one writes', async () => {
    const { url, pool } = await caseDatabase();
    const session = await pool.query<{ id: string }>(
      `insert into sessions (token_hash, subject_type, subject_id, stage, ip, expires_at)
       values ('stop-orphan', 'customer', 999999, 'active', '203.0.113.9', now() + interval '1 day') returning id`,
    );
    const stray = await pool.query<{ id: string }>(
      `insert into files (bucket, key, filename, mime, size, sha256, owner_type, owner_id)
       values ('b', 'stop/file', 'f', 'text/plain', 1, 's', 'robot', 1) returning id`,
    );
    const message = await expectStop(url, pool, `G2 sessions ${session.rows[0]!.id}`);
    expect(message).toContain(`G2 files ${stray.rows[0]!.id}`);
  });

  it('G3: a shop order of a merchant', async () => {
    const { url, pool, base } = await caseDatabase();
    const m = await merchant(pool, base, 'door@example.test');
    const { rows } = await pool.query<{ id: string }>(
      `insert into orders (service_id, type, source, client_id, unit_price, total_price, currency) values ($1, 'imei', 'store', $2, 5, 5, 'USD') returning id`,
      [base.service, m],
    );
    await expectStop(url, pool, `G3 orders ${rows[0]!.id}`);
  });

  it('G4: an invoice without a merchant or a customer', async () => {
    const { url, pool } = await caseDatabase();
    const { rows } = await pool.query<{ id: string }>(
      `insert into invoices (number, kind, amount, net_amount, total, currency, status) values ('STOP-G4', 'manual', 5, 5, 5, 'USD', 'paid') returning id`,
    );
    await expectStop(url, pool, `G4 invoices ${rows[0]!.id}`);
  });

  it('G5: a rank of an unknown kind', async () => {
    const { url, pool } = await caseDatabase();
    const { rows } = await pool.query<{ id: string }>(
      `insert into client_groups (name, kind) values ('Stop odd', 'wholesale') returning id`,
    );
    await expectStop(url, pool, `G5 client_groups ${rows[0]!.id}`);
  });

  it("G6: a customer's refund of another customer's payment", async () => {
    const { url, pool, base } = await caseDatabase();
    const one = await customer(pool, 'one@example.test');
    const two = await customer(pool, 'two@example.test');
    const order = await pool.query<{ id: string }>(
      `insert into orders (service_id, type, source, customer_id, unit_price, total_price, currency) values ($1, 'imei', 'store', $2, 5, 5, 'USD') returning id`,
      [base.service, two],
    );
    const payment = await pool.query<{ id: string }>(
      `insert into payments (customer_id, order_id, purpose, amount, currency, status, method_type) values ($1, $2, 'order', 5, 'USD', 'captured', 'balance') returning id`,
      [two, order.rows[0]!.id],
    );
    const refund = await pool.query<{ id: string }>(
      `insert into refunds (payment_id, order_id, customer_id, amount, currency, method, status, requested_by_type)
       values ($1, $2, $3, 5, 'USD', 'original', 'requested', 'system') returning id`,
      [payment.rows[0]!.id, order.rows[0]!.id, one],
    );
    await expectStop(url, pool, `G6 refunds ${refund.rows[0]!.id}`);
  });

  it('G7: a campaign is being sent', async () => {
    const { url, pool, base } = await caseDatabase();
    const { rows } = await pool.query<{ id: string }>(
      `insert into notification_campaigns (name, purpose, channels, audience, content, status, created_by, queued_at)
       values ('Stop', 'service', '{in_app}', '{"merchants": {}}', '{}', 'sending', $1, now()) returning id`,
      [base.staff],
    );
    await expectStop(url, pool, `G7 notification_campaigns ${rows[0]!.id}`);
  });

  it('G8: the retail rank allows credit', async () => {
    const { url, pool } = await caseDatabase();
    const { rows } = await pool.query<{ id: string }>(
      `update client_groups set overdraft_allowed = true where kind = 'b2c_retail' returning id`,
    );
    await expectStop(url, pool, `G8 client_groups ${rows[0]!.id}`);
  });
});

describe('the realistic fixture without the approval', () => {
  it('stops with E5 for the merchant and the customer that share an email', async () => {
    const { url, pool } = await caseDatabase();
    const ids = await loadFixture(pool, 'not-approved');
    const message = await expectStop(url, pool, `E5 client ${ids.mc} customer ${ids.cp}`);
    expect(message).toEndWith('(1 finding)');
  });

  it('is read the same way by the check script, in a READ ONLY transaction that changes nothing', async () => {
    const { url, pool } = await caseDatabase();
    const ids = await loadFixture(pool, 'not-approved');
    const client = new Client({ connectionString: url });
    await client.connect();
    try {
      const block = preflightBlockOf(expandMigrationText());
      const result = await runPreflight(client, block);
      expect(result.clean).toBe(false);
      expect(result.findings).toEqual([{ code: 'E5', text: `E5 client ${ids.mc} customer ${ids.cp}` }]);
      // Approving the pair writes the settings row; the preflight is then clean and the migration runs.
      const approval = await approve(client, block, [{ clientId: ids.mc, customerId: ids.cp, action: 'one_account' }]);
      expect(approval).toMatchObject({ written: true, clean: true, refused: [] });
    } finally {
      await client.end();
    }
    await migrateDatabase(url);
    expect(
      Number(
        (
          await pool.query(
            `select account_id from account_legacy_ids where legacy_type = 'customer' and legacy_id = $1`,
            [ids.cp],
          )
        ).rows[0]?.account_id,
      ),
    ).toBe(ids.mc);
  });

  it('refuses an approval whose customer is blocked and writes nothing', async () => {
    const { url, pool, base } = await caseDatabase();
    const m = await merchant(pool, base, 'blocked@example.test');
    const c = await customer(pool, 'blocked@example.test', true, 'blocked');
    const client = new Client({ connectionString: url });
    await client.connect();
    try {
      const approval = await approve(client, preflightBlockOf(expandMigrationText()), [
        { clientId: m, customerId: c, action: 'one_account' },
      ]);
      expect(approval.written).toBe(false);
      expect(approval.refused).toEqual([{ code: 'E3', text: `E3 client ${m} customer ${c}` }]);
    } finally {
      await client.end();
    }
    expect(
      (await pool.query(`select count(*)::int as n from settings where key = 'accountsMerge.approvedPairs'`)).rows[0]
        ?.n,
    ).toBe(0);
  });
});

describe('the check script on a database', () => {
  it('prints the approved pairs the settings row already holds', async () => {
    const { url, pool, base } = await caseDatabase();
    const { m, c } = await approvedPair(pool, base);
    const logs = spyOn(console, 'log').mockImplementation(() => undefined);
    try {
      expect(await main([], { NODE_ENV: 'test', DATABASE_URL_TEST: url })).toBe(EXIT.ok);
      const printed = logs.mock.calls.map((call) => String(call[0]));
      expect(printed).toContain(`  merchant ${m} with customer ${c}`);
      expect(printed.some((line) => line.includes('the migration merges them'))).toBe(true);
    } finally {
      logs.mockRestore();
    }
  });

  it('migrates the named rehearsal copy with the migration command, and refuses the live database', async () => {
    const live = await caseDatabase();
    await approvedPair(live.pool, live.base);
    const copy = await scratch.create(template);
    const env = { ...process.env, NODE_ENV: 'test', DATABASE_URL_TEST: live.url };
    const migrations = await appliedCount(live.pool);
    const errors = spyOn(console, 'error').mockImplementation(() => undefined);
    const logs = spyOn(console, 'log').mockImplementation(() => undefined);
    try {
      expect(await main(['--rehearse', live.url.slice(live.url.lastIndexOf('/') + 1)], env)).toBe(EXIT.error);
      expect(await main(['--rehearse', copy.name], env)).toBe(EXIT.ok);
    } finally {
      errors.mockRestore();
      logs.mockRestore();
    }
    const copyPool = poolOn(copy.url);
    pools.push(copyPool);
    expect((await copyPool.query(`select to_regclass('public.account_legacy_ids') as t`)).rows[0]?.t).not.toBeNull();
    expect((await live.pool.query(`select to_regclass('public.account_legacy_ids') as t`)).rows[0]?.t).toBeNull();
    expect(await appliedCount(live.pool)).toBe(migrations);
  });
});
