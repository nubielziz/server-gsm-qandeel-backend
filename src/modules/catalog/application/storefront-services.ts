// StorefrontServices and TacDirectory: the read-only views of the catalog the storefront and the IMEI check use (feature 14a).
// The storefront module prices and lists; this file only says which services a group may buy and what the TAC catalogue knows.
import { Injectable } from '@nestjs/common';
import { Money } from '../../../common/money';
import type { DbExecutor } from '../../../infra/db';
import type { ServiceFieldType, ServiceType } from '../db/schema';
import {
  findPricedServiceIds,
  findSellableServices,
  findServiceNames,
  findServiceFields,
  findTacEntry,
} from '../infra/storefront-services.repository';

/** A service as the storefront needs it: no cost, no supplier, no staff-only flag. */
export interface SellableService {
  readonly id: number;
  readonly name: string;
  readonly type: ServiceType;
  readonly categoryName: string;
  /** The service's own text, shown on its page. */
  readonly info: string;
  /** The delivery time as text (`'1 day'`). */
  readonly deliveryTime: string;
  readonly slaMinutes: number;
  /** The base price: the storefront floor starts from it (catalog-12). */
  readonly basePrice: Money;
  readonly minQty: number;
  readonly maxQty: number;
  readonly qtyOptions: readonly number[];
}

/** A service as a buyer's own record names it: no price, no visibility rule. */
export interface ServiceName {
  readonly id: number;
  readonly name: string;
  readonly type: ServiceType;
  readonly deliveryTime: string;
}

/** An order field of a service as the storefront shows it. */
export interface SellableField {
  readonly id: number;
  readonly key: string;
  readonly label: string;
  readonly fieldType: ServiceFieldType;
  readonly options: readonly string[];
  readonly required: boolean;
  /** A regular expression the value must match; `''` for none. */
  readonly regex: string;
  /** The form order (with `id` as the tie-break); the checkout picks the main input by it. */
  readonly sort: number;
}

/**
 * Says which services a merchant group may buy and what their order forms ask.
 *
 * Why: catalog-3 and the storefront rules: archived or disabled services, services in an inactive category and services whose
 * category excludes the storefront's retail group are never listed or sold. The storefront passes the retail group id and gets
 * only what it may show; the rule is the merchant catalog's (`visibleTo`), so the portal and the shop never disagree.
 *
 * Side effects: none (reads only).
 */
@Injectable()
export class StorefrontServices {
  /**
   * Lists the ids of the services the storefront may sell: visible to the group and priced for it.
   *
   * @param db the database or a transaction
   * @param groupId the storefront's retail group
   * @returns the ids in ascending order
   */
  priced(db: DbExecutor, groupId: number): Promise<number[]> {
    return findPricedServiceIds(db, groupId);
  }

  /**
   * Reads the sellable services among some ids.
   *
   * @param db the database or a transaction
   * @param ids the service ids
   * @param groupId the group whose visibility counts
   * @returns the visible services by id (an unknown, archived, disabled or hidden one is absent)
   */
  async sellable(db: DbExecutor, ids: readonly number[], groupId: number): Promise<Map<number, SellableService>> {
    const rows = await findSellableServices(db, ids, groupId);
    return new Map(
      rows.map(({ service, categoryName }) => [
        service.id,
        {
          id: service.id,
          name: service.name,
          type: service.type,
          categoryName,
          info: service.info,
          deliveryTime: service.deliveryTime,
          slaMinutes: service.slaMinutes,
          basePrice: Money.of(service.basePrice),
          minQty: service.minQty,
          maxQty: service.maxQty,
          qtyOptions: service.qtyOptions,
        },
      ]),
    );
  }

  /**
   * Reads the names of services whatever their state.
   *
   * @param db the database or a transaction
   * @param ids the service ids
   * @returns name, type and delivery time by id (an id that does not exist is absent)
   */
  async names(db: DbExecutor, ids: readonly number[]): Promise<Map<number, ServiceName>> {
    const rows = await findServiceNames(db, ids);
    return new Map(
      rows.map((row) => [row.id, { id: row.id, name: row.name, type: row.type, deliveryTime: row.deliveryTime }]),
    );
  }

  /**
   * Reads the order fields of a service.
   *
   * @param db the database or a transaction
   * @param serviceId the service
   * @returns the fields in form order (the supplier's field name is not part of it)
   */
  async fields(db: DbExecutor, serviceId: number): Promise<SellableField[]> {
    const rows = await findServiceFields(db, serviceId);
    return rows.map((row) => ({
      id: row.id,
      sort: row.sort,
      key: row.key,
      label: row.label,
      fieldType: row.fieldType,
      options: row.options,
      required: row.required,
      regex: row.regex,
    }));
  }
}

/** A TAC catalogue entry as the IMEI check shows it. */
export interface TacRef {
  readonly tac: string;
  readonly brand: string;
  readonly model: string;
  readonly marketingName: string;
  readonly releaseYear: number | null;
}

/**
 * Looks up the brand and model of a TAC.
 *
 * Why: the IMEI check recognises a device by the first 8 digits (RESOLUTIONS b2c-3, map `tac_catalog`); the catalog module owns
 * the table, so the risk module asks here.
 *
 * Side effects: none (reads only).
 */
@Injectable()
export class TacDirectory {
  /**
   * Finds a TAC.
   *
   * @param db the database or a transaction
   * @param tac exactly 8 digits
   * @returns the entry, or `undefined` when the catalogue does not know the TAC
   */
  async find(db: DbExecutor, tac: string): Promise<TacRef | undefined> {
    const row = await findTacEntry(db, tac);
    return row === undefined
      ? undefined
      : {
          tac: row.tac,
          brand: row.brand,
          model: row.model,
          marketingName: row.marketingName,
          releaseYear: row.releaseYear,
        };
  }
}
