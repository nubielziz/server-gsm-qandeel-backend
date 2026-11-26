// Cross-row checks and the planning of the replace-all list of the custom fields of a service. Pure functions: they find the
// later occurrence of a repeated key or Name, the way the console highlights it (`fields.N.name`), and they
// decide the key, Name, label and main-input flag of every field row before it is written.
import { fieldKeyBase, fieldNameKey, freeFieldKey, imeiNamedFieldIndex } from '../../../common/field-names';
import type { ServiceFieldType } from '../db/schema';

/** A problem in a list, at the index of the row that caused it. */
export interface ListProblem {
  /** The dotted path the console highlights, for example `fields.7.name`. */
  readonly field: string;
  readonly message: string;
}

/** One custom field row as the fields route receives it (already trimmed by the contract). */
export interface FieldDraft {
  /** The hidden key of a saved field; absent for a new field (the server makes it from the Name). */
  readonly key?: string | undefined;
  readonly name: string;
  /** Absent keeps the saved label of an existing field; an empty text stores the Name. */
  readonly label?: string | undefined;
  readonly fieldType: ServiceFieldType;
  readonly required: boolean;
  readonly options: string[];
  readonly regex: string;
  /** Absent keeps the saved value of an existing field and is `false` for a new one. */
  readonly isMainInput?: boolean | undefined;
}

/** A field row ready to be written: every column that the replace-all list decides. */
export interface PlannedField {
  readonly key: string;
  /** The field's Name (the column keeps the map's name, decision 065). */
  readonly supplierKey: string;
  readonly label: string;
  readonly fieldType: ServiceFieldType;
  readonly required: boolean;
  readonly options: string[];
  readonly regex: string;
  readonly isMainInput: boolean;
}

/**
 * The custom field an IMEI service gets when staff create it by hand (`POST /admin/services`).
 *
 * Why: decision 073: the owner's order "make the IMEI input the default and give the user the freedom": the service type `imei` forces
 * nothing, so a new IMEI service starts with the field its IMEI is typed into: Name and label `IMEI`, type `imei` (15 digits, Luhn),
 * required, the main input, first in the form, no pattern. The supplier import gives a plain IMEI service the same field (decision 071).
 * Staff may rename it, change its type, make it optional or remove it on the fields route afterwards.
 */
export const IMEI_DEFAULT_FIELD: FieldDraft = {
  name: 'IMEI',
  label: 'IMEI',
  fieldType: 'imei',
  required: true,
  options: [],
  regex: '',
  isMainInput: true,
};

/**
 * What the audit row of a fields save says about one field.
 *
 * Why: decision 065: the main-input flag decides what travels as the IMEI parameter, and the Name, label and `required` what a supplier
 * and a buyer see; decision 073: the type and the pattern decide what is refused (turning an `imei` field into `text` removes the IMEI
 * check), so a change of either shows in the audit log. Shared by the fields route and the default field of a new IMEI service.
 *
 * @param field a saved field (`supplierKey` is the Name)
 * @returns the audited facts: key, Name, label, type, pattern, `required` and the main-input flag
 */
export function auditedField(field: {
  readonly key: string;
  readonly supplierKey: string;
  readonly label: string;
  readonly fieldType: ServiceFieldType;
  readonly regex: string;
  readonly required: boolean;
  readonly isMainInput: boolean;
}) {
  return {
    key: field.key,
    name: field.supplierKey,
    label: field.label,
    fieldType: field.fieldType,
    regex: field.regex,
    required: field.required,
    isMainInput: field.isMainInput,
  };
}

/** What the saved fields of a service say about a row that names one of their keys. */
export interface SavedFieldFacts {
  readonly key: string;
  readonly label: string;
  readonly isMainInput: boolean;
}

/**
 * Finds the problems of a custom field list that only the whole list shows: a key that no saved field has, a repeated key, a Name
 * that an earlier field already has (ignoring letter case) and a second main input.
 *
 * Why: decision 065: a field is recognised by its hidden key, which nobody types, so an unknown key means the page is out of date;
 * Names are unique in a service without regard to case (they are what a supplier receives in CUSTOMFIELD); at most one field is the
 * main input. `service_fields` is unique on all three, and the replace-all PUT names the later occurrence
 * (docs/contract/endpoints/catalog.md, PUT /admin/services/:id/fields).
 *
 * @param rows the field rows in list order (names already trimmed)
 * @param savedKeys the keys of the fields the service holds now
 * @param savedMainKeys the keys of the saved fields that are the main input now: a row that leaves `isMainInput` out keeps that
 *   value, so it counts when another row asks for the flag
 * @returns the problems, in row order: `fields.N.key`, `fields.N.name`, `fields.N.isMainInput`
 */
export function fieldListProblems(
  rows: ReadonlyArray<{ key?: string | undefined; name: string; isMainInput?: boolean | undefined }>,
  savedKeys: ReadonlySet<string>,
  savedMainKeys: ReadonlySet<string> = new Set(),
): ListProblem[] {
  const keys = new Set<string>();
  const names = new Set<string>();
  const problems: ListProblem[] = [];
  let mainInputs = 0;
  rows.forEach((row, index) => {
    if (row.key !== undefined) {
      if (!savedKeys.has(row.key)) {
        problems.push({ field: `fields.${index}.key`, message: 'This field no longer exists. Reload the page.' });
      } else if (keys.has(row.key)) {
        problems.push({ field: `fields.${index}.key`, message: `The key ${row.key} is used twice.` });
      }
      keys.add(row.key);
    }
    const nameKey = fieldNameKey(row.name);
    if (nameKey === '') {
      problems.push({ field: `fields.${index}.name`, message: 'Enter a name.' });
    } else if (names.has(nameKey)) {
      problems.push({
        field: `fields.${index}.name`,
        message: `The name ${row.name.trim()} is used by an earlier field.`,
      });
    }
    names.add(nameKey);
    const isMain = row.isMainInput ?? (row.key !== undefined && savedMainKeys.has(row.key));
    if (isMain) {
      mainInputs += 1;
      if (mainInputs > 1) {
        problems.push({ field: `fields.${index}.isMainInput`, message: 'Only one field can be the main input.' });
      }
    }
  });
  return problems;
}

/**
 * Decides the key, Name, label and main-input flag of every row of a custom field list.
 *
 * Why: decision 065: the server, not the console, makes the key of a new field from its Name (the rule the supplier import has), a saved
 * field keeps its key for ever, and a label or flag the console leaves out keeps what is saved instead of being lost by the replace-all
 * write.
 *
 * Rules: a row without a key gets `freeFieldKey(fieldKeyBase(name), used)`, where `used` holds every saved key (kept or not: a deleted
 * field's key is not handed out again in the same save) and the keys planned so far. The Name is stored in `supplierKey`. A label that
 * is given and not empty wins; an empty label stores the Name; an absent one keeps the saved label of that key (a new field gets the
 * Name). `isMainInput` given wins; absent keeps the saved value (a new field is `false`). On an IMEI service a list that leaves no field
 * flagged flags the first field whose Name is IMEI in any letter case ({@link imeiNamedFieldIndex}): that field is the IMEI itself, so
 * no form draws a second IMEI box for it (the rule the supplier import has).
 *
 * @param rows the field rows in list order; a row that names a key has passed {@link fieldListProblems}
 * @param saved the fields the service holds now
 * @param imeiService the service is of type `imei`
 * @returns the rows to write, in the same order
 */
export function plannedFieldRows(
  rows: readonly FieldDraft[],
  saved: readonly SavedFieldFacts[],
  imeiService = false,
): PlannedField[] {
  const byKey = new Map(saved.map((field) => [field.key, field]));
  const used = new Set(byKey.keys());
  const planned = rows.map((row): PlannedField => {
    const name = row.name.trim();
    const before = row.key === undefined ? undefined : byKey.get(row.key);
    let key = row.key;
    if (key === undefined) {
      key = freeFieldKey(fieldKeyBase(name), used);
      used.add(key);
    }
    const label = row.label === undefined ? (before?.label ?? name) : row.label.trim() === '' ? name : row.label.trim();
    return {
      key,
      supplierKey: name,
      label,
      fieldType: row.fieldType,
      required: row.required,
      options: row.options,
      regex: row.regex,
      isMainInput: row.isMainInput ?? before?.isMainInput ?? false,
    };
  });
  const named = imeiService ? imeiNamedFieldIndex(planned) : -1;
  return named < 0 ? planned : planned.map((row, index) => (index === named ? { ...row, isMainInput: true } : row));
}
