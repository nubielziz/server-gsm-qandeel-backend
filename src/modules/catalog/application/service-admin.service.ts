// ServiceAdminService: the use cases of the service routes (map domain B, stage 4): list, show, create, change and delete (archive
// or hard delete). Money figures come from SQL (infra/service-figures.sql.ts); the floor check of a price change uses the same
// rules in code (domain/service-figures.ts).
import { Inject, Injectable } from '@nestjs/common';
import { CLOCK, type Clock } from '../../../common/clock';
import type { ParsedListQuery } from '../../../common/contract';
import { AppError } from '../../../common/errors';
import { Money } from '../../../common/money';
import { DbService, type DbExecutor, isForeignKeyViolation, isUniqueViolation } from '../../../infra/db';
import { AuditService } from '../../platform';
import type {
  FulfillmentMode,
  Service,
  ServiceFieldType,
  ServiceOptionList,
  ServiceStatus,
  ServiceType,
} from '../db/schema';
import { deliveryTimeText, dollars, effectiveMinProfit, floorPrice } from '../domain/service-figures';
import { lockCategoryRow } from '../infra/category.repository';
import {
  type SupplierChain,
  type SupplierRef,
  isServiceReferenced,
  supplierChainsOf,
} from '../infra/foreign-reads.repository';
import {
  type ServiceRow,
  deactivateServiceRules,
  deleteServiceRow,
  deleteServiceRules,
  findServiceByCode,
  findServiceRow,
  insertServiceRow,
  listFieldRows,
  listGroupPriceRows,
  listOptionRows,
  listServiceRows,
  lockLiveService,
  updateServiceRow,
} from '../infra/service.repository';
import { recomputeEffectiveCost } from './effective-cost';

/** A service as the console reads it. */
export interface ServiceView {
  readonly id: number;
  readonly name: string;
  readonly code: string;
  readonly type: ServiceType;
  readonly status: ServiceStatus;
  readonly executionMode: FulfillmentMode;
  readonly categoryId: number;
  readonly category: { id: number; name: string } | null;
  readonly basePrice: string;
  readonly cost: string;
  readonly costChangedFrom: string | null;
  readonly minProfit: string;
  readonly floorPrice: string;
  readonly marginPct: string;
  readonly belowFloor: boolean;
  readonly slaMinutes: number;
  readonly supplier: SupplierRef | null;
  readonly fallbackSupplier: SupplierRef | null;
}

/** A custom field as the console reads it. */
export interface FieldView {
  readonly key: string;
  readonly label: string;
  readonly fieldType: ServiceFieldType;
  readonly required: boolean;
  readonly options: string[];
  readonly regex: string;
  readonly supplierKey: string;
}

/** An option list entry as the console reads it. */
export interface OptionView {
  readonly list: ServiceOptionList;
  readonly value: string;
  readonly label: string;
  readonly supplierValue: string;
}

/** A service with its parts. */
export interface ServiceDetailView extends ServiceView {
  readonly fields: FieldView[];
  readonly options: OptionView[];
  readonly groupPrices: Array<{ groupId: number; price: string }>;
}

/** The fields of `POST /admin/services`. */
export interface CreateServiceInput {
  readonly name: string;
  readonly code: string;
  readonly categoryId: number;
  readonly type: ServiceType;
  readonly slaMinutes: number;
  readonly basePrice: string;
}

/** The fields `PATCH /admin/services/:id` may change; `minProfit: null` goes back to the default policy. */
export interface UpdateServiceInput {
  readonly name?: string | undefined;
  readonly code?: string | undefined;
  readonly categoryId?: number | undefined;
  readonly type?: ServiceType | undefined;
  readonly slaMinutes?: number | undefined;
  readonly basePrice?: string | undefined;
  readonly minProfit?: string | null | undefined;
  readonly status?: ServiceStatus | undefined;
  readonly executionMode?: FulfillmentMode | undefined;
}

/**
 * Maps a field row to the wire view (shared with the replace-all use case).
 *
 * @param field a `service_fields` row
 * @returns the field as the console reads it
 */
export const toFieldView = (field: {
  key: string;
  label: string;
  fieldType: ServiceFieldType;
  required: boolean;
  options: string[];
  regex: string;
  supplierKey: string;
}): FieldView => ({
  key: field.key,
  label: field.label,
  fieldType: field.fieldType,
  required: field.required,
  options: field.options,
  regex: field.regex,
  supplierKey: field.supplierKey,
});

/**
 * Maps an option row to the wire view (shared with the replace-all use case).
 *
 * @param option a `service_options` row
 * @returns the option as the console reads it
 */
export const toOptionView = (option: {
  list: ServiceOptionList;
  value: string;
  label: string;
  supplierValue: string;
}): OptionView => ({
  list: option.list,
  value: option.value,
  label: option.label,
  supplierValue: option.supplierValue,
});

function invalid(field: string, message: string, code = 'invalid'): AppError {
  return new AppError('VALIDATION_FAILED', { errors: [{ field, code, message }] });
}

function codeTaken(code: string, owner: string | undefined): AppError {
  const message =
    owner === undefined ? `The code ${code} is already used.` : `The code ${code} is already used by ${owner}.`;
  return new AppError('CODE_TAKEN', { detail: message, errors: [{ field: 'code', code: 'CODE_TAKEN', message }] });
}

const snapshot = (service: Service) => ({
  name: service.name,
  code: service.code,
  type: service.type,
  categoryId: service.categoryId,
  status: service.status,
  executionMode: service.fulfillment,
  basePrice: service.basePrice,
  minProfit: service.minProfit,
  slaMinutes: service.slaMinutes,
});

function toView(row: ServiceRow, chain: SupplierChain | undefined): ServiceView {
  const { service } = row;
  return {
    id: service.id,
    name: service.name,
    code: service.code,
    type: service.type,
    status: service.status,
    executionMode: service.fulfillment,
    categoryId: service.categoryId,
    category: { id: service.categoryId, name: row.categoryName },
    basePrice: service.basePrice,
    cost: service.effectiveCost,
    costChangedFrom: service.costWas,
    minProfit: row.minProfit,
    floorPrice: row.floorPrice,
    marginPct: row.marginPct,
    belowFloor: row.belowFloor,
    slaMinutes: service.slaMinutes,
    supplier: chain?.supplier ?? null,
    fallbackSupplier: chain?.fallbackSupplier ?? null,
  };
}

/**
 * Manages the service catalog.
 *
 * Why: services are what merchants buy (Dhru SERVICEID). The server owns the figures: `cost` on the wire is the effective cost
 * (RESOLUTIONS catalog-1, user rule 9), the floor is that cost plus the minimum profit, a base price under it is refused, and
 * a saved base price clears the "cost changed" mark (catalog-14). A service's type equals its category's (catalog-13). Deleting
 * a service archives it when anything refers to it and deletes it otherwise (catalog-3); an archived service is gone for every
 * reader, and its code is free again.
 *
 * Side effects: writes `services` (and, on delete, the service's `pricing_rules` and children) and `audit_logs` (entity
 * `service`); recomputes `services.effective_cost` on create and change.
 *
 * @see docs/contract/endpoints/catalog.md (the `/admin/services` sections)
 */
@Injectable()
export class ServiceAdminService {
  constructor(
    private readonly db: DbService,
    private readonly audit: AuditService,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  /**
   * Lists live services with their figures and supplier chain.
   *
   * @param query the parsed list request
   * @returns the page of services and the exact total
   */
  async list(
    query: ParsedListQuery<'name' | 'type' | 'cost' | 'basePrice' | 'id'>,
  ): Promise<{ rows: ServiceView[]; total: number }> {
    const { rows, total } = await listServiceRows(this.db.db, query);
    const chains = await supplierChainsOf(
      this.db.db,
      rows.map((row) => row.service.id),
    );
    return { rows: rows.map((row) => toView(row, chains.get(row.service.id))), total };
  }

  /**
   * Shows one live service with its custom fields, options and group prices.
   *
   * @param id the service id
   * @returns the service with its parts
   * @throws {AppError} `NOT_FOUND` (404: unknown or archived)
   */
  async show(id: number): Promise<ServiceDetailView> {
    const db = this.db.db;
    const row = await findServiceRow(db, id);
    if (!row) throw notFound();
    const [chains, fields, options, groupPrices] = await Promise.all([
      supplierChainsOf(db, [id]),
      listFieldRows(db, id),
      listOptionRows(db, id),
      listGroupPriceRows(db, id),
    ]);
    return {
      ...toView(row, chains.get(id)),
      fields: fields.map(toFieldView),
      options: options.map(toOptionView),
      groupPrices: groupPrices.map((price) => ({ groupId: price.groupId, price: price.price })),
    };
  }

  /**
   * Creates a service.
   *
   * @param input name, code, category, type, SLA and base price
   * @returns the new service
   * @throws {AppError} `VALIDATION_FAILED` (422 on `categoryId` for an unknown category or one of another type), `CODE_TAKEN`
   *   (409 on `code`)
   */
  async create(input: CreateServiceInput): Promise<ServiceView> {
    return this.db.runInTransaction(async ({ tx }) => {
      const category = await lockCategoryRow(tx, input.categoryId, 'share');
      if (!category) throw invalid('categoryId', 'This category does not exist.', 'unknown');
      if (category.type !== input.type) {
        throw invalid('categoryId', `${category.name} holds ${category.type} services.`, 'type_mismatch');
      }
      const owner = await findServiceByCode(tx, input.code);
      if (owner) throw codeTaken(input.code, owner.name);

      let service: Service;
      try {
        service = await insertServiceRow(tx, {
          categoryId: input.categoryId,
          type: input.type,
          name: input.name,
          deliveryTime: deliveryTimeText(input.slaMinutes),
          status: 'active',
          // New services go through a supplier until staff switch them to manual (the same defaults as a supplier import, B24).
          fulfillment: 'auto',
          priceMode: 'fixed',
          duplicateRule: 'block_open',
          basePrice: input.basePrice,
          cost: '0.0000',
          effectiveCost: '0.0000',
          code: input.code,
          slaMinutes: input.slaMinutes,
        });
      } catch (error) {
        throw this.translateWriteError(error, input.code);
      }
      await recomputeEffectiveCost(tx, [service.id]);
      await this.audit.record(tx, {
        action: 'created service',
        entityType: 'service',
        entityId: service.id,
        entityLabel: service.name,
        after: snapshot(service),
      });
      return this.viewOf(tx, service.id);
    });
  }

  /**
   * Changes a service.
   *
   * @param id the service id
   * @param changes the keys to change
   * @returns the updated service with its figures worked out again
   * @throws {AppError} `NOT_FOUND` (404: unknown or archived); `VALIDATION_FAILED` (422 on `basePrice` under the floor, on
   *   `categoryId` or `type` when they disagree); `CODE_TAKEN` (409)
   */
  async update(id: number, changes: UpdateServiceInput): Promise<ServiceView> {
    return this.db.runInTransaction(async ({ tx }) => {
      const before = await lockLiveService(tx, id);
      if (!before) throw notFound();
      // Work from the cost the suppliers set now, so the floor check and the figures never use a stale effective cost.
      await recomputeEffectiveCost(tx, [id]);
      const current = (await findServiceRow(tx, id))!.service;

      if (changes.categoryId !== undefined || changes.type !== undefined) {
        const categoryId = changes.categoryId ?? current.categoryId;
        const type = changes.type ?? current.type;
        const category = await lockCategoryRow(tx, categoryId, 'share');
        if (!category) throw invalid('categoryId', 'This category does not exist.', 'unknown');
        if (category.type !== type) {
          throw invalid(
            changes.categoryId === undefined ? 'type' : 'categoryId',
            `${category.name} holds ${category.type} services.`,
            'type_mismatch',
          );
        }
      }
      if (changes.code !== undefined) {
        const owner = await findServiceByCode(tx, changes.code, id);
        if (owner) throw codeTaken(changes.code, owner.name);
      }
      if (changes.basePrice !== undefined) this.assertAboveFloor(current, changes);

      let after: Service | undefined;
      try {
        after = await updateServiceRow(tx, id, {
          ...(changes.name === undefined ? {} : { name: changes.name }),
          ...(changes.code === undefined ? {} : { code: changes.code }),
          ...(changes.categoryId === undefined ? {} : { categoryId: changes.categoryId }),
          ...(changes.type === undefined ? {} : { type: changes.type }),
          ...(changes.slaMinutes === undefined
            ? {}
            : { slaMinutes: changes.slaMinutes, deliveryTime: deliveryTimeText(changes.slaMinutes) }),
          // Saving a base price answers "the cost changed" for good: the mark goes (RESOLUTIONS catalog-14).
          ...(changes.basePrice === undefined ? {} : { basePrice: changes.basePrice, costWas: null }),
          ...(changes.minProfit === undefined ? {} : { minProfit: changes.minProfit }),
          ...(changes.status === undefined ? {} : { status: changes.status }),
          ...(changes.executionMode === undefined ? {} : { fulfillment: changes.executionMode }),
        });
      } catch (error) {
        throw this.translateWriteError(error, changes.code);
      }
      await this.audit.record(tx, {
        action: 'edited service',
        entityType: 'service',
        entityId: id,
        entityLabel: after!.name,
        before: snapshot(current),
        after: snapshot(after!),
      });
      return this.viewOf(tx, id);
    });
  }

  /**
   * Archives or deletes a service.
   *
   * Why: RESOLUTIONS catalog-3 (user decision): a service that orders, supplier links, listings, inventory codes, checkout
   * sessions, help articles or IMEI checks refer to is archived (disabled, hidden, its service pricing rules switched off, its
   * history kept); any other service is deleted with its service pricing rules (fields, options, prices and links go by
   * cascade). The service row is locked first, so nothing can start to refer to it between the check and the write.
   *
   * @param id the service id
   * @throws {AppError} `NOT_FOUND` (404: unknown or already archived)
   */
  async remove(id: number): Promise<void> {
    await this.db.runInTransaction(async ({ tx }) => {
      const service = await lockLiveService(tx, id);
      if (!service) throw notFound();
      if (await isServiceReferenced(tx, id)) {
        const deactivated = await deactivateServiceRules(tx, id);
        const archivedAt = this.clock.now();
        await updateServiceRow(tx, id, { status: 'disabled', archivedAt });
        await this.audit.record(tx, {
          action: 'archived service',
          entityType: 'service',
          entityId: id,
          entityLabel: service.name,
          before: snapshot(service),
          after: { status: 'disabled', archivedAt: archivedAt.toISOString(), deactivatedPricingRuleIds: deactivated },
        });
        return;
      }
      const removedRuleIds = await deleteServiceRules(tx, id);
      await deleteServiceRow(tx, id);
      await this.audit.record(tx, {
        action: 'deleted service',
        entityType: 'service',
        entityId: id,
        entityLabel: service.name,
        before: { ...snapshot(service), removedPricingRuleIds: removedRuleIds },
      });
    });
  }

  /** Refuses a base price under the floor of the effective cost plus the minimum profit being saved. */
  private assertAboveFloor(current: Service, changes: UpdateServiceInput): void {
    const effective = Money.of(current.effectiveCost);
    const own = changes.minProfit === undefined ? current.minProfit : changes.minProfit;
    const minProfit = effectiveMinProfit(own === null ? null : Money.of(own), effective);
    const floor = floorPrice(effective, minProfit);
    if (Money.of(changes.basePrice!).cmp(floor) < 0) {
      throw invalid(
        'basePrice',
        `Below the floor. Cost ${dollars(effective)} plus minimum profit ${dollars(minProfit)} is ${dollars(floor)}.`,
        'below_floor',
      );
    }
  }

  /** Turns a database refusal of a service write into the error the console expects (a race the pre-checks could not see). */
  private translateWriteError(error: unknown, code: string | undefined): Error {
    if (isUniqueViolation(error, 'services_code_uq') && code !== undefined) {
      // The transaction is aborted, so the owner's name cannot be read any more: the message stays general.
      return codeTaken(code, undefined);
    }
    if (isForeignKeyViolation(error, 'services_category_type_fk')) {
      return invalid('categoryId', 'This category no longer holds services of this type.', 'type_mismatch');
    }
    return error instanceof Error ? error : new Error('The service could not be saved.', { cause: error });
  }

  private async viewOf(db: DbExecutor, id: number): Promise<ServiceView> {
    const row = (await findServiceRow(db, id))!;
    const chains = await supplierChainsOf(db, [id]);
    return toView(row, chains.get(id));
  }
}

function notFound(): AppError {
  return new AppError('NOT_FOUND', { detail: 'No service has this id.' });
}
