// SupplierCatalogueService: the use cases about a supplier's own services and how they meet our catalog (stage 6): list the synced
// services, preview and run the import, and read and replace the supplier chain of a service (resolutions orders-suppliers-10,
// catalog-9, B24; the read: decision 060).
import { Injectable } from '@nestjs/common';
import type { ParsedListQuery } from '../../../common/contract';
import { AppError } from '../../../common/errors';
import { DbService } from '../../../infra/db';
import { CatalogPriceVersion, ServiceImporter, recomputeEffectiveCost } from '../../catalog';
import { AuditService, SettingsReader } from '../../platform';
import type { SupplierService } from '../db/schema';
import { classifyImportItem, importShape, importableType, quantityDiffers } from '../domain/import-plan';
import { supplierQuantityRule } from '../domain/supplier-quantity';
import { lockLiveServiceRow, linkedServicesOf, liveServiceInfo } from '../infra/foreign-reads.repository';
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
   * @returns one item per picked service of this supplier, with the supplier's quantity rule and whether the linked service's differs
   * @throws {AppError} `NOT_FOUND`
   */
  async preview(supplierId: number, ids: readonly number[]): Promise<{ items: ImportPreviewItem[] }> {
    const supplier = await findSupplier(this.db.db, supplierId);
    if (!supplier) throw notFound();
    const picked = await supplierServicesByIds(this.db.db, supplierId, ids);
    const linked = await linkedServicesOf(
      this.db.db,
      picked.map((row) => row.id),
    );
    return {
      items: picked.map((row) => {
        const found = linked.get(row.id) ?? null;
        const { state, cost, previousCost } = classifyImportItem(row, supplier.creditRate, found);
        const rule = supplierQuantityRule(row.raw);
        // The supplier's type name, unless the import makes the service another type (decision 042: an IMEI service whose main box
        // is not an IMEI becomes a server service); the console shows the tag upper-cased either way.
        const shaped = importShape(row).type;
        return {
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
      }),
    };
  }

  /**
   * Imports the picked services: creates the new ones and updates the cost of the changed ones.
   *
   * @param supplierId the supplier
   * @param ids the picked supplier services
   * @returns how many services were created, updated and left as they were, and the ids of the created ones in creation order
   *   (decision 060: the console prepares one publish run per call from them); a new service starts with the supplier's quantity
   *   rule (feature 25, B213), and the audit row `imported services from` also counts `createdWithQuantity`
   * @throws {AppError} `NOT_FOUND`; `VALIDATION_FAILED` (422 on `supplierServiceIds`: none belongs to this supplier, or a new item
   *   has a type that is not imei, server, remote or file; nothing is imported then)
   */
  async import(supplierId: number, ids: readonly number[]): Promise<ImportOutcome> {
    const defaultSla = await this.settings.integer(IMPORT_DEFAULT_SLA_KEY, DEFAULT_IMPORT_SLA_MINUTES, SLA_BOUNDS);
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
        ...classifyImportItem(row, supplier.creditRate, linked.get(row.id) ?? null),
      }));
      const refused = plan.filter((item) => item.state === 'new' && importShape(item.row).type === undefined);
      if (refused.length > 0) {
        const names = refused.map((item) => `"${item.row.name}" (${item.row.type})`).join(', ');
        throw invalid(
          'supplierServiceIds',
          `Only imei, server, remote and file services can be imported; not these: ${names}. Nothing was imported.`,
          'unsupported_type',
        );
      }

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
            status: 'active',
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
      const moved = await recomputeEffectiveCost(tx, touched);
      if (created > 0 || moved.length > 0) this.priceVersion.bumpAfterCommit(work);
      await this.audit.record(tx, {
        action: 'imported services from',
        entityType: 'supplier',
        entityId: supplier.id,
        entityLabel: supplier.name,
        after: { created, updated, unchanged, createdWithQuantity },
      });
      return { created, updated, unchanged, createdServiceIds };
    });
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
