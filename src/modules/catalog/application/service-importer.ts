// ServiceImporter: the catalog's writes for the supplier import of stage 6 (RESOLUTIONS orders-suppliers-10, catalog-9, B24): create a
// service (and its category and custom fields) from a supplier service, and set a service's cost. The suppliers module decides what
// to import and calls this inside its transaction; it never writes catalog tables itself.
import { Injectable } from '@nestjs/common';
import { and, eq, sql } from 'drizzle-orm';
import type { DbExecutor } from '../../../infra/db';
import { type ServiceFieldType, type ServiceType, serviceCategories, services } from '../db/schema';
import { deliveryTimeText } from '../domain/service-figures';
import { insertCategoryRow, nextCategorySort } from '../infra/category.repository';
import { findServiceByCode, insertServiceRow, replaceFieldRows } from '../infra/service.repository';

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
  readonly fields: ReadonlyArray<{
    readonly key: string;
    readonly label: string;
    readonly fieldType: ServiceFieldType;
    readonly options: string[];
    readonly required: boolean;
    readonly supplierKey: string;
  }>;
}

/** The longest delivery time text a service keeps. */
const MAX_DELIVERY_TEXT = 80;

/**
 * Writes imported services into the catalog.
 *
 * Why: orders-suppliers-10 (with B24 and catalog-9): a new item becomes an active, automatic, fixed-price service with the
 * `POST /admin/services` defaults, a category found or created by (type, name), the suggested price as `base_price` and the
 * supplier's custom fields as service fields. The caller recomputes the effective cost and moves the catalog price version
 * afterwards. A changed item only has its cost set here.
 *
 * Side effects: inserts `service_categories` (when the group has none yet), `services` and `service_fields`; updates
 * `services.cost`. No audit row: the import's use case writes one for the whole import.
 */
@Injectable()
export class ServiceImporter {
  /**
   * Creates a service from a supplier service.
   *
   * @param tx the import's transaction
   * @param input what the supplier service says
   * @returns the new service's id and the code it got
   */
  async create(tx: DbExecutor, input: ImportedServiceInput): Promise<{ serviceId: number; code: string }> {
    const categoryId = await this.categoryFor(
      tx,
      input.type,
      input.group.trim() === '' ? 'Imported' : input.group.trim(),
    );
    const code = await this.freeCode(tx, `IMP-${input.supplierServiceId}`);
    const service = await insertServiceRow(tx, {
      categoryId,
      type: input.type,
      name: input.name,
      deliveryTime:
        input.time.trim() === '' ? deliveryTimeText(input.slaMinutes) : input.time.trim().slice(0, MAX_DELIVERY_TEXT),
      status: 'active',
      fulfillment: 'auto',
      priceMode: 'fixed',
      duplicateRule: 'block_open',
      basePrice: input.basePrice,
      cost: input.cost,
      effectiveCost: input.cost,
      code,
      slaMinutes: input.slaMinutes,
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
          regex: '',
          supplierKey: field.supplierKey,
        })),
      );
    }
    return { serviceId: service.id, code };
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

  /** The category of this type with this name (ignoring case), created when it does not exist. */
  private async categoryFor(tx: DbExecutor, type: ServiceType, name: string): Promise<number> {
    const [found] = await tx
      .select({ id: serviceCategories.id })
      .from(serviceCategories)
      .where(and(eq(serviceCategories.type, type), sql`lower(${serviceCategories.name}) = lower(${name})`))
      .limit(1);
    if (found) return found.id;
    const created = await insertCategoryRow(tx, {
      name,
      type,
      allowedGroupIds: [],
      sort: await nextCategorySort(tx),
      isActive: true,
    });
    return created.id;
  }

  /** The first free code from `base`, `base-2`, `base-3`, ... (case-insensitive, live services only). */
  private async freeCode(tx: DbExecutor, base: string): Promise<string> {
    for (let n = 1; ; n += 1) {
      const code = n === 1 ? base : `${base}-${n}`;
      if (!(await findServiceByCode(tx, code))) return code;
    }
  }
}
