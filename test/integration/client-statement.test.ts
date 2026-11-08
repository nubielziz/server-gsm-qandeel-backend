// Integration tests of the client statement PDF (feature 11): GET /admin/reports/client-statement/:clientId makes the official account
// statement of a merchant from the wallet ledger. It needs reports:read, answers 404 for an unknown merchant, starts with %PDF, honours
// the period (UTC days, both included), shows opening and closing balances that match the wallet, never reads a cache and writes an audit row.
import { afterAll, beforeAll, beforeEach, describe, expect, it, spyOn } from 'bun:test';
import { eq } from 'drizzle-orm';
import { Money } from '../../src/common/money';
import { schema as s } from '../../src/infra/db';
import { adjust, deposit, postTransaction } from '../../src/modules/money';
import { ClientStatementService } from '../../src/modules/money/application/client-statement.service';
import { PdfRenderer, type PdfDocument } from '../../src/modules/platform';
import { type AdminApi, adminWith } from '../support/admin-api';
import { type TestApp, createTestApp } from '../support/app';
import { clearIdentityCaches } from '../support/auth';
import { insertInvoiceRow } from '../support/billing';
import { TestClock } from '../support/clock';
import { closeTestDb, resetDb, testDb } from '../support/db';
import { type TestMerchant, insertWalletMerchant } from '../support/money';

const clock = new TestClock('2026-11-07T12:00:00.000Z');
let t: TestApp;
let staff: AdminApi;
let merchant: TestMerchant;

beforeAll(async () => {
  t = await createTestApp({ clock });
});
beforeEach(async () => {
  clock.set('2026-11-07T12:00:00.000Z');
  await resetDb();
  await clearIdentityCaches(t);
  const { db } = await testDb();
  merchant = await insertWalletMerchant(db, { name: 'Zain Mobile Hub' });
  await db.update(s.clients).set({ company: 'Zain Trading LLC', country: 'JO' }).where(eq(s.clients.id, merchant.id));
  staff = await adminWith(t, ['reports:read']);
});
afterAll(async () => {
  await resetDb();
  await clearIdentityCaches(t);
  await t.close();
  await closeTestDb();
});

let sequence = 0;
/** Posts one wallet line at an exact time through the real ledger writer. */
async function post(kind: 'credit' | 'debit', amount: string, iso: string): Promise<void> {
  const { db } = await testDb();
  const event =
    kind === 'credit'
      ? deposit({ clientId: merchant.id, amount: Money.of(amount) })
      : adjust({ clientId: merchant.id, amount: Money.of(amount), direction: 'debit' });
  sequence += 1;
  await db.transaction((tx) =>
    postTransaction(
      tx,
      {
        ...event,
        refId: merchant.id,
        idempotencyKey: `statement-test:${sequence}`,
        currency: 'USD',
        memo: `Line ${sequence}`,
        createdBy: { type: 'system', id: null },
      },
      new Date(iso),
    ),
  );
}

/**
 * The wallet used below, oldest first (balance after in brackets):
 * 10-05 09:00 +100 (100) · 10-20 10:00 -30 (70) · 10-31 23:59:59.999 +5 (75) · 11-01 00:00:00.000 +10 (85) · 11-03 08:00 -25 (60)
 */
async function seedWallet(): Promise<void> {
  await post('credit', '100', '2026-10-05T09:00:00.000Z');
  await post('debit', '30', '2026-10-20T10:00:00.000Z');
  await post('credit', '5', '2026-10-31T23:59:59.999Z');
  await post('credit', '10', '2026-11-01T00:00:00.000Z');
  await post('debit', '25', '2026-11-03T08:00:00.000Z');
}

/** Downloads the statement, keeping the document the renderer was given (the PDF text is compressed, so tests read it there). */
async function download(path: string, as: AdminApi = staff) {
  const renderer = t.app.get(PdfRenderer, { strict: false });
  const spy = spyOn(renderer, 'render');
  try {
    const res = await t.app.inject({ method: 'GET', url: path, headers: as.session.headers });
    const document: PdfDocument | undefined = spy.mock.calls[0]?.[0];
    return { res, status: res.statusCode, document };
  } finally {
    spy.mockRestore();
  }
}

/** Calls the service directly with a lower cap (the route never changes it), keeping the document the renderer was given. */
async function renderWithCap(query: { from?: string; to?: string }, maxRows: number) {
  const service = t.app.get(ClientStatementService, { strict: false });
  const renderer = t.app.get(PdfRenderer, { strict: false });
  const spy = spyOn(renderer, 'render');
  try {
    const file = await service.render(merchant.id, query, maxRows);
    const document: PdfDocument | undefined = spy.mock.calls[0]?.[0];
    return { file, document };
  } finally {
    spy.mockRestore();
  }
}

const factsOf = (document: PdfDocument | undefined): Record<string, string> => {
  const block = document?.blocks.find((item) => item.kind === 'facts');
  return block?.kind === 'facts' ? Object.fromEntries(block.rows) : {};
};
const walletRows = (document: PdfDocument | undefined): readonly string[][] => {
  const block = document?.blocks.find((item) => item.kind === 'table');
  return block?.kind === 'table' ? block.rows.map((row) => [...row]) : [];
};
const URL = (id: number, query = '') => `/admin/reports/client-statement/${id}${query}`;

describe('GET /admin/reports/client-statement/:clientId', () => {
  it('answers a PDF attachment named after the merchant and the whole history', async () => {
    await seedWallet();
    const { res, status } = await download(URL(merchant.id));
    expect(status).toBe(200);
    expect(res.headers['content-type']).toBe('application/pdf');
    expect(res.headers['cache-control']).toBe('no-store');
    const name = `statement-${merchant.id}-2026-10-05-2026-11-07.pdf`;
    expect(res.headers['content-disposition']).toBe(`attachment; filename="${name}"; filename*=UTF-8''${name}`);
    expect(res.rawPayload.subarray(0, 5).toString()).toBe('%PDF-');
  });

  it('shows opening and closing balances and totals that match the wallet, and every line oldest first', async () => {
    await seedWallet();
    const { body } = await (await adminWith(t, ['wallet:read'])).get(`/admin/clients/${merchant.id}/wallet`);
    expect(body.balance).toBe('60.0000');

    const { document } = await download(URL(merchant.id));
    expect(document?.title).toBe('Account statement');
    expect(factsOf(document)).toMatchObject({
      Merchant: `Zain Mobile Hub (#${merchant.id})`,
      Company: 'Zain Trading LLC',
      Country: 'JO',
      Period: '2026-10-05 to 2026-11-07 (UTC days, both included)',
      'Opening balance': '0.0000 USD',
      'Total credits': '115.0000 USD',
      'Total debits': '55.0000 USD',
      'Closing balance': `${body.balance} USD`,
      'Credit limit': '0.0000 USD',
    });
    const rows = walletRows(document);
    expect(rows.map((row) => [row[0], row[4], row[5], row[6]])).toEqual([
      ['2026-10-05 09:00', '', '100.0000', '100.0000'],
      ['2026-10-20 10:00', '30.0000', '', '70.0000'],
      ['2026-10-31 23:59', '', '5.0000', '75.0000'],
      ['2026-11-01 00:00', '', '10.0000', '85.0000'],
      ['2026-11-03 08:00', '25.0000', '', '60.0000'],
    ]);
    expect(rows[0]![1]).toMatch(/^JRN-\d+$/);
    expect(rows[0]![2]).toBe('deposit');
    expect(rows[1]![2]).toBe('adjustment');
  });

  it('honours from and to as UTC days, both included, with the opening balance carried from before the period', async () => {
    await seedWallet();
    const october = await download(URL(merchant.id, '?from=2026-10-01&to=2026-10-31'));
    expect(october.res.headers['content-disposition']).toContain(`statement-${merchant.id}-2026-10-01-2026-10-31.pdf`);
    expect(factsOf(october.document)).toMatchObject({
      'Opening balance': '0.0000 USD',
      'Closing balance': '75.0000 USD',
    });
    // The line one millisecond before midnight is October's, the one at midnight is November's.
    expect(walletRows(october.document).map((row) => row[6])).toEqual(['100.0000', '70.0000', '75.0000']);

    const november = await download(URL(merchant.id, '?from=2026-11-01&to=2026-11-30'));
    expect(factsOf(november.document)).toMatchObject({
      'Opening balance': '75.0000 USD',
      'Total credits': '10.0000 USD',
      'Total debits': '25.0000 USD',
      'Closing balance': '60.0000 USD',
    });
    expect(walletRows(november.document).map((row) => row[6])).toEqual(['85.0000', '60.0000']);

    // A single day, and quiet periods before and after the activity.
    const oneDay = await download(URL(merchant.id, '?from=2026-10-20&to=2026-10-20'));
    expect(walletRows(oneDay.document).map((row) => row[6])).toEqual(['70.0000']);
    const before = await download(URL(merchant.id, '?from=2026-09-01&to=2026-09-30'));
    expect(factsOf(before.document)).toMatchObject({
      'Opening balance': '0.0000 USD',
      'Closing balance': '0.0000 USD',
    });
    expect(walletRows(before.document)).toEqual([]);
    const after = await download(URL(merchant.id, '?from=2026-11-05&to=2026-11-06'));
    expect(factsOf(after.document)).toMatchObject({
      'Opening balance': '60.0000 USD',
      'Closing balance': '60.0000 USD',
    });
    expect(walletRows(after.document)).toEqual([]);
  });

  it('defaults a missing from to the first line and a missing to to today, and reads to alone as the history up to that day', async () => {
    await seedWallet();
    const upTo = await download(URL(merchant.id, '?to=2026-10-31'));
    expect(upTo.res.headers['content-disposition']).toContain(`statement-${merchant.id}-2026-10-05-2026-10-31.pdf`);
    expect(factsOf(upTo.document)).toMatchObject({ 'Opening balance': '0.0000 USD', 'Closing balance': '75.0000 USD' });
    const early = await download(URL(merchant.id, '?to=2026-09-01'));
    expect(early.res.headers['content-disposition']).toContain(`statement-${merchant.id}-2026-09-01-2026-09-01.pdf`);
    expect(walletRows(early.document)).toEqual([]);
    const from = await download(URL(merchant.id, '?from=2026-11-01'));
    expect(from.res.headers['content-disposition']).toContain(`statement-${merchant.id}-2026-11-01-2026-11-07.pdf`);
    expect(factsOf(from.document)).toMatchObject({
      'Opening balance': '75.0000 USD',
      'Closing balance': '60.0000 USD',
    });
  });

  it('lists the invoices issued in the period and a statement of a merchant with no activity is still a PDF', async () => {
    const { db } = await testDb();
    await insertInvoiceRow(db, merchant.id, {
      number: 'INV-2026-0001',
      status: 'paid',
      amount: '100.0000',
      paidAt: new Date('2026-10-10T08:00:00.000Z'),
      createdAt: new Date('2026-10-10T07:00:00.000Z'),
    });
    await insertInvoiceRow(db, merchant.id, {
      number: 'INV-2026-0002',
      kind: 'manual',
      amount: '25.5000',
      createdAt: new Date('2026-11-02T07:00:00.000Z'),
    });
    const october = await download(URL(merchant.id, '?from=2026-10-01&to=2026-10-31'));
    const tablesOf = (document: PdfDocument | undefined) =>
      (document?.blocks ?? []).flatMap((block) => (block.kind === 'table' ? [block.rows.map((row) => [...row])] : []));
    expect(tablesOf(october.document)).toEqual([[['INV-2026-0001', 'topup', 'paid', '100.0000 USD', '2026-10-10']]]);
    const all = await download(URL(merchant.id, '?from=2026-10-01&to=2026-11-30'));
    expect(tablesOf(all.document)[0]?.map((row) => row[0])).toEqual(['INV-2026-0001', 'INV-2026-0002']);
    expect(all.res.rawPayload.subarray(0, 5).toString()).toBe('%PDF-');
  });

  it('never reads a cache: a posting made between two downloads shows in the second', async () => {
    await post('credit', '40', '2026-11-02T09:00:00.000Z');
    const first = await download(URL(merchant.id));
    expect(factsOf(first.document)['Closing balance']).toBe('40.0000 USD');
    await post('credit', '2', '2026-11-03T09:00:00.000Z');
    const second = await download(URL(merchant.id));
    expect(factsOf(second.document)['Closing balance']).toBe('42.0000 USD');
  });

  it('draws the credit limit the merchant has', async () => {
    const { db } = await testDb();
    const credit = await insertWalletMerchant(db, { name: 'Credit Co', creditLimit: '750' });
    const { document } = await download(URL(credit.id));
    expect(factsOf(document)['Credit limit']).toBe('750.0000 USD');
  });

  it('writes an audit row for every download, with the period and the balances', async () => {
    await seedWallet();
    const { db } = await testDb();
    await download(URL(merchant.id, '?from=2026-11-01&to=2026-11-30'));
    const rows = await db.select().from(s.auditLogs);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      action: 'exported statement of',
      entityType: 'merchant',
      entityId: merchant.id,
      entityLabel: 'Zain Mobile Hub',
      actorId: staff.staffId,
      after: { from: '2026-11-01', to: '2026-11-30', lines: 2, invoices: 0, opening: '75.0000', closing: '60.0000' },
    });
  });

  it('answers 404 for a merchant that does not exist and writes nothing', async () => {
    const { db } = await testDb();
    const res = await staff.get(URL(999_999));
    expect(res.status).toBe(404);
    expect(res.body.code).toBe('NOT_FOUND');
    expect(await db.select().from(s.auditLogs)).toHaveLength(0);
  });

  it('answers 422 on a bad date, a reversed period, an explicit period that holds too many lines, and an id that is not a number', async () => {
    const reversed = await staff.get(URL(merchant.id, '?from=2026-11-05&to=2026-11-01'));
    expect(reversed.status).toBe(422);
    expect(reversed.body.errors[0]).toMatchObject({ field: 'from', code: 'invalid_range' });
    const future = await staff.get(URL(merchant.id, '?from=2026-11-08'));
    expect(future.status).toBe(422);
    for (const query of ['?from=2026-13-40', '?to=yesterday', '?from=2026-1-1']) {
      expect((await staff.get(URL(merchant.id, query))).status).toBe(422);
    }
    expect((await staff.get('/admin/reports/client-statement/abc')).status).toBe(422);

    await seedWallet();
    // The limit is on an explicit period: this one holds five lines, a narrower one fits.
    const tooMany = await renderWithCap({ from: '2026-10-01' }, 4).then(
      () => undefined,
      (error: { code?: string; errors?: Array<{ field: string }> }) => error,
    );
    expect(tooMany?.code).toBe('VALIDATION_FAILED');
    expect(tooMany?.errors?.[0]?.field).toBe('from');
    expect((await renderWithCap({ from: '2026-11-01', to: '2026-11-30' }, 4)).file.bytes.length).toBeGreaterThan(0);
  });

  it('never answers 422 without a period: a history longer than the cap is cut to its newest lines, starting the period on their first day', async () => {
    await seedWallet();
    // Five lines, cap four: the newest four are shown (10-20 on), the opening balance is the balance before the first of them.
    const { file, document } = await renderWithCap({}, 4);
    expect(file.filename).toBe(`statement-${merchant.id}-2026-10-20-2026-11-07.pdf`);
    expect(factsOf(document)).toMatchObject({
      Period: '2026-10-20 to 2026-11-07 (UTC days, both included)',
      'Opening balance': '100.0000 USD',
      'Total credits': '15.0000 USD',
      'Total debits': '55.0000 USD',
      'Closing balance': '60.0000 USD',
    });
    expect(walletRows(document).map((row) => row[6])).toEqual(['70.0000', '75.0000', '85.0000', '60.0000']);

    // `to` alone is no explicit period either: the newest lines up to that day.
    const upTo = await renderWithCap({ to: '2026-10-31' }, 2);
    expect(upTo.file.filename).toBe(`statement-${merchant.id}-2026-10-20-2026-10-31.pdf`);
    expect(factsOf(upTo.document)).toMatchObject({
      'Opening balance': '100.0000 USD',
      'Closing balance': '75.0000 USD',
    });

    // A history that fits the cap is whole, from the first line, with a zero opening balance.
    const whole = await renderWithCap({}, 5);
    expect(whole.file.filename).toBe(`statement-${merchant.id}-2026-10-05-2026-11-07.pdf`);
    expect(factsOf(whole.document)).toMatchObject({
      'Opening balance': '0.0000 USD',
      'Closing balance': '60.0000 USD',
    });

    // Through the route the cap is 10,000, so the console's request (no period) is a PDF.
    expect((await download(URL(merchant.id))).status).toBe(200);
  });

  it('never answers 422 without a period for too many invoices either: the newest ones are shown, while an explicit period over the cap is 422', async () => {
    await seedWallet();
    const { db } = await testDb();
    await insertInvoiceRow(db, merchant.id, {
      number: 'INV-2026-0101',
      createdAt: new Date('2026-11-04T07:00:00.000Z'),
    });
    await insertInvoiceRow(db, merchant.id, {
      number: 'INV-2026-0102',
      createdAt: new Date('2026-11-05T07:00:00.000Z'),
    });
    const invoiceTables = (document: PdfDocument | undefined) =>
      (document?.blocks ?? []).flatMap((block) => (block.kind === 'table' ? [block.rows.map((row) => row[0])] : []));

    // Cap one: the period (cut to the newest line, 11-03) holds two invoices, so only the newer one is kept and the answer is a PDF.
    const cut = await renderWithCap({}, 1);
    expect(Buffer.from(cut.file.bytes.subarray(0, 5)).toString()).toBe('%PDF-');
    expect(invoiceTables(cut.document)).toEqual([[expect.any(String)], ['INV-2026-0102']]);

    // Cap two holds both, oldest first.
    const whole = await renderWithCap({ to: '2026-11-07' }, 2);
    expect(invoiceTables(whole.document).at(-1)).toEqual(['INV-2026-0101', 'INV-2026-0102']);

    // An explicit period is the caller's: its one line fits the cap of one, but its two invoices do not (422 on `from`).
    const tooMany = await renderWithCap({ from: '2026-11-03' }, 1).then(
      () => undefined,
      (error: { code?: string; errors?: Array<{ field: string }> }) => error,
    );
    expect(tooMany?.code).toBe('VALIDATION_FAILED');
    expect(tooMany?.errors?.[0]?.field).toBe('from');
  });

  it('orders the lines and finds the opening balance by ledger entry id, so the closing balance is the wallet balance when clock times are out of id order', async () => {
    // The second posting carries an earlier clock time than the first one.
    await post('credit', '100', '2026-11-03T09:00:00.000Z');
    await post('credit', '50', '2026-11-02T09:00:00.000Z');
    const { body } = await (await adminWith(t, ['wallet:read'])).get(`/admin/clients/${merchant.id}/wallet`);
    expect(body.balance).toBe('150.0000');

    const whole = await download(URL(merchant.id));
    expect(factsOf(whole.document)).toMatchObject({
      Period: '2026-11-02 to 2026-11-07 (UTC days, both included)',
      'Opening balance': '0.0000 USD',
      'Total credits': '150.0000 USD',
      'Closing balance': `${body.balance} USD`,
    });
    // Entry id order, not clock order: 100 first (balance 100), then 50 (balance 150).
    expect(walletRows(whole.document).map((row) => [row[0], row[5], row[6]])).toEqual([
      ['2026-11-03 09:00', '100.0000', '100.0000'],
      ['2026-11-02 09:00', '50.0000', '150.0000'],
    ]);

    // The later entry alone: its opening balance is the balance after the entry before it by id, so the figures chain.
    const second = await download(URL(merchant.id, '?from=2026-11-02&to=2026-11-02'));
    expect(factsOf(second.document)).toMatchObject({
      'Opening balance': '100.0000 USD',
      'Total credits': '50.0000 USD',
      'Closing balance': '150.0000 USD',
    });
  });

  it('writes the lines and the balances of a cut statement in the audit row', async () => {
    await seedWallet();
    const { db } = await testDb();
    await renderWithCap({}, 4);
    const [row] = await db.select().from(s.auditLogs);
    expect(row?.after).toMatchObject({
      from: '2026-10-20',
      to: '2026-11-07',
      lines: 4,
      opening: '100.0000',
      closing: '60.0000',
    });
  });

  it('needs reports:read: 403 without it, 401 signed out', async () => {
    const wrong = await adminWith(t, ['wallet:read', 'orders:read']);
    expect((await wrong.get(URL(merchant.id))).status).toBe(403);
    expect((await staff.anonymous('GET', URL(merchant.id))).status).toBe(401);
    expect((await download(URL(merchant.id))).status).toBe(200);
  });
});
