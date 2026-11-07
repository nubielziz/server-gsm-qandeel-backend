// Rules of the tax rate rows (map routes /admin/tax-rates, built ahead of feature 14b): field checks and the one-window-at-a-time
// rule per country and region. Pure: the service reads the rows and the clock and applies these.
import type { FieldError } from '../../../common/errors';

/** The tax types the console names (`vat`, `gst`, `sales_tax`, `none`); the column stays open text for older rows. */
export const TAX_TYPES = ['vat', 'gst', 'sales_tax', 'none'] as const;

/** One value of {@link TAX_TYPES}. */
export type TaxType = (typeof TAX_TYPES)[number];

const COUNTRY = /^[A-Z]{2}$/;
// A percent with up to four decimal places (the column is numeric with 4 dp), 0 to 100.
const PERCENT = /^\d{1,3}(\.\d{1,4})?$/;

/** The longest texts the console's dialog lets through, kept here so a direct API call cannot store more. */
export const TAX_TEXT_LIMITS = { region: 60, appliesTo: 60, label: 80, ossScheme: 40 } as const;

/**
 * Checks a country code.
 *
 * @param country the code as sent, already trimmed and upper-cased by the caller
 * @returns the problem on `country`, or `undefined`
 */
export function checkCountry(country: string): FieldError | undefined {
  return COUNTRY.test(country)
    ? undefined
    : { field: 'country', code: 'format', message: 'Enter the two-letter country code, such as FR.' };
}

/**
 * Checks a rate in percent.
 *
 * Why: the map stores the rate as a percent between 0 and 100 (CHECK `tax_rates_rate_check`); the console sends the typed
 * text.
 *
 * @param ratePercent the rate as sent
 * @returns the problem on `ratePercent`, or `undefined`
 */
export function checkRatePercent(ratePercent: string): FieldError | undefined {
  const text = ratePercent.trim();
  if (!PERCENT.test(text) || Number(text) > 100) {
    return { field: 'ratePercent', code: 'range', message: 'Enter a rate from 0 to 100, with up to four decimals.' };
  }
  return undefined;
}

/**
 * Checks a tax type.
 *
 * @param taxType the type as sent
 * @returns the problem on `taxType`, or `undefined`
 */
export function checkTaxType(taxType: string): FieldError | undefined {
  return (TAX_TYPES as readonly string[]).includes(taxType)
    ? undefined
    : { field: 'taxType', code: 'enum', message: 'Choose VAT, GST, sales tax or no tax.' };
}

/**
 * Checks a text field against its length limit.
 *
 * @param field the field name, a key of {@link TAX_TEXT_LIMITS}
 * @param value the trimmed value
 * @returns the problem on that field, or `undefined`
 */
export function checkTaxText(field: keyof typeof TAX_TEXT_LIMITS, value: string): FieldError | undefined {
  const limit = TAX_TEXT_LIMITS[field];
  return value.length > limit ? { field, code: 'max', message: `Use at most ${limit} characters.` } : undefined;
}

/**
 * Checks a validity window.
 *
 * Why: CHECK `tax_rates_validity_check` wants an end after the start; an open end (`null`) means "until further notice".
 *
 * @param validFrom the start
 * @param validTo the end, or `null`
 * @returns the problem on `validTo`, or `undefined`
 */
export function checkWindow(validFrom: Date, validTo: Date | null): FieldError | undefined {
  return validTo !== null && validTo.getTime() <= validFrom.getTime()
    ? { field: 'validTo', code: 'order', message: 'The end date must be after the start date.' }
    : undefined;
}

/** A validity window: from `from` (inclusive) to `to` (exclusive); `null` is open-ended. */
export interface TaxWindow {
  readonly from: Date;
  readonly to: Date | null;
}

/**
 * True when two validity windows share at least one instant.
 *
 * Why: one rate at a time per country and region, so the price a customer is shown never depends on which of two rows a
 * query happens to pick (the endpoint doc's overlap refusal, 422 on `validFrom`).
 *
 * @param a one window
 * @param b the other window
 * @returns whether they overlap
 */
export function windowsOverlap(a: TaxWindow, b: TaxWindow): boolean {
  const aEnd = a.to?.getTime() ?? Number.POSITIVE_INFINITY;
  const bEnd = b.to?.getTime() ?? Number.POSITIVE_INFINITY;
  return a.from.getTime() < bEnd && b.from.getTime() < aEnd;
}
