// Nest module of the storefront search shared by the API and the worker (feature 29, decision 038): the change signals and their outbox
// routes, the searchable rule, the collections and the `search` health indicator.
import { Global, Inject, Module, type OnModuleInit } from '@nestjs/common';
import { APP_CONFIG, type AppConfig } from '../../../config';
import { HealthRegistry, HealthRegistryModule } from '../../../infra/health';
import { SearchHealthIndicator, TypesenseClient } from '../../../infra/search';
import { SearchCollections } from './application/search-collections';
import { SearchDocuments } from './application/search-documents';
import { SearchSignals } from './application/search-signals';
import { SearchableIds } from './application/searchable-ids';
import { SearchOutboxRoutes } from './jobs/search-outbox-routes';

/**
 * Provides {@link SearchSignals}, {@link SearchableIds}, {@link SearchDocuments} and {@link SearchCollections}, registers the search's
 * outbox routes and, while search is on, the `search` health indicator.
 *
 * Why: the API writes the events (the listing routes, the console's search routes) and needs the routes registered for
 * `OutboxService.add`; the worker relays and consumes them. Global, so the listing use cases and the search routes of slice B2 inject
 * the signals and the rule without importing it. The indicator is registered here and not by the infra `SearchModule` because the alias
 * it checks carries the schema version this module owns; with `SEARCH_ENABLED=false` it is left out, so `GET /health` is exactly
 * today's.
 */
@Global()
@Module({
  imports: [HealthRegistryModule],
  providers: [SearchSignals, SearchOutboxRoutes, SearchableIds, SearchDocuments, SearchCollections],
  exports: [SearchSignals, SearchableIds, SearchDocuments, SearchCollections],
})
export class SearchIndexModule implements OnModuleInit {
  constructor(
    private readonly registry: HealthRegistry,
    private readonly client: TypesenseClient,
    private readonly collections: SearchCollections,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  /** Registers the `search` indicator while search is on; the check itself runs only when `/health` is called. */
  onModuleInit(): void {
    if (!this.config.search.enabled) return;
    this.registry.register(new SearchHealthIndicator(this.client, this.collections.names.alias('services')));
  }
}
