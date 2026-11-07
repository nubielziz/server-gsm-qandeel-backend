// CSV text of the order exports (GET /admin/orders/export and GET /client/orders/export): a header and one line per order, RFC
// 4180 with CRLF line ends, text cells protected against spreadsheet formulas.

/** The columns of the staff export, in order (the console's mock writes the same ones). */
export const ADMIN_ORDER_CSV_COLUMNS = [
  'id',
  'created',
  'channel',
  'buyer',
  'service',
  'input',
  'status',
  'supplier',
  'price',
  'cost',
] as const;

/** The columns of the merchant's export, in order: nothing the merchant may not see (no cost, no supplier). */
export const CLIENT_ORDER_CSV_COLUMNS = [
  'id',
  'created',
  'service',
  'input',
  'quantity',
  'status',
  'price',
  'currency',
] as const;

/** One cell value: text, a number or nothing. */
export type CsvValue = string | number | null | undefined;

/**
 * Makes one cell safe for a spreadsheet.
 *
 * Why: buyers and merchants type the input and the names; a cell that starts with `=`, `+`, `-`, `@`, a tab or a carriage return
 * would run as a formula when staff open the file. A leading apostrophe turns it into text. Numbers are written as they are.
 *
 * @param value the cell value
 * @returns the cell, quoted when it holds a comma, quote or line break
 */
export function csvCell(value: CsvValue): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'number') return String(value);
  const safe = /^[=+\-@\t\r]/.test(value) ? `'${value}` : value;
  return /[",\r\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
}

/**
 * Writes one CSV line (with its CRLF).
 *
 * @param cells the cell values of the line
 * @returns the line
 */
export function csvLine(cells: readonly CsvValue[]): string {
  return `${cells.map(csvCell).join(',')}\r\n`;
}

/**
 * Writes the header line of an export.
 *
 * @param columns the column names
 * @returns the header line
 */
export function csvHeader(columns: readonly string[]): string {
  return `${columns.join(',')}\r\n`;
}
