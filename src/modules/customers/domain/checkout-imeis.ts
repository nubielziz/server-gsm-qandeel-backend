// The IMEIs of a storefront checkout the blocklist is asked about (RULES risk 5; decisions 073 and 076): when the checkout opens and again
// when it is paid. The field types say which values hold IMEIs (`fieldImeisOf` of the orders module). Pure; no database.
import { type PlacementFieldType, fieldImeisOf, isValidImei, normalizeImei } from '../../orders';

/** The part of a service field these functions read: its key, its type and whether it is the main input. */
export interface ImeiField {
  readonly key: string;
  readonly fieldType: PlacementFieldType;
  /** The field is the service's main input (decision 065). */
  readonly isMainInput: boolean;
}

/**
 * The IMEIs the blocklist is asked about: the main input, the value of every field of type `imei` and each line of every field of type
 * `imei_bulk`, each read as digits (spaces and dashes removed) when that is a valid IMEI; distinct, in that order.
 *
 * Why: RULES risk 5 and decisions 073 and 076: a blocklisted IMEI cannot open a checkout, whether the buyer typed it into a field of type
 * `imei` (main input or not), into a line of an `imei_bulk` list or into a text main input (a service whose staff chose text). The field
 * types say which values hold IMEIs (`fieldImeisOf`).
 *
 * @param mainInput the main input as the order will read it (`mainInputOf`), or `null`
 * @param fields the service's fields
 * @param values the values as stored, by field key
 * @returns the valid IMEIs, as digits, without repeats
 */
export function blockableImeisOf(
  mainInput: string | null,
  fields: ReadonlyArray<{ readonly key: string; readonly fieldType: PlacementFieldType }>,
  values: Readonly<Record<string, string>>,
): string[] {
  const candidates = [
    mainInput,
    ...fields.flatMap((field) => {
      const value = values[field.key];
      return value === undefined ? [] : fieldImeisOf(field, value);
    }),
  ];
  const found: string[] = [];
  for (const candidate of candidates) {
    if (candidate === null || candidate === undefined) continue;
    const digits = normalizeImei(candidate);
    if (isValidImei(digits) && !found.includes(digits)) found.push(digits);
  }
  return found;
}

/**
 * The IMEIs of a paid checkout's main input: the main input itself when it is one IMEI, and every line of it when its field is a list.
 *
 * Why: decision 076: the main input of an IMEI service may be the value of a field of type `imei_bulk` (up to 30 IMEIs, one per line).
 * The payment (the card capture and the balance payment) asks the risk screening about the main input again, so an IMEI blocklisted after
 * the checkout was opened is caught; it reads the main input exactly as {@link blockableImeisOf} read it when the checkout opened (the
 * main input, and the IMEIs its field's type says it holds), so a list whose second IMEI was blocklisted meanwhile is stopped the way one
 * blocklisted IMEI is.
 *
 * @param mainInput the decrypted main input of the checkout, or `undefined` when it has none
 * @param fields the service's fields now (the main-input field is the one flagged `isMainInput`)
 * @returns the valid IMEIs of the main input, as digits, without repeats; empty when it holds none
 */
export function mainInputImeisOf(mainInput: string | undefined, fields: readonly ImeiField[]): string[] {
  if (mainInput === undefined) return [];
  const box = fields.find((field) => field.isMainInput);
  return box === undefined
    ? blockableImeisOf(mainInput, [], {})
    : blockableImeisOf(mainInput, [box], { [box.key]: mainInput });
}
