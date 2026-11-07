// MerchantApiCatalog: the catalog as REST v1 and Dhru show it (map domain B, stage 7): `GET /v1/services` (a page by cursor),
// `GET /v1/services/:id` and the Dhru `imeiservicelist`. Each one remembers the prices it showed (user rule 9).
import { Inject, Injectable, type OnModuleInit } from '@nestjs/common';
import type { z } from 'zod';
import { CLOCK, type Clock } from '../../../common/clock';
import { cutPage, decodeCursor } from '../../../common/contract';
import { DhruGateway } from '../../../common/dhru';
import { AppError } from '../../../common/errors';
import { DbService } from '../../../infra/db';
import { dhruServiceList } from '../contracts/v1-services.contracts';
import type { Service, ServiceField, ServiceFieldType, ServiceType } from '../db/schema';
import { merchantOf } from '../infra/foreign-reads.repository';
import { listFieldRowsOf, listOptionRows } from '../infra/service.repository';
import { toClientServiceView, type ClientServiceDetailView, type ClientServiceView } from './client-catalog.service';
import { ListedPrices } from './listed-prices';
import { type CatalogEntry, type CatalogMerchant, MerchantCatalog } from './merchant-catalog';

/** The `LIST` of the Dhru service list as the contract describes it. */
type DhruList = z.input<(typeof dhruServiceList)['success']>['LIST'];

/** The currency every catalog price is shown in. */
const CURRENCY = 'USD';

/** A service of REST v1: the portal's row and what the service lets the merchant do with its orders. */
export interface ApiServiceView extends ClientServiceView {
  readonly allowCancel: boolean;
  readonly allowVerify: boolean;
  readonly verifyWindowH: number;
}

/** A service of REST v1 with its fields and options. */
export interface ApiServiceDetailView extends ApiServiceView {
  readonly fields: ClientServiceDetailView['fields'];
  readonly options: ClientServiceDetailView['options'];
}

/** What the REST v1 list filters by. */
export interface ApiServiceQuery {
  readonly limit: number;
  readonly cursor?: string | undefined;
  readonly type?: ServiceType | undefined;
  readonly categoryId?: number | undefined;
  readonly q?: string | undefined;
}

const toApiView = (entry: CatalogEntry): ApiServiceView => ({
  ...toClientServiceView(entry),
  allowCancel: entry.service.allowCancel,
  allowVerify: entry.service.allowVerify,
  verifyWindowH: entry.service.verifyWindowH,
});

/** The `Requires.*` flags of the Dhru standard; a service says `None` unless its `requires` description says otherwise. */
const REQUIRES_FLAGS = [
  'Network',
  'Mobile',
  'Provider',
  'PIN',
  'KBH',
  'MEP',
  'PRD',
  'Type',
  'Locks',
  'SN',
  'SecRO',
  'Reference',
] as const;

const DHRU_FIELD_TYPES: Readonly<Record<ServiceFieldType, 'text' | 'textarea' | 'dropdown'>> = {
  text: 'text',
  number: 'text',
  select: 'dropdown',
  textarea: 'textarea',
};

/** The Dhru group a service type belongs to (file services are not part of `imeiservicelist`). */
const DHRU_TYPES: Readonly<Partial<Record<ServiceType, 'IMEI' | 'SERVER' | 'REMOTE'>>> = {
  imei: 'IMEI',
  server: 'SERVER',
  remote: 'REMOTE',
};

/**
 * Builds the `Requires.*` entries of one service for the Dhru list.
 *
 * @param service the service
 * @param fields its custom fields in order
 * @returns the twelve flags, the custom field descriptions
 */
function requiresOf(service: Service, fields: readonly ServiceField[]): Record<string, unknown> {
  const stored: Record<string, unknown> = service.requires;
  const out: Record<string, unknown> = {};
  for (const flag of REQUIRES_FLAGS) {
    const value = stored[flag];
    out[`Requires.${flag}`] = typeof value === 'string' && value !== '' ? value : 'None';
  }
  out['Requires.Custom'] = fields
    // The IMEI of an IMEI service is the order's own input (`IMEI`), not a custom field a client has to draw again.
    .filter((field) => !(service.type === 'imei' && field.key === 'imei'))
    .map((field) => ({
      type: `service${service.type}`,
      fieldname: field.key,
      fieldtype: DHRU_FIELD_TYPES[field.fieldType],
      description: field.label,
      fieldoptions: field.fieldType === 'select' ? field.options.join(',') : '',
      required: field.required ? 1 : 0,
    }));
  return out;
}

/**
 * Serves the merchant's catalog to REST v1 and Dhru.
 *
 * Why: the map's `GET /v1/services`, `GET /v1/services/:id` and `imeiservicelist` rows: an integration lists what it may order at its
 * own prices. Visibility and prices are the portal's (B159: live and active services in an active category open to the merchant's
 * group; the one price resolver); the lists differ only in shape. Every price shown is remembered (user rule 9, B158), so the order
 * path can refuse an order that costs much more than what was listed. Lists are not cached: a price list is never the truth for a
 * charge (the order path prices again), but staleness here would show an old price after a change, and the version key
 * (`CatalogPriceVersion.versioned`) is how a cache would stay honest if the cost of this read ever asks for one.
 *
 * Side effects: writes `listed_prices` (only when a price changed); it binds `imeiservicelist` to the Dhru gateway at start.
 *
 * @see docs/contract/MISMATCHES.md (B117, B158, B159)
 */
@Injectable()
export class MerchantApiCatalog implements OnModuleInit {
  constructor(
    private readonly db: DbService,
    private readonly catalog: MerchantCatalog,
    private readonly listedPrices: ListedPrices,
    private readonly gateway: DhruGateway,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  /** Binds `imeiservicelist` to the Dhru gateway. */
  onModuleInit(): void {
    this.gateway.bind(dhruServiceList, async ({ caller }) => ({
      MESSAGE: 'IMEI Service List' as const,
      LIST: await this.dhruList(caller.clientId),
    }));
  }

  /**
   * Reads a page of the catalog.
   *
   * @param clientId the merchant behind the API key
   * @param query the page size, cursor and filters
   * @returns the services at the merchant's prices and the cursor of the next page
   * @throws {AppError} `UNAUTHORIZED` when the merchant no longer exists; `VALIDATION_FAILED` on `cursor`
   */
  async list(clientId: number, query: ApiServiceQuery): Promise<{ data: ApiServiceView[]; nextCursor: string | null }> {
    const merchant = await this.merchantFor(clientId);
    const afterId = query.cursor === undefined ? undefined : decodeCursor(query.cursor, ['number'] as const)[0];
    const entries = await this.catalog.pageAfter(this.db.db, merchant, {
      limit: query.limit,
      ...(afterId === undefined ? {} : { afterId }),
      ...(query.type === undefined ? {} : { type: query.type }),
      ...(query.categoryId === undefined ? {} : { categoryId: query.categoryId }),
      ...(query.q === undefined ? {} : { search: query.q }),
    });
    const page = cutPage(entries, query.limit, (entry) => [entry.service.id]);
    await this.remember(clientId, page.data);
    return { data: page.data.map(toApiView), nextCursor: page.nextCursor };
  }

  /**
   * Shows one service with its fields and options.
   *
   * @param clientId the merchant behind the API key
   * @param serviceId the service id
   * @returns the service at the merchant's price with its order fields
   * @throws {AppError} `NOT_FOUND` (unknown, archived, off, or hidden from the merchant's group)
   */
  async show(clientId: number, serviceId: number): Promise<ApiServiceDetailView> {
    const merchant = await this.merchantFor(clientId);
    const entry = await this.catalog.find(this.db.db, merchant, serviceId);
    if (!entry) throw new AppError('NOT_FOUND', { detail: 'No service with this id is available to you.' });
    const [fields, options] = await Promise.all([
      listFieldRowsOf(this.db.db, [serviceId]),
      listOptionRows(this.db.db, serviceId),
    ]);
    await this.remember(clientId, [entry]);
    return {
      ...toApiView(entry),
      // The supplier's field names and values are internal: the merchant sees what its own order needs.
      fields: (fields.get(serviceId) ?? []).map((field) => ({
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
   * Builds the Dhru `LIST`: the merchant's IMEI, server and remote services grouped by category.
   *
   * @param clientId the merchant behind the API key
   * @returns the groups by name, each with its services by id
   */
  async dhruList(clientId: number): Promise<DhruList> {
    const merchant = await this.merchantFor(clientId);
    const entries = (await this.catalog.all(this.db.db, merchant)).filter((entry) => DHRU_TYPES[entry.service.type]);
    const fields = await listFieldRowsOf(
      this.db.db,
      entries.map((entry) => entry.service.id),
    );
    await this.remember(clientId, entries);
    const list: DhruList = {};
    const keyOfCategory = new Map<number, string>();
    for (const entry of entries) {
      const { service, category } = entry;
      let key = keyOfCategory.get(category.id);
      if (key === undefined) {
        // Two categories may share a name (one per service type): the group key stays unique.
        key = list[category.name] === undefined ? category.name : `${category.name} (${DHRU_TYPES[service.type]})`;
        keyOfCategory.set(category.id, key);
        list[key] = { GROUPNAME: category.name, GROUPTYPE: DHRU_TYPES[service.type]!, SERVICES: {} };
      }
      list[key]!.SERVICES[String(service.id)] = {
        SERVICEID: String(service.id),
        SERVICETYPE: DHRU_TYPES[service.type],
        SERVICENAME: service.name,
        CREDIT: entry.price.toWire(),
        INFO: service.info,
        TIME: service.deliveryTime,
        QNT: service.maxQty > service.minQty || service.qtyOptions.length > 0 ? '1' : '0',
        QNTOPTIONS: service.qtyOptions.join(','),
        MINQNT: String(service.minQty),
        MAXQNT: String(service.maxQty),
        ...requiresOf(service, fields.get(service.id) ?? []),
        // The `Requires.*` keys are built from a list of names; the gateway checks the whole entry against the contract's schema.
      } as DhruList[string]['SERVICES'][string];
    }
    return list;
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
