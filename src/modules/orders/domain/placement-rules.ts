// The pure rules of order placement for the merchant portal (and, later, Dhru and REST v1): IMEI format, quantity, custom field
// values and totals. The use case asks these functions and turns their answers into `422` field errors; no database here.
import { Money } from '../../../common/money';
import type { FieldError } from '../../../common/errors';
import type { MainInputField } from './main-input';

/** A custom field of a service as placement validates it. */
export interface PlacementField extends MainInputField {
  readonly label: string;
  readonly fieldType: 'text' | 'number' | 'select' | 'textarea';
  readonly options: readonly string[];
  /** A regular expression the value must match; `''` for none. */
  readonly regex: string;
}

/** The part of a service placement checks the quantity against. */
export interface QuantityRules {
  readonly minQty: number;
  readonly maxQty: number;
  readonly qtyOptions: readonly number[];
}

/** The longest value any custom field or main input may have. */
export const MAX_INPUT_LENGTH = 500;

/**
 * Tells whether a text is a valid IMEI.
 *
 * Why: error `INVALID_IMEI` (Luhn and format on placement): exactly 15 digits whose Luhn check digit is right. Spaces and dashes
 * a merchant may paste are removed first by {@link normalizeImei}.
 *
 * @param text the IMEI as typed
 * @returns true for 15 digits with a valid Luhn check digit
 */
export function isValidImei(text: string): boolean {
  if (!/^\d{15}$/.test(text)) return false;
  let sum = 0;
  for (let index = 0; index < 15; index += 1) {
    let digit = Number(text[14 - index]);
    if (index % 2 === 1) {
      digit *= 2;
      if (digit > 9) digit -= 9;
    }
    sum += digit;
  }
  return sum % 10 === 0;
}

/**
 * Removes the spaces and dashes of a pasted IMEI.
 *
 * @param text the IMEI as typed
 * @returns the text without whitespace and dashes
 */
export function normalizeImei(text: string): string {
  return text.replace(/[\s-]/g, '');
}

/**
 * Checks the quantity of an order against the service.
 *
 * Why: a service sells either a range (`minQty` to `maxQty`) or fixed packs (`qtyOptions`); the order's total is the unit price
 * times the quantity, so a quantity the service does not sell must never reach the hold.
 *
 * @param quantity the requested quantity
 * @param rules the service's quantity limits and packs
 * @returns the problem text, or `undefined` when the quantity is fine
 */
export function quantityProblem(quantity: number, rules: QuantityRules): string | undefined {
  if (!Number.isInteger(quantity) || quantity < 1) return 'Enter a whole quantity of 1 or more.';
  if (rules.qtyOptions.length > 0) {
    return rules.qtyOptions.includes(quantity)
      ? undefined
      : `Choose one of the quantities this service sells: ${rules.qtyOptions.join(', ')}.`;
  }
  if (quantity < rules.minQty || quantity > rules.maxQty) {
    return `Enter a quantity from ${rules.minQty} to ${rules.maxQty}.`;
  }
  return undefined;
}

/**
 * Checks the custom field values of an order against the service's fields.
 *
 * Why: the order form is drawn from the fields (`GET /client/services/:id`); the server checks the same rules: a required field
 * has a value, a `select` value is one of its options, a `number` is a number, a pattern matches, and no value is longer than
 * 500 characters. A key the service does not define is refused, so a typo is not silently dropped.
 *
 * @param fields the service's custom fields
 * @param inputs the values by field key
 * @returns one field error per problem (`field` is `inputs.<key>`), empty when everything fits
 */
export function inputProblems(
  fields: readonly PlacementField[],
  inputs: Readonly<Record<string, string>>,
): FieldError[] {
  const problems: FieldError[] = [];
  const known = new Map(fields.map((field) => [field.key, field]));
  for (const key of Object.keys(inputs)) {
    if (!known.has(key)) {
      problems.push({ field: `inputs.${key}`, code: 'unknown_field', message: 'This service has no such field.' });
    }
  }
  for (const field of fields) {
    const raw = inputs[field.key];
    const value = raw?.trim() ?? '';
    const at = `inputs.${field.key}`;
    if (value === '') {
      if (field.required) problems.push({ field: at, code: 'required', message: `${field.label} is required.` });
      continue;
    }
    if (value.length > MAX_INPUT_LENGTH) {
      problems.push({ field: at, code: 'too_long', message: `${field.label} is too long.` });
    } else if (field.fieldType === 'select' && !field.options.includes(value)) {
      problems.push({ field: at, code: 'invalid_option', message: `Choose one of the listed ${field.label} values.` });
    } else if (field.fieldType === 'number' && !/^-?\d+(\.\d+)?$/.test(value)) {
      problems.push({ field: at, code: 'not_a_number', message: `${field.label} must be a number.` });
    } else if (field.regex !== '' && !matchesPattern(field.regex, value)) {
      problems.push({ field: at, code: 'invalid_format', message: `${field.label} is not in the expected format.` });
    }
  }
  return problems;
}

/** Runs a service-defined pattern; a broken pattern (staff typo) matches nothing rather than crashing the order. */
function matchesPattern(pattern: string, value: string): boolean {
  try {
    return new RegExp(pattern).test(value);
  } catch {
    return false;
  }
}

/**
 * The total of an order: the unit price times the quantity.
 *
 * @param unit the unit price
 * @param quantity the quantity (a whole number from 1)
 * @returns the total, exact to four decimals
 */
export function totalOf(unit: Money, quantity: number): Money {
  return unit.mul(quantity);
}
