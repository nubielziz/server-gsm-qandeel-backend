// The rules of the supplier import (resolutions orders-suppliers-10, catalog-9, decisions 042 and 071): what a picked supplier service becomes in our
// catalog, how its custom fields map to ours and what the item costs. Pure (the suggested price needs the catalog's default minimum profit: the use case computes it).
import { supplierFieldName } from '../../../common/dhru';
import {
  fieldKeyBase,
  fieldNameKey,
  freeFieldKey,
  freeFieldName,
  imeiNamedFieldIndex,
} from '../../../common/field-names';
import { Money } from '../../../common/money';
import { linkUnitCost } from './link-selection';
import { type SupplierMainInput, supplierMainInput } from './supplier-main-input';

/** What an item of the import is, compared with the service already linked to it. */
export type ImportState = 'new' | 'matching' | 'changed';

/** The service (if any) a supplier service is linked to. */
export interface LinkedService {
  readonly serviceId: number;
  readonly name: string;
  /** `services.cost` (not the effective cost). */
  readonly cost: string;
  readonly archived: boolean;
  /** The service's quantity rule (feature 25), to tell whether it differs from the supplier's. */
  readonly minQty: number;
  readonly maxQty: number;
  readonly qtyOptions: readonly number[];
}

/**
 * Tells whether a live linked service sells another quantity rule than the supplier states.
 *
 * Why: the import preview shows staff the difference (B213); a service keeps its own rule, nothing is applied or alerted.
 *
 * @param linked the linked service, or `null` for a new item
 * @param rule the supplier's rule as `supplierQuantityRule` reads it
 * @returns false for a new item and for an archived link; else whether any of the three values differs
 */
export function quantityDiffers(
  linked: LinkedService | null,
  rule: { readonly minQty: number; readonly maxQty: number; readonly qtyOptions: readonly number[] },
): boolean {
  if (linked === null || linked.archived) return false;
  return (
    linked.minQty !== rule.minQty ||
    linked.maxQty !== rule.maxQty ||
    linked.qtyOptions.length !== rule.qtyOptions.length ||
    linked.qtyOptions.some((pack, index) => pack !== rule.qtyOptions[index])
  );
}

/**
 * Classifies one picked supplier service.
 *
 * Why: the preview of `POST /admin/suppliers/:id/import/preview`: `new` (no service links it), `matching` (linked and the service
 * cost equals `credit x credit_rate`), `changed` (linked, the cost differs).
 *
 * @param item the supplier service's price in credits
 * @param creditRate the supplier's credit rate
 * @param linked the linked service with the lowest id, or `null`
 * @returns the state, the item's cost in USD and the cost the service had when `changed`
 */
export function classifyImportItem(
  item: { credit: string },
  creditRate: string,
  linked: LinkedService | null,
): { state: ImportState; cost: Money; previousCost: Money | null } {
  const cost = linkUnitCost({ credit: item.credit, creditRate });
  if (linked === null) return { state: 'new', cost, previousCost: null };
  const current = Money.of(linked.cost);
  return cost.eq(current)
    ? { state: 'matching', cost, previousCost: null }
    : { state: 'changed', cost, previousCost: current };
}

/** The service types an import can create (`SERVICE_TYPES`); the quick add counts a supplier service of any other type as unsupported. */
export const IMPORTABLE_TYPES = ['imei', 'server', 'remote', 'file'] as const;

/** One value of {@link IMPORTABLE_TYPES}. */
export type ImportableType = (typeof IMPORTABLE_TYPES)[number];

/**
 * The service type a supplier's type name stands for.
 *
 * @param supplierType the supplier's own type name (`IMEI`, `Server`, ...)
 * @returns the type, or `undefined` when it is not one of imei, server, remote or file
 */
export function importableType(supplierType: string): ImportableType | undefined {
  const lower = supplierType.trim().toLowerCase();
  return IMPORTABLE_TYPES.find((type) => type === lower);
}

/** A custom field to create on an imported service. */
export interface ImportedField {
  /** The hidden key, made from the supplier's field name (`fieldKeyBase`, unique in the service). */
  readonly key: string;
  readonly label: string;
  readonly fieldType: 'text' | 'number' | 'select' | 'textarea' | 'imei';
  readonly options: string[];
  readonly required: boolean;
  /** The field's Name (decision 065): what the supplier receives in CUSTOMFIELD, unique in the service ignoring letter case. */
  readonly supplierKey: string;
  /** The field is the supplier's main box: its value travels as the Dhru `IMEI` parameter, never in CUSTOMFIELD. */
  readonly isMainInput: boolean;
  readonly sort: number;
  /** The pattern a value must match; `''` for none (a field of `Requires.Custom` has none). */
  readonly regex: string;
}

function text(value: unknown): string {
  return typeof value === 'string' ? value.trim() : typeof value === 'number' ? String(value) : '';
}

/**
 * The service field of a supplier's main box.
 *
 * Why: decisions 042 and 065: the box becomes the first required text field of a `server` service with `isMainInput` set, so every channel
 * draws and checks it like any field and the dispatcher sends its value as `IMEI`. Its Name is the box's own name from the supplier
 * (its label); the Name is never sent, so on a clash with another field of the service the box takes the number (`Name 2`) and the
 * supplier's field keeps its name. Its pattern is `^.{min,max}$` from the lengths when the supplier gives a maximum, else none; the
 * supplier's own `regex` is never copied (staff can type one on the field).
 *
 * @param main the box as {@link supplierMainInput} reads it
 * @param used what the service's other fields hold: their keys (the key gets `_2`, `_3`, ... on a clash) and the `fieldNameKey` forms of
 *   their Names (the Name gets ` 2`, ` 3`, ... on a clash)
 * @returns the field, with `sort` 0
 */
export function mainInputField(
  main: SupplierMainInput,
  used: { readonly keys: ReadonlySet<string>; readonly names: ReadonlySet<string> },
): ImportedField {
  // Only a pattern we build from the lengths: the supplier's own `regex` is untrusted (decision 042, review of feature 33).
  const regex = main.maxLength !== null ? `^.{${main.minLength},${main.maxLength}}$` : '';
  return {
    key: freeFieldKey(fieldKeyBase(main.label), used.keys),
    label: main.label,
    fieldType: 'text',
    options: [],
    required: true,
    supplierKey: freeFieldName(main.label, used.names),
    isMainInput: true,
    sort: 0,
    regex,
  };
}

/** The Name and the label of the field a plain IMEI service gets for its IMEI (decision 071). */
export const IMEI_FIELD_NAME = 'IMEI';

/**
 * The main-input field a plain IMEI service gets for its IMEI.
 *
 * Why: decision 071: since decision 070 the order forms draw only a service's custom fields, and an IMEI service's IMEI is typed into the
 * field flagged `isMainInput`. A Dhru supplier names its main box only when it is not an IMEI (`CUSTOM`, decision 042): the IMEI is the
 * `IMEI` parameter of every IMEI order, so the supplier never lists it among its fields, and a plain IMEI service was imported with no
 * field the shop could take its IMEI in. The field is required, named and labelled `IMEI`, first in the form, with no pattern, of type
 * `imei` (decision 073: the field type checks the IMEI, 15 digits and the Luhn digit; the service type forces nothing). Its value never
 * travels in CUSTOMFIELD: the dispatch sends the order's main input as the `IMEI` parameter.
 *
 * @param usedKeys the keys of the service's other fields (the key is `imei`, else `imei_2`, `imei_3`, ...)
 * @returns the field, with `sort` 0
 */
export function imeiInputField(usedKeys: ReadonlySet<string>): ImportedField {
  return {
    key: freeFieldKey(fieldKeyBase(IMEI_FIELD_NAME), usedKeys),
    label: IMEI_FIELD_NAME,
    fieldType: 'imei',
    options: [],
    required: true,
    supplierKey: IMEI_FIELD_NAME,
    isMainInput: true,
    sort: 0,
    regex: '',
  };
}

/** The box the supplier sync's adoption puts on an IMEI service ({@link adoptedBox}). */
export interface AdoptedBox {
  /** The box as {@link mainInputField} makes it; when it replaces a field, with that field's key. */
  readonly field: ImportedField;
  /**
   * The key of the service's main-input field that becomes the box (it keeps its key and its id), or `null` when the service has none and
   * the box is a new first field.
   */
  readonly replaces: string | null;
}

/**
 * The box an adoption gives an IMEI service whose supplier service has a main box of its own.
 *
 * Why: decisions 042 and 071: an `imei` service whose supplier's main box is not an IMEI becomes a `server` service with that box first.
 * Since decision 071 every IMEI service has a main-input field (its IMEI), and a service has at most one: that field becomes the box (its
 * key and id stay, so the answers of older orders stored under the key show under the box's label) instead of a second flagged field being
 * inserted. Everything else is what {@link mainInputField} makes (Name, label, text type, no options, pattern, `required`), the Name
 * checked against the service's other fields only (` 2`, ` 3`, ... on a clash). A service without a main-input field gets the box as a
 * new first field, as before.
 *
 * @param main the supplier's box as {@link supplierMainInput} reads it
 * @param fields the service's fields (`supplierKey` is the Name)
 * @returns the box and the key of the field it replaces
 */
export function adoptedBox(
  main: SupplierMainInput,
  fields: ReadonlyArray<{ readonly key: string; readonly supplierKey: string; readonly isMainInput: boolean }>,
): AdoptedBox {
  const flagged = fields.find((field) => field.isMainInput);
  const others = fields.filter((field) => field !== flagged);
  const field = mainInputField(main, {
    keys: new Set(others.map((other) => other.key)),
    names: new Set(others.map((other) => fieldNameKey(other.supplierKey))),
  });
  return flagged === undefined
    ? { field, replaces: null }
    : { field: { ...field, key: flagged.key }, replaces: flagged.key };
}

/** The texts a supplier writes for a flag that is set (trimmed, lower-case): a Dhru Fusion site writes `"on"` for a checkbox. */
const FLAG_ON_TEXTS: ReadonlySet<string> = new Set(['on', '1', 'yes', 'true', 'required', 'y']);

/**
 * Tells whether a supplier's flag of a `Requires.Custom` field (`required`, `adminonly`) is set.
 *
 * Why: feature 33: a real Dhru Fusion site writes a checked flag as `"on"` and an unchecked one as `""` (635 of 637 required fields of
 * the owner's supplier said `"on"`); other panels write `1`, `"yes"` or `true`. Reading only `true`, `1` and `yes` imported every
 * required field as optional.
 *
 * @param value the flag as the supplier wrote it
 * @returns true for `true`, the number 1, or text that is, trimmed and lower-cased, `on`, `1`, `yes`, `true`, `required` or `y`
 */
export function isSupplierFlagOn(value: unknown): boolean {
  if (value === true || value === 1) return true;
  return typeof value === 'string' && FLAG_ON_TEXTS.has(value.trim().toLowerCase());
}

/**
 * Turns the supplier's `Requires.Custom` list into our service fields.
 *
 * Why: orders-suppliers-10, feature 33 and decision 065: fields come from the supplier's custom fields, and the field's Name
 * (`supplier_key`) is the supplier's field name as the supplier spells it; two names that differ only in letter case cannot both be
 * a Name in one service, so the later one gets ` 2` (`Name 2`, `Name 3`, ...). The label is the supplier's description, else the Name.
 * The hidden key is the field name in lower snake case (unique within the service: a repeat gets `_2`, `_3`, ...), the type follows the
 * supplier's `fieldtype` (`dropdown`, `select` and `radio` become `select` with the `fieldoptions` as options, `number`/`numeric` and
 * `textarea` are kept, anything else is `text`), `required` is {@link isSupplierFlagOn}, and a field the supplier marks `adminonly`
 * (its own staff fill it, not the buyer) is left out. The supplier's `regexpr` is never used (decision 042: untrusted).
 *
 * @param customFields the supplier service's custom field descriptions
 * @returns the fields to create, in the supplier's order
 */
export function importedFields(customFields: readonly unknown[]): ImportedField[] {
  const usedKeys = new Set<string>();
  const usedNames = new Set<string>();
  const fields: ImportedField[] = [];
  for (const entry of customFields) {
    if (typeof entry !== 'object' || entry === null) continue;
    const field = entry as Record<string, unknown>;
    const name = text(field.fieldname);
    if (name === '' || isSupplierFlagOn(field.adminonly)) continue;
    const key = freeFieldKey(fieldKeyBase(name), usedKeys);
    usedKeys.add(key);
    const fieldName = freeFieldName(name, usedNames);
    usedNames.add(fieldNameKey(fieldName));
    const rawType = text(field.fieldtype).toLowerCase();
    const fieldType =
      rawType === 'dropdown' || rawType === 'select' || rawType === 'radio'
        ? 'select'
        : rawType === 'number' || rawType === 'numeric'
          ? 'number'
          : rawType === 'textarea'
            ? 'textarea'
            : 'text';
    const options =
      fieldType === 'select'
        ? text(field.fieldoptions)
            .split(/[,\n]/)
            .map((option) => option.trim())
            .filter((option) => option !== '')
        : [];
    fields.push({
      key,
      label: text(field.description) || fieldName,
      fieldType,
      options,
      required: isSupplierFlagOn(field.required),
      supplierKey: fieldName,
      isMainInput: false,
      sort: fields.length,
      regex: '',
    });
  }
  return fields;
}

/** A service field as {@link fieldsToRequire} reads it. */
export interface RequirableField {
  readonly key: string;
  /** The field's Name (decision 065). */
  readonly supplierKey: string;
  readonly required: boolean;
  /** The main box is not a custom field of the supplier, so it is never matched. */
  readonly isMainInput: boolean;
}

/**
 * The fields of a service made before feature 33 that its supplier requires but that the import made optional.
 *
 * Why: feature 33 (second review round): every `"required": "on"` field was imported as optional, so buyers could leave out what the
 * supplier demands. A field matches a supplier field when its supplier name (`supplierFieldName`: the link's field map, else the
 * Name) equals that field's `fieldname`, exactly first, then without case and with spaces trimmed. Only optional fields are listed:
 * a field is never made optional here, and the main-input field (the supplier's main box, not a custom field) is never listed. A
 * supplier field marked `adminonly` is not the buyer's.
 *
 * @param fields the service's fields
 * @param fieldMap the one active link's `field_map`
 * @param customFields the supplier service's `Requires.Custom` list
 * @returns the keys of the service's fields to make required, in the given order
 */
export function fieldsToRequire(
  fields: readonly RequirableField[],
  fieldMap: Readonly<Record<string, unknown>>,
  customFields: readonly unknown[],
): string[] {
  const demanded: string[] = [];
  for (const entry of customFields) {
    if (typeof entry !== 'object' || entry === null) continue;
    const field = entry as Record<string, unknown>;
    const name = text(field.fieldname);
    if (name !== '' && isSupplierFlagOn(field.required) && !isSupplierFlagOn(field.adminonly)) demanded.push(name);
  }
  if (demanded.length === 0) return [];
  const exact = new Set(demanded);
  const loose = new Set(demanded.map((name) => name.trim().toLowerCase()));
  return fields
    .filter((field) => {
      if (field.required || field.isMainInput) return false;
      const name = supplierFieldName(field, fieldMap[field.key]);
      return exact.has(name) || loose.has(name.trim().toLowerCase());
    })
    .map((field) => field.key);
}

/** What a supplier service becomes in our catalog: its type (`undefined` when it cannot be imported) and its fields in order. */
export interface ImportShape {
  readonly type: ImportableType | undefined;
  readonly fields: ImportedField[];
}

/**
 * Says what a supplier service becomes in our catalog.
 *
 * Why: decision 042: our `imei` type means a real 15-digit IMEI everywhere, so an IMEI service whose main box asks for something else
 * (`CUSTOM`, read by {@link supplierMainInput}) becomes a `server` service whose first field is that box, followed by the fields of
 * `Requires.Custom`. Every reader of the catalog type of a supplier service (the import, the preview, the quick add) asks this.
 * A `server`, `remote` or `file` supplier service is never changed by `CUSTOM`. Decision 065: a service that stays `imei` takes the
 * first field whose Name is IMEI in any letter case as its main input ({@link imeiNamedFieldIndex}): it is the IMEI itself, so no form
 * draws a second IMEI box for it and its value is never sent in CUSTOMFIELD; decision 073 makes it of type `imei` when the supplier's type
 * is text (other types are kept). Decision 071: a service that stays `imei` with no field named
 * IMEI gets one ({@link imeiInputField}) as its first field, the supplier's fields after it, so the shop's form (only the fields, decision
 * 070) has a box for the IMEI.
 *
 * @param row the supplier service: its type name, its `Requires.Custom` list and its stored entry
 * @returns the catalog type and the fields to create
 */
export function importShape(row: {
  readonly type: string;
  readonly customFields: readonly unknown[];
  readonly raw: unknown;
}): ImportShape {
  const type = importableType(row.type);
  const others = importedFields(row.customFields);
  const main = type === 'imei' ? supplierMainInput(row.raw) : null;
  if (main === null) {
    if (type !== 'imei') return { type, fields: others };
    const named = imeiNamedFieldIndex(others);
    if (named >= 0) {
      // Decision 073: the flagged field holds the IMEI, so a supplier field that is plain text becomes of type `imei` (as migration 0072
      // did to the stored ones); a list, a number or a text area keeps the supplier's type.
      return {
        type,
        fields: others.map((other, index) =>
          index === named
            ? { ...other, isMainInput: true, fieldType: other.fieldType === 'text' ? 'imei' : other.fieldType }
            : other,
        ),
      };
    }
    // Decision 071: the supplier never lists the IMEI (it is the IMEI parameter), so the service gets the field the forms take it in.
    const imei = imeiInputField(new Set(others.map((other) => other.key)));
    return { type, fields: [imei, ...others.map((other, index) => ({ ...other, sort: index + 1 }))] };
  }
  const field = mainInputField(main, {
    keys: new Set(others.map((other) => other.key)),
    names: new Set(others.map((other) => fieldNameKey(other.supplierKey))),
  });
  return { type: 'server', fields: [field, ...others.map((other, index) => ({ ...other, sort: index + 1 }))] };
}

/** A service an import would create, as the category choice reads it: the supplier service's name and the type it becomes ({@link importShape}). */
export interface CreatableItem {
  readonly name: string;
  readonly type: ImportableType;
}

/** The most supplier services a category refusal names; the message says how many more there are. */
export const MAX_NAMED_MISFITS = 10;

/**
 * Picks the new services that cannot go into a category chosen by staff.
 *
 * Why: decision 063 (B242): a category holds services of one type (`service_categories.type`, the composite key of `services`), so a category
 * picked for an import must have the type of every service the import creates; a service of another type has no place in it.
 *
 * @param items the services the import would create, in the order the request gave them
 * @param category the picked category
 * @returns the items whose type is not the category's, in the same order (empty when every one fits)
 */
export function categoryMisfits(items: readonly CreatableItem[], category: { readonly type: string }): CreatableItem[] {
  return items.filter((item) => item.type !== category.type);
}

/**
 * Words the refusal of a category that does not fit.
 *
 * Why: decision 063: the console shows the sentence next to the category box; it names the supplier services that do not fit (at most
 * {@link MAX_NAMED_MISFITS}, then a count) so staff can unpick them or pick another category.
 *
 * @param category the picked category
 * @param misfits the services that do not fit ({@link categoryMisfits}); at least one
 * @returns one English sentence, no HTML
 */
export function categoryMismatchMessage(
  category: { readonly name: string; readonly type: string },
  misfits: readonly CreatableItem[],
): string {
  const named = misfits.slice(0, MAX_NAMED_MISFITS).map((item) => `"${item.name}" (${item.type})`);
  const more = misfits.length - named.length;
  const list = more > 0 ? `${named.join(', ')} and ${more} more` : named.join(', ');
  return (
    `The category "${category.name}" holds ${category.type} services only; these supplier services would be another type: ${list}. ` +
    "Pick a category of the same type, or none to use the supplier's group."
  );
}
