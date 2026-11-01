// Storefront tables (map domain H): public service pages, landing and blog pages, help articles, legal documents.
// Conventions: decision 027; schema additions: MISMATCHES B116; ownership: scripts/module-map.mjs.
import { sql } from 'drizzle-orm';
import {
  boolean,
  check,
  index,
  integer,
  pgTable,
  text,
  unique,
  uniqueIndex,
  type AnyPgColumn,
} from 'drizzle-orm/pg-core';
import { createdAt, fk, inList, jsonObject, pk, timestampTz, updatedAt } from '../../../infra/db/columns';
import { services } from '../../catalog/db/schema';
import { staffUsers } from '../../identity/db/schema';
import { files } from '../../platform/db/schema';

/**
 * Kinds of content page: five landing kinds, static pages and the blog.
 *
 * Why: the console's content page wire enum (GET /admin/content-pages).
 */
export const CONTENT_PAGE_KINDS = ['country', 'model', 'brand', 'carrier', 'tool', 'static', 'blog'] as const;

/** One value of {@link CONTENT_PAGE_KINDS}. */
export type ContentPageKind = (typeof CONTENT_PAGE_KINDS)[number];

/**
 * Publication state of a content page; `noindex` is live but hidden from search engines.
 *
 * Why: the console's content page wire enum (B56).
 */
export const CONTENT_PAGE_STATUSES = ['draft', 'published', 'noindex'] as const;

/** One value of {@link CONTENT_PAGE_STATUSES}. */
export type ContentPageStatus = (typeof CONTENT_PAGE_STATUSES)[number];

/**
 * The public service page in the storefront: title, slug and SEO fields per language.
 *
 * Why: The public service page of the storefront, per language: title, slug and SEO (routes /admin/service-listings).
 */
export const serviceListings = pgTable(
  'service_listings',
  {
    id: pk(),
    serviceId: fk((): AnyPgColumn => services.id).notNull(),
    locale: text().notNull().default('en'),
    slug: text().notNull(),
    publicTitle: text().notNull(),
    summary: text().notNull().default(''),
    descriptionMd: text().notNull().default(''),
    etaText: text().notNull().default(''),
    requirementsMd: text().notNull().default(''),
    brand: text().notNull().default(''),
    carrier: text().notNull().default(''),
    country: text().notNull().default(''),
    isListed: boolean().notNull().default(false),
    isFeatured: boolean().notNull().default(false),
    sort: integer().notNull().default(0),
    seoTitle: text().notNull().default(''),
    seoDescription: text().notNull().default(''),
    ogFileId: fk((): AnyPgColumn => files.id),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    unique('service_listings_service_locale_uq').on(t.serviceId, t.locale),
    unique('service_listings_slug_uq').on(t.locale, t.slug),
    index('service_listings_listed_idx').on(t.isListed, t.sort),
    index('service_listings_public_title_idx').on(t.publicTitle),
    index('service_listings_og_file_id_idx').on(t.ogFileId),
  ],
);

/** A row read from `service_listings`. */
export type ServiceListing = typeof serviceListings.$inferSelect;

/** A row to insert into `service_listings`. */
export type NewServiceListing = typeof serviceListings.$inferInsert;

/**
 * Landing pages, static pages and the blog, in several languages.
 *
 * Why: Landing pages, static pages and the blog, in several languages (routes /admin/content-pages).
 */
export const contentPages = pgTable(
  'content_pages',
  {
    id: pk(),
    kind: text().$type<ContentPageKind>().notNull(),
    slug: text().notNull(),
    locale: text().notNull().default('en'),
    title: text().notNull(),
    bodyMd: text().notNull().default(''),
    seoTitle: text().notNull().default(''),
    seoDescription: text().notNull().default(''),
    canonicalUrl: text(),
    status: text().$type<ContentPageStatus>().notNull().default('draft'),
    publishedAt: timestampTz(),
    authorId: fk((): AnyPgColumn => staffUsers.id),
    templateParams: jsonObject(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    unique('content_pages_slug_uq').on(t.locale, t.slug),
    check('content_pages_kind_check', inList(t.kind, CONTENT_PAGE_KINDS)),
    check('content_pages_status_check', inList(t.status, CONTENT_PAGE_STATUSES)),
    index('content_pages_kind_status_idx').on(t.kind, t.status),
    index('content_pages_updated_idx').on(t.updatedAt.desc()),
    index('content_pages_author_id_idx').on(t.authorId),
  ],
);

/** A row read from `content_pages`. */
export type ContentPage = typeof contentPages.$inferSelect;

/** A row to insert into `content_pages`. */
export type NewContentPage = typeof contentPages.$inferInsert;

/**
 * The help centre and FAQ; an article can be linked to a service.
 *
 * Why: The help centre and FAQ; an article can be linked to a service (routes /admin/help-articles).
 */
export const helpArticles = pgTable(
  'help_articles',
  {
    id: pk(),
    /** a free label chosen by staff */
    category: text().notNull(),
    question: text().notNull(),
    answerMd: text().notNull(),
    locale: text().notNull().default('en'),
    serviceId: fk((): AnyPgColumn => services.id),
    sort: integer().notNull().default(0),
    isPublished: boolean().notNull().default(false),
    helpfulYes: integer().notNull().default(0),
    helpfulNo: integer().notNull().default(0),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index('help_articles_published_idx').on(t.isPublished, t.sort),
    index('help_articles_service_id_idx').on(t.serviceId),
  ],
);

/** A row read from `help_articles`. */
export type HelpArticle = typeof helpArticles.$inferSelect;

/** A row to insert into `help_articles`. */
export type NewHelpArticle = typeof helpArticles.$inferInsert;

/**
 * The kinds of legal document the storefront publishes.
 *
 * Why: RESOLUTIONS b2c-14: GET /admin/legal-documents groups documents by these four types.
 */
export const LEGAL_DOCUMENT_TYPES = ['terms', 'privacy', 'refund', 'cookies'] as const;

/** One value of {@link LEGAL_DOCUMENT_TYPES}. */
export type LegalDocumentType = (typeof LEGAL_DOCUMENT_TYPES)[number];

/**
 * Terms, privacy, refund and cookie documents, with archived versions.
 *
 * Why: Terms, privacy, refund and cookie documents with archived versions (routes /admin/legal-documents).
 */
export const legalDocuments = pgTable(
  'legal_documents',
  {
    id: pk(),
    type: text().$type<LegalDocumentType>().notNull(),
    version: text().notNull(),
    locale: text().notNull().default('en'),
    bodyMd: text().notNull(),
    /** null while the version is a draft (NOT_A_DRAFT) */
    effectiveFrom: timestampTz(),
    isCurrent: boolean().notNull().default(false),
    requiresReacceptance: boolean().notNull().default(false),
    createdBy: fk((): AnyPgColumn => staffUsers.id),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    check('legal_documents_type_check', inList(t.type, LEGAL_DOCUMENT_TYPES)),
    unique('legal_documents_version_uq').on(t.type, t.locale, t.version),
    uniqueIndex('legal_documents_current_uq')
      .on(t.type, t.locale)
      .where(sql`${t.isCurrent}`),
    index('legal_documents_created_by_idx').on(t.createdBy),
  ],
);

/** A row read from `legal_documents`. */
export type LegalDocument = typeof legalDocuments.$inferSelect;

/** A row to insert into `legal_documents`. */
export type NewLegalDocument = typeof legalDocuments.$inferInsert;
