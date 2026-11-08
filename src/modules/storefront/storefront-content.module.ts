// The admin and public content routes of the storefront module (feature 15): listings, content pages, help articles and legal
// documents, and the public pages and help centre. Separate from StorefrontModule so a test app built without a database can
// leave it out while the legal documents read stays available.
import { Module } from '@nestjs/common';
import { ContentPageAdminService } from './application/content-page-admin.service';
import { HelpArticleAdminService } from './application/help-article-admin.service';
import { LegalDocumentAdminService } from './application/legal-document-admin.service';
import { PageGeneratorService } from './application/page-generator.service';
import { ListingAdminService } from './application/listing-admin.service';
import { PublicContentService } from './application/public-content.service';
import { ContentPagesController } from './controllers/content-pages.controller';
import { HelpArticlesController } from './controllers/help-articles.controller';
import { LegalDocumentsController } from './controllers/legal-documents.controller';
import { ListingsController } from './controllers/listings.controller';
import { PublicContentController } from './controllers/public-content.controller';

/**
 * Provides `/admin/service-listings`, `/admin/content-pages` (with the landing-page generator), `/admin/help-articles`, `/admin/legal-documents` and the public
 * `/store/v1/pages/:slug`, `/store/v1/help` and `/store/v1/help/:slug`.
 *
 * Why: these use cases need the global database, audit, clock and (for the retail price) cache providers, which a
 * database-less test app does not have; `CurrentLegalDocuments` (the global `StorefrontModule`) needs none of them.
 */
@Module({
  controllers: [
    ListingsController,
    ContentPagesController,
    HelpArticlesController,
    LegalDocumentsController,
    PublicContentController,
  ],
  providers: [
    ListingAdminService,
    ContentPageAdminService,
    HelpArticleAdminService,
    LegalDocumentAdminService,
    PageGeneratorService,
    PublicContentService,
  ],
})
export class StorefrontContentModule {}
