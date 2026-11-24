// Reading the custom field values of a Dhru call by field Name (decision 065). Pure; no database.
import type { FieldError } from '../../../common/errors';
import { fieldNameKey } from '../../../common/field-names';

/** The part of a service field {@link inputsByFieldName} matches a sent name against. */
export interface NamedInputField {
  /** The hidden key the order stores its answer under. */
  readonly key: string;
  /** The field's Name: what a Dhru caller reads as `fieldname` and sends in CUSTOMFIELD. */
  readonly name: string;
  /** The text buyers read; names the field in a problem. */
  readonly label: string;
}

/**
 * Turns the values a Dhru caller sent by field name into values by field key.
 *
 * Why: decision 065: our Dhru server publishes each field under its Name (`fieldname`), so a caller's CUSTOMFIELD carries Names; an order
 * stores its answers under the hidden key and the shop and the portal send keys. A sent name is matched in three steps, the first that
 * finds a field wins: a field's Name exactly; a field's key exactly (outer spaces aside), so a caller that kept the old `fieldname` (the
 * key) still works; a field's Name trimmed and without regard to letter case. So a key sent as it was published is never taken for
 * another field whose Name differs from it only in letter case (Name `SN` on one field, key `sn` on another). A name that matches
 * nothing stays under the name it was sent as, so `inputProblems` answers `unknown_field` for it as before. Two entries for one field
 * (`Email` and `email`, or a Name and the key) are a mistake of the caller: the first is kept and the later one is a `duplicate_field`
 * problem, never a silent overwrite.
 *
 * @param fields the service's fields
 * @param sent the values as the caller sent them, by name
 * @returns the values by field key (and the unknown names as sent) and one problem per repeated field (`field` is `inputs.<later name>`)
 */
export function inputsByFieldName(
  fields: readonly NamedInputField[],
  sent: Readonly<Record<string, string>>,
): { inputs: Record<string, string>; problems: FieldError[] } {
  const byExactName = new Map(fields.map((field) => [field.name, field]));
  const byKey = new Map(fields.map((field) => [field.key, field]));
  const byName = new Map(fields.map((field) => [fieldNameKey(field.name), field]));
  const entries: Array<[string, string]> = [];
  const problems: FieldError[] = [];
  const given = new Set<string>();
  for (const [name, value] of Object.entries(sent)) {
    const field = byExactName.get(name) ?? byKey.get(name.trim()) ?? byName.get(fieldNameKey(name));
    if (field === undefined) {
      entries.push([name, value]);
    } else if (given.has(field.key)) {
      problems.push({ field: `inputs.${name}`, code: 'duplicate_field', message: `${field.label} was sent twice.` });
    } else {
      given.add(field.key);
      entries.push([field.key, value]);
    }
  }
  return { inputs: Object.fromEntries(entries), problems };
}
