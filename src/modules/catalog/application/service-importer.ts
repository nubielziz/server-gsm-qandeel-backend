// ServiceImporter: the catalog's writes for the supplier import of stage 6 (RESOLUTIONS orders-suppliers-10, catalog-9, B24): create a
// service (and its category and custom fields) from a supplier service, and set a service's cost. The suppliers module decides what
// to import and calls this inside its transaction; it never writes catalog tables itself.
import { Inject, Injectable } from '@nestjs/common';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { CLOCK, type Clock } from '../../../common/clock';
import { fieldNameKey } from '../../../common/field-names';
import type { DbExecutor } from '../../../infra/db';
import {
  type ServiceFieldType,
  type ServiceStatus,
  type ServiceType,
  serviceCategories,
  serviceFields,
  services,
} from '../db/schema';
import { cleanGroupName, groupLookupName } from '../domain/category-name';
import { type QuantityRule, quantityRuleProblems } from '../domain/quantity-rule';
import { deliveryTimeText } from '../domain/service-figures';
import {
  categoriesByTypeAndName,
  insertCategoryRow,
  lockCategoryRow,
  nextCategorySort,
} from '../infra/category.repository';
import { restampRetailFollow } from '../infra/retail-price-rule.repository';
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
  /** The supplier's group text as stored: the category is found by it, else by its cleaned name, else made under the cleaned name (`Imported` when empty). */
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
    /** The field's Name (decision 065): what the supplier receives in CUSTOMFIELD; unique in the service ignoring letter case. */
    readonly supplierKey: string;
    /** The field is the supplier's main box: its value travels as the Dhru `IMEI` parameter (decision 065). At most one per service. */
    readonly isMainInput: boolean;
    /** The pattern a value must match, `''` for none (the supplier's main box has one: decision 042). */
    readonly regex: string;
  }>;
}

/** A new service's type and supplier group text, as {@link ServiceImporter.categoriesForGroups} reads them. */
export interface GroupOfService {
  readonly type: ServiceType;
  /** The supplier's group text as stored (`supplier_services.remote_group`). */
  readonly group: string;
}

/**
 * The category `create` puts a new service in: the category it finds (`id` set), or the name it makes one under (`id` `null`: no
 * category of that type has the name yet).
 */
export interface GroupCategory {
  readonly id: number | null;
  readonly name: string;
}

/** The supplier's main box to put first on an IMEI service (decisions 042 and 065): a required text field flagged as the main input. */
export interface AdoptedField {
  readonly key: string;
  readonly label: string;
  readonly fieldType: ServiceFieldType;
  readonly options: string[];
  readonly required: boolean;
  /** The field's Name: never sent (the box travels as `IMEI`), but unique in the service ignoring letter case. */
  readonly supplierKey: string;
  /** True for the box (what `mainInputField` makes); `adoptMainInput` always writes the field as the service's main input. */
  readonly isMainInput: boolean;
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
 * The category of a new service is found by the supplier's raw group text, then by the cleaned name (`cleanGroupName`), and created under
 * the cleaned name when neither exists (plan 31 section 3.5).
 *
 * Side effects: inserts `service_categories` (when the group has none yet), `services` and `service_fields`; updates
 * `services.cost`; the adoption updates `services` (type and category), `service_fields` and the time on the service's
 * `retail_price_follows` row and writes a `catalog.services_changed` outbox event; `requireFields` updates
 * `service_fields.required`. No audit row: the supplier module's use case writes them.
 */
@Injectable()
export class ServiceImporter {
  constructor(
    private readonly signals: CatalogSignals,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

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
    const category = await this.categoryForGroup(tx, input.type, input.group);
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
          isMainInput: field.isMainInput,
        })),
      );
    }
    return { serviceId: service.id, code, categoryCreated: category.created };
  }

  /**
   * Tells, without writing anything, which category `create` would put each new service in.
   *
   * Why: decision 063: the preview of a supplier import names the category of every new service exactly. The lookups are the ones
   * `create` makes (the raw group text, then the cleaned name, by type and name ignoring case), so the preview names the category the
   * import finds, or the cleaned name it would make one under. Two services of one group get the same answer, as the import puts them
   * in one category. A category made or renamed between the preview and the import is the import's to see.
   *
   * Side effects: none (one read of `service_categories`).
   *
   * @param db the database or a transaction
   * @param wanted the type and the supplier group of each new service (at most the 500 services of a request)
   * @returns one answer per entry of `wanted`, in its order
   */
  async categoriesForGroups(db: DbExecutor, wanted: readonly GroupOfService[]): Promise<GroupCategory[]> {
    const names = wanted.map(({ type, group }) => ({
      type,
      raw: groupLookupName(group),
      cleaned: cleanGroupName(group),
    }));
    // Two lookups per service, in the order `create` makes them: lookup 2n is the raw text, 2n + 1 the cleaned name.
    const hits = await categoriesByTypeAndName(
      db,
      names.flatMap(({ type, raw, cleaned }) => [
        { type, name: raw },
        { type, name: cleaned },
      ]),
    );
    const byLookup = new Map(hits.map((hit) => [hit.lookup, hit]));
    return names.map(({ cleaned }, index) => {
      const hit = byLookup.get(2 * index) ?? byLookup.get(2 * index + 1);
      return hit === undefined ? { id: null, name: cleaned } : { id: hit.id, name: hit.name };
    });
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
   * The move can put a following retail price under another rule with nobody watching (plan 31 correction 3), so the follow row's
   * `applied_at` becomes the moment of the move: the follow pass then proposes the new rule's price, even when staff edited that rule
   * after the price was last set, instead of writing it at once.
   *
   * Side effects: locks the service row; may insert `service_categories`; updates `services` (type, category), `service_fields` (sorts,
   * one new row) and `retail_price_follows.applied_at`; inserts one `catalog.services_changed` outbox event (reason `service`).
   *
   * @param tx the sync's transaction
   * @param input the service and the field to put first
   * @returns what changed, or `null` when the service is not adoptable any more (archived, not `imei`, already has a main-input field,
   *   or already has a field with that key or that Name, ignoring letter case): nothing is written then
   */
  async adoptMainInput(
    tx: DbExecutor,
    input: { readonly serviceId: number; readonly field: AdoptedField },
  ): Promise<AdoptedService | null> {
    const service = await lockLiveService(tx, input.serviceId);
    if (!service || service.type !== 'imei') return null;
    const fields = await listFieldRows(tx, service.id);
    // Decision 065: the box is the field flagged as the main input; a key or a Name (ignoring case) that is taken cannot be written
    // (the unique indexes would refuse it), so the service is left alone and the next sync reads it again.
    if (fields.some((field) => field.isMainInput)) return null;
    if (fields.some((field) => field.key === input.field.key)) return null;
    const wantedName = fieldNameKey(input.field.supplierKey);
    if (fields.some((field) => fieldNameKey(field.supplierKey) === wantedName)) return null;

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
    // Lock order: the service row (above), then the follow row.
    await restampRetailFollow(tx, service.id, this.clock.now());
    await insertFirstFieldRow(tx, service.id, {
      key: input.field.key,
      label: input.field.label,
      fieldType: input.field.fieldType,
      options: input.field.options,
      required: input.field.required,
      regex: input.field.regex,
      supplierKey: input.field.supplierKey,
      isMainInput: true,
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

  /**
   * The category of a new service from its supplier group: found by the raw group text, else by the cleaned name, else created under the
   * cleaned name (plan 31 section 3.5, "Category names").
   *
   * Why: the raw text comes first, which is the lookup this importer always made, so a group whose category an earlier import made under the
   * raw text (`&amp;` and all) keeps getting its services, and none are split between two categories. Only a category made from now on
   * carries the cleaned name; the picker's import and the quick add both come through here. The adoption of decision 042 does not: it
   * looks a category up by its exact name (`categoryFor`).
   */
  private async categoryForGroup(
    tx: DbExecutor,
    type: ServiceType,
    group: string,
  ): Promise<{ id: number; created: boolean }> {
    const byRaw = await this.findCategory(tx, type, groupLookupName(group));
    if (byRaw !== undefined) return { id: byRaw, created: false };
    return this.categoryFor(tx, type, cleanGroupName(group));
  }

  /** The id of the category of this type with this name (ignoring case), or `undefined`. */
  private async findCategory(tx: DbExecutor, type: ServiceType, name: string): Promise<number | undefined> {
    const [found] = await tx
      .select({ id: serviceCategories.id })
      .from(serviceCategories)
      .where(and(eq(serviceCategories.type, type), sql`lower(${serviceCategories.name}) = lower(${name})`))
      .limit(1);
    return found?.id;
  }

  /** The category of this type with this exact name (ignoring case), created when it does not exist (visible to all and on, unless told). */
  private async categoryFor(
    tx: DbExecutor,
    type: ServiceType,
    name: string,
    visibility: { readonly allowedGroupIds: number[]; readonly isActive: boolean } = {
      allowedGroupIds: [],
      isActive: true,
    },
  ): Promise<{ id: number; created: boolean }> {
    const found = await this.findCategory(tx, type, name);
    if (found !== undefined) return { id: found, created: false };
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
