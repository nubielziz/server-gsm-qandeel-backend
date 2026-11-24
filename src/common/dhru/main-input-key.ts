// The name a service field travels under towards a supplier (decisions 042 and 065). Since decision 065 a field's Name is its supplier
// name and the main box is a flag on the field (`service_fields.is_main_input`): no rule reads the text `IMEI` of a field. Pure;
// shared by the supplier dispatch, the import and the sync.

/**
 * The name a service field is sent to a supplier under in CUSTOMFIELD.
 *
 * Why: decision 065: a field has one Name (`service_fields.supplier_key`, never empty); the dispatch sends a value under the link's
 * `field_map[key]` when it has text (the place for a second supplier that spells a name differently), else under the Name. The
 * supplier import and the sync's `fieldsToRequire` match a supplier's field names against the same name.
 *
 * @param field the field's Name
 * @param mapped the link's `field_map` value for the field's key, if any (any type: a value that is not text is ignored)
 * @returns the name the supplier is sent
 */
export function supplierFieldName(field: { readonly supplierKey: string }, mapped?: unknown): string {
  if (typeof mapped === 'string' && mapped !== '') return mapped;
  return field.supplierKey;
}
