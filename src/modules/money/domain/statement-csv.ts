// CSV text of a merchant statement (route GET /client/wallet/statement?format=csv).

/** The columns of the CSV file, in order. */
export const STATEMENT_CSV_COLUMNS = ['createdAt', 'transactionId', 'kind', 'memo', 'amount', 'balanceAfter'] as const;

/** One statement line, as far as the CSV needs it. */
export interface StatementCsvLine {
  readonly createdAt: string;
  readonly transactionId: number;
  readonly kind: string;
  readonly memo: string;
  readonly amount: string;
  readonly balanceAfter: string;
}

/**
 * Makes one text cell safe for a spreadsheet.
 *
 * Why: staff type the memo (the adjustment reason) and a merchant opens the file in a spreadsheet; a cell that starts with
 * `=`, `+`, `-`, `@`, a tab or a carriage return would run as a formula. A leading apostrophe turns it into text.
 *
 * @param text the raw text
 * @returns the text, quoted when it holds a comma, quote or line break
 */
export function csvTextCell(text: string): string {
  const safe = /^[=+\-@\t\r]/.test(text) ? `'${text}` : text;
  return /[",\r\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
}

/**
 * Writes statement lines as CSV (RFC 4180, CRLF line ends, header row).
 *
 * Why: the map says `?format=csv` exports the statement; amounts keep their four decimals so the file adds up exactly.
 *
 * @param lines the statement lines
 * @returns the CSV text
 */
export function statementCsv(lines: readonly StatementCsvLine[]): string {
  const rows = lines.map((line) =>
    [
      line.createdAt,
      String(line.transactionId),
      csvTextCell(line.kind),
      csvTextCell(line.memo),
      line.amount,
      line.balanceAfter,
    ].join(','),
  );
  return [STATEMENT_CSV_COLUMNS.join(','), ...rows].join('\r\n') + '\r\n';
}
