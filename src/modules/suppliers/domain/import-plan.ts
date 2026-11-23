// The rules of the supplier import (resolutions orders-suppliers-10, catalog-9, decision 042): what a picked supplier service becomes in our
// catalog, how its custom fields map to ours and what the item costs. Pure (the suggested price needs the catalog's default minimum profit: the use case computes it).
import { MAIN_INPUT_SUPPLIER_KEY, resolvedSupplierKey } from '../../../common/dhru';
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
  readonly key: string;
  readonly label: string;
  readonly fieldType: 'text' | 'number' | 'select' | 'textarea';
  readonly options: string[];
  readonly required: boolean;
  readonly supplierKey: string;
  readonly sort: number;
  /** The pattern a value must match; `''` for none (a field of `Requires.Custom` has none). */
  readonly regex: string;
}

function text(value: unknown): string {
  return typeof value === 'string' ? value.trim() : typeof value === 'number' ? String(value) : '';
}

/** A field key from a name: lower snake case, at most 60 characters, `field` when nothing is left. */
function keyBase(name: string): string {
  return (
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '_')
      .replace(/^_+|_+$/g, '')
      .slice(0, 60) || 'field'
  );
}

/** The first of `base`, `base_2`, `base_3`, ... that `used` does not hold. */
function freeKey(base: string, used: ReadonlySet<string>): string {
  let key = base;
  for (let n = 2; used.has(key); n += 1) key = `${base}_${n}`;
  return key;
}

/**
 * The service field of a supplier's main box.
 *
 * Why: decision 042: the box becomes the first required text field of a `server` service with the supplier key `IMEI`, so every channel
 * draws and checks it like any field and the dispatcher sends it as `IMEI`. Its pattern is `^.{min,max}$` from the lengths when the
 * supplier gives a maximum, else none; the supplier's own `regex` is never copied (staff can type one on the field).
 *
 * @param main the box as {@link supplierMainInput} reads it
 * @param usedKeys the keys the service's other fields hold (the key gets `_2`, `_3`, ... on a clash)
 * @returns the field, with `sort` 0
 */
export function mainInputField(main: SupplierMainInput, usedKeys: ReadonlySet<string>): ImportedField {
  // Only a pattern we build from the lengths: the supplier's own `regex` is untrusted (decision 042, review of feature 33).
  const regex = main.maxLength !== null ? `^.{${main.minLength},${main.maxLength}}$` : '';
  return {
    key: freeKey(keyBase(main.label), usedKeys),
    label: main.label,
    fieldType: 'text',
    options: [],
    required: true,
    supplierKey: MAIN_INPUT_SUPPLIER_KEY,
    sort: 0,
    regex,
  };
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
 * Why: orders-suppliers-10 and feature 33: fields come from the supplier's custom fields, `supplier_key` is the supplier's field name.
 * The key is the field name in lower snake case (unique within the service: a repeat gets `_2`, `_3`, ...), the type follows the
 * supplier's `fieldtype` (`dropdown`, `select` and `radio` become `select` with the `fieldoptions` as options, `number`/`numeric` and
 * `textarea` are kept, anything else is `text`), `required` is {@link isSupplierFlagOn}, and a field the supplier marks `adminonly`
 * (its own staff fill it, not the buyer) is left out. The supplier's `regexpr` is never used (decision 042: untrusted).
 *
 * @param customFields the supplier service's custom field descriptions
 * @returns the fields to create, in the supplier's order
 */
export function importedFields(customFields: readonly unknown[]): ImportedField[] {
  const used = new Set<string>();
  const fields: ImportedField[] = [];
  for (const entry of customFields) {
    if (typeof entry !== 'object' || entry === null) continue;
    const field = entry as Record<string, unknown>;
    const name = text(field.fieldname);
    if (name === '' || isSupplierFlagOn(field.adminonly)) continue;
    const key = freeKey(keyBase(name), used);
    used.add(key);
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
      label: text(field.description) || name,
      fieldType,
      options,
      required: isSupplierFlagOn(field.required),
      supplierKey: name,
      sort: fields.length,
      regex: '',
    });
  }
  return fields;
}

/** A service field as {@link fieldsToRequire} reads it. */
export interface RequirableField {
  readonly key: string;
  readonly supplierKey: string;
  readonly required: boolean;
}

/**
 * The fields of a service made before feature 33 that its supplier requires but that the import made optional.
 *
 * Why: feature 33 (second review round): every `"required": "on"` field was imported as optional, so buyers could leave out what the
 * supplier demands. A field matches a supplier field when its supplier name (`resolvedSupplierKey`: the link's field map, else the
 * supplier key, else the key) equals that field's `fieldname`, exactly first, then without case and with spaces trimmed. Only optional
 * fields are listed: a field is never made optional here. A supplier field marked `adminonly` is not the buyer's.
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
      if (field.required) return false;
      const name = resolvedSupplierKey(field, fieldMap[field.key]);
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
 * A `server`, `remote` or `file` supplier service is never changed by `CUSTOM`.
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
  if (main === null) return { type, fields: others };
  const field = mainInputField(main, new Set(others.map((other) => other.key)));
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
