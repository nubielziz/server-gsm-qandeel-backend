// SearchOutboxRoutes: registers the outbox routes of the storefront search (feature 29, plan section 4.5): the catalog's and the
// listings' change events and the settings event to the `search-index` queue, the rebuild request to `maintenance`.
// Loaded by the API (the writers' OutboxService.add needs the routes) and by the worker (its relay only knows its own process's routes).
import { Injectable, type OnModuleInit } from '@nestjs/common';
import { CATALOG_CATEGORY_CHANGED_EVENT, CATALOG_SERVICES_CHANGED_EVENT } from '../../../catalog';
import { OutboxRouteRegistry } from '../../../platform';
import {
  LISTING_CHANGED_EVENT,
  REBUILD_REQUESTED_EVENT,
  SEARCH_JOBS,
  SETTINGS_CHANGED_EVENT,
} from '../application/search-signals';

/**
 * Maps the search's events to their queues and jobs.
 *
 * Why: decision 038 ("change signals"): the catalog and the storefront write domain events; the search module is their consumer, so it
 * registers them: `catalog.services_changed`, `catalog.category_changed` and `storefront.listing_changed` become `search_sync` jobs,
 * `search.settings_changed` a `search_settings` job (all on `search-index`), and `search.rebuild_requested` a `search_rebuild` job on
 * `maintenance`. Without these routes `OutboxService.add` refuses the events (a programming error found by the first writer's test).
 *
 * Side effects: registers five routes at boot.
 */
@Injectable()
export class SearchOutboxRoutes implements OnModuleInit {
  constructor(private readonly routes: OutboxRouteRegistry) {}

  /** Registers the routes. */
  onModuleInit(): void {
    for (const type of [CATALOG_SERVICES_CHANGED_EVENT, CATALOG_CATEGORY_CHANGED_EVENT, LISTING_CHANGED_EVENT]) {
      this.routes.register({ type, queue: 'search-index', jobName: SEARCH_JOBS.sync });
    }
    this.routes.register({ type: SETTINGS_CHANGED_EVENT, queue: 'search-index', jobName: SEARCH_JOBS.settings });
    this.routes.register({ type: REBUILD_REQUESTED_EVENT, queue: 'maintenance', jobName: SEARCH_JOBS.rebuild });
  }
}
