// The pure rules of order placement (the portal, Dhru and the shop's checkout): IMEI format, quantity, custom field values (one table of
// field types, FIELD_TYPE_RULES, reads and judges every value: a field of type `imei` holds one IMEI, decision 073; ten more types,
// decision 076) and totals. The use case asks these functions and turns their answers into `422` field errors; no database here.
import { Money } from '../../../common/money';
import type { FieldError } from '../../../common/errors';
import { FIELD_VALUE_MAX_LENGTH, compileFieldPattern } from '../../../common/field-pattern';
import type { OrderSource } from '../db/schema';
import type { MainInputField } from './main-input';

/** The sources an order can be placed with today: every value of `ORDER_SOURCES` but the retired `admin` (decision 062; old rows may still carry it). */
export type PlacedOrderSource = Exclude<OrderSource, 'admin'>;

/**
 * The types a custom field can have (the catalog's `SERVICE_FIELD_TYPES`, in its order): `imei` holds one IMEI, read as digits and
 * checked for its length and Luhn digit (decision 073); `imei_bulk` to `box_sn` are the check types of decision 076, each read and judged
 * by its row of {@link FIELD_TYPE_RULES}.
 */
export type PlacementFieldType =
  | 'text'
  | 'number'
  | 'select'
  | 'textarea'
  | 'imei'
  | 'imei_bulk'
  | 'imeisv'
  | 'serial'
  | 'iccid'
  | 'eid'
  | 'meid'
  | 'ecid'
  | 'mac_address'
  | 'mi_lock_code'
  | 'box_sn';

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

/**
 * The longest value any custom field or main input may have in its stored form (the length a field pattern is judged for, decision 051);
 * {@link inputProblems} answers `too_long` above it.
 */
export const MAX_INPUT_LENGTH = FIELD_VALUE_MAX_LENGTH;

/**
 * The longest custom field value a request may send as typed, before it is read into its stored form: the cap of the request schemas
 * (the portal's `POST /client/orders`, the shop's `POST /store/v1/checkout-sessions`).
 *
 * Why: decision 076: a list of 30 valid IMEIs typed with CRLF line breaks, with `, ` or with spaces and dashes inside each IMEI is longer
 * than {@link MAX_INPUT_LENGTH} as typed but 479 characters stored, so the request lets it through and {@link inputProblems} holds the
 * stored form of every type to {@link MAX_INPUT_LENGTH} (a 600-character text is still `too_long`).
 */
export const MAX_RAW_INPUT_LENGTH = 2000;

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

/** The most IMEIs one value of a field of type `imei_bulk` holds (decision 076: 30 joined by line breaks are 479 characters). */
export const MAX_FIELD_IMEIS = 30;

/** A problem of one value, as its field type finds it: the code and the message of the field error. */
export interface FieldValueProblem {
  readonly code: string;
  readonly message: string;
}

/** The part of a field its type's check reads: the label a message names and the choices of a `select`. */
type JudgedField = Pick<PlacementField, 'label' | 'options'>;

/** How one field type reads and judges a value (a row of {@link FIELD_TYPE_RULES}). */
export interface FieldTypeRule {
  /**
   * Reads a trimmed value into its stored form (what is judged, matched by the pattern and stored). Left out for a type whose value is
   * judged trimmed and stored as sent (`text`, `number`, `select`, `textarea`).
   */
  readonly read?: (text: string) => string;
  /**
   * The problem of a value in its stored form that is judged before the {@link MAX_INPUT_LENGTH} cap: the count of a list (`imei_bulk`,
   * decision 076: a list of 31 or more IMEIs is told the most it may hold, `too_many_imeis`, not `too_long`). Left out for every other
   * type, whose value meets the cap first.
   */
  readonly countProblem?: (value: string) => FieldValueProblem | undefined;
  /** The problem of a value in its stored form, or `undefined` when the type accepts it; left out for a type that accepts any text. */
  readonly problem?: (value: string, field: JudgedField) => FieldValueProblem | undefined;
  /** The IMEIs a value in its stored form holds (each as digits, not judged), for the blocklist; left out for a type that holds none. */
  readonly imeis?: (value: string) => string[];
}

/** Removes every space of a value (tabs and other white space too). */
const withoutSpaces = (text: string): string => text.replace(/\s/g, '');

/** A problem with a fixed message: the code and the sentence of decision 076. */
const fixedProblem =
  (pattern: RegExp, code: string, message: string) =>
  (value: string): FieldValueProblem | undefined =>
    pattern.test(value) ? undefined : { code, message };

/**
 * The items of a list of IMEIs as typed: split on line breaks, commas and semicolons, each item without its spaces and dashes, the empty
 * ones dropped.
 */
function imeiListItems(text: string): string[] {
  return text
    .split(/[\r\n,;]/)
    .map(normalizeImei)
    .filter((item) => item !== '');
}

/** The items of a list of IMEIs in its stored form (one per line); none for an empty value. */
function storedImeiItems(value: string): string[] {
  return value === '' ? [] : value.split('\n');
}

/** The problem of a list of IMEIs in its stored form that holds more than {@link MAX_FIELD_IMEIS} items, judged before the length cap. */
function imeiCountProblem(value: string): FieldValueProblem | undefined {
  return storedImeiItems(value).length > MAX_FIELD_IMEIS
    ? { code: 'too_many_imeis', message: `Enter at most ${MAX_FIELD_IMEIS} IMEIs.` }
    : undefined;
}

/**
 * The first problem of a list of IMEIs in its stored form (one per line): more than {@link MAX_FIELD_IMEIS} items, then by line, an item
 * that is not a valid IMEI or one that repeats an earlier item. A value with no item at all is refused as line 1.
 */
function imeiListProblem(value: string): FieldValueProblem | undefined {
  const tooMany = imeiCountProblem(value);
  if (tooMany !== undefined) return tooMany;
  const items = storedImeiItems(value);
  const invalid = (line: number): FieldValueProblem => ({
    code: 'invalid_imei',
    message: `Line ${line} is not a valid IMEI: each line must be 15 digits with a correct check digit.`,
  });
  if (items.length === 0) return invalid(1);
  const seen = new Set<string>();
  for (const [index, item] of items.entries()) {
    if (!isValidImei(item)) return invalid(index + 1);
    if (seen.has(item)) return { code: 'duplicate_imei', message: `Line ${index + 1} repeats an IMEI of this list.` };
    seen.add(item);
  }
  return undefined;
}

/** Reads a MAC address: the 12 hexadecimal characters, upper-cased, as `AA:BB:CC:DD:EE:FF`, when it is written in an accepted form. */
function macAddressOf(text: string): string {
  const accepted =
    /^[0-9A-F]{12}$/i.test(text) ||
    /^[0-9A-F]{2}(:[0-9A-F]{2}){5}$/i.test(text) ||
    /^[0-9A-F]{2}(-[0-9A-F]{2}){5}$/i.test(text) ||
    /^[0-9A-F]{4}(\.[0-9A-F]{4}){2}$/i.test(text);
  if (!accepted) return text;
  const hex = text.replace(/[:.-]/g, '').toUpperCase();
  return hex.match(/.{2}/g)!.join(':');
}

/** Reads an ECID: without spaces and upper-cased, a leading `0x` (any case) kept as `0x`. */
function ecidOf(text: string): string {
  const compact = withoutSpaces(text);
  return /^0x/i.test(compact) ? `0x${compact.slice(2).toUpperCase()}` : compact.toUpperCase();
}

/**
 * How every field type reads and judges a value: one row per value of `SERVICE_FIELD_TYPES`.
 *
 * Why: decisions 073 and 076: staff choose the type of a field, and the server judges the value by its type on every surface (the
 * portal's `POST /client/orders`, Dhru's `placeimeiorder` and its bulk form, the shop's checkout session and the paid checkout). One
 * table drives {@link fieldValueOf}, {@link normalizedInputs}, {@link inputProblems} and {@link fieldImeisOf}, so no service carries code
 * of its own for a type. A value is trimmed first; each row says how it is then read into its stored form and when it is valid. A
 * problem `invalid_imei` (a field of type `imei`, or a line of an `imei_bulk` list) makes the answer `INVALID_IMEI`; every other code
 * the ordinary `VALIDATION_FAILED`. `imei_bulk` is one order at one price: the list is the value of one field of one order (it never
 * places one order per IMEI).
 *
 * @see docs/decisions/076-ten-more-field-types.md
 */
export const FIELD_TYPE_RULES: Readonly<Record<PlacementFieldType, FieldTypeRule>> = {
  text: {},
  number: {
    problem: (value, field) =>
      /^-?\d+(\.\d+)?$/.test(value) ? undefined : { code: 'not_a_number', message: `${field.label} must be a number.` },
  },
  select: {
    problem: (value, field) =>
      field.options.includes(value)
        ? undefined
        : { code: 'invalid_option', message: `Choose one of the listed ${field.label} values.` },
  },
  textarea: {},
  imei: {
    read: normalizeImei,
    problem: (value) => (isValidImei(value) ? undefined : { code: 'invalid_imei', message: INVALID_IMEI_MESSAGE }),
    imeis: (value) => [value],
  },
  imei_bulk: {
    read: (text) => imeiListItems(text).join('\n'),
    countProblem: imeiCountProblem,
    problem: imeiListProblem,
    imeis: storedImeiItems,
  },
  imeisv: {
    read: normalizeImei,
    problem: fixedProblem(/^\d{16}$/, 'invalid_imeisv', 'This IMEISV is not valid: it must be 16 digits.'),
  },
  serial: {
    read: (text) => withoutSpaces(text).toUpperCase(),
    problem: fixedProblem(
      /^[A-Z0-9]{5,30}$/,
      'invalid_serial',
      'This serial number is not valid: 5 to 30 letters and digits.',
    ),
  },
  iccid: {
    read: normalizeImei,
    problem: fixedProblem(
      /^89\d{16,20}$/,
      'invalid_iccid',
      'This ICCID is not valid: 18 to 22 digits, starting with 89.',
    ),
  },
  eid: {
    read: normalizeImei,
    problem: fixedProblem(/^\d{32}$/, 'invalid_eid', 'This EID is not valid: it must be 32 digits.'),
  },
  meid: {
    read: (text) => normalizeImei(text).toUpperCase(),
    problem: fixedProblem(
      /^([0-9A-F]{14,15}|\d{18})$/,
      'invalid_meid',
      'This MEID is not valid: 14 hexadecimal characters (0-9, A-F), or 18 digits.',
    ),
  },
  ecid: {
    read: ecidOf,
    problem: fixedProblem(
      /^((0x)?[0-9A-F]{8,16}|\d{8,20})$/,
      'invalid_ecid',
      'This ECID is not valid: 8 to 16 hexadecimal characters, or up to 20 digits.',
    ),
  },
  mac_address: {
    read: macAddressOf,
    problem: fixedProblem(
      /^[0-9A-F]{2}(:[0-9A-F]{2}){5}$/,
      'invalid_mac_address',
      'This MAC address is not valid: 12 hexadecimal characters, like AA:BB:CC:DD:EE:FF.',
    ),
  },
  mi_lock_code: {
    read: (text) => text,
    problem: fixedProblem(
      /^[A-Za-z0-9-]{6,64}$/,
      'invalid_mi_lock_code',
      'This Mi lock code is not valid: 6 to 64 letters, digits and dashes.',
    ),
  },
  box_sn: {
    read: (text) => withoutSpaces(text).toUpperCase(),
    problem: fixedProblem(
      /^[A-Z0-9-]{4,32}$/,
      'invalid_box_sn',
      'This box serial number is not valid: 4 to 32 letters, digits and dashes.',
    ),
  },
};

/**
 * Reads the value of one custom field the way it is judged and stored: trimmed, then read by its type's row of
 * {@link FIELD_TYPE_RULES} (an `imei` without its spaces and dashes, an `imei_bulk` list one IMEI per line, a MAC address as
 * `AA:BB:CC:DD:EE:FF`, ...).
 *
 * Why: decisions 073 and 076: a pasted IMEI, serial or MAC address often carries spaces, dashes or another notation, and the order stores
 * one form (what the supplier receives and the duplicate check and the blocklist read).
 *
 * @param field the field's type
 * @param value the value as sent
 * @returns the value as judged and stored
 */
export function fieldValueOf(field: { readonly fieldType: PlacementFieldType }, value: string): string {
  const text = value.trim();
  const read = FIELD_TYPE_RULES[field.fieldType].read;
  return read === undefined ? text : read(text);
}

/**
 * Puts the values of the fields whose type reads them (every type of {@link FIELD_TYPE_RULES} with a `read`) in their stored form; every
 * other value stays as sent.
 *
 * Why: decisions 073 and 076: the order (and the shop's checkout) stores the read form of a checked type (an IMEI as digits, an
 * `imei_bulk` list one IMEI per line), whatever the service type and whether or not the field is the main input.
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
      if (field === undefined) return [key, value];
      // A type that reads its value stores the read form. Any other value stays as sent, unless it is longer than the stored cap: the
      // request may carry up to MAX_RAW_INPUT_LENGTH characters (decision 076), and only the padding of white space can make a value that
      // passed `inputProblems` longer than MAX_INPUT_LENGTH, so such a value is stored trimmed and no stored value exceeds the cap.
      const reads = FIELD_TYPE_RULES[field.fieldType].read !== undefined;
      return [key, reads || value.length > MAX_INPUT_LENGTH ? fieldValueOf(field, value) : value];
    }),
  );
}

/**
 * The IMEIs one value of a field holds: one for a field of type `imei`, each line for a field of type `imei_bulk`, none for another type.
 *
 * Why: RULES risk 5 and decisions 073 and 076: the blocklist of the shop's checkout and the account block read every IMEI of an order,
 * whether it was typed into a field of type `imei` or into a line of an `imei_bulk` list.
 *
 * @param field the field's type
 * @param value the value as sent or as stored
 * @returns the IMEIs in their stored form (digits), not judged: the caller keeps those it can use
 */
export function fieldImeisOf(field: { readonly fieldType: PlacementFieldType }, value: string): string[] {
  const imeis = FIELD_TYPE_RULES[field.fieldType].imeis;
  return imeis === undefined ? [] : imeis(fieldValueOf(field, value));
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
 * has a value, no value is longer than 500 characters in its stored form (the request may send up to {@link MAX_RAW_INPUT_LENGTH} as
 * typed; decision 076: an `imei_bulk` list is counted before it is measured, so 31 or more IMEIs answer `too_many_imeis`, every other
 * value meets the cap first), the value fits its type (its row of {@link FIELD_TYPE_RULES}: a `select` value
 * is one of its options, a `number` is a number, an `imei` is one IMEI, decision 073: read as digits, spaces and dashes removed, it is 15
 * digits with a valid Luhn check digit, else `invalid_imei`, which the callers answer as `INVALID_IMEI`; decision 076: an `imei_bulk`
 * list, an IMEISV, a serial, ... each with its own code, answered as `VALIDATION_FAILED` but a bad line of a list, `invalid_imei`), and a
 * pattern matches the stored form (patterns outside the supported form of decision 051 are not run; an `imei` is matched as digits).
 * Only the first problem of a field is reported. A key the service does not define is refused, so a typo is not silently dropped.
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
    const rule = FIELD_TYPE_RULES[field.fieldType];
    // Decision 076: a list is counted before it is measured; the cap is on the stored form, whatever was typed around it.
    const countProblem = rule.countProblem?.(value);
    if (countProblem !== undefined) {
      problems.push({ field: at, ...countProblem });
      continue;
    }
    if (value.length > MAX_INPUT_LENGTH) {
      problems.push({ field: at, code: 'too_long', message: `${field.label} is too long.` });
      continue;
    }
    const typeProblem = rule.problem?.(value, field);
    if (typeProblem !== undefined) {
      problems.push({ field: at, ...typeProblem });
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
