// ServiceImporter: the catalog's writes for the supplier import of stage 6 (RESOLUTIONS orders-suppliers-10, catalog-9, B24): create a
// service (and its category and custom fields) from a supplier service, and set a service's cost. The suppliers module decides what
// to import and calls this inside its transaction; it never writes catalog tables itself.
import { Injectable } from '@nestjs/common';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { isMainInputKey, resolvedSupplierKey } from '../../../common/dhru';
import type { DbExecutor } from '../../../infra/db';
import {
  type ServiceFieldType,
  type ServiceStatus,
  type ServiceType,
  serviceCategories,
  serviceFields,
  services,
} from '../db/schema';
import { type QuantityRule, quantityRuleProblems } from '../domain/quantity-rule';
import { deliveryTimeText } from '../domain/service-figures';
import { insertCategoryRow, lockCategoryRow, nextCategorySort } from '../infra/category.repository';
import {
  findServiceByCode,
  insertFirstFieldRow,
  insertServiceRow,
  listFieldRows,
  lockLiveService,
  replaceFieldRows,
  updateServiceRow,
} from '../infra/service.repository';
import { CatalogSignals } from './catalog-signals';

/** A supplier service to bring into the catalog as a new service. */
export interface ImportedServiceInput {
  /** The supplier service's id: the service's code is `IMP-<id>` (then `-2`, `-3`, ... on a collision). */
  readonly supplierServiceId: number;
  readonly type: ServiceType;
  readonly name: string;
  /** The supplier's group name: the category's name (`Imported` when empty). */
  readonly group: string;
  /** The supplier's delivery time text, kept as the service's `delivery_time`. */
  readonly time: string;
  /** What the supplier charges for one unit, in USD (4 decimals). */
  readonly cost: string;
  /** The suggested price: the effective cost plus the default minimum profit (catalog-9). */
  readonly basePrice: string;
  readonly slaMinutes: number;
  /** The quantity rule the service starts with (feature 25): the supplier's, already normalised by the suppliers module. */
  readonly quantity: QuantityRule;
  /** The state the service starts in: `active` when omitted (the import's rule); the supplier quick add may ask for `disabled` (feature 26). */
  readonly status?: ServiceStatus;
  readonly fields: ReadonlyArray<{
    readonly key: string;
    readonly label: string;
    readonly fieldType: ServiceFieldType;
    readonly options: string[];
    readonly required: boolean;
    readonly supplierKey: string;
    /** The pattern a value must match, `''` for none (the supplier's main box has one: decision 042). */
    readonly regex: string;
  }>;
}

/** The supplier's main box to put first on an IMEI service (decision 042): a required text field sent to the supplier as `IMEI`. */
export interface AdoptedField {
  readonly key: string;
  readonly label: string;
  readonly fieldType: ServiceFieldType;
  readonly options: string[];
  readonly required: boolean;
  readonly supplierKey: string;
  readonly regex: string;
}

/** What {@link ServiceImporter.adoptMainInput} changed. */
export interface AdoptedService {
  readonly serviceId: number;
  /** The service's name, for the audit row. */
  readonly name: string;
  readonly before: { readonly type: ServiceType; readonly categoryId: number };
  readonly after: { readonly type: ServiceType; readonly categoryId: number };
  /** True when the `server` category of the same name did not exist and was created. */
  readonly categoryCreated: boolean;
}

/** The longest delivery time text a service keeps. */
const MAX_DELIVERY_TEXT = 80;

/**
 * Writes imported services into the catalog.
 *
 * Why: orders-suppliers-10 (with B24 and catalog-9): a new item becomes an active, automatic, fixed-price service with the
 * `POST /admin/services` defaults, a category found or created by (type, name), the suggested price as `base_price` and the
 * supplier's custom fields as service fields. It also starts with the quantity rule the supplier states (feature 25, B213), written
 * at creation only: a later import or sync never touches a service's quantities. The service starts `active` unless the caller asks
 * for `disabled` (the supplier quick add, feature 26). The caller recomputes the effective cost and
 * moves the catalog price version afterwards. A changed item only has its cost set here.
 *
 * It also adopts the supplier's main box on a service made before decision 042 (`adoptMainInput`) and makes the fields its supplier
 * requires required (`requireFields`), both for the supplier sync (feature 33).
 *
 * Side effects: inserts `service_categories` (when the group has none yet), `services` and `service_fields`; updates
 * `services.cost`; the adoption updates `services` (type and category) and `service_fields` and writes a `catalog.services_changed`
 * outbox event; `requireFields` updates `service_fields.required`. No audit row: the supplier module's use case writes them.
 */
@Injectable()
export class ServiceImporter {
  constructor(private readonly signals: CatalogSignals) {}

  /**
   * Creates a service from a supplier service.
   *
   * @param tx the import's transaction
   * @param input what the supplier service says
   * @returns the new service's id, the code it got and whether its category had to be created
   * @throws {Error} when `input.quantity` breaks the quantity rule (a programming error: the caller normalises it)
   */
  async create(
    tx: DbExecutor,
    input: ImportedServiceInput,
  ): Promise<{ serviceId: number; code: string; categoryCreated: boolean }> {
    const problems = quantityRuleProblems(input.quantity);
    if (problems.length > 0) throw new Error(`The imported quantity rule is invalid: ${problems.join('; ')}`);
    const category = await this.categoryFor(
      tx,
      input.type,
      input.group.trim() === '' ? 'Imported' : input.group.trim(),
    );
    const code = await this.freeCode(tx, `IMP-${input.supplierServiceId}`);
    const service = await insertServiceRow(tx, {
      categoryId: category.id,
      type: input.type,
      name: input.name,
      deliveryTime:
        input.time.trim() === '' ? deliveryTimeText(input.slaMinutes) : input.time.trim().slice(0, MAX_DELIVERY_TEXT),
      status: input.status ?? 'active',
      fulfillment: 'auto',
      priceMode: 'fixed',
      duplicateRule: 'block_open',
      basePrice: input.basePrice,
      cost: input.cost,
      effectiveCost: input.cost,
      code,
      slaMinutes: input.slaMinutes,
      minQty: input.quantity.minQty,
      maxQty: input.quantity.maxQty,
      qtyOptions: input.quantity.qtyOptions,
    });
    if (input.fields.length > 0) {
      await replaceFieldRows(
        tx,
        service.id,
        input.fields.map((field) => ({
          key: field.key,
          label: field.label,
          fieldType: field.fieldType,
          options: field.options,
          required: field.required,
          regex: field.regex,
          supplierKey: field.supplierKey,
        })),
      );
    }
    return { serviceId: service.id, code, categoryCreated: category.created };
  }

  /**
   * Sets a service's cost (the supplier's price changed).
   *
   * @param tx the import's transaction
   * @param serviceId the service
   * @param cost the new cost in USD, 4 decimals
   */
  async setCost(tx: DbExecutor, serviceId: number, cost: string): Promise<void> {
    await tx.update(services).set({ cost }).where(eq(services.id, serviceId));
  }

  /**
   * Makes an IMEI service a `server` service whose first field is the supplier's main box.
   *
   * Why: decision 042 (feature 33): a service imported before the decision from a supplier service whose main box is not an IMEI (an
   * ECID, a serial number) is an `imei` service that refuses every value its supplier takes. The supplier sync adopts it: the type
   * becomes `server`, the category the `server` category with the same name (created when missing, as `create` does), and the box the
   * first field (the other fields keep their keys and move down by one). Nothing else of the service changes: price, cost, status,
   * quantity, SLA, links and listing stay. Like a staff edit of a service's category (`PATCH /admin/services/:id`), it writes the
   * search index's change event; the caller moves the catalog price version after the commit and writes the audit row.
   *
   * Side effects: locks the service row; may insert `service_categories`; updates `services` (type, category) and `service_fields`
   * (sorts, one new row); inserts one `catalog.services_changed` outbox event (reason `service`).
   *
   * @param tx the sync's transaction
   * @param input the service and the field to put first
   * @returns what changed, or `null` when the service is not adoptable any more (archived, not `imei`, already has a field whose
   *   supplier key, or key when that is empty, is `IMEI` in any case, or already has a field with that key): nothing is written then
   */
  async adoptMainInput(
    tx: DbExecutor,
    input: { readonly serviceId: number; readonly field: AdoptedField },
  ): Promise<AdoptedService | null> {
    const service = await lockLiveService(tx, input.serviceId);
    if (!service || service.type !== 'imei') return null;
    const fields = await listFieldRows(tx, service.id);
    // The dispatcher's rule (`resolvedSupplierKey`): a field whose supplier key, or key when that is empty, is `IMEI` is already the box.
    if (fields.some((field) => isMainInputKey(resolvedSupplierKey(field)))) return null;
    if (fields.some((field) => field.key === input.field.key)) return null;

    const [current] = await tx
      .select({
        name: serviceCategories.name,
        allowedGroupIds: serviceCategories.allowedGroupIds,
        isActive: serviceCategories.isActive,
      })
      .from(serviceCategories)
      .where(eq(serviceCategories.id, service.categoryId))
      .limit(1);
    // A category made for the move copies the old one's switch and groups, so the merchants who see the service stay the same.
    const category = await this.categoryFor(tx, 'server', current!.name, {
      allowedGroupIds: current!.allowedGroupIds,
      isActive: current!.isActive,
    });
    // The same lock a staff edit takes on the target category, so its type cannot change under the move (catalog-13).
    await lockCategoryRow(tx, category.id, 'share');
    // Type and category in one statement: the composite key `services_category_type_fk` sees them agree.
    await updateServiceRow(tx, service.id, { type: 'server', categoryId: category.id });
    await insertFirstFieldRow(tx, service.id, {
      key: input.field.key,
      label: input.field.label,
      fieldType: input.field.fieldType,
      options: input.field.options,
      required: input.field.required,
      regex: input.field.regex,
      supplierKey: input.field.supplierKey,
    });
    // The shop's search holds the category and the type's form (feature 29), as after a staff edit.
    await this.signals.servicesChanged(tx, [service.id], 'service');
    return {
      serviceId: service.id,
      name: service.name,
      before: { type: service.type, categoryId: service.categoryId },
      after: { type: 'server', categoryId: category.id },
      categoryCreated: category.created,
    };
  }

  /**
   * Makes some of a service's fields required.
   *
   * Why: feature 33 (second review round): the import read a Dhru Fusion site's `"required": "on"` as optional, so buyers could leave
   * out what the supplier demands and the supplier refused the order. The supplier sync repairs the services made before: only
   * `required` changes (label, type, options, pattern, sort and key stay), and a field is never made optional here. Like a staff save of
   * the fields (`PUT /admin/services/:id/fields`), it writes nothing for the shop or the search index: neither holds a field's
   * `required`.
   *
   * Side effects: locks the service row; updates `service_fields.required`. No audit row: the caller writes it.
   *
   * @param tx the sync's transaction
   * @param input the service and the keys of the fields to make required
   * @returns the keys that changed, in the service's field order (empty when the service is archived or gone, or every field already
   *   was required)
   */
  async requireFields(
    tx: DbExecutor,
    input: { readonly serviceId: number; readonly keys: readonly string[] },
  ): Promise<string[]> {
    if (input.keys.length === 0) return [];
    const service = await lockLiveService(tx, input.serviceId);
    if (!service) return [];
    const wanted = new Set(input.keys);
    const optional = (await listFieldRows(tx, service.id)).filter((field) => !field.required && wanted.has(field.key));
    if (optional.length === 0) return [];
    await tx
      .update(serviceFields)
      .set({ required: true })
      .where(
        and(
          eq(serviceFields.serviceId, service.id),
          inArray(
            serviceFields.id,
            optional.map((field) => field.id),
          ),
        ),
      );
    return optional.map((field) => field.key);
  }

  /** The category of this type with this name (ignoring case), created when it does not exist (visible to all and on, unless told). */
  private async categoryFor(
    tx: DbExecutor,
    type: ServiceType,
    name: string,
    visibility: { readonly allowedGroupIds: number[]; readonly isActive: boolean } = {
      allowedGroupIds: [],
      isActive: true,
    },
  ): Promise<{ id: number; created: boolean }> {
    const [found] = await tx
      .select({ id: serviceCategories.id })
      .from(serviceCategories)
      .where(and(eq(serviceCategories.type, type), sql`lower(${serviceCategories.name}) = lower(${name})`))
      .limit(1);
    if (found) return { id: found.id, created: false };
    const created = await insertCategoryRow(tx, {
      name,
      type,
      allowedGroupIds: visibility.allowedGroupIds,
      sort: await nextCategorySort(tx),
      isActive: visibility.isActive,
    });
    return { id: created.id, created: true };
  }

  /** The first free code from `base`, `base-2`, `base-3`, ... (case-insensitive, live services only). */
  private async freeCode(tx: DbExecutor, base: string): Promise<string> {
    for (let n = 1; ; n += 1) {
      const code = n === 1 ? base : `${base}-${n}`;
      if (!(await findServiceByCode(tx, code))) return code;
    }
  }
}
