// The main input of an order (RESOLUTIONS orders-suppliers-2): the one value stored in `orders.imei` for every service type,
// written by one helper that every placement path (portal, Dhru, REST v1, store, admin) calls. Pure; no database.

/** The part of a service field the helper needs. */
export interface MainInputField {
  readonly key: string;
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
 * file's original name. `null` when the service takes no input (the read model then sends `''`).
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
  switch (source.type) {
    case 'imei':
      return clean(source.imei);
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
