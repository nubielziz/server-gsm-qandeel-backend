// The HTTP side of the storefront search (feature 29, decision 038): the public routes (`/store/v1/search*`), the console's index tools
// (`/admin/search/index*`) and the services they and the public catalog list share. API only; the worker has the index and sync modules.
import { Global, Module } from '@nestjs/common';
import { JobRunsModule } from '../../health';
import { SearchFacetLabels } from './application/facet-labels';
import { ResultsService } from './application/results.service';
import { SearchAdminService } from './application/search-admin.service';
import { SearchCards } from './application/search-cards';
import { SearchEngine } from './application/search-engine';
import { SearchMatches } from './application/search-matches';
import { SearchResolver } from './application/search-resolver';
import { SearchTermsCounter } from './application/search-terms-counter';
import { SuggestService } from './application/suggest.service';
import { AdminSearchController } from './controllers/admin-search.controller';
import { StoreSearchController } from './controllers/store-search.controller';

/**
 * Provides the search routes and the engine-facing services.
 *
 * Why: these use cases need the global database, cache, Redis, audit and clock providers, which a database-less test app does not have, so
 * the module is separate (and replaced there). It is global because the public catalog list (`GET /store/v1/services?q=`) takes its
 * match set from the engine through {@link SearchMatches}, and counts searches with {@link SearchTermsCounter}.
 */
@Global()
@Module({
  imports: [JobRunsModule],
  controllers: [StoreSearchController, AdminSearchController],
  providers: [
    SearchEngine,
    SearchFacetLabels,
    SearchCards,
    SearchMatches,
    SearchResolver,
    SearchTermsCounter,
    SuggestService,
    ResultsService,
    SearchAdminService,
  ],
  exports: [SearchMatches, SearchResolver, SearchTermsCounter],
})
export class SearchHttpModule {}
