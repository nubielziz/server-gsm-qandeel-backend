// The one rule for "this service field is the supplier's main box" (decision 042, feature 33): a value whose supplier key resolves to
// `IMEI` travels as the Dhru `IMEI` parameter, never inside CUSTOMFIELD. Pure; shared by the supplier dispatch and the catalog's adoption.

/** The Dhru parameter the supplier's main box travels in, and the supplier key that marks a field as that box (compared without case). */
export const MAIN_INPUT_SUPPLIER_KEY = 'IMEI';

/**
 * The supplier's name for one service field.
 *
 * Why: the dispatch sends a field's value under this name: the link's `field_map[key]` when it has text, else the field's own
 * `supplier_key`, else the field's `key` (orders-suppliers-10, decision 042).
 *
 * @param field the field's key and supplier key
 * @param mapped the link's `field_map` value for the key, if any (any type: a value that is not text is ignored)
 * @returns the name the supplier is sent
 */
export function resolvedSupplierKey(
  field: { readonly key: string; readonly supplierKey: string },
  mapped?: unknown,
): string {
  if (typeof mapped === 'string' && mapped !== '') return mapped;
  return field.supplierKey !== '' ? field.supplierKey : field.key;
}

/**
 * Tells whether a resolved supplier key names the supplier's main box.
 *
 * Why: decision 042: the dispatcher sends such a value as `IMEI`, and the sync's adoption leaves a service that already has one alone.
 *
 * @param supplierKey a name from {@link resolvedSupplierKey}
 * @returns true for `IMEI` in any case, spaces around it ignored
 */
export function isMainInputKey(supplierKey: string): boolean {
  return supplierKey.trim().toUpperCase() === MAIN_INPUT_SUPPLIER_KEY;
}
