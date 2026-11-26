// The main input of an order (RESOLUTIONS orders-suppliers-2): the one value stored in `orders.imei` for every service type,
// written by one helper that every placement path (portal, Dhru, store, admin) calls, the carry of a shop IMEI onto the
// supplier's main box field after the service's type changed (decision 042), and the bridge that puts the `imei` an older caller sends
// for an IMEI service onto its main-input field (decisions 070 and 073). Pure; no database.

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
  /** The `imei` the request sent (type `imei`: older shop pages, Dhru's `IMEI`, an item of a bulk `imeis`). */
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
 * thing: the value of the first required custom field by `sort` for a server or remote service (a username, a serial, an account); for a
 * file service the first field's value when the service has fields, else the uploaded file's original name. `null` when the service
 * takes no input (the read model then sends `''`). Decision 065: the value of the field flagged as the main input comes first, when it has
 * one: the dispatch sends that value as the `IMEI` parameter, so `orders.imei` and the duplicate check of `block_open` name what the
 * supplier receives. Decision 073: an IMEI service that has a main-input field takes that field's value, else the `imei` the request
 * sent, else nothing (never another field: the dispatch sends the main input as `IMEI` and the other fields in CUSTOMFIELD, so a required
 * ECID beside an empty optional IMEI field must not travel twice); one without a main-input field takes the sent `imei` as typed, else the
 * rule of a server service. The caller passes the values as stored (a field of type `imei` as digits).
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
  const flagged = ordered.find((field) => field.isMainInput);
  const main = flagged ? clean(source.inputs[flagged.key]) : null;
  if (main !== null) return main;
  switch (source.type) {
    case 'imei': {
      const sent = clean(source.imei);
      if (sent !== null || flagged) return sent;
      const first = ordered.find((field) => field.required);
      return first ? clean(source.inputs[first.key]) : null;
    }
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

/** One item of an IMEI service order with the request's `imei` put onto the main-input field ({@link bridgedImeiOf}). */
export interface ImeiBridge {
  /** The values to judge and store, by field key: the sent `imei` replaces the main-input field's value when it has text. */
  readonly inputs: Readonly<Record<string, string>>;
  /** Where the main-input field's problems are reported, by field key (for `inputProblems`); empty: on `inputs.<key>`. */
  readonly paths: Readonly<Record<string, string>>;
  /** The sent `imei`, trimmed, when it has text; `undefined` otherwise. */
  readonly imei: string | undefined;
}

/**
 * Puts the `imei` an older caller sends for an IMEI service onto the service's main-input field.
 *
 * Why: decision 073: the service type `imei` forces nothing any more. An IMEI service's order form is its custom fields, each judged by its
 * own type, Required tick and pattern (decision 070: the forms draw only the fields). Older shop pages, every Dhru call (its `IMEI`
 * parameter) and each item of a bulk `imeis` still send the main input as `imei`: when it has text it is the value of the field flagged
 * as the main input (it wins over a value under that field's key) and is then judged by that field, with its problems on the item's IMEI
 * path, where the caller shows them. A service without a main-input field takes the sent `imei` as typed (`mainInputOf` stores it; no
 * IMEI check). Without a sent `imei` the field is judged on its own value, its problems on `inputs.<key>`, except where the caller cannot
 * see the field (`onImeiPath`: our Dhru list leaves it out), where they stay on the IMEI path.
 *
 * @param source the `imei` the request sent, the values by field key, the item's IMEI path (`imei`, `imeis.N`, `IMEI`), the key of the
 *   main-input field (`undefined` when the service has none) and whether its problems are always shown on the IMEI path
 * @returns the values to judge, the paths of the main-input field's problems and the sent `imei`
 * @see docs/decisions/073-imei-is-a-field-type.md
 */
export function bridgedImeiOf(source: {
  readonly imei: string | undefined;
  readonly inputs: Readonly<Record<string, string>>;
  readonly imeiPath: string;
  readonly fieldKey: string | undefined;
  readonly onImeiPath?: boolean | undefined;
}): ImeiBridge {
  const sent = source.imei?.trim() ?? '';
  const imei = sent === '' ? undefined : sent;
  if (source.fieldKey === undefined) return { inputs: source.inputs, paths: {}, imei };
  return {
    inputs: imei === undefined ? source.inputs : { ...source.inputs, [source.fieldKey]: imei },
    paths: imei !== undefined || source.onImeiPath === true ? { [source.fieldKey]: source.imeiPath } : {},
    imei,
  };
}
