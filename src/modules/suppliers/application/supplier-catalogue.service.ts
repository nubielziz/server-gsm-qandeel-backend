// SupplierCatalogueService: the use cases about a supplier's own services and how they meet our catalog (stage 6): list the synced
// services, preview and run the import, and read and replace the supplier chain of a service (resolutions orders-suppliers-10,
// catalog-9, B24; the read: decision 060).
import { Injectable } from '@nestjs/common';
import type { ParsedListQuery } from '../../../common/contract';
import { AppError } from '../../../common/errors';
import { type DbExecutor, DbService } from '../../../infra/db';
import { CatalogPriceVersion, type GroupCategory, ServiceImporter, recomputeEffectiveCost } from '../../catalog';
import { AuditService, SettingsReader } from '../../platform';
import type { SupplierImportServiceStatus, SupplierService } from '../db/schema';
import {
  type CreatableItem,
  categoryMisfits,
  categoryMismatchMessage,
  classifyImportItem,
  importShape,
  importableType,
  quantityDiffers,
} from '../domain/import-plan';
import { supplierQuantityRule } from '../domain/supplier-quantity';
import {
  type CategoryChoice,
  categoryIdsOfServices,
  findCategoryChoice,
  lockLiveServiceRow,
  linkedServicesOf,
  liveServiceInfo,
} from '../infra/foreign-reads.repository';
import {
  type SupplierServiceListField,
  chainsOf,
  listSupplierServiceRows,
  replaceChain,
  supplierServicesByIds,
  supplierServicesWithSupplier,
} from '../infra/supplier-catalogue.repository';
import { findSupplier, lockSupplier } from '../infra/supplier.repository';
import {
  createImportedService,
  DEFAULT_IMPORT_SLA_MINUTES,
  IMPORT_DEFAULT_SLA_KEY,
  SLA_BOUNDS,
  suggestedPrice,
} from './imported-service';

/** One line of the import preview. */
export interface ImportPreviewItem {
  readonly supplierServiceId: number;
  readonly name: string;
  readonly type: string;
  readonly state: 'new' | 'matching' | 'changed';
  readonly serviceId: number | null;
  readonly serviceName: string | null;
  readonly cost: string;
  readonly previousCost: string | null;
  readonly suggestedPrice: string | null;
  /** The supplier's quantity rule as `supplierQuantityRule` reads it; for a `new` item, what the service will get. */
  readonly minQty: number;
  readonly maxQty: number;
  readonly qtyOptions: number[];
  /** A live linked service sells another rule than the supplier's (a `new` item and an archived link: false). */
  readonly quantityDiffers: boolean;
  /**
   * Decision 063: present only when the request carried `status` or `categoryId` (without them the item is what it always was). The state a
   * `new` item would be created in (`active` unless asked); `null` for an item the import would not create.
   */
  readonly status?: SupplierImportServiceStatus | null;
  /**
   * Decision 063: present together with `status`. The category a `new` item would go into, named exactly: the one staff picked, else
   * the one the importer finds for the supplier's group (by the group text, then by its cleaned name), else the cleaned name the import
   * makes a category under (`id` `null`: it does not exist yet). `null` for an item the import would not create.
   */
  readonly category?: GroupCategory | null;
}

/**
 * What staff may ask of an import beyond the picked services (decision 063, B242); without either key the import is what it always was.
 */
export interface ImportOptions {
  /** The state the new services start in; `active` when omitted. A `disabled` service is inserted disabled: it is never orderable. */
  readonly status?: SupplierImportServiceStatus | undefined;
  /** The category every new service goes into (of the same type as each of them); the category named after the supplier's group when omitted. */
  readonly categoryId?: number | undefined;
}

/** The state a new service starts in when staff do not say. */
export const DEFAULT_IMPORT_STATUS: SupplierImportServiceStatus = 'active';

/** A new service the import would create: what the category check reads, and the supplier service it comes from. */
interface Creatable extends CreatableItem {
  readonly row: SupplierService;
}

/** One step of a service's supplier chain, as the chain routes answer it. */
export interface ChainStepView {
  readonly priority: number;
  readonly supplierId: number;
  readonly supplierName: string;
  readonly supplierServiceId: number;
  readonly supplierServiceName: string;
}

/** What an import did: the counts, and the services this call created. */
export interface ImportOutcome {
  readonly created: number;
  readonly updated: number;
  readonly unchanged: number;
  /** The ids of the services this call created, in creation order (at most 500: one per picked item). */
  readonly createdServiceIds: number[];
}

/** A synced supplier service as the catalogue tab reads it. */
export interface SupplierServiceView {
  readonly id: number;
  readonly supplierId: number;
  readonly remoteId: string;
  readonly remoteGroup: string;
  readonly type: string;
  readonly name: string;
  readonly credit: string;
  readonly time: string;
  readonly isAvailable: boolean;
  readonly lastSeenAt: string | null;
  readonly priceChangedAt: string | null;
  readonly imported: boolean;
  readonly linkedServiceId: number | null;
}

const notFound = () => new AppError('NOT_FOUND', { detail: 'No supplier has this id.' });

function invalid(field: string, message: string, code = 'invalid'): AppError {
  return new AppError('VALIDATION_FAILED', { errors: [{ field, code, message }] });
}

const view = (service: SupplierService, imported: boolean, linkedServiceId: number | null): SupplierServiceView => ({
  id: service.id,
  supplierId: service.supplierId,
  remoteId: service.remoteId,
  remoteGroup: service.remoteGroup,
  type: service.type,
  name: service.name,
  credit: service.credit,
  time: service.time,
  isAvailable: service.isAvailable,
  lastSeenAt: service.lastSeenAt.toISOString(),
  priceChangedAt: service.priceChangedAt?.toISOString() ?? null,
  imported,
  linkedServiceId,
});

/**
 * Lists, imports and links supplier services.
 *
 * Why: orders-suppliers-10: an imported item becomes a service with the `POST /admin/services` defaults and the suggested price; a
 * changed item only updates the linked service's cost (and, through the effective cost, its floor), never its price. All catalog
 * writes go through the catalog's `ServiceImporter` and `recomputeEffectiveCost`; every change that can move what merchants pay
 * moves the catalog price version after the commit (user rule 9).
 *
 * Side effects: the import writes `service_categories`, `services`, `service_fields` and `service_supplier_links`; a chain change
 * writes `service_supplier_links` and `services.effective_cost`; both write `audit_logs` and move the catalog price version.
 */
@Injectable()
export class SupplierCatalogueService {
  constructor(
    private readonly db: DbService,
    private readonly importer: ServiceImporter,
    private readonly audit: AuditService,
    private readonly settings: SettingsReader,
    private readonly priceVersion: CatalogPriceVersion,
  ) {}

  /**
   * Lists the synced services of a supplier.
   *
   * @param supplierId the supplier
   * @param query the parsed list request
   * @returns the page and the exact total
   * @throws {AppError} `NOT_FOUND`
   */
  async listServices(
    supplierId: number,
    query: ParsedListQuery<SupplierServiceListField>,
  ): Promise<{ rows: SupplierServiceView[]; total: number }> {
    if (!(await findSupplier(this.db.db, supplierId))) throw notFound();
    const { rows, total } = await listSupplierServiceRows(this.db.db, supplierId, query);
    // `min(service_id)` is a bigint, which the driver reads as text.
    return {
      rows: rows.map((row) =>
        view(row.service, row.imported, row.linkedServiceId === null ? null : Number(row.linkedServiceId)),
      ),
      total,
    };
  }

  /**
   * Says what an import of the picked services would do, without changing anything.
   *
   * @param supplierId the supplier
   * @param ids the picked supplier services
   * @param options decision 063: the state and the category the new services would get; without either key the answer is what it always
   *   was, with one of them every item also says its `status` and `category`
   * @returns one item per picked service of this supplier, with the supplier's quantity rule and whether the linked service's differs
   * @throws {AppError} `NOT_FOUND`; `VALIDATION_FAILED` (422 on `categoryId`: no such category (`unknown`), or a new service would be
   *   another type than the category's (`kind_mismatch`, naming them))
   */
  async preview(
    supplierId: number,
    ids: readonly number[],
    options: ImportOptions = {},
  ): Promise<{ items: ImportPreviewItem[] }> {
    const supplier = await findSupplier(this.db.db, supplierId);
    if (!supplier) throw notFound();
    const picked = await supplierServicesByIds(this.db.db, supplierId, ids);
    const linked = await linkedServicesOf(
      this.db.db,
      picked.map((row) => row.id),
    );
    const lines = picked.map((row) => {
      const found = linked.get(row.id) ?? null;
      const { state, cost, previousCost } = classifyImportItem(row, supplier.creditRate, found);
      const rule = supplierQuantityRule(row.raw);
      // The supplier's type name, unless the import makes the service another type (decision 042: an IMEI service whose main box
      // is not an IMEI becomes a server service); the console shows the tag upper-cased either way.
      const shaped = importShape(row).type;
      const item: ImportPreviewItem = {
        supplierServiceId: row.id,
        name: row.name,
        type: shaped !== undefined && shaped !== importableType(row.type) ? shaped.toUpperCase() : row.type,
        state,
        serviceId: found?.serviceId ?? null,
        serviceName: found?.name ?? null,
        cost: cost.toWire(),
        previousCost: previousCost?.toWire() ?? null,
        suggestedPrice: state === 'matching' ? null : suggestedPrice(cost).toWire(),
        ...rule,
        quantityDiffers: quantityDiffers(found, rule),
      };
      return { row, item, newType: state === 'new' ? shaped : undefined };
    });
    if (options.status === undefined && options.categoryId === undefined)
      return { items: lines.map((line) => line.item) };

    // Decision 063: what the new services would get. An item the import would not create (matching, changed, or of a type it refuses)
    // has neither.
    const creatable: Creatable[] = lines.flatMap((line) =>
      line.newType === undefined ? [] : [{ row: line.row, name: line.row.name, type: line.newType }],
    );
    const status = options.status ?? DEFAULT_IMPORT_STATUS;
    const chosen =
      options.categoryId === undefined ? null : await this.pickedCategory(this.db.db, options.categoryId, creatable);
    // Without a pick, the catalog's importer says where it would put each new service: the same lookups as its `create`.
    const planned =
      chosen === null
        ? await this.importer.categoriesForGroups(
            this.db.db,
            creatable.map((item) => ({ type: item.type, group: item.row.remoteGroup })),
          )
        : [];
    const categoryOf = new Map<number, GroupCategory>(
      creatable.map((item, index): [number, GroupCategory] => [
        item.row.id,
        chosen === null ? planned[index]! : { id: chosen.id, name: chosen.name },
      ]),
    );
    return {
      items: lines.map(({ row, item }) => {
        const category = categoryOf.get(row.id);
        return category === undefined ? { ...item, status: null, category: null } : { ...item, status, category };
      }),
    };
  }

  /**
   * Imports the picked services: creates the new ones and updates the cost of the changed ones.
   *
   * Why: decision 063 (B242): staff may add the new services switched off, and into a category of their choice instead of the one named after
   * the supplier's group. A `disabled` service is inserted disabled, in the same transaction as everything else: it is never orderable, not
   * even for an instant. A picked category must have the type of every service the import creates (a category holds one type).
   *
   * @param supplierId the supplier
   * @param ids the picked supplier services
   * @param options `status` (`active` when omitted) and `categoryId` (the category of the supplier's group when omitted) for the services
   *   this call creates; they change nothing of an updated or unchanged item
   * @returns how many services were created, updated and left as they were, and the ids of the created ones in creation order
   *   (decision 060: the console prepares one publish run per call from them); a new service starts with the supplier's quantity
   *   rule (feature 25, B213), and the audit row `imported services from` also counts `createdWithQuantity` (and says `serviceStatus` and
   *   `categoryId` when the request carried them)
   * @throws {AppError} `NOT_FOUND`; `VALIDATION_FAILED` (422 on `supplierServiceIds`: none belongs to this supplier, or a new item
   *   has a type that is not imei, server, remote or file; 422 on `categoryId`: no such category (`unknown`), or a new service would be
   *   another type than the category's (`kind_mismatch`, naming them); nothing is imported then)
   */
  async import(supplierId: number, ids: readonly number[], options: ImportOptions = {}): Promise<ImportOutcome> {
    const defaultSla = await this.settings.integer(IMPORT_DEFAULT_SLA_KEY, DEFAULT_IMPORT_SLA_MINUTES, SLA_BOUNDS);
    const status = options.status ?? DEFAULT_IMPORT_STATUS;
    return this.db.runInTransaction(async (work) => {
      const { tx } = work;
      const supplier = await lockSupplier(tx, supplierId);
      if (!supplier) throw notFound();
      const picked = await supplierServicesByIds(tx, supplierId, ids);
      if (picked.length === 0) {
        throw invalid('supplierServiceIds', 'None of the picked services belongs to this supplier.', 'unknown');
      }
      const linked = await linkedServicesOf(
        tx,
        picked.map((row) => row.id),
      );
      const plan = picked.map((row) => ({
        row,
        found: linked.get(row.id) ?? null,
        shaped: importShape(row).type,
        ...classifyImportItem(row, supplier.creditRate, linked.get(row.id) ?? null),
      }));
      const refused = plan.filter((item) => item.state === 'new' && item.shaped === undefined);
      if (refused.length > 0) {
        const names = refused.map((item) => `"${item.row.name}" (${item.row.type})`).join(', ');
        throw invalid(
          'supplierServiceIds',
          `Only imei, server, remote and file services can be imported; not these: ${names}. Nothing was imported.`,
          'unsupported_type',
        );
      }
      // Decision 063: the picked category is read under a share lock (a rename or a type change waits for this transaction) and must fit
      // every service this call creates. Its lock comes after the supplier's, like every other lock of this use case.
      const creatable: Creatable[] = plan.flatMap((item) =>
        item.state === 'new' && item.shaped !== undefined
          ? [{ row: item.row, name: item.row.name, type: item.shaped }]
          : [],
      );
      const category =
        options.categoryId === undefined ? null : await this.pickedCategory(tx, options.categoryId, creatable, 'share');

      let created = 0;
      let createdWithQuantity = 0;
      let updated = 0;
      let unchanged = 0;
      const touched: number[] = [];
      const createdServiceIds: number[] = [];
      for (const item of plan) {
        if (item.state === 'matching') {
          unchanged += 1;
        } else if (item.state === 'new') {
          // The supplier's rule is copied at creation only; a later import or sync never touches the quantities (B213).
          const made = await createImportedService(tx, this.importer, {
            row: item.row,
            cost: item.cost,
            defaultSla,
            status,
            categoryName: category?.name,
          });
          if (made.withQuantity) createdWithQuantity += 1;
          touched.push(made.serviceId);
          createdServiceIds.push(made.serviceId);
          created += 1;
        } else if (item.found!.archived) {
          unchanged += 1;
        } else {
          await this.importer.setCost(tx, item.found!.serviceId, item.cost.toWire());
          touched.push(item.found!.serviceId);
          updated += 1;
        }
      }
      if (category !== null && createdServiceIds.length > 0) {
        // The importer finds the picked category by its name; the unique (type, lower(name)) key makes that exact, and this proves it.
        const placed = await categoryIdsOfServices(tx, createdServiceIds);
        if (createdServiceIds.some((serviceId) => placed.get(serviceId) !== category.id)) {
          throw new Error(
            `The import put a new service outside the picked category ${category.id}; nothing was written.`,
          );
        }
      }
      const moved = await recomputeEffectiveCost(tx, touched);
      if (created > 0 || moved.length > 0) this.priceVersion.bumpAfterCommit(work);
      await this.audit.record(tx, {
        action: 'imported services from',
        entityType: 'supplier',
        entityId: supplier.id,
        entityLabel: supplier.name,
        after: {
          created,
          updated,
          unchanged,
          createdWithQuantity,
          ...(options.status === undefined ? {} : { serviceStatus: status }),
          ...(category === null ? {} : { categoryId: category.id, categoryName: category.name }),
        },
      });
      return { created, updated, unchanged, createdServiceIds };
    });
  }

  /**
   * Reads the category staff picked for an import and checks it fits the services the import would create.
   *
   * @param db the database or the import's transaction
   * @param categoryId the picked category
   * @param creatable the new services the import would create
   * @param lock `share` inside the import's transaction, so the category cannot be renamed or retyped under it; omitted for the preview
   * @returns the category
   * @throws {AppError} `VALIDATION_FAILED` (422 on `categoryId`: `unknown`, or `kind_mismatch` naming the services that do not fit)
   */
  private async pickedCategory(
    db: DbExecutor,
    categoryId: number,
    creatable: readonly Creatable[],
    lock?: 'share',
  ): Promise<CategoryChoice> {
    const category = await findCategoryChoice(db, categoryId, lock);
    if (!category) throw invalid('categoryId', 'No category has this id.', 'unknown');
    const misfits = categoryMisfits(creatable, category);
    if (misfits.length > 0) throw invalid('categoryId', categoryMismatchMessage(category, misfits), 'kind_mismatch');
    return category;
  }

  /**
   * Reads the supplier chain of a live service.
   *
   * Why: decision 060: the catalog's service panel edits the chain of any service, also one no supplier links yet, so it reads the
   * chain by service (the supplier detail lists only the services one supplier serves). Every link counts, switched on or off, in
   * the order the PUT saves.
   *
   * @param serviceId the service
   * @returns the chain in priority order (then link id); `[]` when the service has no link
   * @throws {AppError} `NOT_FOUND` (404: unknown or archived)
   */
  async chainOf(serviceId: number): Promise<ChainStepView[]> {
    const db = this.db.db;
    if (!(await liveServiceInfo(db, serviceId))) throw new AppError('NOT_FOUND', { detail: 'No service has this id.' });
    const chain = await chainsOf(db, [serviceId]);
    return chain.map(({ serviceId: _service, ...step }) => step);
  }

  /**
   * Replaces the supplier chain of a service.
   *
   * @param serviceId the service
   * @param links the new chain: supplier services with a priority
   * @returns the chain as saved, ordered and renumbered 1..n
   * @throws {AppError} `NOT_FOUND` (no live service); `VALIDATION_FAILED` (422 on `links`: an unknown or repeated supplier service)
   */
  async replaceLinks(
    serviceId: number,
    links: ReadonlyArray<{ supplierServiceId: number; priority: number }>,
  ): Promise<
    Array<{
      priority: number;
      supplierId: number;
      supplierName: string;
      supplierServiceId: number;
      supplierServiceName: string;
    }>
  > {
    return this.db.runInTransaction(async (work) => {
      const { tx } = work;
      if (!(await lockLiveServiceRow(tx, serviceId)))
        throw new AppError('NOT_FOUND', { detail: 'No service has this id.' });
      const ids = links.map((link) => link.supplierServiceId);
      if (new Set(ids).size !== ids.length) {
        throw invalid('links', 'A supplier service can be linked once.', 'duplicate');
      }
      const known = await supplierServicesWithSupplier(tx, ids);
      if (ids.some((id) => !known.has(id)))
        throw invalid('links', 'One of the supplier services does not exist.', 'unknown');
      // The order given breaks ties between equal priorities.
      const ordered = links
        .map((link, index) => ({ ...link, index }))
        .sort((a, b) => a.priority - b.priority || a.index - b.index)
        .map((link) => link.supplierServiceId);
      const before = await chainsOf(tx, [serviceId]);
      await replaceChain(tx, serviceId, ordered);
      await recomputeEffectiveCost(tx, [serviceId]);
      // The chain decides which supplier cost sets the floor of the service's prices, so cached price lists start over.
      this.priceVersion.bumpAfterCommit(work);
      const chain = await chainsOf(tx, [serviceId]);
      const service = (await liveServiceInfo(tx, serviceId))!;
      await this.audit.record(tx, {
        action: 'changed supplier links of',
        entityType: 'service',
        entityId: serviceId,
        entityLabel: service.name,
        before: { chain: before.map((step) => `${step.supplierName}: ${step.supplierServiceName}`) },
        after: { chain: chain.map((step) => `${step.supplierName}: ${step.supplierServiceName}`) },
      });
      return chain.map(({ serviceId: _service, ...step }) => step);
    });
  }
}
