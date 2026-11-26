// ServiceAdminService: the use cases of the service routes (map domain B, stage 4): list, show, create, change and delete (archive
// or hard delete). Money figures come from SQL (infra/service-figures.sql.ts); the floor check of a price change uses the same
// rules in code (domain/service-figures.ts). The Catalog page's facts of a row (attention reasons, shop price, shop page) come from
// infra/service-attention.sql.ts and are narrowed to what the caller may read (decision 060).
import { Inject, Injectable } from '@nestjs/common';
import { CLOCK, type Clock } from '../../../common/clock';
import type { ParsedListQuery } from '../../../common/contract';
import { AppError } from '../../../common/errors';
import { Money } from '../../../common/money';
import { DbService, type DbExecutor, isForeignKeyViolation, isUniqueViolation } from '../../../infra/db';
import { type PermissionHolder, requirePermission } from '../../identity';
import { AuditService } from '../../platform';
import type {
  FulfillmentMode,
  NewService,
  Service,
  ServiceFieldType,
  ServiceOptionList,
  ServiceStatus,
  ServiceType,
} from '../db/schema';
import { CODES_IN_STOCK, codesInStockMessage } from '../domain/code-stock';
import { type QuantityChange, type QuantityRule, resolveQuantityRule } from '../domain/quantity-rule';
import { IMEI_DEFAULT_FIELD, auditedField, plannedFieldRows } from '../domain/service-parts';
import type { AttentionReason, ShopBlock } from '../domain/service-attention';
import { deliveryTimeText, dollars } from '../domain/service-figures';
import { lockCategoryRow } from '../infra/category.repository';
import {
  type ListingRef,
  type SupplierChain,
  type SupplierRef,
  isServiceReferenced,
  latestPublishAttemptsOf,
  listingsOf,
  supplierChainsOf,
} from '../infra/foreign-reads.repository';
import { countAvailableCodes } from '../infra/inventory.repository';
import { type AttentionFlags, attentionFlagsOf } from '../infra/service-attention.sql';
import {
  type ServiceListSort,
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
  replaceFieldRows,
  updateServiceRow,
} from '../infra/service.repository';
import { CatalogPriceVersion } from './catalog-price-version';
import { CatalogSignals } from './catalog-signals';
import { recomputeEffectiveCost, writeOwnCost } from './effective-cost';
import { PriceResolver } from './price-resolver';
import { type RetailPriceSource, RetailPrices } from './retail-prices';
import { type ServiceReadAccess, assertListFiltersAllowed, serviceReadAccess } from './service-read-access';

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
  /** The effective cost: the larger of `ownCost` and the cost of the first usable supplier link (`recomputeEffectiveCost`). */
  readonly cost: string;
  /** The service's own cost that staff set (`services.cost`, decision 069). */
  readonly ownCost: string;
  readonly costChangedFrom: string | null;
  readonly minProfit: string;
  readonly floorPrice: string;
  readonly marginPct: string;
  readonly belowFloor: boolean;
  /** Decision 069: only such a service holds codes, and only its orders take a code from the stock. */
  readonly stockDelivery: boolean;
  /** How many of its codes are `available` now (0 for a service without codes). */
  readonly stockAvailable: number;
  readonly slaMinutes: number;
  readonly supplier: SupplierRef | null;
  readonly fallbackSupplier: SupplierRef | null;
  readonly allowCancel: boolean;
  readonly allowVerify: boolean;
  readonly verifyWindowH: number;
  /** The position staff gave the service among those of its category, 0 when never set (decision 063). */
  readonly sort: number;
  /** What one order may buy: a range `minQty..maxQty`, or only the packs in `qtyOptions` (ascending) when it is not empty. */
  readonly minQty: number;
  readonly maxQty: number;
  readonly qtyOptions: number[];
  /** Decision 060: the attention reasons that hold and that the caller may see (`serviceReadAccess`), in their fixed order. */
  readonly attention: AttentionReason[];
  /** The shop price (net USD before VAT), or `null` when the service has none. */
  readonly retailPrice: string | null;
  readonly retailPriceSource: 'rule' | 'manual' | null;
  /** Only for a caller with `pricing:read`. */
  readonly retailPriceRule?: { readonly id: number; readonly label: string } | null;
  /** Only for a caller with `pricing:read`. */
  readonly retailPriceWaiting?: boolean;
  /** Only for a caller with `storefront:read`. */
  readonly listingId?: number | null;
  /** Only for a caller with `storefront:read`. */
  readonly isListed?: boolean;
  /** Only for a caller with `storefront:read`. */
  readonly shopBlocked?: ShopBlock | null;
}

/** Why the last publish attempt of a service was refused, and in which run (decision 060). */
export interface PublishFailureView {
  readonly runId: number;
  readonly reason: string;
  readonly detail: string | null;
  readonly at: string;
}

/** A custom field as the console reads it. */
export interface FieldView {
  readonly key: string;
  /** The field's Name: what a supplier receives in CUSTOMFIELD (stored in `service_fields.supplier_key`, decision 065). */
  readonly name: string;
  readonly label: string;
  readonly fieldType: ServiceFieldType;
  readonly required: boolean;
  readonly options: string[];
  readonly regex: string;
  readonly isMainInput: boolean;
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
  /** Only for a caller with `storefront:read`: set while the reason `publish_failed` holds, else `null`. */
  readonly publishFailure?: PublishFailureView | null;
}

/** The fields of `POST /admin/services`. */
export interface CreateServiceInput {
  readonly name: string;
  readonly code: string;
  readonly categoryId: number;
  readonly type: ServiceType;
  readonly slaMinutes: number;
  readonly basePrice: string;
  /** What a merchant may do with the orders of the service (all off when left out). */
  readonly allowCancel?: boolean | undefined;
  readonly allowVerify?: boolean | undefined;
  readonly verifyWindowH?: number | undefined;
  /** What one order may buy (feature 25); left out = one per order. See `resolveQuantityRule`. */
  readonly minQty?: number | undefined;
  readonly maxQty?: number | undefined;
  readonly qtyOptions?: readonly number[] | undefined;
  /** "Delivered from code stock" (decision 069); off when left out. */
  readonly stockDelivery?: boolean | undefined;
  /** The service's own cost, 0 or more (decision 069); 0 when left out. */
  readonly ownCost?: string | undefined;
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
  readonly allowCancel?: boolean | undefined;
  readonly allowVerify?: boolean | undefined;
  readonly verifyWindowH?: number | undefined;
  /** The quantity rule; a key left out stays, and when any is sent all three columns are written (`resolveQuantityRule`). */
  readonly minQty?: number | undefined;
  readonly maxQty?: number | undefined;
  readonly qtyOptions?: readonly number[] | undefined;
  /** "Delivered from code stock" (decision 069): `false` is refused while codes are available. */
  readonly stockDelivery?: boolean | undefined;
  /** The service's own cost, 0 or more (decision 069): it moves the effective cost like a supplier cost change. */
  readonly ownCost?: string | undefined;
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
  isMainInput: boolean;
}): FieldView => ({
  key: field.key,
  name: field.supplierKey,
  label: field.label,
  fieldType: field.fieldType,
  required: field.required,
  options: field.options,
  regex: field.regex,
  isMainInput: field.isMainInput,
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

/** The quantity rule a service starts with: one per order. */
const NEW_SERVICE_QUANTITY: QuantityRule = { minQty: 1, maxQty: 1, qtyOptions: [] };

/** The rule after a change, or `VALIDATION_FAILED` with every problem (feature 25, B212). */
function quantityOf(current: QuantityRule, change: QuantityChange): QuantityRule {
  const outcome = resolveQuantityRule(current, change);
  if (!outcome.ok) throw new AppError('VALIDATION_FAILED', { errors: outcome.errors });
  return outcome.rule;
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
  allowCancel: service.allowCancel,
  allowVerify: service.allowVerify,
  verifyWindowH: service.verifyWindowH,
  minQty: service.minQty,
  maxQty: service.maxQty,
  qtyOptions: service.qtyOptions,
  ownCost: service.cost,
  stockDelivery: service.stockDelivery,
});

/** The Catalog page's facts of some services (decision 060), read with a fixed number of queries. */
interface HubFacts {
  readonly flags: Map<number, AttentionFlags>;
  readonly sources: Map<number, RetailPriceSource>;
  /** Read only for a caller with `storefront:read`. */
  readonly listings: Map<number, ListingRef> | undefined;
}

function toView(
  row: ServiceRow,
  chain: SupplierChain | undefined,
  facts: HubFacts,
  access: ServiceReadAccess,
): ServiceView {
  const { service } = row;
  const flags = facts.flags.get(service.id);
  const source = facts.sources.get(service.id);
  const listing = facts.listings?.get(service.id);
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
    ownCost: service.cost,
    costChangedFrom: service.costWas,
    minProfit: row.minProfit,
    floorPrice: row.floorPrice,
    marginPct: row.marginPct,
    belowFloor: row.belowFloor,
    stockDelivery: service.stockDelivery,
    stockAvailable: row.stockAvailable,
    slaMinutes: service.slaMinutes,
    supplier: chain?.supplier ?? null,
    fallbackSupplier: chain?.fallbackSupplier ?? null,
    allowCancel: service.allowCancel,
    allowVerify: service.allowVerify,
    verifyWindowH: service.verifyWindowH,
    sort: service.sort,
    minQty: service.minQty,
    maxQty: service.maxQty,
    qtyOptions: service.qtyOptions,
    // A reason the caller may not read is left out, never shown as false (decision 060).
    attention: (flags?.reasons ?? []).filter((reason) => access.reasons.includes(reason)),
    retailPrice: source?.price?.toWire() ?? null,
    retailPriceSource: source?.source ?? null,
    ...(access.pricing ? { retailPriceRule: source?.rule ?? null, retailPriceWaiting: source?.waiting ?? false } : {}),
    ...(access.listing
      ? {
          listingId: listing?.id ?? null,
          isListed: listing?.isListed ?? false,
          shopBlocked: flags?.shopBlocked ?? null,
        }
      : {}),
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
 * A service sells a range or fixed packs (feature 25): the quantity rule is checked by `resolveQuantityRule`, and the audit rows hold
 * `minQty`, `maxQty` and `qtyOptions` before and after.
 *
 * Decision 060: every row also carries the Catalog page's facts: the attention reasons, the shop price and its source, and the shop
 * page facts, each narrowed by `serviceReadAccess` (the same rule for the list, show, create and change answers); a list filter the
 * caller may not use is refused before any query.
 *
 * Decision 069: a row also says whether the service is delivered from code stock (`stockDelivery`), how many codes are available
 * (`stockAvailable`) and its own cost (`ownCost`, next to the effective `cost`); create and change set the first and the last.
 *
 * Side effects: writes `services` (and, on delete, the service's `pricing_rules` and children; on the create of an IMEI service its
 * default `service_fields` row, decision 073) and `audit_logs` (entity `service`); recomputes `services.effective_cost` on create and change (and writes `services.cost` for `ownCost`).
 *
 * @see docs/contract/endpoints/catalog.md (the `/admin/services` sections)
 */
@Injectable()
export class ServiceAdminService {
  constructor(
    private readonly db: DbService,
    private readonly audit: AuditService,
    private readonly resolver: PriceResolver,
    private readonly priceVersion: CatalogPriceVersion,
    private readonly signals: CatalogSignals,
    private readonly retail: RetailPrices,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  /**
   * Lists live services with their figures, supplier chain and the Catalog page's facts.
   *
   * @param caller the signed-in staff member: the facts and filters of decision 060 follow `serviceReadAccess`
   * @param query the parsed list request
   * @returns the page of services and the exact total
   * @throws {AppError} `FORBIDDEN` (403: `isListed` or `notOnShop` without `storefront:read`)
   */
  async list(
    caller: PermissionHolder,
    query: ParsedListQuery<ServiceListSort>,
  ): Promise<{ rows: ServiceView[]; total: number }> {
    const access = serviceReadAccess(caller);
    assertListFiltersAllowed(access, query);
    const db = this.db.db;
    const at = this.clock.now();
    const { rows, total } = await listServiceRows(db, query, at, access.reasons);
    const ids = rows.map((row) => row.service.id);
    const [chains, facts] = await Promise.all([supplierChainsOf(db, ids), this.hubFactsOf(db, ids, access, at)]);
    return { rows: rows.map((row) => toView(row, chains.get(row.service.id), facts, access)), total };
  }

  /**
   * Shows one live service with its custom fields, options and group prices.
   *
   * @param caller the signed-in staff member: the facts of decision 060 follow `serviceReadAccess`
   * @param id the service id
   * @returns the service with its parts and, with `storefront:read`, why its last publish attempt was refused
   * @throws {AppError} `NOT_FOUND` (404: unknown or archived)
   */
  async show(caller: PermissionHolder, id: number): Promise<ServiceDetailView> {
    const access = serviceReadAccess(caller);
    const db = this.db.db;
    const at = this.clock.now();
    const row = await findServiceRow(db, id, at);
    if (!row) throw notFound();
    const [chains, fields, options, groupPrices, facts] = await Promise.all([
      supplierChainsOf(db, [id]),
      listFieldRows(db, id),
      listOptionRows(db, id),
      listGroupPriceRows(db, id),
      this.hubFactsOf(db, [id], access, at),
    ]);
    const failure = access.listing ? { publishFailure: await this.publishFailureOf(db, id, facts) } : {};
    return {
      ...toView(row, chains.get(id), facts, access),
      fields: fields.map(toFieldView),
      options: options.map(toOptionView),
      groupPrices: groupPrices.map((price) => ({ groupId: price.groupId, price: price.price })),
      ...failure,
    };
  }

  /**
   * Creates a service.
   *
   * @param caller the signed-in staff member: the facts of decision 060 in the answer follow `serviceReadAccess`
   * @param input name, code, category, type, SLA, base price and, optionally, the quantity rule, "Delivered from code stock" and the
   *   own cost (decision 069)
   * An IMEI service gets its default custom field in the same transaction (decision 073, {@link IMEI_DEFAULT_FIELD}): Name and label
   * `IMEI`, type `imei`, required, the main input, first; with its own audit row `replaced custom fields of service`.
   *
   * @returns the new service
   * @throws {AppError} `VALIDATION_FAILED` (422 on `categoryId` for an unknown category or one of another type; on `minQty`,
   *   `maxQty` or `qtyOptions` for a quantity rule that breaks `resolveQuantityRule`; on `basePrice` with the code `below_floor` when
   *   `ownCost` is sent and the base price is under the floor it sets, decision 069), `CODE_TAKEN` (409 on `code`)
   */
  async create(caller: PermissionHolder, input: CreateServiceInput): Promise<ServiceView> {
    const access = serviceReadAccess(caller);
    return this.db.runInTransaction(async (work) => {
      const { tx } = work;
      const category = await lockCategoryRow(tx, input.categoryId, 'share');
      if (!category) throw invalid('categoryId', 'This category does not exist.', 'unknown');
      if (category.type !== input.type) {
        throw invalid('categoryId', `${category.name} holds ${category.type} services.`, 'type_mismatch');
      }
      const owner = await findServiceByCode(tx, input.code);
      if (owner) throw codeTaken(input.code, owner.name);
      const quantity = quantityOf(NEW_SERVICE_QUANTITY, input);

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
          // Decision 069: the own cost staff typed (0 until a supplier is linked or imported). The effective cost starts equal to it,
          // so a new service never shows "cost changed" (a new service has no link yet).
          cost: ownCostOf(input.ownCost),
          effectiveCost: ownCostOf(input.ownCost),
          stockDelivery: input.stockDelivery ?? false,
          code: input.code,
          slaMinutes: input.slaMinutes,
          // The merchant's cancel and verification stay off until staff switch them on (the columns default to false, false, 0).
          ...(input.allowCancel === undefined ? {} : { allowCancel: input.allowCancel }),
          ...(input.allowVerify === undefined ? {} : { allowVerify: input.allowVerify }),
          ...(input.verifyWindowH === undefined ? {} : { verifyWindowH: input.verifyWindowH }),
          minQty: quantity.minQty,
          maxQty: quantity.maxQty,
          qtyOptions: quantity.qtyOptions,
        });
      } catch (error) {
        throw this.translateWriteError(error, input.code);
      }
      await recomputeEffectiveCost(tx, [service.id]);
      // Decision 069: an own cost sent sets the floor at once, so the base price is judged against it as a change judges it (the same
      // refusal); without one the new service costs 0 and the base price stays as typed.
      if (input.ownCost !== undefined) await this.assertAboveFloor(tx, service, { basePrice: input.basePrice });
      this.priceVersion.bumpAfterCommit(work);
      await this.signals.servicesChanged(tx, [service.id], 'service');
      await this.audit.record(tx, {
        action: 'created service',
        entityType: 'service',
        entityId: service.id,
        entityLabel: service.name,
        after: snapshot(service),
      });
      // Decision 073: an IMEI service starts with its IMEI field (the default, not a rule: staff may change or remove it later), written
      // and audited like a save of the fields route.
      if (service.type === 'imei') {
        const saved = await replaceFieldRows(tx, service.id, plannedFieldRows([IMEI_DEFAULT_FIELD], [], true));
        await this.audit.record(tx, {
          action: 'replaced custom fields of service',
          entityType: 'service',
          entityId: service.id,
          entityLabel: service.name,
          before: { fields: [] },
          after: { fields: saved.map(auditedField) },
        });
      }
      return this.viewOf(tx, service.id, access);
    });
  }

  /**
   * Changes a service.
   *
   * Decision 069: `ownCost` writes `services.cost` and works out the effective cost again (`writeOwnCost`), with every consequence of
   * a supplier cost change: `costChangedFrom` when it rose, the floor of every price, the catalog price version moved after the commit
   * (cached price lists, the price change scan and the follow pass of a following shop price, decision 040), the search signal and the
   * audit row. It is written before the floor check, so a `basePrice` sent with it is judged against the new floor. `stockDelivery:
   * false` is refused while the service holds available codes (they are counted under the service row lock, which an import takes too).
   *
   * @param caller the signed-in staff member (`basePrice`, `minProfit` and `ownCost` also need `pricing:update`, decisions 046 and 069)
   * @param id the service id
   * @param changes the keys to change
   * @returns the updated service with its figures worked out again
   * @throws {AppError} `FORBIDDEN` (403: `basePrice`, `minProfit` or `ownCost` is sent without `pricing:update`); `NOT_FOUND` (404: unknown or archived); `VALIDATION_FAILED` (422 on `basePrice` under the floor, on
   *   `categoryId` or `type` when they disagree, on `minQty`, `maxQty` or `qtyOptions` for a quantity rule that breaks
   *   `resolveQuantityRule`, on `stockDelivery` with the code `codes_in_stock`); `CODE_TAKEN` (409)
   */
  async update(caller: PermissionHolder, id: number, changes: UpdateServiceInput): Promise<ServiceView> {
    // The base price, the minimum profit and the own cost set the price floor: a pricing decision (decisions 046 and 069).
    // `minProfit: null` counts as sent.
    if (changes.basePrice !== undefined || changes.minProfit !== undefined || changes.ownCost !== undefined) {
      requirePermission(caller, 'pricing:update');
    }
    const access = serviceReadAccess(caller);
    return this.db.runInTransaction(async (work) => {
      const { tx } = work;
      const before = await lockLiveService(tx, id);
      if (!before) throw notFound();
      // Work from the cost the suppliers set now, so the floor check and the figures never use a stale effective cost.
      await recomputeEffectiveCost(tx, [id]);
      const current = (await findServiceRow(tx, id, this.clock.now()))!.service;

      // Decision 069: the codes in stock are voided before the service stops delivering from its stock (the row lock holds imports off).
      if (changes.stockDelivery === false) {
        const available = await countAvailableCodes(tx, id);
        if (available > 0) throw invalid('stockDelivery', codesInStockMessage(available), CODES_IN_STOCK);
      }

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
      // The own cost first: the floor a `basePrice` sent with it is judged against starts from the new effective cost.
      if (changes.ownCost !== undefined) await writeOwnCost(tx, id, ownCostOf(changes.ownCost));
      if (changes.basePrice !== undefined) await this.assertAboveFloor(tx, current, changes);
      // Only a request that sends a quantity key touches (and re-checks) the rule; it then writes all three columns.
      const quantity =
        changes.minQty === undefined && changes.maxQty === undefined && changes.qtyOptions === undefined
          ? undefined
          : quantityOf(current, changes);

      let after: Service | undefined;
      try {
        const columns: Partial<Omit<NewService, 'id'>> = {
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
          ...(changes.allowCancel === undefined ? {} : { allowCancel: changes.allowCancel }),
          ...(changes.allowVerify === undefined ? {} : { allowVerify: changes.allowVerify }),
          ...(changes.verifyWindowH === undefined ? {} : { verifyWindowH: changes.verifyWindowH }),
          ...(changes.stockDelivery === undefined ? {} : { stockDelivery: changes.stockDelivery }),
          ...(quantity === undefined ? {} : quantity),
        };
        // A request that sends only `ownCost` has no column left to write here (`writeOwnCost` wrote it): the row is read back.
        after =
          Object.keys(columns).length === 0 ? await lockLiveService(tx, id) : await updateServiceRow(tx, id, columns);
      } catch (error) {
        throw this.translateWriteError(error, changes.code);
      }
      // Any change can move what merchants see (the price, the status, the category), so cached price lists start over.
      this.priceVersion.bumpAfterCommit(work);
      // ... and what the shop's search holds (status, category, the name's model codes): feature 29.
      await this.signals.servicesChanged(tx, [id], 'service');
      await this.audit.record(tx, {
        action: 'edited service',
        entityType: 'service',
        entityId: id,
        entityLabel: after!.name,
        before: snapshot(current),
        after: snapshot(after!),
      });
      return this.viewOf(tx, id, access);
    });
  }

  /**
   * Archives or deletes a service.
   *
   * Why: RESOLUTIONS catalog-3 (user decision): a service that orders, supplier links, listings, inventory codes, checkout
   * sessions or help articles refer to is archived (disabled, hidden, its service pricing rules switched off, its
   * history kept); any other service is deleted with its service pricing rules (fields, options, prices and links go by
   * cascade). The service row is locked first, so nothing can start to refer to it between the check and the write.
   *
   * @param id the service id
   * @throws {AppError} `NOT_FOUND` (404: unknown or already archived)
   */
  async remove(id: number): Promise<void> {
    await this.db.runInTransaction(async (work) => {
      const { tx } = work;
      const service = await lockLiveService(tx, id);
      if (!service) throw notFound();
      this.priceVersion.bumpAfterCommit(work);
      await this.signals.servicesChanged(tx, [id], 'service');
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

  /**
   * Refuses a base price under the floor: the effective cost plus the minimum profit being saved, or, when the service has none
   * of its own, the one the first matching rule for every group asks for (RESOLUTIONS catalog-1: no merchant here).
   */
  private async assertAboveFloor(tx: DbExecutor, current: Service, changes: UpdateServiceInput): Promise<void> {
    const own = changes.minProfit === undefined ? current.minProfit : changes.minProfit;
    const context = await this.resolver.context(tx, { serviceIds: [current.id], at: this.clock.now() });
    const { cost, minProfit, floor } = context.floor(current.id, null, own === null ? null : Money.of(own))!;
    if (Money.of(changes.basePrice!).cmp(floor) < 0) {
      throw invalid(
        'basePrice',
        `Below the floor. Cost ${dollars(cost)} plus minimum profit ${dollars(minProfit)} is ${dollars(floor)}.`,
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

  private async viewOf(db: DbExecutor, id: number, access: ServiceReadAccess): Promise<ServiceView> {
    const at = this.clock.now();
    const row = (await findServiceRow(db, id, at))!;
    const chains = await supplierChainsOf(db, [id]);
    const facts = await this.hubFactsOf(db, [id], access, at);
    return toView(row, chains.get(id), facts, access);
  }

  /**
   * Reads the Catalog page's facts of some services (decision 060): the attention flags and the shop block (one select over the
   * fragments of service-attention.sql.ts), the shop price and its source (`RetailPrices.sources`) and, only for a caller who may
   * read them, the listings.
   */
  private async hubFactsOf(
    db: DbExecutor,
    ids: readonly number[],
    access: ServiceReadAccess,
    at: Date,
  ): Promise<HubFacts> {
    // One after the other: `db` may be the caller's transaction (create and change answer from inside it).
    const flags = await attentionFlagsOf(db, ids, at);
    const sources = await this.retail.sources(db, ids);
    const listings = access.listing ? await listingsOf(db, ids) : undefined;
    return { flags, sources, listings };
  }

  /**
   * The refused last publish attempt of a service while the reason `publish_failed` holds, else `null` (decision 060).
   *
   * The reason flag and the attempt are read apart, so the attempt is checked on its own: only a `refused` one is a failure.
   */
  private async publishFailureOf(db: DbExecutor, id: number, facts: HubFacts): Promise<PublishFailureView | null> {
    if (!facts.flags.get(id)?.reasons.includes('publish_failed')) return null;
    const attempt = (await latestPublishAttemptsOf(db, [id])).get(id);
    // The flag and the attempt are two reads: an attempt that finished in between (published, skipped) is not a failure to show.
    if (attempt === undefined || attempt.result !== 'refused') return null;
    return { runId: attempt.runId, reason: attempt.reason, detail: attempt.detail, at: attempt.at.toISOString() };
  }
}

/** An own cost as stored: 4 decimals, 0 when none was sent (decision 069). */
function ownCostOf(value: string | undefined): string {
  return Money.of(value ?? '0').toWire();
}

function notFound(): AppError {
  return new AppError('NOT_FOUND', { detail: 'No service has this id.' });
}
