// The supplier's own main box of a Dhru service (decision 042, feature 33): the classic service list describes it as `CUSTOM`; when it
// asks for something other than an IMEI (an ECID, a serial number), our catalog makes the service a `server` service whose first field
// is that box, sent to the supplier as `IMEI`. Pure; the import and the sync's adoption read it from `supplier_services.raw`.

/** The main box a supplier service asks for instead of an IMEI. */
export interface SupplierMainInput {
  /** `customname` with its spaces collapsed, at most 120 characters. */
  readonly label: string;
  /** The fewest characters (`customlen`, else 1). */
  readonly minLength: number;
  /** The most characters (`maxlength`), or `null` when the supplier gives no usable limit. */
  readonly maxLength: number | null;
}

/** The longest label a service field takes (`PUT /admin/services/:id/fields`). */
const MAX_LABEL = 120;
/** The longest value an order input takes (`MAX_INPUT_LENGTH` of placement): a larger `maxlength` is not a usable limit. */
const MAX_LENGTH = 500;
/** Names that only say IMEI, after lower-casing and dropping everything but letters and digits: such a box takes a real IMEI. */
const IMEI_NAMES: ReadonlySet<string> = new Set(['imei', 'imeino', 'imeinumber']);

function ownMember(value: unknown, key: string): unknown {
  return typeof value === 'object' && value !== null && !Array.isArray(value) && Object.hasOwn(value, key)
    ? (value as Record<string, unknown>)[key]
    : undefined;
}

/** A whole number written as a number or as digits, else `undefined`. */
function wholeNumber(value: unknown): number | undefined {
  if (typeof value === 'number') return Number.isSafeInteger(value) ? value : undefined;
  if (typeof value === 'string' && /^\d{1,9}$/.test(value.trim())) return Number(value.trim());
  return undefined;
}

/**
 * Reads the supplier's main box of a service.
 *
 * Why: decision 042: the classic list describes the main box as `CUSTOM: { allow, customname, customlen, maxlength, regex, ... }`; with
 * `allow` on, the buyer types what `customname` says instead of an IMEI and the value travels as the `IMEI` parameter. A box named only
 * IMEI takes a real IMEI, so it is not a main input of its own. The supplier's own `regex` is never used: it is untrusted text that may
 * be written for another engine (PHP's `\A`, `[[:alnum:]]`) and match nothing, or backtrack without end on every order check; staff can
 * type a pattern on the field. `isalpha`, `bulk` and `custominfo` are not used either.
 *
 * @param raw the supplier's own entry of the service (`supplier_services.raw`)
 * @returns the box, or `null` when `CUSTOM` is missing, not allowed, unnamed or named only IMEI
 */
export function supplierMainInput(raw: unknown): SupplierMainInput | null {
  const custom = ownMember(raw, 'CUSTOM');
  if (typeof custom !== 'object' || custom === null || Array.isArray(custom)) return null;
  const allow = ownMember(custom, 'allow');
  const allowed = allow === 1 || allow === true || (typeof allow === 'string' && allow.trim() === '1');
  if (!allowed) return null;
  const name = ownMember(custom, 'customname');
  if (typeof name !== 'string') return null;
  const label = name.replace(/\s+/g, ' ').trim().slice(0, MAX_LABEL).trim();
  if (label === '') return null;
  if (IMEI_NAMES.has(label.toLowerCase().replace(/[^a-z0-9]/g, ''))) return null;

  const max = wholeNumber(ownMember(custom, 'maxlength'));
  const maxLength = max !== undefined && max >= 1 && max <= MAX_LENGTH ? max : null;
  const min = wholeNumber(ownMember(custom, 'customlen'));
  const minLength = min !== undefined && min >= 1 && min <= (maxLength ?? MAX_LENGTH) ? min : 1;
  return { label, minLength, maxLength };
}
