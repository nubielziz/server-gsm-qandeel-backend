// Storefront & content module (map domain H): service listings, content pages, help articles and legal documents (docs/ARCHITECTURE.md § 2).
// It provides the read-only CurrentLegalDocuments (no connection: callers pass their database handle) and imports the public catalog
// (stage 14: configuration, the service list and the service page); the admin and public content routes are StorefrontContentModule.
import { Global, Module } from '@nestjs/common';
import { CurrentLegalDocuments } from './application/legal-documents';
import { StorefrontPublicModule } from './storefront-public.module';

/**
 * Nest module for Storefront & content (map domain H).
 *
 * Why: one module per map domain, each owning its tables and exposing a public service through `index.ts` (decision 016). It is
 * global so the checkouts of the customers feature can inject the legal documents (the version a consent references) without
 * importing the module. `CurrentLegalDocuments` needs no infrastructure, so a test app built without a database keeps it, like
 * catalog's directory and resolver. The routes with their use cases (`StorefrontPublicModule`, `StorefrontContentModule`) are
 * separate so a test app built without a database can leave out what needs it.
 */
@Global()
@Module({
  imports: [StorefrontPublicModule],
  providers: [CurrentLegalDocuments],
  exports: [CurrentLegalDocuments],
})
export class StorefrontModule {}
