// The bulk publish's engine, without any route (feature 31, plan 31 section 6): the publisher, the preparer, the runner, the run switch,
// the Quick add hand-over, the outbox events and their routes. Loaded by the API (its routes write the events) and by the worker (its relay and its jobs need them).
import { Module } from '@nestjs/common';
import { CatalogModule, CatalogPricesModule } from '../../catalog';
import { AuditService } from '../../platform';
import { ListingPublisher } from '../application/listing-publisher';
import { SearchIndexModule } from '../search/search-index.module';
import { PublishDraftFacts } from './application/publish-draft-facts';
import { PublishFromQuickAdd } from './application/publish-from-quick-add';
import { PublishOutbox } from './application/publish-outbox';
import { PublishPreparer } from './application/publish-preparer';
import { PublishRunner } from './application/publish-runner';
import { PublishSwitch } from './application/publish-switch';
import { PublishOutboxRoutes } from './jobs/publish-outbox-routes';

/**
 * Provides {@link ListingPublisher}, {@link PublishPreparer}, {@link PublishRunner}, {@link PublishSwitch}, {@link PublishFromQuickAdd},
 * {@link PublishDraftFacts} and {@link PublishOutbox}, and registers the outbox routes of a publish run (and the route of the Quick add
 * hand-over event).
 *
 * Why: decisions 016 and 020: both processes run the same engine, so it lives in one module without controllers, and each relay only
 * knows the routes of its own process. The publisher needs no upload path, so the worker loads it without the HTTP modules. The module
 * brings the catalog's price providers and the search signals itself; the audit writer is a plain service of the database, and the worker
 * has no global audit module, so the module provides its own, like the other worker modules.
 *
 * @see docs/briefs/31-bulk-publish.md (section 6)
 */
@Module({
  imports: [CatalogModule, CatalogPricesModule, SearchIndexModule],
  providers: [
    AuditService,
    ListingPublisher,
    PublishDraftFacts,
    PublishFromQuickAdd,
    PublishOutbox,
    PublishOutboxRoutes,
    PublishPreparer,
    PublishRunner,
    PublishSwitch,
  ],
  exports: [
    ListingPublisher,
    PublishDraftFacts,
    PublishFromQuickAdd,
    PublishOutbox,
    PublishPreparer,
    PublishRunner,
    PublishSwitch,
  ],
})
export class PublishEngineModule {}
