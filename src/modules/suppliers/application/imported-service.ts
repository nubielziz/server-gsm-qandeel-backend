// Creates one catalog service from one supplier service: the part the picker's import and the quick add (feature 26) share, so both
// copy the same fields, price, SLA, quantity rule and first link.
import { Money } from '../../../common/money';
import type { DbExecutor } from '../../../infra/db';
import { type ServiceImporter, defaultMinProfit } from '../../catalog';
import type { SupplierImportServiceStatus, SupplierService } from '../db/schema';
import { importShape } from '../domain/import-plan';
import { slaMinutesOf } from '../domain/sla-time';
import { supplierQuantityRule } from '../domain/supplier-quantity';
import { insertFirstLink } from '../infra/supplier-catalogue.repository';

/** The setting that gives an imported service an SLA when the supplier's time text cannot be read (orders-suppliers-10). */
export const IMPORT_DEFAULT_SLA_KEY = 'catalog.importDefaultSlaMinutes';
/** The SLA an imported service gets when the setting is missing: one day. */
export const DEFAULT_IMPORT_SLA_MINUTES = 1440;
/** The accepted range of the setting {@link IMPORT_DEFAULT_SLA_KEY}, in minutes. */
export const SLA_BOUNDS = { min: 1, max: 525_600 } as const;

/** What {@link createImportedService} needs to make one service. */
export interface ImportedServiceArgs {
  /** The supplier service; its type must be importable (`importShape(row).type`). */
  readonly row: SupplierService;
  /** What the supplier charges: `credit x credit_rate`, in USD. */
  readonly cost: Money;
  /** The SLA in minutes when the supplier's time text cannot be read (`catalog.importDefaultSlaMinutes`). */
  readonly defaultSla: number;
  /** The state the service starts in. */
  readonly status: SupplierImportServiceStatus;
  /** The quick add run that creates the service (written on its first link); omitted for the picker's import. */
  readonly importRunId?: number | null | undefined;
}

/** What {@link createImportedService} made. */
export interface ImportedServiceResult {
  readonly serviceId: number;
  /** True when the service's category did not exist and was created for it. */
  readonly categoryCreated: boolean;
  /** True when the service started with a quantity rule other than one per order (feature 25). */
  readonly withQuantity: boolean;
}

/**
 * The suggested price of an item: its cost plus the default minimum profit.
 *
 * Why: catalog-9: at least 0.02 above cost; the import preview shows it and the import stores it as the service's price.
 *
 * @param cost the item's cost in USD
 * @returns the cost plus the default minimum profit
 */
export const suggestedPrice = (cost: Money): Money => cost.add(defaultMinProfit(cost));

/**
 * Creates the catalog service of a supplier service and links it at priority 1.
 *
 * Why: orders-suppliers-10 and B213: a new item becomes a service with the `POST /admin/services` defaults, the category of its type and
 * group, the suggested price, the supplier's custom fields and the supplier's quantity rule, written at creation only. The type and the
 * fields are `importShape`'s: an IMEI service whose main box is not an IMEI is a `server` service with that box first (decision 042). The picker's
 * import (always `active`) and the quick add (`active` or `disabled`) both come here.
 *
 * Side effects: inserts `service_categories` (when the group has none yet), `services`, `service_fields` and `service_supplier_links`
 * (with `import_run_id` when a quick add run makes it) on the caller's transaction. The caller recomputes the effective cost, moves the catalog price version and writes the audit row.
 *
 * @param tx the transaction (the supplier row is locked)
 * @param importer the catalog's importer
 * @param args the supplier service, its cost, the default SLA, the starting state and the quick add run that makes it
 * @returns the new service's id and what the creation did besides it
 * @throws {Error} when the supplier service's type is not importable (the caller checks first), or the database refuses a row
 */
export async function createImportedService(
  tx: DbExecutor,
  importer: ServiceImporter,
  args: ImportedServiceArgs,
): Promise<ImportedServiceResult> {
  const { row, cost, defaultSla, status, importRunId = null } = args;
  // An IMEI service whose main box is not an IMEI becomes a server service with that box first (decision 042).
  const { type, fields } = importShape(row);
  if (type === undefined)
    throw new Error(`The supplier service ${row.id} has a type that cannot be imported: ${row.type}.`);
  // The supplier's rule is copied here, at creation only; a later import or sync never touches the quantities (B213).
  const quantity = supplierQuantityRule(row.raw);
  const made = await importer.create(tx, {
    supplierServiceId: row.id,
    type,
    name: row.name,
    group: row.remoteGroup,
    time: row.time,
    cost: cost.toWire(),
    basePrice: suggestedPrice(cost).toWire(),
    slaMinutes: slaMinutesOf(row.time, defaultSla),
    quantity,
    fields,
    status,
  });
  await insertFirstLink(tx, made.serviceId, row.id, importRunId);
  return {
    serviceId: made.serviceId,
    categoryCreated: made.categoryCreated,
    withQuantity: quantity.minQty !== 1 || quantity.maxQty !== 1 || quantity.qtyOptions.length > 0,
  };
}
