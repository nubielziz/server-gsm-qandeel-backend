// Unit tests of the storefront search's outbox routes (feature 29, plan section 4.5): the five event types go to their exact queue and
// job, and both processes load the module that registers them (each relay only knows the routes of its own process, decision 020).
// The integration suite calls the processors directly, so a wrong queue or job name, or a module dropped from a root module, is caught
// here only.
import { describe, expect, it } from 'bun:test';
import { WorkerModule } from '@src/worker.module';
import { AppModule } from '@src/app.module';
import { OutboxRouteRegistry } from '@src/modules/platform';
import { SearchIndexModule } from '@src/modules/storefront/search/search-index.module';
import { SearchWorkerModule } from '@src/modules/storefront/search/search-worker.module';
import { SearchOutboxRoutes } from '@src/modules/storefront/search/jobs/search-outbox-routes';

describe('SearchOutboxRoutes', () => {
  it('registers the three change events to search_sync, the settings event to search_settings and the rebuild to maintenance', () => {
    const registry = new OutboxRouteRegistry();
    new SearchOutboxRoutes(registry).onModuleInit();
    expect(registry.list()).toEqual([
      { type: 'catalog.services_changed', queue: 'search-index', jobName: 'search_sync' },
      { type: 'catalog.category_changed', queue: 'search-index', jobName: 'search_sync' },
      { type: 'storefront.listing_changed', queue: 'search-index', jobName: 'search_sync' },
      { type: 'search.settings_changed', queue: 'search-index', jobName: 'search_settings' },
      { type: 'search.rebuild_requested', queue: 'maintenance', jobName: 'search_rebuild' },
    ]);
  });

  it('is loaded by the worker through SearchWorkerModule, and by the API through SearchIndexModule', () => {
    expect(Reflect.getMetadata('imports', WorkerModule) as unknown[]).toContain(SearchWorkerModule);
    expect(Reflect.getMetadata('imports', SearchWorkerModule) as unknown[]).toContain(SearchIndexModule);
    expect(Reflect.getMetadata('imports', AppModule) as unknown[]).toContain(SearchIndexModule);
    expect(Reflect.getMetadata('providers', SearchIndexModule) as unknown[]).toContain(SearchOutboxRoutes);
  });
});
