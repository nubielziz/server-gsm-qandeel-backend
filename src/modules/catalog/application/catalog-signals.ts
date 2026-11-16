// CatalogSignals: the domain events a catalog change writes to the outbox when it changes a fact the storefront search indexes
// (feature 29, decision 038): `catalog.services_changed` and `catalog.category_changed`, ids only, in the writer's transaction.
import { Injectable } from '@nestjs/common';
import type { DbExecutor } from '../../../infra/db';
import { OutboxService } from '../../platform';

/** The outbox event of services whose searchable facts may have changed (`{ serviceIds, reason }`, aggregate `services`). */
export const CATALOG_SERVICES_CHANGED_EVENT = 'catalog.services_changed';
/** The outbox event of a category whose name, switch or groups changed (`{ categoryId }`, aggregate `service_categories`). */
export const CATALOG_CATEGORY_CHANGED_EVENT = 'catalog.category_changed';

/**
 * Why services changed: a metric label of the consumer only.
 *
 * Why: plan section 4.5: `service` (create, edit, archive, delete), `price` (the group prices, the retail row included), `options`
 * (the model and network lists), `stock` (inventory codes in or out).
 */
export const SERVICE_CHANGE_REASONS = ['service', 'price', 'options', 'stock'] as const;

/** One value of {@link SERVICE_CHANGE_REASONS}. */
export type ServiceChangeReason = (typeof SERVICE_CHANGE_REASONS)[number];

/** The most ids one event carries (the outbox payload limit is 50 elements and 2048 bytes; 50 ids of 10 digits fit). */
export const MAX_IDS_PER_EVENT = 50;

/**
 * Splits ids into events of at most {@link MAX_IDS_PER_EVENT}: distinct, ascending.
 *
 * Why: plan section 4.5: an outbox payload holds at most 50 list elements (a longer list is a `RangeError` that would roll the
 * writer's transaction back), so a change of 120 services writes 3 events in the same transaction.
 *
 * @param ids the ids of one change
 * @param size the chunk size (default 50)
 * @returns the chunks; none for no id
 */
export function idChunks(ids: readonly number[], size = MAX_IDS_PER_EVENT): number[][] {
  const distinct = [...new Set(ids)].filter((id) => Number.isSafeInteger(id) && id > 0).sort((a, b) => a - b);
  const chunks: number[][] = [];
  for (let start = 0; start < distinct.length; start += size) chunks.push(distinct.slice(start, start + size));
  return chunks;
}

/**
 * Writes the catalog's change events for the search index.
 *
 * Why: decision 038 ("change signals"): every writer of an indexed fact writes a domain event with ids in its own transaction, so a
 * rolled-back change writes none and a committed change never loses its event; the storefront's `search-index` queue applies them
 * (the catalog never calls the search code). The queue route is registered by the storefront search module, which the API and the
 * worker load.
 *
 * Side effects: inserts `outbox_events` rows on the caller's transaction.
 *
 * @see docs/queues.md (search-index)
 */
@Injectable()
export class CatalogSignals {
  constructor(private readonly outbox: OutboxService) {}

  /**
   * Records that some services changed.
   *
   * @param tx the writer's transaction
   * @param serviceIds the services (split into events of 50)
   * @param reason what changed (a metric label)
   */
  async servicesChanged(tx: DbExecutor, serviceIds: readonly number[], reason: ServiceChangeReason): Promise<void> {
    for (const chunk of idChunks(serviceIds)) {
      await this.outbox.add(tx, {
        type: CATALOG_SERVICES_CHANGED_EVENT,
        aggregateType: 'services',
        aggregateId: chunk[0]!,
        payload: { serviceIds: chunk, reason },
      });
    }
  }

  /**
   * Records that a category changed (its services' visibility or category name may have changed).
   *
   * @param tx the writer's transaction
   * @param categoryId the category
   */
  async categoryChanged(tx: DbExecutor, categoryId: number): Promise<void> {
    await this.outbox.add(tx, {
      type: CATALOG_CATEGORY_CHANGED_EVENT,
      aggregateType: 'service_categories',
      aggregateId: categoryId,
      payload: { categoryId },
    });
  }
}
