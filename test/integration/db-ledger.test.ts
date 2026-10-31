// The ledger rules the database enforces on its own (decisions 024, 027): every transaction sums to zero at commit,
// the ledger, the order timeline and the audit log are append-only, and account identity is unique.
import { afterAll, beforeEach, describe, expect, it } from 'bun:test';
import { schema as s } from '../../src/infra/db';
import { insertLedgerAccounts, insertLedgerTransaction, insertOrder, insertOrderParents } from '../support/fixtures';
import { closeTestDb, pgErrorOf, resetDb, testDb } from '../support/db';

beforeEach(resetDb);
afterAll(closeTestDb);

/** Posts one ledger transaction with raw SQL in its own database transaction, exactly as `postTransaction` will. */
async function post(
  lines: Array<[account: number, amount: string]>,
  key = `k:${crypto.randomUUID()}`,
): Promise<number> {
  const { pool } = await testDb();
  const client = await pool.connect();
  try {
    await client.query('begin');
    const header = await client.query<{ id: number }>(
      `insert into ledger_transactions (kind, ref_type, idempotency_key, created_by_type)
       values ('deposit', 'system', $1, 'system') returning id`,
      [key],
    );
    const id = Number(header.rows[0]!.id);
    for (const [account, amount] of lines) {
      await client.query(
        'insert into ledger_entries (transaction_id, account_id, amount, balance_after) values ($1, $2, $3, 0)',
        [id, account, amount],
      );
    }
    await client.query('commit');
    return id;
  } catch (error) {
    await client.query('rollback').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

describe('zero-sum constraint trigger', () => {
  it('accepts balanced transactions of two or more lines', async () => {
    const { db } = await testDb();
    const { bank, revenue } = await insertLedgerAccounts(db);
    await post([
      [bank, '5.0000'],
      [revenue, '-5.0000'],
    ]);
    await post([
      [bank, '10.0000'],
      [revenue, '-4.0000'],
      [revenue, '-6.0000'],
    ]);
    expect(await db.$count(s.ledgerEntries)).toBe(5);
  });

  it('rejects an unbalanced transaction at commit and leaves nothing behind', async () => {
    const { db } = await testDb();
    const { bank, revenue } = await insertLedgerAccounts(db);
    const failure = await pgErrorOf(
      post([
        [bank, '5.0000'],
        [revenue, '-4.9999'],
      ]),
    );
    expect(failure.code).toBe('23514');
    expect(failure.constraint).toBe('ledger_entries_zero_sum');
    expect(failure.message).toContain('does not sum to zero');
    expect(await db.$count(s.ledgerTransactions)).toBe(0);
    expect(await db.$count(s.ledgerEntries)).toBe(0);
  });

  it('rejects a balanced transaction whose accounts use different currencies', async () => {
    const { db } = await testDb();
    const { bank } = await insertLedgerAccounts(db);
    await db.insert(s.currencies).values({ code: 'EUR', name: 'Euro', rateToBase: '0.92000000', decimals: 2 });
    const [eurRevenue] = await db
      .insert(s.ledgerAccounts)
      .values({ kind: 'revenue', currency: 'EUR' })
      .returning({ id: s.ledgerAccounts.id });
    const failure = await pgErrorOf(
      post([
        [bank, '5.0000'],
        [eurRevenue!.id, '-5.0000'],
      ]),
    );
    expect(failure.code).toBe('23514');
    expect(failure.constraint).toBe('ledger_entries_single_currency');
    expect(await db.$count(s.ledgerEntries)).toBe(0);
  });

  it('rejects a single line', async () => {
    const { db } = await testDb();
    const { bank } = await insertLedgerAccounts(db);
    expect((await pgErrorOf(post([[bank, '1.0000']]))).constraint).toBe('ledger_entries_zero_sum');
  });

  it('checks at commit, not per statement: lines may be inserted one at a time', async () => {
    const { db, pool } = await testDb();
    const { bank, revenue } = await insertLedgerAccounts(db);
    const client = await pool.connect();
    try {
      await client.query('begin');
      const header = await client.query(
        `insert into ledger_transactions (kind, ref_type, idempotency_key, created_by_type)
         values ('deposit', 'system', $1, 'system') returning id`,
        [`deferred:${crypto.randomUUID()}`],
      );
      const entry =
        'insert into ledger_entries (transaction_id, account_id, amount, balance_after) values ($1, $2, $3, 0)';
      await client.query(entry, [header.rows[0].id, bank, '2.0000']);
      await client.query(entry, [header.rows[0].id, revenue, '-2.0000']);
      await client.query('commit');
    } finally {
      client.release();
    }
    expect(await db.$count(s.ledgerEntries)).toBe(2);
  });

  it('catches an UPDATE that breaks the sum even when the append-only trigger is out of the way', async () => {
    const { db, pool } = await testDb();
    const { bank, revenue } = await insertLedgerAccounts(db);
    await post([
      [bank, '5.0000'],
      [revenue, '-5.0000'],
    ]);
    const [entry] = await db.select({ id: s.ledgerEntries.id }).from(s.ledgerEntries).limit(1);

    const client = await pool.connect();
    try {
      await client.query('begin');
      // DDL is transactional: if this transaction fails to commit, the trigger comes back enabled.
      await client.query('alter table ledger_entries disable trigger ledger_entries_append_only');
      await client.query('update ledger_entries set amount = amount + 1 where id = $1', [entry!.id]);
      const failure = await pgErrorOf(client.query('commit'));
      expect(failure.constraint).toBe('ledger_entries_zero_sum');
    } finally {
      await client.query('rollback').catch(() => undefined);
      client.release();
    }
    const { rows } = await pool.query(`select tgenabled from pg_trigger where tgname = 'ledger_entries_append_only'`);
    expect(rows[0].tgenabled).toBe('O');
    expect((await db.select().from(s.ledgerEntries)).map((row) => row.amount).sort()).toEqual(['-5.0000', '5.0000']);
  });

  it('catches a line moved to another transaction, and a deleted line', async () => {
    const { db, pool } = await testDb();
    const { bank, revenue } = await insertLedgerAccounts(db);
    const first = await post([
      [bank, '5.0000'],
      [revenue, '-5.0000'],
    ]);
    const second = await post([
      [bank, '7.0000'],
      [revenue, '-7.0000'],
    ]);
    const [entry] = await db.select({ id: s.ledgerEntries.id }).from(s.ledgerEntries).limit(1);

    for (const statement of [
      ['update ledger_entries set transaction_id = $2 where id = $1', [entry!.id, second]],
      ['delete from ledger_entries where id = $1', [entry!.id]],
    ] as const) {
      const client = await pool.connect();
      try {
        await client.query('begin');
        await client.query('alter table ledger_entries disable trigger ledger_entries_append_only');
        await client.query(statement[0], [...statement[1]]);
        expect((await pgErrorOf(client.query('commit'))).constraint).toBe('ledger_entries_zero_sum');
      } finally {
        await client.query('rollback').catch(() => undefined);
        client.release();
      }
    }
    expect(first).not.toBe(second);
    expect(await db.$count(s.ledgerEntries)).toBe(4);
  });

  it('refuses a zero-amount line', async () => {
    const { db } = await testDb();
    const { bank } = await insertLedgerAccounts(db);
    const transaction = await insertLedgerTransaction(db);
    const failure = await pgErrorOf(
      db
        .insert(s.ledgerEntries)
        .values({ transactionId: transaction, accountId: bank, amount: '0', balanceAfter: '0' }),
    );
    expect(failure.constraint).toBe('ledger_entries_amount_check');
  });
});

describe('append-only tables', () => {
  async function seedAppendOnly() {
    const { db } = await testDb();
    const { bank, revenue } = await insertLedgerAccounts(db);
    await post([
      [bank, '5.0000'],
      [revenue, '-5.0000'],
    ]);
    const parents = await insertOrderParents(db);
    const orderId = await insertOrder(db, parents);
    await db
      .insert(s.orderEvents)
      .values({ orderId, type: 'placed', toStatus: 'pending', actorType: 'client', actorId: parents.clientId });
    await db
      .insert(s.auditLogs)
      .values({ actorType: 'staff', actorId: 1, action: 'suspended admin', entityType: 'staff', entityId: 2 });
    return db;
  }

  const UPDATES: Record<string, string> = {
    ledger_entries: 'update ledger_entries set balance_after = balance_after',
    ledger_transactions: "update ledger_transactions set memo = 'changed'",
    order_events: "update order_events set type = 'changed'",
    audit_logs: "update audit_logs set action = 'changed'",
  };

  for (const [table, update] of Object.entries(UPDATES)) {
    it(`${table} refuses UPDATE and DELETE`, async () => {
      await seedAppendOnly();
      const { pool } = await testDb();
      const updated = await pgErrorOf(pool.query(update));
      expect(updated.constraint).toBe(`${table}_append_only`);
      expect(updated.message).toContain('append-only');
      const deleted = await pgErrorOf(pool.query(`delete from ${table}`));
      expect(deleted.constraint).toBe(`${table}_append_only`);
      const { rows } = await pool.query(`select count(*)::int as n from ${table}`);
      expect(rows[0].n).toBeGreaterThan(0);
    });
  }

  it('still lets the test reset truncate them (TRUNCATE is not blocked)', async () => {
    await seedAppendOnly();
    const { db } = await testDb();
    await resetDb();
    expect(await db.$count(s.ledgerEntries)).toBe(0);
    expect(await db.$count(s.auditLogs)).toBe(0);
  });
});

describe('ledger accounts', () => {
  it('keep one system account per kind and currency (NULL owners count as equal)', async () => {
    const { db } = await testDb();
    await insertLedgerAccounts(db);
    const failure = await pgErrorOf(db.insert(s.ledgerAccounts).values({ kind: 'bank', currency: 'USD' }));
    expect(failure.code).toBe('23505');
    expect(failure.constraint).toBe('ledger_accounts_identity_uq');
  });

  it('give each merchant one wallet and one hold, and refuse an account whose kind and owner disagree', async () => {
    const { db } = await testDb();
    const { clientId } = await insertOrderParents(db);
    await db.insert(s.ledgerAccounts).values([
      { kind: 'client_wallet', ownerType: 'client', ownerId: clientId, currency: 'USD' },
      { kind: 'client_hold', ownerType: 'client', ownerId: clientId, currency: 'USD' },
    ]);
    const twice = await pgErrorOf(
      db
        .insert(s.ledgerAccounts)
        .values({ kind: 'client_wallet', ownerType: 'client', ownerId: clientId, currency: 'USD' }),
    );
    expect(twice.constraint).toBe('ledger_accounts_identity_uq');
    const walletWithoutOwner = await pgErrorOf(
      db.insert(s.ledgerAccounts).values({ kind: 'client_wallet', currency: 'USD' }),
    );
    expect(walletWithoutOwner.constraint).toBe('ledger_accounts_kind_owner_check');
    const bankWithOwner = await pgErrorOf(
      db.insert(s.ledgerAccounts).values({ kind: 'bank', ownerType: 'client', ownerId: clientId, currency: 'USD' }),
    );
    expect(bankWithOwner.constraint).toBe('ledger_accounts_kind_owner_check');
  });

  it('keep the idempotency key of a transaction unique', async () => {
    const { db } = await testDb();
    await insertLedgerAccounts(db);
    await insertLedgerTransaction(db, 'order_event:1');
    const failure = await pgErrorOf(insertLedgerTransaction(db, 'order_event:1'));
    expect(failure.constraint).toBe('ledger_transactions_idempotency_key_uq');
  });
});
