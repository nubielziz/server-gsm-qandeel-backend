// The naming rules of a service's custom fields (decision 065), shared by the catalog (the fields route) and the supplier import, which
// cannot import each other: a field has a hidden key the server makes from its Name, and a Name that is unique in its service ignoring
// letter case. Pure.

/** The longest key a field may have (the fields route's limit). */
export const FIELD_KEY_MAX = 60;

/** The longest Name a field may have (the fields route's limit). */
export const FIELD_NAME_MAX = 120;

/** Cuts a text to at most `max` UTF-16 units without leaving half of a surrogate pair at the end. */
function cut(text: string, max: number): string {
  const head = text.slice(0, max);
  return /[\uD800-\uDBFF]$/.test(head) ? head.slice(0, -1) : head;
}

/**
 * The key a field's Name suggests: lower snake case, at most {@link FIELD_KEY_MAX} characters, `field` when nothing is left.
 *
 * Why: decision 065: nobody types a key; the server makes it from the Name when a field is created (the supplier import's rule since
 * decision 042). A Name in a script without Latin letters or digits gets `field`.
 *
 * @param name the field's Name
 * @returns the base of the key, before {@link freeFieldKey} makes it unique
 */
export function fieldKeyBase(name: string): string {
  return (
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '_')
      .replace(/^_+|_+$/g, '')
      .slice(0, FIELD_KEY_MAX) || 'field'
  );
}

/**
 * The first of `base`, `base_2`, `base_3`, ... that a service does not use yet.
 *
 * Why: decision 065: a key is unique within its service and never changes, so a clash takes the next number instead of renaming the
 * field that holds the key. The base is cut so the key stays at most {@link FIELD_KEY_MAX} characters.
 *
 * @param base a key base, usually from {@link fieldKeyBase}
 * @param used the keys the service's fields hold (and any key already planned in the same save)
 * @returns a key that `used` does not hold
 */
export function freeFieldKey(base: string, used: ReadonlySet<string>): string {
  let key = base.slice(0, FIELD_KEY_MAX);
  for (let n = 2; used.has(key); n += 1) {
    const suffix = `_${n}`;
    key = `${base.slice(0, FIELD_KEY_MAX - suffix.length)}${suffix}`;
  }
  return key;
}

/**
 * The form of a Name that two Names are compared by: trimmed and lower-case.
 *
 * Why: decision 065: Names are unique in a service without regard to letter case (the database's `lower(supplier_key)` index), and an
 * incoming CUSTOMFIELD name matches a field's Name the same way.
 *
 * @param name a Name, as typed or as received
 * @returns the comparison form
 */
export function fieldNameKey(name: string): string {
  return name.trim().toLowerCase();
}

/**
 * The field an IMEI service takes as its main input by its Name: the first, in the order given, whose Name is `IMEI` in any letter
 * case, when no field is flagged yet.
 *
 * Why: decision 065: on an IMEI service a field whose Name is IMEI is the IMEI itself, so no form draws a second IMEI box for it and the
 * typed IMEI is its value. The supplier import and the fields route both set the flag on it; a field that is flagged already keeps it.
 *
 * @param fields the service's fields in form order, as they will be stored (`supplierKey` is the Name)
 * @returns the index of the field to flag, or -1 when a field is flagged already or no field is named IMEI
 */
export function imeiNamedFieldIndex(
  fields: ReadonlyArray<{ readonly supplierKey: string; readonly isMainInput: boolean }>,
): number {
  if (fields.some((field) => field.isMainInput)) return -1;
  return fields.findIndex((field) => fieldNameKey(field.supplierKey) === 'imei');
}

/**
 * A Name for a field that no other field of the service has: the trimmed Name when it is free, else `Name 2`, `Name 3`, ...
 *
 * Why: decision 065: two fields of a service may not share a Name ignoring case, and a supplier may list one name twice; the later one
 * gets the first free number (the rule the migration applied to stored fields). A numbered Name is cut so it stays at most
 * {@link FIELD_NAME_MAX} characters; a free Name is kept whole, because it is what the supplier receives.
 *
 * @param name the wanted Name (not empty after trimming)
 * @param used the {@link fieldNameKey} forms of the Names the service's other fields hold
 * @returns a Name whose {@link fieldNameKey} form `used` does not hold
 */
export function freeFieldName(name: string, used: ReadonlySet<string>): string {
  const trimmed = name.trim();
  let candidate = trimmed;
  for (let n = 2; used.has(fieldNameKey(candidate)); n += 1) {
    const suffix = ` ${n}`;
    candidate = `${cut(trimmed, FIELD_NAME_MAX - suffix.length)}${suffix}`;
  }
  return candidate;
}
