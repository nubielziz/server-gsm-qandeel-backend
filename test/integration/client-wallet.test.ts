// Integration tests of the merchant portal's wallet routes (map stage 3): GET /client/wallet and GET /client/wallet/statement,
// as JSON and as a CSV file (?format=csv), with a merchant session.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import { Money } from '../../src/common/money';
import { adjust, deposit, order, postTransaction } from '../../src/modules/money';
import { type TestApp, createTestApp } from '../support/app';
import { clearIdentityCaches, openSession, signInStaff } from '../support/auth';
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

async function world() {
  const { db } = await testDb();
  const mine = await insertWalletMerchant(db, { name: 'Zain', creditLimit: '500' });
  const other = await insertWalletMerchant(db, { name: 'Other' });
  const book = (posting: ReturnType<typeof deposit>, refId: number, key: string, memo: string) => {
    clock.advance(MINUTE);
    return db.transaction((tx) =>
      postTransaction(
        tx,
        { ...posting, refId, idempotencyKey: key, currency: 'USD', memo, createdBy: { type: 'system', id: null } },
        clock.now(),
      ),
    );
  };
  await book(deposit({ clientId: mine.id, amount: m('100') }), 1, 'a', 'Deposit PAY-1');
  await book(order({ clientId: mine.id, amount: m('5') }), 7, 'b', 'Hold for ORD-7');
  await book(
    adjust({ clientId: mine.id, amount: m('2.5'), direction: 'debit' }),
    mine.id,
    'c',
    '=HYPERLINK("http://evil.example","pay")',
  );
  await book(deposit({ clientId: other.id, amount: m('999') }), 2, 'd', 'Deposit PAY-2');
  const session = await openSession(t, { type: 'client', id: mine.id });
  return { db, mine, other, session };
}

describe('GET /client/wallet', () => {
  it("answers the signed-in merchant's own figures", async () => {
    const { session } = await world();
    const res = await t.app.inject({ method: 'GET', url: '/client/wallet', headers: session.headers });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      balance: '92.5000',
      reserved: '5.0000',
      creditLimit: '500.0000',
      available: '592.5000',
    });
  });

  it('shows another merchant their own wallet, never a neighbour’s', async () => {
    const { other } = await world();
    const session = await openSession(t, { type: 'client', id: other.id });
    const res = await t.app.inject({ method: 'GET', url: '/client/wallet', headers: session.headers });
    expect(res.json().balance).toBe('999.0000');
  });

  it('refuses a staff session and no session at all', async () => {
    await world();
    const staff = await signInStaff(t, ['wallet:read', 'ledger:read']);
    expect(
      (await t.app.inject({ method: 'GET', url: '/client/wallet', headers: staff.session.headers })).statusCode,
    ).toBe(401);
    expect((await t.app.inject({ method: 'GET', url: '/client/wallet' })).statusCode).toBe(401);
  });
});

describe('GET /client/wallet/statement', () => {
  it('lists only my wallet lines, newest first, from the merchant side', async () => {
    const { session } = await world();
    const res = await t.app.inject({ method: 'GET', url: '/client/wallet/statement', headers: session.headers });
    expect(res.statusCode).toBe(200);
    expect(res.headers['x-total-count']).toBe('3');
    expect(res.json<Array<Record<string, string>>>().map((row) => [row.kind, row.amount, row.balanceAfter])).toEqual([
      ['adjustment', '-2.5000', '92.5000'],
      ['order_hold', '-5.0000', '95.0000'],
      ['deposit', '100.0000', '100.0000'],
    ]);
  });

  it('sorts, pages and refuses what it does not offer', async () => {
    const { session } = await world();
    const page = await t.app.inject({
      method: 'GET',
      url: '/client/wallet/statement?_sort=createdAt&_order=asc&_start=0&_end=1',
      headers: session.headers,
    });
    expect(page.json<Array<{ kind: string }>>().map((row) => row.kind)).toEqual(['deposit']);
    expect(page.headers['x-total-count']).toBe('3');
    for (const url of [
      '/client/wallet/statement?_sort=amount',
      '/client/wallet/statement?format=xml',
      '/client/wallet/statement?kind=deposit',
    ]) {
      expect((await t.app.inject({ method: 'GET', url, headers: session.headers })).statusCode).toBe(422);
    }
  });

  it('exports every line as a CSV file with ?format=csv', async () => {
    const { session } = await world();
    const res = await t.app.inject({
      method: 'GET',
      url: '/client/wallet/statement?format=csv&_start=0&_end=1',
      headers: session.headers,
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toBe('text/csv; charset=utf-8');
    expect(res.headers['content-disposition']).toBe('attachment; filename="statement.csv"');
    expect(res.headers['cache-control']).toBe('no-store');
    const lines = res.body.split('\r\n');
    // The page range does not cut an export: all three lines, newest first, after the header row.
    expect(lines[0]).toBe('createdAt,transactionId,kind,memo,amount,balanceAfter');
    expect(lines.slice(1, 4).map((line) => line.split(',').slice(2).join(','))).toEqual([
      expect.stringContaining('adjustment'),
      'order_hold,Hold for ORD-7,-5.0000,95.0000',
      'deposit,Deposit PAY-1,100.0000,100.0000',
    ]);
    expect(lines[4]).toBe('');
  });

  it('keeps a staff-typed memo from running as a spreadsheet formula', async () => {
    const { session } = await world();
    const res = await t.app.inject({
      method: 'GET',
      url: '/client/wallet/statement?format=csv',
      headers: session.headers,
    });
    expect(res.body).toContain(`"'=HYPERLINK(""http://evil.example"",""pay"")"`);
    expect(res.body).not.toMatch(/,=HYPERLINK/);
  });

  it('answers JSON again for format=json and for a request without a format', async () => {
    const { session } = await world();
    for (const url of ['/client/wallet/statement?format=json', '/client/wallet/statement']) {
      const res = await t.app.inject({ method: 'GET', url, headers: session.headers });
      expect(res.headers['content-type']).toContain('application/json');
      expect(res.json()).toHaveLength(3);
    }
  });

  it('is empty for a merchant without a wallet line, and refuses a staff session', async () => {
    const { db } = await testDb();
    const fresh = await insertWalletMerchant(db, { name: 'New' });
    const session = await openSession(t, { type: 'client', id: fresh.id });
    const res = await t.app.inject({ method: 'GET', url: '/client/wallet/statement', headers: session.headers });
    expect(res.json()).toEqual([]);
    expect(res.headers['x-total-count']).toBe('0');
    const csv = await t.app.inject({
      method: 'GET',
      url: '/client/wallet/statement?format=csv',
      headers: session.headers,
    });
    expect(csv.body).toBe('createdAt,transactionId,kind,memo,amount,balanceAfter\r\n');
    const staff = await signInStaff(t, ['wallet:read']);
    expect(
      (await t.app.inject({ method: 'GET', url: '/client/wallet/statement', headers: staff.session.headers }))
        .statusCode,
    ).toBe(401);
  });
});
