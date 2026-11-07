// SupplierCatalogueService: the use cases about a supplier's own services and how they meet our catalog (stage 6): list the synced
// services, preview and run the import, and replace the supplier chain of a service (resolutions orders-suppliers-10, catalog-9, B24).
import { Injectable } from '@nestjs/common';
import type { ParsedListQuery } from '../../../common/contract';
import { AppError } from '../../../common/errors';
import { Money } from '../../../common/money';
import { DbService } from '../../../infra/db';
import { CatalogPriceVersion, ServiceImporter, defaultMinProfit, recomputeEffectiveCost } from '../../catalog';
import { AuditService, SettingsReader } from '../../platform';
import type { SupplierService } from '../db/schema';
import { classifyImportItem, importableType, importedFields } from '../domain/import-plan';
import { slaMinutesOf } from '../domain/sla-time';
import { lockLiveServiceRow, linkedServicesOf, liveServiceInfo } from '../infra/foreign-reads.repository';
import {
  type SupplierServiceListField,
  chainsOf,
  insertFirstLink,
  listSupplierServiceRows,
  replaceChain,
  supplierServicesByIds,
  supplierServicesWithSupplier,
} from '../infra/supplier-catalogue.repository';
import { findSupplier, lockSupplier } from '../infra/supplier.repository';

/** The setting that gives an imported service an SLA when the supplier's time text cannot be read (orders-suppliers-10). */
export const IMPORT_DEFAULT_SLA_KEY = 'catalog.importDefaultSlaMinutes';
const DEFAULT_IMPORT_SLA_MINUTES = 1440;
const SLA_BOUNDS = { min: 1, max: 525_600 } as const;

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

/** The suggested price of an item: its cost plus the default minimum profit (catalog-9: at least 0.02 above cost). */
const suggestedPrice = (cost: Money): Money => cost.add(defaultMinProfit(cost));

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
   * @returns one item per picked service of this supplier
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
        return {
          supplierServiceId: row.id,
          name: row.name,
          type: row.type,
          state,
          serviceId: found?.serviceId ?? null,
          serviceName: found?.name ?? null,
          cost: cost.toWire(),
          previousCost: previousCost?.toWire() ?? null,
          suggestedPrice: state === 'matching' ? null : suggestedPrice(cost).toWire(),
        };
      }),
    };
  }

  /**
   * Imports the picked services: creates the new ones and updates the cost of the changed ones.
   *
   * @param supplierId the supplier
   * @param ids the picked supplier services
   * @returns how many services were created, updated and left as they were
   * @throws {AppError} `NOT_FOUND`; `VALIDATION_FAILED` (422 on `supplierServiceIds`: none belongs to this supplier, or a new item
   *   has a type that is not imei, server, remote or file; nothing is imported then)
   */
  async import(
    supplierId: number,
    ids: readonly number[],
  ): Promise<{ created: number; updated: number; unchanged: number }> {
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
      const refused = plan.filter((item) => item.state === 'new' && importableType(item.row.type) === undefined);
      if (refused.length > 0) {
        const names = refused.map((item) => `"${item.row.name}" (${item.row.type})`).join(', ');
        throw invalid(
          'supplierServiceIds',
          `Only imei, server, remote and file services can be imported; not these: ${names}. Nothing was imported.`,
          'unsupported_type',
        );
      }

      let created = 0;
      let updated = 0;
      let unchanged = 0;
      const touched: number[] = [];
      for (const item of plan) {
        if (item.state === 'matching') {
          unchanged += 1;
        } else if (item.state === 'new') {
          const type = importableType(item.row.type)!;
          const made = await this.importer.create(tx, {
            supplierServiceId: item.row.id,
            type,
            name: item.row.name,
            group: item.row.remoteGroup,
            time: item.row.time,
            cost: item.cost.toWire(),
            basePrice: suggestedPrice(item.cost).toWire(),
            slaMinutes: slaMinutesOf(item.row.time, defaultSla),
            fields: importedFields(item.row.customFields),
          });
          await insertFirstLink(tx, made.serviceId, item.row.id);
          touched.push(made.serviceId);
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
        after: { created, updated, unchanged },
      });
      return { created, updated, unchanged };
    });
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
