// ClientPriceAdminService: the use cases of the client price routes (map domain B, stage 4): a merchant's fixed price for a
// service, which beats the group price, the pricing rules and every discount. Rules: above zero, never under the floor of the
// merchant's group, one price per merchant and service.
import { Inject, Injectable } from '@nestjs/common';
import { CLOCK, type Clock } from '../../../common/clock';
import type { ParsedListQuery } from '../../../common/contract';
import { AppError } from '../../../common/errors';
import { Money } from '../../../common/money';
import { type DbExecutor, DbService, isUniqueViolation } from '../../../infra/db';
import { AuditService } from '../../platform';
import type { Service, ServiceClientPrice, ServiceType } from '../db/schema';
import { belowFloorMessage } from '../domain/price-resolution';
import {
  type ClientPriceRow,
  deleteClientPriceRow,
  findClientPriceByPair,
  findClientPriceRow,
  insertClientPrice,
  listClientPriceRows,
  lockClientPriceRow,
  updateClientPriceRow,
} from '../infra/client-price.repository';
import { type MerchantRef, merchantOf, merchantsOf } from '../infra/foreign-reads.repository';
import { lockLiveService } from '../infra/service.repository';
import { CatalogPriceVersion } from './catalog-price-version';
import { type PricingContext, PriceResolver } from './price-resolver';

/** A client price as the console reads it. */
export interface ClientPriceView {
  readonly id: number;
  readonly serviceId: number;
  readonly clientId: number;
  readonly price: string;
  readonly note: string;
  readonly createdAt: string;
  readonly service: {
    id: number;
    name: string;
    type: ServiceType;
    basePrice: string | null;
    floorPrice: string | null;
  };
  readonly groupPrice: string | null;
}

/** The fields of `POST /admin/client-prices`. */
export interface CreateClientPriceInput {
  readonly clientId: number;
  readonly serviceId: number;
  readonly price: string;
  readonly note?: string | undefined;
}

/** The fields `PATCH /admin/client-prices/:id` may change. */
export interface UpdateClientPriceInput {
  readonly price?: string | undefined;
  readonly note?: string | undefined;
}

function invalid(field: string, message: string, code = 'invalid'): AppError {
  return new AppError('VALIDATION_FAILED', { errors: [{ field, code, message }] });
}

const priceExists = () =>
  new AppError('PRICE_EXISTS', {
    detail: 'This merchant already has a fixed price for that service.',
    errors: [
      {
        field: 'serviceId',
        code: 'PRICE_EXISTS',
        message: 'This merchant already has a fixed price for that service.',
      },
    ],
  });

const notFound = () => new AppError('NOT_FOUND', { detail: 'No client price has this id.' });

/** The audit label of a client price: the merchant and the service, as the demo logs it (`Zain Mobile, IMEI-ATT-USA`). */
const labelOf = (merchantName: string, service: Pick<Service, 'code'>): string => `${merchantName}, ${service.code}`;

const snapshot = (price: ServiceClientPrice) => ({ price: price.price, note: price.note });

/**
 * Manages the fixed prices of merchants.
 *
 * Why: staff agree a price with one merchant for one service; from the next order it beats everything else (RESOLUTIONS
 * catalog-4, step 1). It can never be below the floor of the merchant's group (effective cost plus the minimum profit that counts
 * for that group, catalog-1), so a fixed price cannot sell below a supplier's raised cost. Each row also shows what the merchant
 * would pay without it (`groupPrice`, catalog-16): the resolver result for its group after rounding and the floor clamp.
 *
 * Side effects: writes `service_client_prices` and `audit_logs` (entity `merchant`, `set client price for` or `removed client
 * price for`, like the demo); moves the catalog price version after the commit.
 *
 * @see docs/contract/endpoints/catalog.md (the `/admin/client-prices` sections)
 */
@Injectable()
export class ClientPriceAdminService {
  constructor(
    private readonly db: DbService,
    private readonly audit: AuditService,
    private readonly resolver: PriceResolver,
    private readonly priceVersion: CatalogPriceVersion,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  /**
   * Lists client prices with their service, floor and group price.
   *
   * @param query the parsed list request
   * @returns the page of prices and the exact total
   */
  async list(
    query: ParsedListQuery<'service.name' | 'price' | 'createdAt' | 'id'>,
  ): Promise<{ rows: ClientPriceView[]; total: number }> {
    const { rows, total } = await listClientPriceRows(this.db.db, query);
    return { rows: await this.views(this.db.db, rows), total };
  }

  /**
   * Sets a merchant's fixed price for a service.
   *
   * @param input merchant, service, price and an optional note
   * @param staffId the staff member who sets it (`created_by`)
   * @returns the new price with its joins
   * @throws {AppError} `VALIDATION_FAILED` (422 on `serviceId` for an unknown, archived or turned-off service, on `clientId` for
   *   an unknown merchant, on `price` under the merchant group's floor); `PRICE_EXISTS` (409)
   */
  async create(input: CreateClientPriceInput, staffId: number): Promise<ClientPriceView> {
    return this.db.runInTransaction(async (work) => {
      const { tx } = work;
      const service = await lockLiveService(tx, input.serviceId, 'share');
      if (!service) throw invalid('serviceId', 'This service does not exist.', 'unknown');
      if (service.status !== 'active') throw invalid('serviceId', 'This service is turned off.', 'inactive');
      const merchant = await merchantOf(tx, input.clientId);
      if (!merchant) throw invalid('clientId', 'This merchant does not exist.', 'unknown');
      await this.assertAboveFloor(tx, service.id, merchant, input.price);
      if (await findClientPriceByPair(tx, merchant.id, service.id)) throw priceExists();

      let created: ServiceClientPrice;
      try {
        created = await insertClientPrice(tx, {
          serviceId: service.id,
          clientId: merchant.id,
          price: input.price,
          note: input.note ?? '',
          createdBy: staffId,
        });
      } catch (error) {
        if (isUniqueViolation(error, 'service_client_prices_uq')) throw priceExists();
        throw error;
      }
      this.priceVersion.bumpAfterCommit(work);
      await this.audit.record(tx, {
        action: 'set client price for',
        entityType: 'merchant',
        entityId: merchant.id,
        entityLabel: labelOf(merchant.name, service),
        before: null,
        after: snapshot(created),
      });
      return this.viewOf(tx, created.id);
    });
  }

  /**
   * Changes the price or the note of a fixed price.
   *
   * @param id the client price id
   * @param changes the keys to change
   * @returns the updated price with its joins
   * @throws {AppError} `NOT_FOUND` (404: unknown, or its service is archived); `VALIDATION_FAILED` (422 on `price` under the
   *   floor of the merchant's group)
   */
  async update(id: number, changes: UpdateClientPriceInput): Promise<ClientPriceView> {
    return this.db.runInTransaction(async (work) => {
      const { tx } = work;
      const row = await lockClientPriceRow(tx, id);
      if (!row) throw notFound();
      const merchant = await merchantOf(tx, row.price.clientId);
      if (changes.price !== undefined) {
        await this.assertAboveFloor(tx, row.service.id, merchant, changes.price);
      }
      const after = await updateClientPriceRow(tx, id, {
        ...(changes.price === undefined ? {} : { price: changes.price }),
        ...(changes.note === undefined ? {} : { note: changes.note }),
      });
      if (changes.price !== undefined) this.priceVersion.bumpAfterCommit(work);
      await this.audit.record(tx, {
        action: 'set client price for',
        entityType: 'merchant',
        entityId: row.price.clientId,
        entityLabel: labelOf(merchant?.name ?? `Merchant ${row.price.clientId}`, row.service),
        before: snapshot(row.price),
        after: snapshot(after!),
      });
      return this.viewOf(tx, id);
    });
  }

  /**
   * Removes a fixed price: the merchant pays the group price again from its next order.
   *
   * @param id the client price id
   * @throws {AppError} `NOT_FOUND` (404: unknown, or its service is archived)
   */
  async remove(id: number): Promise<void> {
    await this.db.runInTransaction(async (work) => {
      const { tx } = work;
      const row = await lockClientPriceRow(tx, id);
      if (!row) throw notFound();
      const merchant = await merchantOf(tx, row.price.clientId);
      await deleteClientPriceRow(tx, id);
      this.priceVersion.bumpAfterCommit(work);
      await this.audit.record(tx, {
        action: 'removed client price for',
        entityType: 'merchant',
        entityId: row.price.clientId,
        entityLabel: labelOf(merchant?.name ?? `Merchant ${row.price.clientId}`, row.service),
        before: snapshot(row.price),
        after: null,
      });
    });
  }

  /** Refuses a price under the floor of the merchant's group (the message of RESOLUTIONS catalog-12). */
  private async assertAboveFloor(
    tx: DbExecutor,
    serviceId: number,
    merchant: MerchantRef | undefined,
    price: string,
  ): Promise<void> {
    const context = await this.resolver.context(tx, { serviceIds: [serviceId], at: this.clock.now() });
    const quote = context.floor(serviceId, merchant?.groupId ?? null)!;
    if (Money.of(price).cmp(quote.floor) < 0) {
      throw invalid('price', belowFloorMessage(quote.cost, quote.minProfit), 'below_floor');
    }
  }

  private async viewOf(db: DbExecutor, id: number): Promise<ClientPriceView> {
    const row = (await findClientPriceRow(db, id))!;
    return (await this.views(db, [row]))[0]!;
  }

  /** Builds the console rows for a page: one query for the merchants and one load for the resolver. */
  private async views(db: DbExecutor, rows: readonly ClientPriceRow[]): Promise<ClientPriceView[]> {
    if (rows.length === 0) return [];
    const merchants = await merchantsOf(
      db,
      rows.map((row) => row.price.clientId),
    );
    const context: PricingContext = await this.resolver.context(db, {
      serviceIds: rows.map((row) => row.service.id),
      at: this.clock.now(),
    });
    return rows.map(({ price, service }) => {
      // The price the merchant would pay without the override, for its group (catalog-16).
      const without = context.resolve({
        serviceId: service.id,
        groupId: merchants.get(price.clientId)?.groupId ?? null,
        clientId: null,
      });
      return {
        id: price.id,
        serviceId: price.serviceId,
        clientId: price.clientId,
        price: price.price,
        note: price.note,
        createdAt: price.createdAt.toISOString(),
        service: {
          id: service.id,
          name: service.name,
          type: service.type,
          basePrice: service.basePrice,
          floorPrice: without?.floor.toWire() ?? null,
        },
        groupPrice: without?.price.toWire() ?? null,
      };
    });
  }
}
