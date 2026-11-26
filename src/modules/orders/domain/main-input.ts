// The main input of an order (RESOLUTIONS orders-suppliers-2): the one value stored in `orders.imei` for every service type,
// written by one helper that every placement path (portal, Dhru, store, admin) calls, the carry of a shop IMEI onto the
// supplier's main box field after the service's type changed (decision 042), and where the IMEI of an IMEI order was typed
// (decision 070). Pure; no database.

/** The part of a service field the helper needs. */
export interface MainInputField {
  readonly key: string;
  /** The field is the service's main input: its value travels as the IMEI parameter (decision 065). */
  readonly isMainInput: boolean;
  readonly required: boolean;
  readonly sort: number;
  /** The field id, to keep the order stable when two fields share a `sort`. */
  readonly id: number;
}

/** What the helper needs to know about the order being placed. */
export interface MainInputSource {
  /** The service type: `imei`, `server`, `remote` or `file`. */
  readonly type: 'imei' | 'server' | 'remote' | 'file';
  /** The IMEI the buyer gave (type `imei`). */
  readonly imei?: string | undefined;
  /** The custom field values by field key. */
  readonly inputs: Readonly<Record<string, string>>;
  /** The service's custom fields (any order). */
  readonly fields: readonly MainInputField[];
  /** The original name of the uploaded input file (type `file`). */
  readonly fileName?: string | undefined;
}

function bySort(a: MainInputField, b: MainInputField): number {
  return a.sort - b.sort || a.id - b.id;
}

/**
 * Chooses the main input of an order.
 *
 * Why: orders-suppliers-2: the console shows one input per order and the bulk reply matches on it, so every path stores the same
 * thing: the IMEI for an IMEI service; the value of the first required custom field by `sort` for a server or remote service
 * (a username, a serial, an account); for a file service the first field's value when the service has fields, else the uploaded
 * file's original name. `null` when the service takes no input (the read model then sends `''`). Decision 065: on a server, remote or
 * file service the value of the field flagged as the main input comes first, when it has one: the dispatch sends that value as the
 * `IMEI` parameter, so `orders.imei` and the duplicate check of `block_open` name what the supplier receives.
 *
 * @param source the service type, the values the buyer gave, the service fields and the input file name
 * @returns the main input text (trimmed), or `null`
 */
export function mainInputOf(source: MainInputSource): string | null {
  const clean = (value: string | undefined): string | null => {
    const text = value?.trim();
    return text === undefined || text === '' ? null : text;
  };
  const ordered = [...source.fields].sort(bySort);
  if (source.type === 'imei') return clean(source.imei);
  const flagged = ordered.find((field) => field.isMainInput);
  const main = flagged ? clean(source.inputs[flagged.key]) : null;
  if (main !== null) return main;
  switch (source.type) {
    case 'server':
    case 'remote': {
      const first = ordered.find((field) => field.required);
      return first ? clean(source.inputs[first.key]) : null;
    }
    case 'file': {
      const first = ordered[0];
      return first ? clean(source.inputs[first.key]) : clean(source.fileName);
    }
  }
}

/** A service field as {@link carriedImeiInputs} reads it: its key, whether it is the main input and its place in the form. */
export interface CarryField {
  readonly key: string;
  /** The field is the service's main input (decision 065). */
  readonly isMainInput: boolean;
  readonly sort: number;
  readonly id: number;
}

/**
 * Puts an IMEI typed for a service that is no longer an IMEI service under the field sent as the supplier's main box.
 *
 * Why: decision 042 (feature 33): the supplier sync can make an `imei` service a `server` service whose first field is the supplier's
 * main box (an ECID, a serial number). A shop checkout opened before that and paid after it carries the buyer's value as its IMEI; it
 * must reach the order exactly as before the change: in that field (so `orders.imei` holds it through {@link mainInputOf}, staff see
 * it and the dispatch sends it as `IMEI`). Decision 065: the field is the first by form order that is flagged as the main input (the
 * flag the dispatcher reads too); a value the buyer gave that field wins.
 *
 * @param source the service type, the IMEI the buyer gave, the field values and the service's fields
 * @returns the field values with the IMEI added, or the values as given when the service takes an IMEI, no IMEI was given, no field
 *   is the main box, or that field already has a value
 */
export function carriedImeiInputs(source: {
  readonly type: MainInputSource['type'];
  readonly imei: string | undefined;
  readonly inputs: Readonly<Record<string, string>>;
  readonly fields: readonly CarryField[];
}): Readonly<Record<string, string>> {
  const imei = source.imei?.trim() ?? '';
  if (source.type === 'imei' || imei === '') return source.inputs;
  const box = [...source.fields].sort((a, b) => a.sort - b.sort || a.id - b.id).find((field) => field.isMainInput);
  if (!box || (source.inputs[box.key]?.trim() ?? '') !== '') return source.inputs;
  return { ...source.inputs, [box.key]: imei };
}

/** Where the IMEI of one item of an IMEI service order was typed (decision 070). */
export interface TypedImei {
  /** The IMEI as typed, trimmed (not yet normalised); `''` when the request has none. */
  readonly text: string;
  /** The request path every problem about the IMEI is reported on: the item's IMEI path, or `inputs.<key>` of the main-input field. */
  readonly path: string;
  /** The key of the main-input field the IMEI is read from (and asked for when it is missing); `undefined` when only the IMEI path counts. */
  readonly fieldKey: string | undefined;
}

/**
 * Finds the IMEI of one item of an order for an IMEI service, and the request path its problems belong to.
 *
 * Why: decision 070: the order forms of the shop and the portal draw only the service's custom fields, so the buyer types the IMEI into
 * the field flagged as the main input (decision 065). Older shop pages and every Dhru call still send it as `imei` (Dhru's `IMEI`), and
 * that value wins when it has text, with its problems on the item's IMEI path as before. Otherwise the IMEI is the value under the
 * main-input field's key, and every problem about it (missing, `invalid_imei`, the field's pattern) is reported on `inputs.<key>`,
 * where the form draws the box. With neither and no main-input field (or a caller that reads the IMEI only from its own parameter),
 * the IMEI is missing on the item's IMEI path, as before.
 *
 * @param source the `imei` the request sent, the values by field key, the item's IMEI path (`imei`, `imeis.N`, `IMEI`) and the key of
 *   the main-input field the IMEI may be typed into (`undefined`: the service has none, or the caller reads the IMEI only as `imei`)
 * @returns the typed text (trimmed, `''` for none), the path its problems are reported on and the field it came from, if any
 * @see docs/decisions/070-fields-only-order-forms.md
 */
export function typedImeiOf(source: {
  readonly imei: string | undefined;
  readonly inputs: Readonly<Record<string, string>>;
  readonly imeiPath: string;
  readonly fieldKey: string | undefined;
}): TypedImei {
  const sent = source.imei?.trim() ?? '';
  // `imei` wins when it has text (both sent: the order of before); a field-only form never sends it.
  if (sent !== '' || source.fieldKey === undefined) return { text: sent, path: source.imeiPath, fieldKey: undefined };
  return {
    text: source.inputs[source.fieldKey]?.trim() ?? '',
    path: `inputs.${source.fieldKey}`,
    fieldKey: source.fieldKey,
  };
}
