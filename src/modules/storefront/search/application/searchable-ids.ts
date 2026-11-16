// SearchableIds: the one rule of what the storefront search may hold and show (feature 29, plan section 4.1), used by the index build
// and by every re-check of a hit: sellable for the retail group, a retail price row, an English listing with `is_listed`.
import { Injectable } from '@nestjs/common';
import type { DbExecutor } from '../../../../infra/db';
import { ClientGroupDirectory, type SellableService, StorefrontServices } from '../../../catalog';
import { listedServiceIdsIn } from '../../infra/listing.repository';

/** The services that passed the rule, and the retail group it was judged for. */
export interface Searchable {
  /** The storefront's retail group; `undefined` when the shop has none (then nothing is searchable). */
  readonly retailGroupId: number | undefined;
  /** The searchable services by id (an id that failed the rule is absent). */
  readonly services: ReadonlyMap<number, SellableService>;
}

/**
 * Decides which services are search documents.
 *
 * Why: decision 038 ("every hit is re-checked"): the engine's documents are derived, so the build and every page of hits pass the
 * same rule against Postgres: catalog's sellable view for the retail group (live, active, active category, group allowed), a retail
 * price row (`service_group_prices` of the retail group) and a switched-on English listing (`listedServiceIdsIn(..., 'en')`; the
 * checkout's `listedServiceIds` accepts any language, the search does not). Merchant-only, unlisted, unpriced, Arabic-only and archived
 * services fail it.
 *
 * Side effects: none (three reads).
 */
@Injectable()
export class SearchableIds {
  constructor(
    private readonly groups: ClientGroupDirectory,
    private readonly services: StorefrontServices,
  ) {}

  /**
   * Finds the retail group.
   *
   * @param db the database or a transaction
   * @returns its id, or `undefined` when the shop has no retail group
   */
  async retailGroupId(db: DbExecutor): Promise<number | undefined> {
    return (await this.groups.findRetail(db))?.id;
  }

  /**
   * Applies the rule to some services.
   *
   * @param db the database or a transaction
   * @param ids the service ids
   * @param retailGroupId the retail group when the caller already read it
   * @returns the searchable services and the group
   */
  async of(db: DbExecutor, ids: readonly number[], retailGroupId?: number): Promise<Searchable> {
    const groupId = retailGroupId ?? (await this.retailGroupId(db));
    if (groupId === undefined || ids.length === 0) return { retailGroupId: groupId, services: new Map() };
    const sellable = await this.services.sellable(db, ids, groupId);
    const priced = await this.services.pricedAmong(db, [...sellable.keys()], groupId);
    const listed = await listedServiceIdsIn(db, [...priced], 'en');
    return {
      retailGroupId: groupId,
      services: new Map([...sellable].filter(([id]) => priced.has(id) && listed.has(id))),
    };
  }
}
