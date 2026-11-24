// The expand migration of one account type (backend decision 064) on the realistic fixture, the approved variant
// (scripts/accounts-merge/fixture.sql): a database is held right before the migration, filled with rows of the old shape, then migrated
// to the newest file. Also an empty database and the smallest database with rows (one merchant and one customer, emails apart). Each
// database is a scratch database of this file; the shared test database is not touched.
import { afterAll, beforeAll, describe, expect, it, setDefaultTimeout } from 'bun:test';
import type { Pool } from 'pg';
import { migrateDatabase } from '@src/infra/db/migrate';
import { type FixtureIds, loadFixture } from '../../support/legacy-shapes';
import {
  ACCOUNTS_EXPAND_SUFFIX,
  ScratchDatabases,
  appliedCount,
  migrateUntil,
  poolOn,
} from '../../support/migration-files';

// CREATE DATABASE and a migration from zero take seconds on an idle machine and much longer when several suites run at once.
setDefaultTimeout(240_000);

const scratch = new ScratchDatabases('amexp');
const pools: Pool[] = [];

afterAll(async () => {
  for (const pool of pools) await pool.end().catch(() => undefined);
  await scratch.dropAll();
});

/** A scratch database right before the expand migration, and a pool on it. */
async function beforeExpand(): Promise<{ url: string; pool: Pool }> {
  const db = await scratch.create();
  await migrateUntil(db.url, ACCOUNTS_EXPAND_SUFFIX);
  const pool = poolOn(db.url);
  pools.push(pool);
  return { url: db.url, pool };
}

/** Every row of a table as JSON text, by id: the bytes a reader of history sees. */
async function rowsAsText(pool: Pool, table: string): Promise<string[]> {
  const { rows } = await pool.query<{ row: string }>(
    `select row_to_json(t)::text as row from "${table}" t order by id`,
  );
  return rows.map((row) => row.row);
}

/** One value of one row. */
async function value<T = unknown>(pool: Pool, text: string, params: unknown[] = []): Promise<T> {
  const { rows } = await pool.query<{ v: T }>(text, params);
  return rows[0]?.v as T;
}

/** The account of an old customer, through the map. */
const accountOfCustomer = (pool: Pool, customerId: number): Promise<number> =>
  value<string>(
    pool,
    `select account_id::text as v from account_legacy_ids where legacy_type = 'customer' and legacy_id = $1`,
    [customerId],
  ).then(Number);

/** The fields of a Postgres error a test asserts on. */
async function refusal(work: Promise<unknown>): Promise<{ code?: string; constraint?: string }> {
  try {
    await work;
  } catch (error) {
    const pg = error as { code?: string; constraint?: string };
    return { code: pg.code, constraint: pg.constraint };
  }
  throw new Error('Expected the database to refuse the statement.');
}

describe('the realistic fixture, approved variant', () => {
  let url = '';
  let pool: Pool;
  let ids: FixtureIds;
  const before = {
    clients: 0,
    customers: 0,
    credentials: 0,
    maxClientId: 0,
    maxCustomerId: 0,
    audit: [] as string[],
    orderEvents: [] as string[],
    entries: [] as string[],
    journals: [] as string[],
    balances: new Map<number, string>(),
    consents: [] as Array<Record<string, unknown>>,
    alertId: 0,
    migrations: 0,
  };

  beforeAll(async () => {
    ({ url, pool } = await beforeExpand());
    ids = await loadFixture(pool, 'approved');
    // An open alert about merchant A (the evaluator's key is type:id).
    const rule = await value<string>(
      pool,
      `insert into alert_rules (key, name, metric, comparator, threshold, window_seconds, severity)
       values ('amfx.rule', 'AMFX rule', 'client.balance', 'lt', 0, 60, 'warning') returning id::text as v`,
    );
    before.alertId = Number(
      await value<string>(
        pool,
        `insert into alert_events (rule_id, severity, value, subject_type, subject_id, subject_key, rule_name, metric, comparator,
           threshold, window_seconds)
         values ($1, 'warning', -5, 'client', $2, $3, 'AMFX rule', 'client.balance', 'lt', 0, 60) returning id::text as v`,
        [rule, ids.ma, `client:${ids.ma}`],
      ),
    );
    before.clients = Number(await value(pool, 'select count(*)::int as v from clients'));
    before.customers = Number(await value(pool, 'select count(*)::int as v from customers'));
    before.credentials = Number(await value(pool, 'select count(*)::int as v from customer_credentials'));
    before.maxClientId = Number(await value(pool, 'select max(id)::int as v from clients'));
    before.maxCustomerId = Number(await value(pool, 'select max(id)::int as v from customers'));
    before.audit = await rowsAsText(pool, 'audit_logs');
    before.orderEvents = await rowsAsText(pool, 'order_events');
    before.entries = await rowsAsText(pool, 'ledger_entries');
    before.journals = await rowsAsText(pool, 'ledger_transactions');
    const balances = await pool.query<{ id: string; balance: string }>('select id, balance::text from ledger_accounts');
    before.balances = new Map(balances.rows.map((row) => [Number(row.id), row.balance]));
    before.consents = (
      await pool.query(
        `select id, legal_document_id, purpose, granted, checkout_session_id, order_id, ip, user_agent, created_at::text
           from consent_records order by id`,
      )
    ).rows;
    before.migrations = await appliedCount(pool);
    await migrateDatabase(url);
  });

  it('applies the expand migration and the stored-roles migration, and a second run applies nothing', async () => {
    expect(await appliedCount(pool)).toBe(before.migrations + 2);
    expect(await migrateDatabase(url)).toBe(0);
  });

  it('gives every converted customer a new id above every old merchant id and every old customer id, in customer id order', async () => {
    const { rows } = await pool.query<{ legacy_id: string; account_id: string; merged: boolean }>(
      `select legacy_id, account_id, merged from account_legacy_ids where legacy_type = 'customer' order by legacy_id`,
    );
    expect(rows).toHaveLength(before.customers);
    const fresh = rows.filter((row) => !row.merged).map((row) => Number(row.account_id));
    for (const id of fresh) expect(id).toBeGreaterThan(Math.max(before.maxClientId, before.maxCustomerId));
    expect(fresh).toEqual([...fresh].sort((a, b) => a - b));
    // One account per customer that was not merged, one map row per old merchant (its own id).
    expect(Number(await value(pool, 'select count(*)::int as v from clients'))).toBe(before.clients + fresh.length);
    const clientRows = await pool.query<{ legacy_id: string; account_id: string }>(
      `select legacy_id, account_id from account_legacy_ids where legacy_type = 'client'`,
    );
    expect(clientRows.rows).toHaveLength(before.clients);
    for (const row of clientRows.rows) expect(row.account_id).toBe(row.legacy_id);
  });

  it('copies a blocked and an anonymized customer with their status, and gives the anonymized one the erasure address of its new id', async () => {
    const blocked = await accountOfCustomer(pool, ids.cb);
    const anonymized = await accountOfCustomer(pool, ids.ca);
    const { rows } = await pool.query<{
      id: string;
      status: string;
      email: string;
      anonymized_at: Date | null;
      username: string | null;
    }>('select id, status, email, anonymized_at, username from clients where id = any($1::bigint[]) order by id', [
      [blocked, anonymized],
    ]);
    const byId = new Map(rows.map((row) => [Number(row.id), row]));
    expect(byId.get(blocked)?.status).toBe('blocked');
    expect(byId.get(anonymized)?.status).toBe('anonymized');
    expect(byId.get(anonymized)?.email).toBe(`deleted-account-${anonymized}@redacted.invalid`);
    expect(byId.get(anonymized)?.anonymized_at).not.toBeNull();
    for (const row of rows) expect(row.username).toBeNull();
  });

  it('keeps a guest that typed a merchant email as its own guest row, with no password even though a stray credentials row exists', async () => {
    const guest = await accountOfCustomer(pool, ids.cg);
    expect(guest).not.toBe(ids.ma);
    const { rows } = await pool.query<{ id: string; has_account: boolean; password_hash: string | null; kind: string }>(
      `select c.id, c.has_account, c.password_hash, g.kind from clients c join client_groups g on g.id = c.group_id
        where lower(c.email) = lower('amfx-ma@example.test') order by c.id`,
    );
    expect(rows.map((row) => [Number(row.id), row.has_account])).toEqual([
      [ids.ma, true],
      [guest, false],
    ]);
    expect(rows[1]?.password_hash).toBeNull();
    expect(rows[1]?.kind).toBe('b2c_retail');
    // The guest's checkout, order, payment and consent moved with it, never to the merchant.
    expect(
      Number(await value(pool, `select account_id::int as v from checkout_sessions where token = 'amfx-cs-cg'`)),
    ).toBe(guest);
    expect(
      Number(
        await value(
          pool,
          `select o.account_id::int as v from orders o join checkout_sessions s on s.id = o.checkout_session_id where s.token = 'amfx-cs-cg'`,
        ),
      ),
    ).toBe(guest);
  });

  it('makes the approved pair one account: the merchant row is the base, blanks are filled, the email proof is not copied', async () => {
    expect(await accountOfCustomer(pool, ids.cp)).toBe(ids.mc);
    expect(
      await value(
        pool,
        `select merged as v from account_legacy_ids where legacy_type = 'customer' and legacy_id = $1`,
        [ids.cp],
      ),
    ).toBe(true);
    const row = (
      await pool.query(
        `select username, email, password_hash, phone, country, currency, marketing_opt_in, created_by, email_verified_at,
                last_login_at, internal_notes, has_account, status from clients where id = $1`,
        [ids.mc],
      )
    ).rows[0];
    expect(row.username).toBe('amfx-mc');
    expect(row.email).toBe('Amfx-Pair@example.test');
    expect(row.password_hash).toBeNull();
    expect(row.phone).toBe('+962700000001');
    expect(row.country).toBe('JO');
    expect(row.currency).toBe('USD');
    expect(row.marketing_opt_in).toBe(true);
    expect(Number(row.created_by)).toBe(ids.staff);
    expect(row.email_verified_at).toBeNull();
    expect(new Date(row.last_login_at).toISOString()).toBe('2026-04-01T10:00:00.000Z');
    expect(row.internal_notes).toBe('merchant note\ncustomer note');
    expect(
      Number(await value(pool, `select count(*)::int as v from clients where lower(email) = 'amfx-pair@example.test'`)),
    ).toBe(1);
  });

  it("re-keys the pair's store wallet with its history at zero onto the account as the inactive wallet", async () => {
    const { rows } = await pool.query<{ kind: string; balance: string; entries: number }>(
      `select la.kind, la.balance::text, (select count(*)::int from ledger_entries e where e.account_id = la.id) as entries
         from ledger_accounts la where la.owner_type = 'account' and la.owner_id = $1 order by la.kind`,
      [ids.mc],
    );
    expect(rows).toEqual([
      { kind: 'client_hold', balance: '0.0000', entries: 0 },
      { kind: 'client_wallet', balance: '40.0000', entries: 1 },
      { kind: 'customer_wallet', balance: '0.0000', entries: 2 },
    ]);
  });

  it('converts the pending merchant to suspended and narrows the status check to the final four', async () => {
    expect(Number(await value(pool, `select count(*)::int as v from clients where status = 'pending'`))).toBe(0);
    expect(await value(pool, 'select status as v from clients where id = $1', [ids.mb])).toBe('suspended');
    const definition = await value<string>(
      pool,
      `select pg_get_constraintdef(oid) as v from pg_constraint where conname = 'clients_status_check'`,
    );
    expect(definition).not.toContain('pending');
    for (const status of ['active', 'suspended', 'blocked', 'anonymized']) expect(definition).toContain(`'${status}'`);
    const pending = await refusal(pool.query(`update clients set status = 'pending' where id = $1`, [ids.ma]));
    expect(pending).toEqual({ code: '23514', constraint: 'clients_status_check' });
  });

  it('gives every copied customer and the guest the retail rank, and every account a rank', async () => {
    const { rows } = await pool.query<{ kind: string; n: number }>(
      `select g.kind, count(*)::int as n from clients c join client_groups g on g.id = c.group_id
        where c.id in (select account_id from account_legacy_ids where legacy_type = 'customer' and not merged) group by g.kind`,
    );
    expect(rows).toEqual([{ kind: 'b2c_retail', n: before.customers - 1 }]);
    expect(
      Number(
        await value(
          pool,
          `select count(*)::int as v from clients c join client_groups g on g.id = c.group_id
            where not c.has_account and g.kind <> 'b2c_retail'`,
        ),
      ),
    ).toBe(0);
  });

  it('ends every session that is not a staff session and rewrites it to the account', async () => {
    const { rows } = await pool.query<{
      token_hash: string;
      subject_type: string;
      subject_id: string;
      revoked: boolean;
    }>(
      `select token_hash, subject_type, subject_id, revoked_at is not null as revoked from sessions order by token_hash`,
    );
    const byToken = new Map(rows.map((row) => [row.token_hash, row]));
    expect(byToken.get('amfx-session-staff')).toMatchObject({ subject_type: 'staff', revoked: false });
    expect(byToken.get('amfx-session-ma')).toMatchObject({
      subject_type: 'account',
      subject_id: String(ids.ma),
      revoked: true,
    });
    expect(byToken.get('amfx-session-cp')).toMatchObject({
      subject_type: 'account',
      subject_id: String(ids.mc),
      revoked: true,
    });
    expect(byToken.get('amfx-session-co')).toMatchObject({
      subject_type: 'account',
      subject_id: String(await accountOfCustomer(pool, ids.co)),
      revoked: true,
    });
  });

  it("voids the customers' links and the links of an account that may not act, and keeps an active merchant's invitation", async () => {
    const { rows } = await pool.query<{ token_hash: string; subject_type: string; used: boolean }>(
      'select token_hash, subject_type, used_at is not null as used from auth_tokens order by token_hash',
    );
    expect(Object.fromEntries(rows.map((row) => [row.token_hash, [row.subject_type, row.used]]))).toEqual({
      'amfx-token-ma': ['account', false],
      'amfx-token-mb': ['account', true],
      'amfx-token-co': ['account', true],
      'amfx-token-cp': ['account', true],
    });
  });

  it('owns every wallet by the account, and leaves every entry, journal and balance as it was', async () => {
    expect(
      Number(
        await value(pool, `select count(*)::int as v from ledger_accounts where owner_type in ('client', 'customer')`),
      ),
    ).toBe(0);
    expect(await rowsAsText(pool, 'ledger_entries')).toEqual(before.entries);
    expect(await rowsAsText(pool, 'ledger_transactions')).toEqual(before.journals);
    const balances = await pool.query<{ id: string; balance: string }>('select id, balance::text from ledger_accounts');
    expect(new Map(balances.rows.map((row) => [Number(row.id), row.balance]))).toEqual(before.balances);
    // Every stored balance still equals its entries (debit-positive entries, balances in the account's normal sign).
    const differences = await pool.query(
      `select la.id from ledger_accounts la left join ledger_entries e on e.account_id = la.id group by la.id
       having la.balance <> case when la.kind in ('fee_income', 'vat_payable', 'customer_funds', 'revenue', 'owner_capital',
                                                  'client_wallet', 'client_hold', 'customer_wallet')
                                 then -coalesce(sum(e.amount), 0) else coalesce(sum(e.amount), 0) end`,
    );
    expect(differences.rows).toEqual([]);
  });

  it('leaves the audit log and the order timeline byte for byte, and refuses an old actor word in a new audit row', async () => {
    expect(await rowsAsText(pool, 'audit_logs')).toEqual(before.audit);
    expect(await rowsAsText(pool, 'order_events')).toEqual(before.orderEvents);
    const old = await refusal(
      pool.query(
        `insert into audit_logs (actor_type, actor_id, action, entity_type, entity_id) values ('customer', 1, 'x', 'account', 1)`,
      ),
    );
    expect(old).toEqual({ code: '23514', constraint: 'audit_logs_actor_type_current_check' });
    await pool.query(
      `insert into audit_logs (actor_type, actor_id, action, entity_type, entity_id) values ('account', $1, 'account.update', 'account', $1)`,
      [ids.ma],
    );
    // The old merchant row of the audit log still names its account through the map.
    expect(
      Number(
        await value(
          pool,
          `select m.account_id::int as v from audit_logs a
             join account_legacy_ids m on m.legacy_type = 'client' and m.legacy_id = a.actor_id
            where a.actor_type = 'client' and a.action = 'merchant.update'`,
        ),
      ),
    ).toBe(ids.ma);
  });

  it('refuses a store wallet owned by the old customer word', async () => {
    const refused = await refusal(
      pool.query(
        `insert into ledger_accounts (kind, owner_type, owner_id, currency) values ('customer_wallet', 'customer', 999, 'USD')`,
      ),
    );
    expect(refused.code).toBe('23514');
    expect(['ledger_accounts_owner_type_check', 'ledger_accounts_kind_owner_check']).toContain(
      refused.constraint ?? '',
    );
  });

  it('leaves no old word in a mutable (type, id) column', async () => {
    const counts = await pool.query<{ n: number }>(
      `select ((select count(*) from sessions where subject_type in ('client', 'customer'))
             + (select count(*) from auth_tokens where subject_type in ('client', 'customer'))
             + (select count(*) from notifications where recipient_type in ('client', 'customer'))
             + (select count(*) from notification_inbox where recipient_type in ('client', 'customer'))
             + (select count(*) from support_tickets where requester_type in ('client', 'customer'))
             + (select count(*) from ticket_messages where author_type in ('client', 'customer'))
             + (select count(*) from consent_records where subject_type in ('client', 'customer'))
             + (select count(*) from files where owner_type in ('client', 'customer'))
             + (select count(*) from refunds where requested_by_type = 'customer')
             + (select count(*) from alert_events where subject_type = 'client'))::int as n`,
    );
    expect(counts.rows[0]?.n).toBe(0);
  });

  it('rewrites the alert about a merchant, its key included', async () => {
    const row = (
      await pool.query('select subject_type, subject_id, subject_key from alert_events where id = $1', [before.alertId])
    ).rows[0];
    expect(row).toEqual({ subject_type: 'account', subject_id: String(ids.ma), subject_key: `account:${ids.ma}` });
  });

  it('moves tickets, messages, files and consents to the account, the proof columns of each consent untouched', async () => {
    expect(
      (await pool.query(`select requester_type, requester_id::int from support_tickets where number = 'AMFX-T1'`))
        .rows[0],
    ).toEqual({ requester_type: 'account', requester_id: ids.mc });
    expect(
      (await pool.query(`select owner_type, owner_id::int from files where key = 'amfx/cp-receipt.png'`)).rows[0],
    ).toEqual({ owner_type: 'account', owner_id: ids.mc });
    expect(
      (
        await pool.query(
          `select distinct author_type from ticket_messages m join support_tickets t on t.id = m.ticket_id where t.number like 'AMFX-%'`,
        )
      ).rows
        .map((row) => row.author_type as string)
        .sort(),
    ).toEqual(['account', 'staff']);
    const after = (
      await pool.query(
        `select id, legal_document_id, purpose, granted, checkout_session_id, order_id, ip, user_agent, created_at::text
           from consent_records order by id`,
      )
    ).rows;
    expect(after).toEqual(before.consents);
    expect(
      Number(
        await value(
          pool,
          `select count(*)::int as v from consent_records where subject_type = 'account' and subject_id = $1`,
          [ids.mc],
        ),
      ),
    ).toBe(1);
  });

  it('keeps one campaign item for the pair (read at the earlier time), and the audience of a message for its old rows', async () => {
    const items = await pool.query<{ recipient_id: string; read_at: Date | null }>(
      `select recipient_id, read_at from notification_inbox where campaign_id is not null`,
    );
    expect(items.rows).toHaveLength(1);
    expect(Number(items.rows[0]!.recipient_id)).toBe(ids.mc);
    expect(items.rows[0]!.read_at?.toISOString()).toBe('2026-05-01T08:00:00.000Z');
    const keyless = await value<string>(
      pool,
      `select dedupe_key as v from notification_inbox where event = 'order.completed'`,
    );
    expect(keyless).toMatch(/^inapp:customer:order\.completed:migrated-\d+$/);
    const audiences = await pool.query<{ audience: string }>(
      `select payload ->> 'audience' as audience from notifications order by id`,
    );
    expect(audiences.rows.map((row) => row.audience)).toEqual(['merchant', 'customer']);
  });

  it('lists the people of a campaign as accounts, a person who became a duplicate once', async () => {
    const audience = await value<{ include: unknown[]; exclude: unknown[] }>(
      pool,
      'select audience as v from notification_campaigns',
    );
    expect(audience.include).toEqual([
      { type: 'account', id: ids.mc },
      { type: 'account', id: await accountOfCustomer(pool, ids.co) },
      { type: 'staff', id: ids.staff },
    ]);
    expect(audience.exclude).toEqual([{ type: 'account', id: await accountOfCustomer(pool, ids.cb) }]);
  });

  it('gives every order, invoice, payment, dispute and data request an account, and every refund with a payment its payment account', async () => {
    for (const table of ['orders', 'invoices', 'payments', 'disputes', 'data_requests']) {
      expect(Number(await value(pool, `select count(*)::int as v from ${table} where account_id is null`)), table).toBe(
        0,
      );
    }
    const refunds = await pool.query<{ account_id: string | null; payment_account: string }>(
      `select r.account_id, p.account_id as payment_account from refunds r join payments p on p.id = r.payment_id`,
    );
    expect(refunds.rows).toHaveLength(2);
    for (const row of refunds.rows) expect(row.account_id).toBe(row.payment_account);
  });

  it('keeps the old customer tables, refuses any write to them, and drops the approvals row', async () => {
    expect(Number(await value(pool, 'select count(*)::int as v from customers'))).toBe(before.customers);
    expect(Number(await value(pool, 'select count(*)::int as v from customer_credentials'))).toBe(before.credentials);
    expect(await refusal(pool.query(`insert into customers (email) values ('amfx-new@example.test')`))).toEqual({
      code: '23514',
      constraint: 'customers_retired',
    });
    expect(await refusal(pool.query(`update customer_credentials set must_change_password = true`))).toEqual({
      code: '23514',
      constraint: 'customer_credentials_retired',
    });
    expect(
      Number(await value(pool, `select count(*)::int as v from settings where key = 'accountsMerge.approvedPairs'`)),
    ).toBe(0);
  });

  it('keeps the four current checks NOT VALID', async () => {
    const { rows } = await pool.query<{ conname: string; convalidated: boolean }>(
      `select conname, convalidated from pg_constraint where conname like '%\\_current\\_check' order by conname`,
    );
    expect(rows).toEqual([
      { conname: 'audit_logs_actor_type_current_check', convalidated: false },
      { conname: 'ledger_transactions_created_by_type_current_check', convalidated: false },
      { conname: 'ledger_transactions_ref_type_current_check', convalidated: false },
      { conname: 'order_events_actor_type_current_check', convalidated: false },
    ]);
  });
});

describe('an empty database', () => {
  it('migrates from zero through the expand migration with nothing to move, and a second run applies nothing', async () => {
    const db = await scratch.create();
    await migrateDatabase(db.url);
    const pool = poolOn(db.url);
    pools.push(pool);
    expect(Number(await value(pool, 'select count(*)::int as v from account_legacy_ids'))).toBe(0);
    expect(Number(await value(pool, 'select count(*)::int as v from clients'))).toBe(0);
    expect(await migrateDatabase(db.url)).toBe(0);
  });
});

describe('one merchant and one customer', () => {
  it('turns merchant 1 and customer 1 into accounts 1 and 2, and the old rows of merchant 1 still name account 1', async () => {
    const { url, pool } = await beforeExpand();
    const group = await value<string>(
      pool,
      `select id::text as v from client_groups where kind = 'b2b' order by id limit 1`,
    );
    await pool.query(
      `insert into clients (id, username, email, name, group_id, referral_code, status) overriding system value
       values (1, 'shop-one', 'shop@example.test', 'Shop', $1, 'REF-1', 'active')`,
      [group],
    );
    await pool.query(
      `insert into customers (id, email, name, has_account) overriding system value values (1, 'buyer@example.test', 'Buyer', true)`,
    );
    await pool.query(
      `insert into audit_logs (actor_type, actor_id, action, entity_type, entity_id) values ('client', 1, 'merchant.update', 'merchant', 1)`,
    );
    await migrateDatabase(url);
    expect(
      (
        await pool.query(
          `select legacy_type, legacy_id::int, account_id::int from account_legacy_ids order by legacy_type`,
        )
      ).rows,
    ).toEqual([
      { legacy_type: 'client', legacy_id: 1, account_id: 1 },
      { legacy_type: 'customer', legacy_id: 1, account_id: 2 },
    ]);
    expect((await pool.query('select id::int, email from clients order by id')).rows).toEqual([
      { id: 1, email: 'shop@example.test' },
      { id: 2, email: 'buyer@example.test' },
    ]);
  });
});
