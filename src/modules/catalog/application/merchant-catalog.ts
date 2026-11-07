// MerchantCatalog: the services a merchant may see, at the prices that merchant pays. The portal routes (GET /client/services,
// /client/services/:id, /client/prices/export) use it here; the Dhru and REST v1 lists (7a) and the storefront reuse it.
import { Injectable } from '@nestjs/common';
import type { ParsedListQuery } from '../../../common/contract';
import type { Money } from '../../../common/money';
import type { DbExecutor } from '../../../infra/db';
import type { Service } from '../db/schema';
import {
  findVisibleService,
  listVisibleServices,
  pageVisibleServices,
  pageVisibleServicesAfter,
  type ServiceCursorFilter,
  type VisibleServiceRow,
} from '../infra/merchant-catalog.repository';
import { PriceResolver } from './price-resolver';

/** Who is asking: the merchant and its group (the price and the visibility both follow the group). */
export interface CatalogMerchant {
  readonly clientId: number;
  readonly groupId: number;
}

/** A visible service with the price this merchant pays for it. */
export interface CatalogEntry {
  readonly service: Service;
  readonly category: { readonly id: number; readonly name: string };
  /** The resolved price for the merchant (client price, group price or base price with rule, discount, rounding and floor). */
  readonly price: Money;
}

/** The fields a catalog list may be sorted by (`category` is the category's own order). */
export type CatalogSort = 'category' | 'name' | 'type' | 'id';

/**
 * Lists the services a merchant may see with their prices.
 *
 * Why: user rule 9 and B117 (3): the portal catalog, the Dhru and REST v1 lists and the price export all show the real price,
 * resolved for the signed-in merchant by the one resolver (catalog-4). Visibility: live (not archived), `active`, in an active
 * category whose allowed groups are empty or include the merchant's group (RULES services 10, categories 5). It does not record
 * the listed prices: the caller does, with `ListedPrices.record`, because only the caller knows which rows the merchant was
 * actually shown.
 *
 * Side effects: none (reads only).
 */
@Injectable()
export class MerchantCatalog {
  constructor(private readonly resolver: PriceResolver) {}

  /**
   * Lists one page of the catalog.
   *
   * @param db the database or a transaction
   * @param merchant the merchant and its group
   * @param query the parsed list request
   * @returns the page of entries and the exact total
   */
  async page(
    db: DbExecutor,
    merchant: CatalogMerchant,
    query: ParsedListQuery<CatalogSort>,
  ): Promise<{ entries: CatalogEntry[]; total: number }> {
    const { rows, total } = await pageVisibleServices(db, merchant.groupId, query);
    return { entries: await this.priced(db, merchant, rows), total };
  }

  /**
   * Reads one page of the catalog by cursor, in id order (REST v1).
   *
   * @param db the database or a transaction
   * @param merchant the merchant and its group
   * @param options the page size (the page holds at most `limit` entries; one more is read to know whether another page follows),
   *   where to continue and the filters
   * @returns up to `limit + 1` entries; the extra one only says there is a next page
   */
  async pageAfter(
    db: DbExecutor,
    merchant: CatalogMerchant,
    options: { readonly limit: number; readonly afterId?: number } & ServiceCursorFilter,
  ): Promise<CatalogEntry[]> {
    return this.priced(
      db,
      merchant,
      await pageVisibleServicesAfter(db, merchant.groupId, { ...options, limit: options.limit + 1 }),
    );
  }

  /**
   * Finds one service the merchant may see.
   *
   * @param db the database or a transaction
   * @param merchant the merchant and its group
   * @param serviceId the service id
   * @returns the entry, or `undefined` when the service is unknown, archived, off or hidden from the group
   */
  async find(db: DbExecutor, merchant: CatalogMerchant, serviceId: number): Promise<CatalogEntry | undefined> {
    const row = await findVisibleService(db, merchant.groupId, serviceId);
    return row ? (await this.priced(db, merchant, [row]))[0] : undefined;
  }

  /**
   * Lists the whole visible catalog (up to 10,000 services), by category order then name.
   *
   * @param db the database or a transaction
   * @param merchant the merchant and its group
   * @param filter optional `type` and `categoryId` filters
   * @returns the entries
   */
  async all(
    db: DbExecutor,
    merchant: CatalogMerchant,
    filter: { readonly type?: Service['type']; readonly categoryId?: number } = {},
  ): Promise<CatalogEntry[]> {
    return this.priced(db, merchant, await listVisibleServices(db, merchant.groupId, filter));
  }

  private async priced(db: DbExecutor, merchant: CatalogMerchant, rows: VisibleServiceRow[]): Promise<CatalogEntry[]> {
    const context = await this.resolver.context(db, {
      serviceIds: rows.map((row) => row.service.id),
      clientIds: [merchant.clientId],
    });
    return rows.flatMap((row) => {
      const resolution = context.resolve({
        serviceId: row.service.id,
        groupId: merchant.groupId,
        clientId: merchant.clientId,
      });
      return resolution ? [{ service: row.service, category: row.category, price: resolution.price }] : [];
    });
  }
}
