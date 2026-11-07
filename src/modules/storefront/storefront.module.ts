// Storefront & content module (map domain H): service listings, content pages, help articles and legal documents (docs/ARCHITECTURE.md § 2).
// Stage 14 built the public catalog: configuration, the service list and the service page. The admin routes arrive with feature 15.
import { Module } from '@nestjs/common';
import { StorefrontPublicModule } from './storefront-public.module';

/**
 * Nest module for Storefront & content (map domain H).
 *
 * Why: one module per map domain, each owning its tables and exposing a public service through `index.ts` (decision 016). The
 * routes with their use cases (`StorefrontPublicModule`) are separate so a test app built without a database can leave out
 * what needs it.
 */
@Module({ imports: [StorefrontPublicModule] })
export class StorefrontModule {}
