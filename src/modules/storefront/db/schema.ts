// Storefront tables (map domain H): public service pages, landing and blog pages, help articles, legal documents.
// Conventions: decision 027; schema additions: MISMATCHES B116; ownership: scripts/module-map.mjs.
import { sql } from 'drizzle-orm';
import {
  bigint,
  boolean,
  check,
  date,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  unique,
  uniqueIndex,
  type AnyPgColumn,
} from 'drizzle-orm/pg-core';
import {
  bigId,
  bigintList,
  createdAt,
  fk,
  inList,
  jsonObject,
  money,
  pk,
  textList,
  timestampTz,
  updatedAt,
} from '../../../infra/db/columns';
import { retailPriceRules, services } from '../../catalog/db/schema';
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
 * The public service page in the storefront: title, slug, SEO fields and the facts the shop filters by; one per service.
 *
 * Why: The public service page of the storefront: title, slug and SEO (routes /admin/service-listings). English only (decision
 * 039, B224): the map's `locale` column is dropped (`REMOVED` in test/schema/structure.test.ts), a service has one listing and a
 * slug is unique for the site.
 */
export const serviceListings = pgTable(
  'service_listings',
  {
    id: pk(),
    serviceId: fk((): AnyPgColumn => services.id).notNull(),
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
    /** first time the listing went on the site; set once, never reset (feature 22: "new arrivals") */
    listedAt: timestampTz(),
    /** non-rejected orders of the service in the last 30 days, written only by the popularity job (feature 22) */
    sales30d: integer('sales_30d').notNull().default(0),
    /** the service's picture (a `files` row under `media/`; feature 22) */
    imageFileId: fk((): AnyPgColumn => files.id),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    // One listing per service (also the index behind the foreign key) and one slug for the site (decision 039).
    unique('service_listings_service_uq').on(t.serviceId),
    unique('service_listings_slug_uq').on(t.slug),
    index('service_listings_listed_idx').on(t.isListed, t.sort),
    index('service_listings_public_title_idx').on(t.publicTitle),
    index('service_listings_og_file_id_idx').on(t.ogFileId),
    index('service_listings_image_file_id_idx').on(t.imageFileId),
  ],
);

/** A row read from `service_listings`. */
export type ServiceListing = typeof serviceListings.$inferSelect;

/** A row to insert into `service_listings`. */
export type NewServiceListing = typeof serviceListings.$inferInsert;

/**
 * Landing pages, static pages and the blog.
 *
 * Why: Landing pages, static pages and the blog (routes /admin/content-pages). English only (decision 039, B224): the map's
 * `locale` column is dropped (`REMOVED` in test/schema/structure.test.ts) and a slug is unique for the site.
 */
export const contentPages = pgTable(
  'content_pages',
  {
    id: pk(),
    kind: text().$type<ContentPageKind>().notNull(),
    slug: text().notNull(),
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
    unique('content_pages_slug_uq').on(t.slug),
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
 * Why: The help centre and FAQ; an article can be linked to a service (routes /admin/help-articles). English only (decision 039,
 * B224): the map's `locale` column is dropped (`REMOVED` in test/schema/structure.test.ts).
 */
export const helpArticles = pgTable(
  'help_articles',
  {
    id: pk(),
    /** a free label chosen by staff */
    category: text().notNull(),
    question: text().notNull(),
    answerMd: text().notNull(),
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
 * Why: Terms, privacy, refund and cookie documents with archived versions (routes /admin/legal-documents). English only (decision
 * 039, B224), with one exception: `locale` stays as an archive tag. A version in another language that a consent record references
 * is the proof of what a person accepted, so migration 0035 retires it (`is_current = false`) instead of deleting it. Every version
 * that can be created or published is `en`: `legal_documents_locale_check` forbids a non-English version in force, and
 * `legal_documents_current_uq` allows one version in force per type.
 */
export const legalDocuments = pgTable(
  'legal_documents',
  {
    id: pk(),
    type: text().$type<LegalDocumentType>().notNull(),
    version: text().notNull(),
    /** The archive tag: `en`, or the code of a retired version kept as evidence (never in force: the CHECK). */
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
      .on(t.type)
      .where(sql`${t.isCurrent}`),
    check('legal_documents_locale_check', sql`${t.locale} = 'en' or not ${t.isCurrent}`),
    index('legal_documents_created_by_idx').on(t.createdBy),
  ],
);

/** A row read from `legal_documents`. */
export type LegalDocument = typeof legalDocuments.$inferSelect;

/** A row to insert into `legal_documents`. */
export type NewLegalDocument = typeof legalDocuments.$inferInsert;

// --- Storefront search (feature 29, decision 038, plan section 4.6) -----------------------------------------------------------------
// The search's own tables live here and not in search/db/schema.ts: only a module's db/schema.ts may hold foreign keys to another
// module's tables (decision 016, the boundary lint), and the infra barrel re-exports only those files. Owned by storefront
// (`additionalTables` in scripts/module-map.mjs).

/**
 * Kinds of a search synonym: every term means the others (`multi`), or the root expands to the terms (`one_way`).
 *
 * Why: Typesense synonym sets know both kinds (plan section 4.6).
 */
export const SEARCH_SYNONYM_KINDS = ['multi', 'one_way'] as const;

/** One value of {@link SEARCH_SYNONYM_KINDS}. */
export type SearchSynonymKind = (typeof SEARCH_SYNONYM_KINDS)[number];

/**
 * How a pin rule matches the query: the whole query (`exact`) or a part of it (`contains`).
 *
 * Why: Typesense curation rules know both (plan section 4.6).
 */
export const SEARCH_PIN_MATCHES = ['exact', 'contains'] as const;

/** One value of {@link SEARCH_PIN_MATCHES}. */
export type SearchPinMatch = (typeof SEARCH_PIN_MATCHES)[number];

/**
 * The synonyms of the storefront search, edited by staff and pushed to the Typesense synonym set (feature 29).
 *
 * Why: plan section 4.6: synonyms live in Postgres and are pushed whole; nothing is edited in Typesense by hand. Migration 0033 inserts
 * the owner's five (frp, icloud, unlock, imei check, kg lock).
 */
export const searchSynonyms = pgTable(
  'search_synonyms',
  {
    id: pk(),
    kind: text().$type<SearchSynonymKind>().notNull(),
    /** required for `one_way`: the word that expands to the terms */
    root: text(),
    /** 2-20 normalised items of 1-60 characters, distinct */
    terms: textList(),
    isEnabled: boolean().notNull().default(true),
    note: text().notNull().default(''),
    createdBy: fk((): AnyPgColumn => staffUsers.id),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    check('search_synonyms_kind_check', inList(t.kind, SEARCH_SYNONYM_KINDS)),
    check('search_synonyms_root_check', sql`${t.kind} <> 'one_way' or ${t.root} is not null`),
    check('search_synonyms_terms_check', sql`cardinality(${t.terms}) between 2 and 20`),
    index('search_synonyms_created_by_idx').on(t.createdBy),
  ],
);

/** A row read from `search_synonyms`. */
export type SearchSynonym = typeof searchSynonyms.$inferSelect;

/** A row to insert into `search_synonyms`. */
export type NewSearchSynonym = typeof searchSynonyms.$inferInsert;

/**
 * The pinned and hidden results of a query, pushed to the Typesense curation set (feature 29).
 *
 * Why: plan section 4.6: staff put chosen services first for a query (or hide some), optionally in a time window; the rows are the
 * truth and the curation set is rebuilt from them.
 */
export const searchPins = pgTable(
  'search_pins',
  {
    id: pk(),
    /** the normalised query, 1-100 characters */
    query: text().notNull(),
    match: text().$type<SearchPinMatch>().notNull(),
    /** `[{ serviceId, position }]`, at most 10, positions 1-10 distinct */
    pinned: jsonb().$type<Array<{ serviceId: number; position: number }>>().notNull().default([]),
    /** service ids left out of the results, at most 50 */
    hidden: bigintList(),
    startsAt: timestampTz(),
    endsAt: timestampTz(),
    isEnabled: boolean().notNull().default(true),
    note: text().notNull().default(''),
    createdBy: fk((): AnyPgColumn => staffUsers.id),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    unique('search_pins_query_match_uq').on(t.query, t.match),
    check('search_pins_match_check', inList(t.match, SEARCH_PIN_MATCHES)),
    check('search_pins_query_check', sql`char_length(${t.query}) between 1 and 100`),
    check(
      'search_pins_lists_check',
      sql`jsonb_typeof(${t.pinned}) = 'array' and jsonb_array_length(${t.pinned}) <= 10 and cardinality(${t.hidden}) <= 50`,
    ),
    check('search_pins_window_check', sql`${t.startsAt} is null or ${t.endsAt} is null or ${t.endsAt} > ${t.startsAt}`),
    index('search_pins_created_by_idx').on(t.createdBy),
  ],
);

/** A row read from `search_pins`. */
export type SearchPin = typeof searchPins.$inferSelect;

/** A row to insert into `search_pins`. */
export type NewSearchPin = typeof searchPins.$inferInsert;

/**
 * Searched terms staff keep out of the popular searches (feature 29).
 *
 * Why: plan section 5.6 and owner question 4: popular searches are automatic, and staff can hide a term.
 */
export const searchHiddenTerms = pgTable(
  'search_hidden_terms',
  {
    id: pk(),
    /** the normalised term */
    term: text().notNull(),
    note: text().notNull().default(''),
    createdBy: fk((): AnyPgColumn => staffUsers.id),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    unique('search_hidden_terms_term_uq').on(t.term),
    index('search_hidden_terms_created_by_idx').on(t.createdBy),
  ],
);

/** A row read from `search_hidden_terms`. */
export type SearchHiddenTerm = typeof searchHiddenTerms.$inferSelect;

/**
 * Searches per day and term: counts and a distinct-visitor estimate, no IP, user, session or cookie (feature 29).
 *
 * Why: plan section 5.6: the "no results" report and the popular searches read these rows; the `search_terms_flush` job writes
 * absolute values from the day's Redis counters (a repeat writes the same numbers); rows older than 180 days are purged.
 */
export const searchTermsDaily = pgTable(
  'search_terms_daily',
  {
    id: pk(),
    day: date({ mode: 'string' }).notNull(),
    /** the normalised term, at most 64 characters */
    term: text().notNull(),
    searches: integer().notNull().default(0),
    zeroResults: integer().notNull().default(0),
    /** distinct visitors of the day (a HyperLogLog estimate over a daily salted hash) */
    visitors: integer().notNull().default(0),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    unique('search_terms_daily_day_term_uq').on(t.day, t.term),
    check('search_terms_daily_term_check', sql`char_length(${t.term}) between 1 and 64`),
    check(
      'search_terms_daily_counts_check',
      sql`${t.searches} >= 0 and ${t.zeroResults} >= 0 and ${t.zeroResults} <= ${t.searches} and ${t.visitors} >= 0`,
    ),
  ],
);

/** A row read from `search_terms_daily`. */
export type SearchTermsDay = typeof searchTermsDaily.$inferSelect;

/**
 * The state of the search index: one row, written by the worker, read by `GET /admin/search/index` (feature 29).
 *
 * Why: plan section 3.4 and 4.6: the console shows the engine version, its memory, the documents, the last sync, reconcile and
 * rebuild and the last error, which only the worker sees (the API holds a search-only key). `singleton` (always true, unique) keeps
 * it to one row.
 */
export const searchIndexState = pgTable(
  'search_index_state',
  {
    id: pk(),
    singleton: boolean().notNull().default(true),
    schemaVersion: integer().notNull().default(0),
    servicesCollection: text(),
    termsCollection: text(),
    documents: integer().notNull().default(0),
    engineVersion: text(),
    memoryBytes: bigint({ mode: 'number' }),
    lastSyncAt: timestampTz(),
    lastReconcileAt: timestampTz(),
    lastRebuildAt: timestampTz(),
    lastTermsBuildAt: timestampTz(),
    lastError: text(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    unique('search_index_state_singleton_uq').on(t.singleton),
    check('search_index_state_singleton_check', sql`${t.singleton}`),
  ],
);

/** A row read from `search_index_state`. */
export type SearchIndexState = typeof searchIndexState.$inferSelect;

// --- Bulk publish (feature 31, decision 040, plan 31 section 4.2) ---------------------------------------------------------------------
// Owned by storefront (`additionalTables` in scripts/module-map.mjs). A run is a draft kept on the server (its rows), then a background
// apply that publishes one service per transaction. The lists no CHECK holds (`PUBLISH_FLAGS`, `PUBLISH_RESULT_REASONS`) live in
// publish/domain/publish-item.ts.

/**
 * The states of a publish run.
 *
 * Why: plan 31 sections 5.2 and 6: `preparing` (the worker builds the draft), `draft` (staff review it), `queued` and `running`
 * (apply), then `succeeded`, `failed` or `cancelled`.
 */
export const PUBLISH_RUN_STATUSES = [
  'preparing',
  'draft',
  'queued',
  'running',
  'succeeded',
  'failed',
  'cancelled',
] as const;

/** One value of {@link PUBLISH_RUN_STATUSES}. */
export type PublishRunStatus = (typeof PUBLISH_RUN_STATUSES)[number];

/**
 * Who made a publish run: staff in the console, or the Quick add hand-over.
 *
 * Why: plan 31 sections 5.2 and 6.3.
 */
export const PUBLISH_RUN_SOURCES = ['console', 'quick_add'] as const;

/** One value of {@link PUBLISH_RUN_SOURCES}. */
export type PublishRunSource = (typeof PUBLISH_RUN_SOURCES)[number];

/**
 * The states of a run switch (take everything a run published off the shop, or put it back).
 *
 * Why: plan 31 section 6.7.
 */
export const PUBLISH_SWITCH_STATUSES = ['queued', 'running', 'done', 'failed'] as const;

/** One value of {@link PUBLISH_SWITCH_STATUSES}. */
export type PublishSwitchStatus = (typeof PUBLISH_SWITCH_STATUSES)[number];

/**
 * Where the slug of a publish row comes from: the rules (`auto`) or staff (`staff`).
 *
 * Why: plan 31 section 3.2: at apply a taken `auto` slug gets the next free suffix, a taken `staff` slug refuses the row.
 */
export const PUBLISH_SLUG_SOURCES = ['auto', 'staff'] as const;

/** One value of {@link PUBLISH_SLUG_SOURCES}. */
export type PublishSlugSource = (typeof PUBLISH_SLUG_SOURCES)[number];

/**
 * How a publish row is priced: by the rule, by the price staff typed in the row, or by keeping the service's retail price.
 *
 * Why: plan 31 sections 5.2 and 6.2 (`normalisePriceMode`, `decidePrice`).
 */
export const PUBLISH_PRICE_MODES = ['rule', 'manual', 'keep'] as const;

/** One value of {@link PUBLISH_PRICE_MODES}. */
export type PublishPriceMode = (typeof PUBLISH_PRICE_MODES)[number];

/**
 * The state of a publish row: publishable, publishable after a look, or not publishable now.
 *
 * Why: plan 31 section 3.2.
 */
export const PUBLISH_ITEM_STATES = ['ready', 'review', 'blocked'] as const;

/** One value of {@link PUBLISH_ITEM_STATES}. */
export type PublishItemState = (typeof PUBLISH_ITEM_STATES)[number];

/**
 * Why a publish row cannot be published now, in the order they are judged (the first that applies is the row's).
 *
 * Why: plan 31 section 3.2, the table of blocking reasons.
 */
export const PUBLISH_BLOCK_REASONS = [
  'already_listed',
  'service_disabled',
  'category_inactive',
  'b2b_only',
  'not_orderable',
  'supplier_unavailable',
  'title_missing',
  'title_too_long',
  'price_missing',
  'below_floor',
  'slug_taken',
] as const;

/** One value of {@link PUBLISH_BLOCK_REASONS}. */
export type PublishBlockReason = (typeof PUBLISH_BLOCK_REASONS)[number];

/**
 * What happened to a publish row at apply.
 *
 * Why: plan 31 section 3.2 (the result table); the reasons are `PUBLISH_RESULT_REASONS` of the domain file.
 */
export const PUBLISH_ITEM_RESULTS = ['published', 'skipped', 'refused'] as const;

/** One value of {@link PUBLISH_ITEM_RESULTS}. */
export type PublishItemResult = (typeof PUBLISH_ITEM_RESULTS)[number];

/**
 * A run of the bulk publish: a draft of rows, then its apply, and the switch that takes what it published off the shop or back.
 *
 * Why: decision 040 and plan 31 section 4.2: the preview is a draft kept on the server; apply is a background job (queue `imports`)
 * that keeps the run's id across a resume, so the claim counts (`attempt`): a worker whose number is no longer the row's writes
 * nothing. `source_run_id` and `replaced_by_run_id` are plain ids (the storefront schema does not import the suppliers', and the
 * replacing run is written once with the cancel).
 */
export const listingPublishRuns = pgTable(
  'listing_publish_runs',
  {
    id: pk(),
    status: text().$type<PublishRunStatus>().notNull().default('preparing'),
    source: text().$type<PublishRunSource>().notNull(),
    /** the Quick add run that asked for this one (no foreign key: a suppliers table) */
    sourceRunId: bigId(),
    /** the scope as sent (`{ kind, ... }`, plan 31 section 5.2) */
    scope: jsonObject(),
    /** the run "Check again" made from this draft (set with the cancel; "Prepare again" moves it when that run died unprepared) */
    replacedByRunId: bigId(),
    /** whether apply switches the listings on; the run switch stores its target here too */
    listed: boolean().notNull().default(true),
    /** applied by the system as soon as it is prepared (the Quick add hand-over) */
    auto: boolean().notNull().default(false),
    /** `NAMING_RULES_VERSION` of the naming that made the titles */
    rulesVersion: integer().notNull(),
    total: integer().notNull().default(0),
    /** the three counters, written at the close and by a cancel (a live read counts the rows) */
    publishedCount: integer().notNull().default(0),
    skippedCount: integer().notNull().default(0),
    refusedCount: integer().notNull().default(0),
    /** at most 500 characters */
    error: text(),
    requestedBy: fk((): AnyPgColumn => staffUsers.id),
    /** the claim counter: every claim of an apply or a switch adds one; every write of a worker requires the number it got */
    attempt: integer().notNull().default(0),
    /** set by the worker that prepares the draft (the claim of the prepare) */
    prepareClaimedAt: timestampTz(),
    preparedAt: timestampTz(),
    startedAt: timestampTz(),
    finishedAt: timestampTz(),
    /** the clock's time at insert, at each claim and by every step; five minutes without one reads as stalled */
    heartbeatAt: timestampTz().notNull(),
    /** the run switch; null: never asked */
    switchStatus: text().$type<PublishSwitchStatus>(),
    /** the switch's target */
    switchListed: boolean(),
    switchedCount: integer().notNull().default(0),
    switchSkippedCount: integer().notNull().default(0),
    /** at most 500 characters */
    switchError: text(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    check('listing_publish_runs_status_check', inList(t.status, PUBLISH_RUN_STATUSES)),
    check('listing_publish_runs_source_check', inList(t.source, PUBLISH_RUN_SOURCES)),
    check('listing_publish_runs_switch_status_check', inList(t.switchStatus, PUBLISH_SWITCH_STATUSES)),
    check('listing_publish_runs_switch_check', sql`(${t.switchStatus} is null) = (${t.switchListed} is null)`),
    check(
      'listing_publish_runs_counts_check',
      sql`${t.total} >= 0 and ${t.publishedCount} >= 0 and ${t.skippedCount} >= 0 and ${t.refusedCount} >= 0 and ${t.attempt} >= 0 and ${t.switchedCount} >= 0 and ${t.switchSkippedCount} >= 0`,
    ),
    // One publish run per Quick add run (the hand-over's conflict target).
    uniqueIndex('listing_publish_runs_source_run_uq')
      .on(t.sourceRunId)
      .where(sql`${t.sourceRunId} is not null`),
    index('listing_publish_runs_status_idx').on(t.status, t.id),
    index('listing_publish_runs_requested_by_idx').on(t.requestedBy),
  ],
);

/** A row read from `listing_publish_runs`. */
export type ListingPublishRun = typeof listingPublishRuns.$inferSelect;

/** A row to insert into `listing_publish_runs`. */
export type NewListingPublishRun = typeof listingPublishRuns.$inferInsert;

/**
 * One service of a publish run: what the rules detected, what staff changed, how it is priced and what happened at apply.
 *
 * Why: plan 31 section 4.2: the row is a flat record (`detected` beside the edited fields), evaluated at prepare, at every edit and
 * again at apply on the locked service (the stored state is never trusted for a write). `replaces_price` is the typed price staff
 * chose to replace with the rule price, set only by the row's `PATCH`; `existing_price` is for display and decides nothing.
 */
export const listingPublishItems = pgTable(
  'listing_publish_items',
  {
    id: pk(),
    runId: fk((): AnyPgColumn => listingPublishRuns.id, 'cascade').notNull(),
    serviceId: fk((): AnyPgColumn => services.id, 'cascade').notNull(),
    /** `{ title, slug, brand, brandKind, carrier, country }` as the rules found them (for "Reset") */
    detected: jsonObject(),
    /** what will be published; staff may edit */
    title: text().notNull().default(''),
    slug: text().notNull().default(''),
    brand: text().notNull().default(''),
    carrier: text().notNull().default(''),
    country: text().notNull().default(''),
    slugSource: text().$type<PublishSlugSource>().notNull().default('auto'),
    priceMode: text().$type<PublishPriceMode>().notNull().default('rule'),
    /** the price staff typed in the row (`manual` only) */
    priceOverride: money(),
    /** the typed retail price staff chose to replace with the rule price; the publisher replaces it only while it is still this */
    replacesPrice: money(),
    /** the retail price the service had at the last evaluation (display only) */
    existingPrice: money(),
    /** as evaluated; `cost` is the figure the publish limit compares with */
    cost: money().notNull().default('0'),
    floorPrice: money().notNull().default('0'),
    ruleId: bigId().references((): AnyPgColumn => retailPriceRules.id, { onDelete: 'set null' }),
    rulePrice: money(),
    state: text().$type<PublishItemState>().notNull().default('blocked'),
    blockedReason: text().$type<PublishBlockReason>(),
    /** the flags of plan 31 section 3.2 (`PUBLISH_FLAGS` of the domain file) */
    flags: textList(),
    included: boolean().notNull().default(false),
    edited: boolean().notNull().default(false),
    evaluatedAt: timestampTz(),
    result: text().$type<PublishItemResult>(),
    /** one of `PUBLISH_RESULT_REASONS` of the domain file */
    resultReason: text(),
    /** at most 300 characters */
    resultDetail: text(),
    listingId: bigId().references((): AnyPgColumn => serviceListings.id, { onDelete: 'set null' }),
    publishedPrice: money(),
    finishedAt: timestampTz(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    unique('listing_publish_items_run_service_uq').on(t.runId, t.serviceId),
    check('listing_publish_items_slug_source_check', inList(t.slugSource, PUBLISH_SLUG_SOURCES)),
    check('listing_publish_items_price_mode_check', inList(t.priceMode, PUBLISH_PRICE_MODES)),
    check('listing_publish_items_state_check', inList(t.state, PUBLISH_ITEM_STATES)),
    check('listing_publish_items_blocked_reason_check', inList(t.blockedReason, PUBLISH_BLOCK_REASONS)),
    check('listing_publish_items_result_check', inList(t.result, PUBLISH_ITEM_RESULTS)),
    check(
      'listing_publish_items_override_check',
      sql`(${t.priceMode} = 'manual') = (${t.priceOverride} is not null) and (${t.priceOverride} is null or ${t.priceOverride} > 0)`,
    ),
    check('listing_publish_items_replaces_check', sql`${t.replacesPrice} is null or ${t.priceMode} = 'rule'`),
    // A blocked row cannot be ticked: an evaluation that blocks a row clears the tick in the same write.
    check('listing_publish_items_included_check', sql`${t.state} <> 'blocked' or ${t.included} = false`),
    index('listing_publish_items_run_idx').on(t.runId, t.id),
    index('listing_publish_items_run_state_idx').on(t.runId, t.state),
    index('listing_publish_items_run_result_idx').on(t.runId, t.result),
    index('listing_publish_items_service_idx').on(t.serviceId),
    index('listing_publish_items_listing_idx').on(t.listingId),
    index('listing_publish_items_rule_idx').on(t.ruleId),
  ],
);

/** A row read from `listing_publish_items`. */
export type ListingPublishItem = typeof listingPublishItems.$inferSelect;

/** A row to insert into `listing_publish_items`. */
export type NewListingPublishItem = typeof listingPublishItems.$inferInsert;

// --- Old addresses (feature 30, English only, decision 039, plan section 4.5) --------------------------------------------------------
// Owned by storefront (`additionalTables` in scripts/module-map.mjs). Migration 0035 fills it once from the addresses in other
// languages it deletes; nothing writes it after that (the demo seed adds two rows for the website's e2e).

/**
 * Kinds of an old storefront address: a service page, a content page or a help article.
 *
 * Why: decision 039 (plan 30 section 4.5): `GET /store/v1/legacy-slugs/:kind/:slug` answers for these three; the help centre
 * addresses an article by its leading id, so a `help` slug is that id.
 */
export const LEGACY_SLUG_KINDS = ['service', 'page', 'help'] as const;

/** One value of {@link LEGACY_SLUG_KINDS}. */
export type LegacySlugKind = (typeof LEGACY_SLUG_KINDS)[number];

/**
 * An address in another language that no longer exists, remembered so the English page that receives it can send the reader on.
 *
 * Why: decision 039 (English only): every URL under the retired second-language prefix answers 308 to the same path under `/en`; when that path names a service,
 * page or help article that only existed in another language, the website asks this table where to go (the English page of the
 * same service, else the list; a page: the home page; a help article: the help centre). `service_id` cascades: an old address
 * must never keep a service from being deleted, and a deleted service's old address is simply gone (404).
 */
export const legacySlugs = pgTable(
  'legacy_slugs',
  {
    id: pk(),
    kind: text().$type<LegacySlugKind>().notNull(),
    /** the old slug; for `help` the article id the old address started with */
    slug: text().notNull(),
    /** the service of an old service address; null for a page or a help article, or when no service is known */
    serviceId: fk((): AnyPgColumn => services.id, 'cascade'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    unique('legacy_slugs_kind_slug_uq').on(t.kind, t.slug),
    check('legacy_slugs_kind_check', inList(t.kind, LEGACY_SLUG_KINDS)),
    check('legacy_slugs_service_check', sql`${t.serviceId} is null or ${t.kind} = 'service'`),
    index('legacy_slugs_service_id_idx').on(t.serviceId),
  ],
);

/** A row read from `legacy_slugs`. */
export type LegacySlug = typeof legacySlugs.$inferSelect;

/** A row to insert into `legacy_slugs`. */
export type NewLegacySlug = typeof legacySlugs.$inferInsert;
