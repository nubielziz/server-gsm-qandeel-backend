// The rules of the supplier import (resolutions orders-suppliers-10, catalog-9): what a picked supplier service becomes in our
// catalog, how its custom fields map to ours and what the item costs. Pure (the suggested price needs the catalog's default minimum profit: the use case computes it).
import { Money } from '../../../common/money';
import { linkUnitCost } from './link-selection';

/** What an item of the import is, compared with the service already linked to it. */
export type ImportState = 'new' | 'matching' | 'changed';

/** The service (if any) a supplier service is linked to. */
export interface LinkedService {
  readonly serviceId: number;
  readonly name: string;
  /** `services.cost` (not the effective cost). */
  readonly cost: string;
  readonly archived: boolean;
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

/** The service types an import can create (`SERVICE_TYPES`). */
const IMPORTABLE_TYPES = ['imei', 'server', 'remote', 'file'] as const;

/**
 * The service type a supplier's type name stands for.
 *
 * @param supplierType the supplier's own type name (`IMEI`, `Server`, ...)
 * @returns the type, or `undefined` when it is not one of imei, server, remote or file
 */
export function importableType(supplierType: string): (typeof IMPORTABLE_TYPES)[number] | undefined {
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
}

function text(value: unknown): string {
  return typeof value === 'string' ? value.trim() : typeof value === 'number' ? String(value) : '';
}

/**
 * Turns the supplier's `Requires.Custom` list into our service fields.
 *
 * Why: orders-suppliers-10: fields come from the supplier's custom fields, `supplier_key` is the supplier's field name. The key
 * is the field name in lower snake case (unique within the service: a repeat gets `_2`, `_3`, ...), the type follows the supplier's
 * `fieldtype` (`dropdown` and `select` become `select`, `number`/`numeric` and `textarea` are kept, anything else is `text`).
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
    if (name === '') continue;
    const base =
      name
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '_')
        .replace(/^_+|_+$/g, '')
        .slice(0, 60) || 'field';
    let key = base;
    for (let n = 2; used.has(key); n += 1) key = `${base}_${n}`;
    used.add(key);
    const rawType = text(field.fieldtype).toLowerCase();
    const fieldType =
      rawType === 'dropdown' || rawType === 'select'
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
    const requiredText = text(field.required).toLowerCase();
    fields.push({
      key,
      label: text(field.description) || name,
      fieldType,
      options,
      required: field.required === true || requiredText === '1' || requiredText === 'yes' || requiredText === 'true',
      supplierKey: name,
      sort: fields.length,
    });
  }
  return fields;
}
