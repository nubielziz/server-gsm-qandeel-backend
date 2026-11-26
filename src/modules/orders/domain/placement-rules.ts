// The pure rules of order placement (the portal, Dhru and the shop's checkout): IMEI format, quantity, custom field values (a field of
// type `imei` holds one IMEI, decision 073) and totals. The use case asks these functions and turns their answers into `422` field errors; no database here.
import { Money } from '../../../common/money';
import type { FieldError } from '../../../common/errors';
import { FIELD_VALUE_MAX_LENGTH, compileFieldPattern } from '../../../common/field-pattern';
import type { OrderSource } from '../db/schema';
import type { MainInputField } from './main-input';

/** The sources an order can be placed with today: every value of `ORDER_SOURCES` but the retired `admin` (decision 062; old rows may still carry it). */
export type PlacedOrderSource = Exclude<OrderSource, 'admin'>;

/**
 * The types a custom field can have (the catalog's `SERVICE_FIELD_TYPES`): `imei` holds one IMEI, read as digits and checked for its
 * length and Luhn digit (decision 073).
 */
export type PlacementFieldType = 'text' | 'number' | 'select' | 'textarea' | 'imei';

/** A custom field of a service as placement validates it. */
export interface PlacementField extends MainInputField {
  /** The field's Name (decision 065): unique in its service ignoring case, what a Dhru caller sends in CUSTOMFIELD. */
  readonly name: string;
  readonly label: string;
  readonly fieldType: PlacementFieldType;
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

/** The longest value any custom field or main input may have (the length a field pattern is judged for, decision 051). */
export const MAX_INPUT_LENGTH = FIELD_VALUE_MAX_LENGTH;

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

/** The message of the `invalid_imei` problem of a field of type `imei` (the response's error code is `INVALID_IMEI`). */
export const INVALID_IMEI_MESSAGE = 'This IMEI is not valid: it must be 15 digits with a correct check digit.';

/**
 * Reads the value of one custom field the way it is judged and stored: trimmed, and for a field of type `imei` without its spaces and
 * dashes.
 *
 * Why: decision 073: a field of type `imei` holds one IMEI on any service; a pasted IMEI often carries spaces or dashes, and the order
 * stores the digits (what the supplier receives and the duplicate check and the blocklist read).
 *
 * @param field the field's type
 * @param value the value as sent
 * @returns the value as stored
 */
export function fieldValueOf(field: { readonly fieldType: PlacementFieldType }, value: string): string {
  const text = value.trim();
  return field.fieldType === 'imei' ? normalizeImei(text) : text;
}

/**
 * Puts the values of the fields of type `imei` in their stored form (digits only); every other value stays as sent.
 *
 * Why: decision 073: the order (and the shop's checkout) stores the normalised IMEI of a field of type `imei`, whatever the service type
 * and whether or not the field is the main input.
 *
 * @param fields the service's custom fields
 * @param inputs the values by field key
 * @returns a new object with the same keys; a key no field has is kept as sent (`inputProblems` refuses it)
 */
export function normalizedInputs(
  fields: ReadonlyArray<{ readonly key: string; readonly fieldType: PlacementFieldType }>,
  inputs: Readonly<Record<string, string>>,
): Record<string, string> {
  const byKey = new Map(fields.map((field) => [field.key, field]));
  return Object.fromEntries(
    Object.entries(inputs).map(([key, value]) => {
      const field = byKey.get(key);
      return [key, field?.fieldType === 'imei' ? fieldValueOf(field, value) : value];
    }),
  );
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
 * has a value, a `select` value is one of its options, a `number` is a number, an `imei` is one IMEI (decision 073: read as digits,
 * spaces and dashes removed, it is 15 digits with a valid Luhn check digit; else `invalid_imei`, which the callers answer as
 * `INVALID_IMEI`), a pattern matches (patterns outside the supported form of decision 051 are not run; an `imei` is matched as digits),
 * and no value is longer than 500 characters. A key the service does not define is refused, so a typo is not silently dropped.
 *
 * Decisions 070 and 073: when the IMEI of an IMEI service came as the request's `imei` (older shop pages, Dhru's `IMEI`, an item of a
 * bulk `imeis`), it is the value of the main-input field and that field's problems are shown where the IMEI was sent, so the caller
 * names that path in `paths`.
 *
 * @param fields the service's custom fields
 * @param inputs the values by field key
 * @param paths the path to report a field's problems on, by field key, in place of `inputs.<key>`
 * @returns one field error per problem (`field` is `inputs.<key>` unless `paths` names another), empty when everything fits
 */
export function inputProblems(
  fields: readonly PlacementField[],
  inputs: Readonly<Record<string, string>>,
  paths: Readonly<Record<string, string>> = {},
): FieldError[] {
  const problems: FieldError[] = [];
  const known = new Map(fields.map((field) => [field.key, field]));
  for (const key of Object.keys(inputs)) {
    if (!known.has(key)) {
      problems.push({ field: `inputs.${key}`, code: 'unknown_field', message: 'This service has no such field.' });
    }
  }
  for (const field of fields) {
    const raw = inputs[field.key] ?? '';
    const at = Object.hasOwn(paths, field.key) ? paths[field.key]! : `inputs.${field.key}`;
    if (raw.trim() === '') {
      if (field.required) problems.push({ field: at, code: 'required', message: `${field.label} is required.` });
      continue;
    }
    const value = fieldValueOf(field, raw);
    if (value.length > MAX_INPUT_LENGTH) {
      problems.push({ field: at, code: 'too_long', message: `${field.label} is too long.` });
    } else if (field.fieldType === 'select' && !field.options.includes(value)) {
      problems.push({ field: at, code: 'invalid_option', message: `Choose one of the listed ${field.label} values.` });
    } else if (field.fieldType === 'number' && !/^-?\d+(\.\d+)?$/.test(value)) {
      problems.push({ field: at, code: 'not_a_number', message: `${field.label} must be a number.` });
    } else if (field.fieldType === 'imei' && !isValidImei(value)) {
      problems.push({ field: at, code: 'invalid_imei', message: INVALID_IMEI_MESSAGE });
    } else if (field.regex !== '' && !matchesPattern(field.regex, value)) {
      problems.push({ field: at, code: 'invalid_format', message: `${field.label} is not in the expected format.` });
    }
  }
  return problems;
}

/**
 * Runs a service-defined pattern.
 *
 * Why: decision 051: a pattern runs on the request path of every placement, so only one in the supported form is run; a pattern outside it
 * (or one that does not compile) is not run and the field has no pattern, so the order is never held up or refused by it.
 */
function matchesPattern(pattern: string, value: string): boolean {
  const compiled = compileFieldPattern(pattern);
  return compiled === null || compiled.test(value);
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
