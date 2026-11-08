// The routes and use cases of the public storefront catalog (stage 14): configuration, service list and service page, plus the
// services other modules use (the quotes and the policy switches). Separate from StorefrontModule so a test app built without a
// database can leave it out.
import { Global, Module } from '@nestjs/common';
import { StorefrontCatalogService } from './application/storefront-catalog.service';
import { StorefrontPolicies } from './application/storefront-policies';
import { StorefrontQuotes } from './application/storefront-quotes';
import { StorefrontPublicController } from './controllers/storefront-public.controller';

/**
 * Provides `/store/v1/config` and `/store/v1/services*` and the storefront services the checkout reuses.
 *
 * Why: these use cases need the global database, settings, clock, catalog and money providers, which a database-less test app
 * does not have. It is global because the customers module (checkout sessions, consents) prices a session with
 * `StorefrontQuotes` and reads `StorefrontPolicies`; `CurrentLegalDocuments` (which the catalog config and the consents use) is
 * provided by the global `StorefrontModule`.
 */
@Global()
@Module({
  controllers: [StorefrontPublicController],
  providers: [StorefrontQuotes, StorefrontPolicies, StorefrontCatalogService],
  exports: [StorefrontQuotes, StorefrontPolicies],
})
export class StorefrontPublicModule {}
