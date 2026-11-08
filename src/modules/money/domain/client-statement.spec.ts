// Unit tests of the client statement PDF content: the totals, the file name and the document laid out for the renderer.
import { describe, expect, it } from 'bun:test';
import {
  type StatementData,
  type StatementPdfLine,
  statementDocument,
  statementFilename,
  statementTotals,
} from './client-statement';

const at = (iso: string) => new Date(iso);
const line = (amount: string, balanceAfter: string, createdAt: string, extra: Partial<StatementPdfLine> = {}) => ({
  transactionId: 11,
  kind: 'deposit',
  memo: 'Deposit PAY-1000',
  amount,
  balanceAfter,
  createdAt: at(createdAt),
  ...extra,
});

describe('statementTotals', () => {
  it('splits the ledger signs into credits (money in) and debits (money out) and closes on the last balance', () => {
    const totals = statementTotals('10.0000', [
      line('-100.0000', '110.0000', '2026-10-05T09:00:00.000Z'),
      line('30.0000', '80.0000', '2026-10-20T10:00:00.000Z'),
    ]);
    expect(totals.credits.toWire()).toBe('100.0000');
    expect(totals.debits.toWire()).toBe('30.0000');
    expect(totals.closing.toWire()).toBe('80.0000');
  });

  it('closes on the opening balance when the period has no line', () => {
    const totals = statementTotals('42.5000', []);
    expect(totals.closing.toWire()).toBe('42.5000');
    expect(totals.credits.toWire()).toBe('0.0000');
    expect(totals.debits.toWire()).toBe('0.0000');
  });
});

describe('statementFilename', () => {
  it('names the file with the merchant and the period', () => {
    expect(statementFilename(12, '2026-10-01', '2026-10-31')).toBe('statement-12-2026-10-01-2026-10-31.pdf');
  });
});

const data: StatementData = {
  merchant: { id: 12, name: 'Zain Mobile Hub', company: '', country: 'JO' },
  from: '2026-10-01',
  to: '2026-10-31',
  opening: '10.0000',
  lines: [
    line('-100.0000', '110.0000', '2026-10-05T09:30:00.000Z', { transactionId: 7 }),
    line('30.0000', '80.0000', '2026-10-20T10:00:00.000Z', {
      transactionId: 9,
      kind: 'adjustment',
      memo: 'Manual debit',
    }),
  ],
  creditLimit: '500',
  invoices: [
    {
      number: 'INV-2026-0001',
      kind: 'topup',
      status: 'paid',
      total: '100',
      currency: 'USD',
      paidAt: at('2026-10-05T09:00:00.000Z'),
    },
    { number: 'INV-2026-0002', kind: 'manual', status: 'open', total: '25.5', currency: 'USD', paidAt: null },
  ],
  createdAt: at('2026-11-07T12:00:00.000Z'),
};

describe('statementDocument', () => {
  const document = statementDocument(data);
  const facts = document.blocks.find((block) => block.kind === 'facts');
  const tables = document.blocks.filter((block) => block.kind === 'table');

  it('shows the merchant, the period, the balances, the totals and the credit limit with four decimals in USD', () => {
    expect(document.createdAt).toEqual(data.createdAt);
    expect(document.subtitle).toBe('Zain Mobile Hub  -  2026-10-01 to 2026-10-31  -  USD');
    expect(facts?.kind === 'facts' ? Object.fromEntries(facts.rows) : {}).toEqual({
      Merchant: 'Zain Mobile Hub (#12)',
      Company: '-',
      Country: 'JO',
      Period: '2026-10-01 to 2026-10-31 (UTC days, both included)',
      'Opening balance': '10.0000 USD',
      'Total credits': '100.0000 USD',
      'Total debits': '30.0000 USD',
      'Closing balance': '80.0000 USD',
      'Credit limit': '500.0000 USD',
    });
  });

  it('lists the wallet lines with a journal number, debit, credit and the balance after', () => {
    const wallet = tables[0];
    expect(wallet?.kind === 'table' ? wallet.rows : []).toEqual([
      ['2026-10-05 09:30', 'JRN-7', 'deposit', 'Deposit PAY-1000', '', '100.0000', '110.0000'],
      ['2026-10-20 10:00', 'JRN-9', 'adjustment', 'Manual debit', '30.0000', '', '80.0000'],
    ]);
  });

  it('lists the invoices with their total and the day they were paid', () => {
    const invoices = tables[1];
    expect(invoices?.kind === 'table' ? invoices.rows : []).toEqual([
      ['INV-2026-0001', 'topup', 'paid', '100.0000 USD', '2026-10-05'],
      ['INV-2026-0002', 'manual', 'open', '25.5000 USD', '-'],
    ]);
  });

  it('says so when the period has no line and no invoice, instead of drawing empty tables', () => {
    const empty = statementDocument({ ...data, lines: [], invoices: [] });
    expect(empty.blocks.filter((block) => block.kind === 'table')).toHaveLength(0);
    expect(
      empty.blocks.filter((block) => block.kind === 'text').map((block) => (block as { text: string }).text),
    ).toEqual(['No wallet activity in this period.', 'No invoices were issued in this period.']);
  });
});
