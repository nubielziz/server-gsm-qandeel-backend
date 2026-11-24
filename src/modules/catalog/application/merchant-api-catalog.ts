// MerchantApiCatalog: the catalog as Dhru shows it (map domain B, stage 7): the `imeiservicelist` action. It remembers the prices it
// showed (user rule 9).
import { Inject, Injectable, type OnModuleInit } from '@nestjs/common';
import type { z } from 'zod';
import { CLOCK, type Clock } from '../../../common/clock';
import { DhruGateway } from '../../../common/dhru';
import { AppError } from '../../../common/errors';
import { DbService } from '../../../infra/db';
import { dhruServiceList } from '../contracts/dhru-services.contracts';
import type { Service, ServiceField, ServiceFieldType, ServiceType } from '../db/schema';
import { merchantOf } from '../infra/foreign-reads.repository';
import { listFieldRowsOf } from '../infra/service.repository';
import { ListedPrices } from './listed-prices';
import { type CatalogEntry, type CatalogMerchant, MerchantCatalog } from './merchant-catalog';

/** The `LIST` of the Dhru service list as the contract describes it. */
type DhruList = z.input<(typeof dhruServiceList)['success']>['LIST'];

/** The currency every catalog price is shown in. */
const CURRENCY = 'USD';

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
 * Serves the merchant's catalog to Dhru.
 *
 * Why: the map's `imeiservicelist` row: a Dhru client lists what it may order at its own prices. Visibility and prices are the
 * portal's (B159: live and active services in an active category open to the merchant's group; the one price resolver); the list differs
 * only in shape. Every price shown is remembered (user rule 9, B158), so the order path can refuse an order that costs much more than
 * what was listed. The list is not cached: a price list is never the truth for a charge (the order path prices again), but staleness
 * here would show an old price after a change, and the version key (`CatalogPriceVersion.versioned`) is how a cache would stay honest
 * if the cost of this read ever asks for one.
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
