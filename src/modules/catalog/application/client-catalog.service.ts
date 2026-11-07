// ClientCatalogService: the use cases of the merchant portal's catalog routes (map domain B, stage 4): the catalog at my prices,
// one service with its order-form schema, and my price list as a CSV file. Each one remembers the prices it showed (user rule 9).
import { Inject, Injectable } from '@nestjs/common';
import { CLOCK, type Clock } from '../../../common/clock';
import type { ParsedListQuery } from '../../../common/contract';
import { AppError } from '../../../common/errors';
import { DbService } from '../../../infra/db';
import type { Service, ServiceFieldType, ServiceOptionList, ServiceType } from '../db/schema';
import { type PriceCsvLine, priceListCsv } from '../domain/price-csv';
import { merchantOf } from '../infra/foreign-reads.repository';
import { listFieldRows, listOptionRows } from '../infra/service.repository';
import { ListedPrices } from './listed-prices';
import { type CatalogEntry, type CatalogMerchant, type CatalogSort, MerchantCatalog } from './merchant-catalog';

/** The currency every catalog price is shown in. */
const CURRENCY = 'USD';

/** A service at the merchant's price, as the portal reads it. */
export interface ClientServiceView {
  readonly id: number;
  readonly name: string;
  readonly code: string;
  readonly type: ServiceType;
  readonly category: { id: number; name: string };
  readonly price: string;
  readonly currency: string;
  readonly deliveryTime: string;
  readonly slaMinutes: number;
  readonly info: string;
  readonly minQty: number;
  readonly maxQty: number;
  readonly qtyOptions: number[];
}

/** A service with the field schema of its order form. */
export interface ClientServiceDetailView extends ClientServiceView {
  readonly fields: Array<{
    key: string;
    label: string;
    fieldType: ServiceFieldType;
    required: boolean;
    options: string[];
    regex: string;
  }>;
  readonly options: Array<{ list: ServiceOptionList; value: string; label: string }>;
}

function toView(entry: CatalogEntry): ClientServiceView {
  const { service } = entry;
  return {
    id: service.id,
    name: service.name,
    code: service.code,
    type: service.type,
    category: entry.category,
    price: entry.price.toWire(),
    currency: CURRENCY,
    deliveryTime: service.deliveryTime,
    slaMinutes: service.slaMinutes,
    info: service.info,
    minQty: service.minQty,
    maxQty: service.maxQty,
    qtyOptions: service.qtyOptions,
  };
}

/**
 * Serves the merchant's catalog.
 *
 * Why: the merchant portal lists what the merchant may buy at its own prices, draws the order form from a service's field schema
 * and exports the price list (map stage 4). The merchant must be approved: the guard refuses a pending one before any of this
 * runs (B153). A service the merchant may not see is `404`, like an unknown one. Prices come from the one resolver and are
 * remembered as the listed prices, so the order path can refuse an order that costs much more than what was shown.
 *
 * Side effects: writes `listed_prices` (only when a price changed).
 *
 * @see docs/contract/endpoints/catalog.md (the `/client/services` and `/client/prices/export` sections)
 */
@Injectable()
export class ClientCatalogService {
  constructor(
    private readonly db: DbService,
    private readonly catalog: MerchantCatalog,
    private readonly listedPrices: ListedPrices,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  /**
   * Lists a page of the merchant's catalog.
   *
   * @param clientId the signed-in merchant
   * @param query the parsed list request
   * @returns the page of services at the merchant's prices and the exact total
   * @throws {AppError} `UNAUTHORIZED` (401) when the merchant no longer exists
   */
  async list(
    clientId: number,
    query: ParsedListQuery<CatalogSort>,
  ): Promise<{ rows: ClientServiceView[]; total: number }> {
    const merchant = await this.merchantFor(clientId);
    const { entries, total } = await this.catalog.page(this.db.db, merchant, query);
    await this.remember(clientId, entries);
    return { rows: entries.map(toView), total };
  }

  /**
   * Shows one service with its order-form schema.
   *
   * @param clientId the signed-in merchant
   * @param serviceId the service id
   * @returns the service at the merchant's price with its fields and options
   * @throws {AppError} `NOT_FOUND` (404: unknown, archived, off, or hidden from the merchant's group)
   */
  async show(clientId: number, serviceId: number): Promise<ClientServiceDetailView> {
    const merchant = await this.merchantFor(clientId);
    const entry = await this.catalog.find(this.db.db, merchant, serviceId);
    if (!entry) throw new AppError('NOT_FOUND', { detail: 'No service with this id is available to you.' });
    const [fields, options] = await Promise.all([
      listFieldRows(this.db.db, serviceId),
      listOptionRows(this.db.db, serviceId),
    ]);
    await this.remember(clientId, [entry]);
    return {
      ...toView(entry),
      // The supplier's field names and values are internal: the merchant sees what its own order form needs.
      fields: fields.map((field) => ({
        key: field.key,
        label: field.label,
        fieldType: field.fieldType,
        required: field.required,
        options: field.options,
        regex: field.regex,
      })),
      options: options.map((option) => ({ list: option.list, value: option.value, label: option.label })),
    };
  }

  /**
   * Writes the merchant's price list as CSV.
   *
   * @param clientId the signed-in merchant
   * @param filter optional `type` and `categoryId` filters
   * @returns the CSV text
   * @throws {AppError} `UNAUTHORIZED` (401) when the merchant no longer exists
   */
  async exportCsv(
    clientId: number,
    filter: { readonly type?: Service['type']; readonly categoryId?: number } = {},
  ): Promise<string> {
    const merchant = await this.merchantFor(clientId);
    const entries = await this.catalog.all(this.db.db, merchant, filter);
    await this.remember(clientId, entries);
    const lines: PriceCsvLine[] = entries.map((entry) => ({
      serviceId: entry.service.id,
      code: entry.service.code,
      name: entry.service.name,
      type: entry.service.type,
      category: entry.category.name,
      price: entry.price.toWire(),
      currency: CURRENCY,
      deliveryTime: entry.service.deliveryTime,
    }));
    return priceListCsv(lines);
  }

  private async merchantFor(clientId: number): Promise<CatalogMerchant> {
    const merchant = await merchantOf(this.db.db, clientId);
    if (!merchant) throw new AppError('UNAUTHORIZED');
    return { clientId, groupId: merchant.groupId };
  }

  private async remember(clientId: number, entries: readonly CatalogEntry[]): Promise<void> {
    await this.listedPrices.record(
      this.db.db,
      clientId,
      entries.map((entry) => ({ serviceId: entry.service.id, price: entry.price })),
      this.clock.now(),
      CURRENCY,
    );
  }
}
