// The client statement PDF (route GET /admin/reports/client-statement/:clientId, stage 11): the totals of a period and the document the
// platform's PdfRenderer draws. Pure functions, unit-tested; the reads and the audit row are in application/client-statement.service.ts.
import { Money } from '../../../common/money';
import type { PdfDocument } from '../../platform';
import { BASE_CURRENCY } from './accounts';

/** Who the statement is for. */
export interface StatementMerchant {
  readonly id: number;
  readonly name: string;
  readonly company: string;
  readonly country: string;
}

/** One wallet line of the statement as stored. */
export interface StatementPdfLine {
  readonly transactionId: number;
  readonly kind: string;
  readonly memo: string;
  /** Signed, debit positive: the wallet is credit-normal, so a deposit is negative here. */
  readonly amount: string;
  /** The wallet balance right after the line, merchant side. */
  readonly balanceAfter: string;
  readonly createdAt: Date;
}

/** One invoice of the merchant issued in the period. */
export interface StatementPdfInvoice {
  readonly number: string;
  readonly kind: string;
  readonly status: string;
  readonly total: string;
  readonly currency: string;
  readonly paidAt: Date | null;
}

/** What the document is made from. */
export interface StatementData {
  readonly merchant: StatementMerchant;
  /** The first and the last day of the period, `YYYY-MM-DD`, both included. */
  readonly from: string;
  readonly to: string;
  /** The wallet balance before the first day. */
  readonly opening: string;
  readonly lines: readonly StatementPdfLine[];
  readonly creditLimit: string;
  readonly invoices: readonly StatementPdfInvoice[];
  /** When the statement was made (the injected clock). */
  readonly createdAt: Date;
}

/** The sums of a statement. */
export interface StatementTotals {
  /** Money that left the wallet in the period (ledger debits). */
  readonly debits: Money;
  /** Money that entered the wallet in the period (ledger credits). */
  readonly credits: Money;
  /** The balance after the last line of the period, or the opening balance when there is none. */
  readonly closing: Money;
}

/**
 * Adds up a statement.
 *
 * Why: the official statement shows what came in, what went out and the balance the period ended with. The closing balance is the
 * ledger's own `balance_after` of the last line, so it is the wallet's balance at that moment, not a sum the report made up.
 *
 * @param opening the balance before the period
 * @param lines the wallet lines of the period, oldest first
 * @returns the debits, the credits and the closing balance
 */
export function statementTotals(opening: string, lines: readonly StatementPdfLine[]): StatementTotals {
  let debits = Money.zero();
  let credits = Money.zero();
  for (const line of lines) {
    const amount = Money.of(line.amount);
    // Ledger sign: positive debits the wallet (money out), negative credits it (money in).
    if (amount.isPositive()) debits = debits.add(amount);
    else credits = credits.add(amount.abs());
  }
  const last = lines[lines.length - 1];
  return { debits, credits, closing: Money.of(last ? last.balanceAfter : opening) };
}

/**
 * The name of the downloaded file.
 *
 * @param clientId the merchant
 * @param from the first day of the period
 * @param to the last day of the period
 * @returns for example `statement-12-2026-10-01-2026-10-31.pdf`
 */
export function statementFilename(clientId: number, from: string, to: string): string {
  return `statement-${clientId}-${from}-${to}.pdf`;
}

const minute = (date: Date): string => date.toISOString().slice(0, 16).replace('T', ' ');
const day = (date: Date | null): string => (date ? date.toISOString().slice(0, 10) : '-');
const usd = (amount: Money): string => `${amount.toWire()} ${BASE_CURRENCY}`;

/**
 * Lays the statement out as a document for the PdfRenderer.
 *
 * Why: the map row "Official account statement for a merchant" (contract money.md): merchant header, period, opening balance, the
 * wallet lines with debit, credit and balance after, closing balance, the credit limit, then the invoices issued in the period.
 * Amounts keep four decimals in USD. The text is English (decision 030).
 *
 * @param data the merchant, the period and the rows read from the ledger
 * @returns the document to render
 */
export function statementDocument(data: StatementData): PdfDocument {
  const totals = statementTotals(data.opening, data.lines);
  const creditLimit = Money.of(data.creditLimit);
  const lines = data.lines.map((line) => {
    const amount = Money.of(line.amount);
    return [
      minute(line.createdAt),
      `JRN-${line.transactionId}`,
      line.kind,
      line.memo,
      amount.isPositive() ? amount.toWire() : '',
      amount.isNegative() ? amount.abs().toWire() : '',
      Money.of(line.balanceAfter).toWire(),
    ];
  });
  return {
    title: 'Account statement',
    subtitle: `${data.merchant.name}  -  ${data.from} to ${data.to}  -  ${BASE_CURRENCY}`,
    createdAt: data.createdAt,
    footer: `GSM   Generated ${minute(data.createdAt)} UTC`,
    blocks: [
      {
        kind: 'facts',
        rows: [
          ['Merchant', `${data.merchant.name} (#${data.merchant.id})`],
          ['Company', data.merchant.company || '-'],
          ['Country', data.merchant.country || '-'],
          ['Period', `${data.from} to ${data.to} (UTC days, both included)`],
          ['Opening balance', usd(Money.of(data.opening))],
          ['Total credits', usd(totals.credits)],
          ['Total debits', usd(totals.debits)],
          ['Closing balance', usd(totals.closing)],
          ['Credit limit', usd(creditLimit)],
        ],
      },
      { kind: 'space' },
      { kind: 'heading', text: 'Wallet activity' },
      lines.length === 0
        ? { kind: 'text', muted: true, text: 'No wallet activity in this period.' }
        : {
            kind: 'table',
            columns: [
              { title: 'Date (UTC)', width: 2.4 },
              { title: 'Journal', width: 1.7 },
              { title: 'Kind', width: 1.9 },
              { title: 'Memo', width: 4.4 },
              { title: 'Debit', width: 1.9, align: 'right' },
              { title: 'Credit', width: 1.9, align: 'right' },
              { title: 'Balance', width: 2, align: 'right' },
            ],
            rows: lines,
          },
      { kind: 'space' },
      { kind: 'heading', text: 'Invoices issued in this period' },
      data.invoices.length === 0
        ? { kind: 'text', muted: true, text: 'No invoices were issued in this period.' }
        : {
            kind: 'table',
            columns: [
              { title: 'Number', width: 2.5 },
              { title: 'Kind', width: 2 },
              { title: 'Status', width: 1.5 },
              { title: 'Total', width: 2.5, align: 'right' },
              { title: 'Paid at', width: 2, align: 'right' },
            ],
            rows: data.invoices.map((invoice) => [
              invoice.number,
              invoice.kind,
              invoice.status,
              `${Money.of(invoice.total).toWire()} ${invoice.currency}`,
              day(invoice.paidAt),
            ]),
          },
    ],
  };
}
