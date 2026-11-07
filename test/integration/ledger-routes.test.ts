// Integration tests of the ledger screens (map stage 3, resolutions money-1, money-6, money-15): GET /admin/ledger/transactions
// (filters, sorts, search, ranges), GET /admin/ledger/transactions/:id, GET /admin/ledger/accounts and POST /admin/ledger/reconcile.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import { eq, sql } from 'drizzle-orm';
import type { LightMyRequestResponse } from 'fastify';
import { Money } from '../../src/common/money';
import { schema as s } from '../../src/infra/db';
import {
  type MoneyEventPosting,
  adjust,
  b2cPay,
  complete,
  deposit,
  order,
  payout,
  postTransaction,
  topup,
} from '../../src/modules/money';
import { type TestApp, createTestApp } from '../support/app';
import { clearIdentityCaches, signInStaff } from '../support/auth';
import { MINUTE, TestClock } from '../support/clock';
import { closeTestDb, resetDb, testDb } from '../support/db';
import { insertWalletMerchant } from '../support/money';

const clock = new TestClock('2026-11-01T10:00:00.000Z');
let t: TestApp;

beforeAll(async () => {
  t = await createTestApp({ clock });
});
afterAll(async () => {
  await resetDb();
  await t.close();
  await closeTestDb();
});
beforeEach(async () => {
  clock.set('2026-11-01T10:00:00.000Z');
  await resetDb();
  await clearIdentityCaches(t);
});

const m = (amount: string) => Money.of(amount);
type Staff = Awaited<ReturnType<typeof signInStaff>>;
const get = (staff: Staff, url: string) => t.app.inject({ method: 'GET', url, headers: staff.session.headers });
const post = (staff: Staff, url: string) =>
  t.app.inject({ method: 'POST', url, headers: staff.session.mutationHeaders });

interface Journal {
  id: number;
  kind: string;
  memo: string;
  refType: string;
  refId: number;
  createdAt: string;
  createdBy: { type: string; id: number | null; name: string | null };
  entries: Array<{
    id: number;
    amount: string;
    balanceAfter: string;
    account: { kind: string; id: number; ownerType: string | null; ownerId: number | null; ownerName: string | null };
  }>;
}

/** A small world: two merchants, a supplier, and eight journals one minute apart. */
async function world() {
  const { db } = await testDb();
  const zain = await insertWalletMerchant(db, { name: 'Zain Mobile Hub' });
  const noor = await insertWalletMerchant(db, { name: 'Al-Noor Telecom' });
  const [supplier] = await db
    .insert(s.suppliers)
    .values({ name: 'Nordic GSM', driver: 'dhru', baseUrl: 'https://supplier.example', paramFormat: 'dhru_xml' })
    .returning({ id: s.suppliers.id });
  const staff = await signInStaff(t, ['ledger:read', 'ledger:reconcile']);
  const [named] = await db
    .select({ name: s.staffUsers.name })
    .from(s.staffUsers)
    .where(eq(s.staffUsers.id, staff.staffId));
  const ids: Record<string, number> = {};
  const book = async (
    label: string,
    posting: MoneyEventPosting,
    refId: number,
    memo: string,
    by: { type: 'staff' | 'system'; id: number | null } = { type: 'system', id: null },
  ) => {
    clock.advance(MINUTE);
    const posted = await db.transaction((tx) =>
      postTransaction(
        tx,
        { ...posting, refId, idempotencyKey: `world:${label}`, currency: 'USD', memo, createdBy: by },
        clock.now(),
      ),
    );
    ids[label] = posted.id;
  };
  await book(
    'deposit',
    deposit({ clientId: zain.id, amount: m('100'), fee: m('3') }),
    1000,
    'Deposit PAY-1000 (Bank transfer)',
    {
      type: 'staff',
      id: staff.staffId,
    },
  );
  await book('deposit2', deposit({ clientId: noor.id, amount: m('50') }), 1001, 'Deposit PAY-1001 (Card)');
  await book('hold', order({ clientId: zain.id, amount: m('5') }), 48100, 'Hold for ORD-48100');
  await book(
    'settle',
    complete({ clientId: zain.id, price: m('5'), cost: m('3'), supplierId: supplier!.id }),
    48100,
    'Settle ORD-48100',
  );
  await book(
    'topup',
    topup({ supplierId: supplier!.id, amount: m('50') }),
    supplier!.id,
    'Prepaid top-up, Nordic GSM',
    {
      type: 'staff',
      id: staff.staffId,
    },
  );
  await book(
    'adjust',
    adjust({ clientId: noor.id, amount: m('10'), direction: 'credit' }),
    noor.id,
    'Manual credit: goodwill',
    {
      type: 'staff',
      id: staff.staffId,
    },
  );
  await book('b2c', b2cPay({ net: m('12.49'), vat: m('2.50') }), 20400, 'Payment for SF-20400 (Card (3DS))');
  await book('payout', payout({ amount: m('14.26') }), 0, 'Gateway payout to bank');
  return { db, zain, noor, supplierId: supplier!.id, staff, staffName: named!.name, ids };
}

const idsOf = (res: LightMyRequestResponse) => res.json<Journal[]>().map((row) => row.id);

describe('GET /admin/ledger/transactions', () => {
  it('lists journals newest first with their lines, owner names, author and wire reference types', async () => {
    const { staff, staffName, ids, zain } = await world();
    const res = await get(staff, '/admin/ledger/transactions');
    expect(res.statusCode).toBe(200);
    expect(res.headers['x-total-count']).toBe('8');
    const rows = res.json<Journal[]>();
    expect(rows.map((row) => row.id)).toEqual([
      ids.payout,
      ids.b2c,
      ids.adjust,
      ids.topup,
      ids.settle,
      ids.hold,
      ids.deposit2,
      ids.deposit,
    ] as number[]);

    const deposit = rows.at(-1)!;
    expect(deposit).toMatchObject({
      kind: 'deposit',
      memo: 'Deposit PAY-1000 (Bank transfer)',
      refType: 'payment',
      refId: 1000,
      createdAt: '2026-11-01T10:01:00.000Z',
      createdBy: { type: 'staff', id: staff.staffId, name: staffName },
    });
    // Debit positive, and balanceAfter in the same sign (a credit-normal account reads negative).
    expect(deposit.entries.map((entry) => [entry.account.kind, entry.amount, entry.balanceAfter])).toEqual([
      ['gateway_clearing', '103.0000', '103.0000'],
      ['client_wallet', '-100.0000', '-100.0000'],
      ['fee_income', '-3.0000', '-3.0000'],
    ]);
    expect(deposit.entries[1]!.account).toMatchObject({
      ownerType: 'client',
      ownerId: zain.id,
      ownerName: 'Zain Mobile Hub',
    });
    expect(deposit.entries[0]!.account).toMatchObject({ ownerType: null, ownerId: null, ownerName: null });
    for (const row of rows) {
      expect(Money.sum(row.entries.map((entry) => m(entry.amount))).toWire()).toBe('0.0000');
    }
    // A system posting has no author and refId 0.
    expect(rows[0]).toMatchObject({
      kind: 'settlement',
      refType: 'system',
      refId: 0,
      createdBy: { type: 'system', id: null, name: null },
    });
  });

  it('names a supplier on its prepaid account', async () => {
    const { staff, ids } = await world();
    const rows = (await get(staff, '/admin/ledger/transactions?kind=supplier_topup')).json<Journal[]>();
    expect(rows.map((row) => row.id)).toEqual([ids.topup!]);
    expect(rows[0]!.entries.find((entry) => entry.account.kind === 'supplier_prepaid')!.account).toMatchObject({
      ownerType: 'supplier',
      ownerName: 'Nordic GSM',
    });
  });

  it('sends a manual adjustment as refType system with the merchant as refId, and filters it with system', async () => {
    const { staff, ids, noor } = await world();
    const rows = (await get(staff, '/admin/ledger/transactions?refType=system')).json<Journal[]>();
    // The stored `system` payout and the stored `client` adjustment both answer to the wire word `system`.
    expect(rows.map((row) => row.id).sort()).toEqual([ids.adjust!, ids.payout!].sort());
    expect(rows.find((row) => row.id === ids.adjust)).toMatchObject({ refType: 'system', refId: noor.id });
    const stored = await (
      await testDb()
    ).db
      .select({ refType: s.ledgerTransactions.refType })
      .from(s.ledgerTransactions)
      .where(eq(s.ledgerTransactions.id, ids.adjust!));
    expect(stored[0]!.refType).toBe('client');
  });

  it('never sends a reference type the console does not know', async () => {
    const { staff } = await world();
    const known = ['order', 'payment', 'invoice', 'refund', 'dispute', 'accrual', 'supplier', 'system'];
    const rows = (await get(staff, '/admin/ledger/transactions?_end=100')).json<Journal[]>();
    expect(rows.every((row) => known.includes(row.refType))).toBe(true);
  });

  it('filters by refType and refId, by kind and by account kind, and combines them', async () => {
    const { staff, ids } = await world();
    expect(idsOf(await get(staff, '/admin/ledger/transactions?refType=order&refId=48100&_sort=id&_order=asc'))).toEqual(
      [ids.hold!, ids.settle!],
    );
    expect(idsOf(await get(staff, '/admin/ledger/transactions?refType=payment&refId=1001'))).toEqual([ids.deposit2!]);
    expect(idsOf(await get(staff, '/admin/ledger/transactions?kind=deposit&_sort=id&_order=asc'))).toEqual([
      ids.deposit!,
      ids.deposit2!,
    ]);
    expect(
      idsOf(await get(staff, '/admin/ledger/transactions?refType=order&refType=supplier&_sort=id&_order=asc')),
    ).toEqual([ids.hold!, ids.settle!, ids.topup!, ids.b2c!]);
    expect(
      idsOf(
        await get(
          staff,
          '/admin/ledger/transactions?refType_ne=order&refType_ne=payment&refType_ne=system&refType_ne=accrual&_sort=id&_order=asc',
        ),
      ),
    ).toEqual([ids.topup!]);
    const bank = await get(staff, '/admin/ledger/transactions?accountKind=bank&_sort=id&_order=asc');
    expect(idsOf(bank)).toEqual([ids.topup!, ids.payout!]);
    expect(bank.headers['x-total-count']).toBe('2');
    expect(idsOf(await get(staff, '/admin/ledger/transactions?accountKind=client_hold&kind=order_settle'))).toEqual([
      ids.settle!,
    ]);
    // refId 0 is a real value: the system postings.
    expect(idsOf(await get(staff, '/admin/ledger/transactions?refId=0'))).toEqual([ids.payout!]);
  });

  it('sorts by createdAt, id or kind in either direction, with the id breaking ties', async () => {
    const { staff, ids } = await world();
    expect(idsOf(await get(staff, '/admin/ledger/transactions?_sort=createdAt&_order=asc&_end=2'))).toEqual([
      ids.deposit!,
      ids.deposit2!,
    ]);
    expect(idsOf(await get(staff, '/admin/ledger/transactions?_sort=id&_order=desc&_end=1'))).toEqual([ids.payout!]);
    const byKind = (await get(staff, '/admin/ledger/transactions?_sort=kind,id&_order=asc,asc&_end=100')).json<
      Journal[]
    >();
    expect(byKind.map((row) => row.kind)).toEqual([...byKind.map((row) => row.kind)].sort());
    expect(byKind.filter((row) => row.kind === 'deposit').map((row) => row.id)).toEqual([ids.deposit!, ids.deposit2!]);
  });

  it('pages with the range and counts every match before the range', async () => {
    const { staff, ids } = await world();
    const page = await get(staff, '/admin/ledger/transactions?_start=2&_end=4&_sort=id&_order=asc');
    expect(idsOf(page)).toEqual([ids.hold!, ids.settle!]);
    expect(page.headers['x-total-count']).toBe('8');
    const none = await get(staff, '/admin/ledger/transactions?_start=100&_end=110');
    expect(none.json()).toEqual([]);
    expect(none.headers['x-total-count']).toBe('8');
    expect((await get(staff, '/admin/ledger/transactions?kind=nothing')).headers['x-total-count']).toBe('0');
  });

  describe('q', () => {
    it('reads a number as a journal id or a record id of any reference type (resolution money-15)', async () => {
      const { staff, ids } = await world();
      // 48100 is the order of two journals; the hold's own journal id is a small number.
      expect(idsOf(await get(staff, '/admin/ledger/transactions?q=48100&_sort=id&_order=asc'))).toEqual([
        ids.hold!,
        ids.settle!,
      ]);
      expect(idsOf(await get(staff, `/admin/ledger/transactions?q=${ids.b2c}`))).toContain(ids.b2c!);
      expect(idsOf(await get(staff, '/admin/ledger/transactions?q=1000'))).toEqual([ids.deposit!]);
    });

    it('reads text as memo, kind and owner names, ignoring case', async () => {
      const { staff, ids } = await world();
      expect(idsOf(await get(staff, '/admin/ledger/transactions?q=pay-1001'))).toEqual([ids.deposit2!]);
      expect(idsOf(await get(staff, '/admin/ledger/transactions?q=supplier_topup'))).toEqual([ids.topup!]);
      // By merchant name: every journal with a line on one of Zain's accounts.
      expect(idsOf(await get(staff, '/admin/ledger/transactions?q=ZAIN&_sort=id&_order=asc'))).toEqual([
        ids.deposit!,
        ids.hold!,
        ids.settle!,
      ]);
      expect(idsOf(await get(staff, '/admin/ledger/transactions?q=nordic&_sort=id&_order=asc'))).toEqual([
        ids.settle!,
        ids.topup!,
      ]);
    });

    it('takes % and _ literally and combines with the filters', async () => {
      const { staff, ids } = await world();
      expect(idsOf(await get(staff, '/admin/ledger/transactions?q=%25'))).toEqual([]);
      expect(idsOf(await get(staff, '/admin/ledger/transactions?q=Hold_for'))).toEqual([]);
      expect(idsOf(await get(staff, '/admin/ledger/transactions?q=Hold%20for'))).toEqual([ids.hold!]);
      expect(idsOf(await get(staff, '/admin/ledger/transactions?q=zain&kind=deposit'))).toEqual([ids.deposit!]);
    });
  });

  it('refuses what it does not offer with 422 naming the parameter', async () => {
    const { staff } = await world();
    for (const url of [
      '/admin/ledger/transactions?refType=ledger_transaction',
      '/admin/ledger/transactions?refType=client',
      '/admin/ledger/transactions?accountKind=piggy_bank',
      '/admin/ledger/transactions?_sort=memo',
      '/admin/ledger/transactions?amount=1',
      '/admin/ledger/transactions?refId=abc',
      '/admin/ledger/transactions?_end=5000',
    ]) {
      expect((await get(staff, url)).statusCode).toBe(422);
    }
    const bad = await get(staff, '/admin/ledger/transactions?refType=client');
    expect(bad.json().errors[0].field).toBe('refType');
  });

  it('needs ledger:read', async () => {
    await world();
    const other = await signInStaff(t, ['wallet:read']);
    expect((await get(other, '/admin/ledger/transactions')).json()).toMatchObject({ code: 'FORBIDDEN' });
    expect((await t.app.inject({ method: 'GET', url: '/admin/ledger/transactions' })).statusCode).toBe(401);
  });
});

describe('GET /admin/ledger/transactions/:id', () => {
  it('answers one journal in the shape of a list row', async () => {
    const { staff, ids } = await world();
    const one = (await get(staff, `/admin/ledger/transactions/${ids.settle}`)).json<Journal>();
    const listed = (await get(staff, '/admin/ledger/transactions?q=Settle%20ORD')).json<Journal[]>()[0];
    expect(one).toEqual(listed!);
    expect(one.entries.map((entry) => [entry.account.kind, entry.amount])).toEqual([
      ['client_hold', '5.0000'],
      ['cogs', '3.0000'],
      ['revenue', '-5.0000'],
      ['supplier_prepaid', '-3.0000'],
    ]);
  });

  it('answers 404 for an unknown journal and 422 for a bad id', async () => {
    const { staff } = await world();
    expect((await get(staff, '/admin/ledger/transactions/99999')).json()).toMatchObject({ code: 'NOT_FOUND' });
    expect((await get(staff, '/admin/ledger/transactions/abc')).statusCode).toBe(422);
  });
});

describe('GET /admin/ledger/accounts', () => {
  it('sums each account kind debit positive and balances the books', async () => {
    const { staff } = await world();
    const body = (await get(staff, '/admin/ledger/accounts')).json();
    const byKind = Object.fromEntries(
      (body.rows as Array<{ kind: string; balance: string; accounts: number }>).map((row) => [row.kind, row]),
    );
    expect(body.currency).toBe('USD');
    // Zain: 100 deposited, 5 held then settled; Al-Noor: 50 + 10; so the wallets owe the merchants 155.
    expect(byKind.client_wallet).toEqual({ kind: 'client_wallet', balance: '-155.0000', accounts: 2 });
    expect(byKind.client_hold).toEqual({ kind: 'client_hold', balance: '0.0000', accounts: 2 });
    expect(byKind.supplier_prepaid).toMatchObject({ balance: '47.0000', accounts: 1 });
    expect(byKind.bank).toMatchObject({ balance: '-35.7400' });
    expect(byKind.revenue).toMatchObject({ balance: '-5.0000' });
    expect(byKind.vat_payable).toMatchObject({ balance: '-2.5000' });
    expect(body.totalDebit).toBe(body.totalCredit);
    // Rows come in the order of the map's account list.
    const kinds = (body.rows as Array<{ kind: string }>).map((row) => row.kind);
    expect(kinds.indexOf('fee_income')).toBeLessThan(kinds.indexOf('bank'));
  });

  it('answers an empty trial balance for an empty ledger', async () => {
    const staff = await signInStaff(t, ['ledger:read']);
    expect((await get(staff, '/admin/ledger/accounts')).json()).toEqual({
      currency: 'USD',
      rows: [],
      totalDebit: '0.0000',
      totalCredit: '0.0000',
    });
  });

  it('needs ledger:read', async () => {
    const other = await signInStaff(t, ['wallet:read']);
    expect((await get(other, '/admin/ledger/accounts')).json()).toMatchObject({ code: 'FORBIDDEN' });
  });
});

describe('POST /admin/ledger/reconcile', () => {
  it('reports a clean ledger with what it checked, records the run and audits it', async () => {
    const { staff, db } = await world();
    clock.advance(5 * MINUTE);
    const res = await post(staff, '/admin/ledger/reconcile');
    expect(res.statusCode).toBe(200);
    const accounts = (await db.select({ n: sql<number>`count(*)::int` }).from(s.ledgerAccounts))[0]!.n;
    expect(res.json()).toEqual({
      ranAt: clock.now().toISOString(),
      accountsChecked: accounts,
      entriesChecked: 20,
      differences: [],
    });

    const [run] = await db.select().from(s.jobRuns);
    expect(run).toMatchObject({
      job: 'ledger_reconcile',
      trigger: 'manual',
      status: 'succeeded',
      triggeredBy: staff.staffId,
      processed: accounts,
      result: { accountsChecked: accounts, entriesChecked: 20, differences: 0 },
    });
    const [audit] = await db.select().from(s.auditLogs);
    expect(audit).toMatchObject({
      action: 'ran',
      actorId: staff.staffId,
      after: { accountsChecked: accounts, entriesChecked: 20, differences: 0 },
    });
  });

  it('reports each account whose balance differs from its entries, debit positive, and corrects nothing', async () => {
    const { staff, db, zain } = await world();
    // Tamper as a bug or a manual edit would: the wallet shows 1.2345 more than its entries, the bank 2 less.
    await db.execute(
      sql`update ledger_accounts set balance = balance + 1.2345 where kind = 'client_wallet' and owner_id = ${zain.id}`,
    );
    await db.execute(sql`update ledger_accounts set balance = balance - 2 where kind = 'bank'`);
    const res = await post(staff, '/admin/ledger/reconcile');
    const { differences } = res.json<{
      differences: Array<{
        accountId: number;
        kind: string;
        ownerName: string | null;
        stored: string;
        expected: string;
        difference: string;
      }>;
    }>();
    expect(differences.map((row) => row.kind).sort()).toEqual(['bank', 'client_wallet']);
    // Zain's wallet is credit-normal: it owes him 95 and shows 96.2345, so in debit-positive terms -96.2345 against -95.
    expect(differences.find((row) => row.kind === 'client_wallet')).toMatchObject({
      ownerName: 'Zain Mobile Hub',
      stored: '-96.2345',
      expected: '-95.0000',
      difference: '-1.2345',
    });
    const bank = differences.find((row) => row.kind === 'bank')!;
    expect(bank.ownerName).toBeNull();
    expect(bank.difference).toBe('-2.0000');
    expect(Money.of(bank.stored).sub(Money.of(bank.expected)).toWire()).toBe(bank.difference);
    // Read-only: a second run finds the same two differences, and the ledger gained no entry.
    expect((await post(staff, '/admin/ledger/reconcile')).json<{ differences: unknown[] }>().differences).toHaveLength(
      2,
    );
    expect((await db.select({ n: sql<number>`count(*)::int` }).from(s.ledgerEntries))[0]!.n).toBe(20);
    const runs = await db.select().from(s.jobRuns).orderBy(s.jobRuns.id);
    expect(runs.map((run) => run.result)).toMatchObject([{ differences: 2 }, { differences: 2 }]);
  });

  it('answers 409 RECONCILE_RUNNING while a run is going on, and runs again once it ended', async () => {
    const { staff, db } = await world();
    const [running] = await db
      .insert(s.jobRuns)
      .values({ job: 'ledger_reconcile', trigger: 'manual', status: 'running', startedAt: clock.now() })
      .returning({ id: s.jobRuns.id });
    const refused = await post(staff, '/admin/ledger/reconcile');
    expect(refused.statusCode).toBe(409);
    expect(refused.json()).toMatchObject({ code: 'RECONCILE_RUNNING' });
    expect(await db.select().from(s.auditLogs)).toHaveLength(0);
    await db
      .update(s.jobRuns)
      .set({ status: 'succeeded', finishedAt: clock.now() })
      .where(eq(s.jobRuns.id, running!.id));
    expect((await post(staff, '/admin/ledger/reconcile')).statusCode).toBe(200);
  });

  it('lets only one of two simultaneous runs through', async () => {
    const { staff } = await world();
    const results = await Promise.all([post(staff, '/admin/ledger/reconcile'), post(staff, '/admin/ledger/reconcile')]);
    const codes = results.map((res) => res.statusCode).sort();
    expect(codes[0]).toBe(200);
    // The second either overlapped (409) or came after the first ended (200): never two runs at once.
    expect([200, 409]).toContain(codes[1]!);
  });

  it('needs ledger:reconcile', async () => {
    await world();
    const reader = await signInStaff(t, ['ledger:read']);
    expect((await post(reader, '/admin/ledger/reconcile')).json()).toMatchObject({ code: 'FORBIDDEN' });
  });
});
