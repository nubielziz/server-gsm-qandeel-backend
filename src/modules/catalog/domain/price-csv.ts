// CSV text of a merchant's price list (route GET /client/prices/export).

/** The columns of the file, in order. */
export const PRICE_CSV_COLUMNS = [
  'serviceId',
  'code',
  'name',
  'type',
  'category',
  'price',
  'currency',
  'deliveryTime',
] as const;

/** One line of the price list. */
export interface PriceCsvLine {
  readonly serviceId: number;
  readonly code: string;
  readonly name: string;
  readonly type: string;
  readonly category: string;
  /** Four-decimal money text. */
  readonly price: string;
  readonly currency: string;
  readonly deliveryTime: string;
}

/**
 * Makes one text cell safe for a spreadsheet.
 *
 * Why: staff type service names and categories and a merchant opens the file in a spreadsheet; a cell that starts with `=`, `+`,
 * `-`, `@`, a tab or a carriage return would run as a formula. A leading apostrophe turns it into text. The same rule as the
 * statement export of the money module.
 *
 * @param text the raw text
 * @returns the text, quoted when it holds a comma, quote or line break
 */
export function csvCell(text: string): string {
  const safe = /^[=+\-@\t\r]/.test(text) ? `'${text}` : text;
  return /[",\r\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
}

/**
 * Writes the price list as CSV (RFC 4180, CRLF line ends, header row).
 *
 * Why: the map says the merchant can export "my price list as CSV"; prices keep their four decimals so the file is exact.
 *
 * @param lines the services with the prices this merchant pays
 * @returns the CSV text
 */
export function priceListCsv(lines: readonly PriceCsvLine[]): string {
  const rows = lines.map((line) =>
    [
      String(line.serviceId),
      csvCell(line.code),
      csvCell(line.name),
      line.type,
      csvCell(line.category),
      line.price,
      line.currency,
      csvCell(line.deliveryTime),
    ].join(','),
  );
  return [PRICE_CSV_COLUMNS.join(','), ...rows].join('\r\n') + '\r\n';
}
