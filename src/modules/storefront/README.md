# Storefront & content module (`storefront`)

Map domain H. The content of the public storefront: service listings, content pages, help articles and legal documents.

Layout, boundaries and the request pipeline: `docs/ARCHITECTURE.md` §§ 2-3 and decision 016. Every route is a zod contract (decision 008); how to add one: `CONTRIBUTING.md`.

Decisions that shape this module: 022 caching, 034 Turnstile, 038 search on Typesense. Common to all modules: 008 route contracts, 016 layout and boundaries, 027 database conventions.

## Status

Built: the public catalog (feature 14a, storefront-checkout: 3 of the 6 storefront routes `GET /store/v1/config`,
`GET /store/v1/services`, `GET /store/v1/services/:slug`) and the admin and content parts (feature 15: the admin routes of the
listings, content pages, help articles and legal documents and the three public content routes, 20 routes), with the one demo seed
(`scripts/seed/storefront.ts`), and the page generator (feature 19: `POST /admin/content-pages/generate`). Feature 16 built
`PATCH /admin/storefront/settings` (below). Feature 22 (the storefront catalog backend) added the listing content editor, the
catalog filters and sorts, `GET /store/v1/categories`, the availability flag, the popularity job, the public page list, the slug
alternates, the help vote and the service picture (upload, removal, `imageUrl`; section "Feature 22" below).

Feature 29 (decision 038) added the English search: `GET /store/v1/search/suggest`, `GET /store/v1/search`, the engine path of
`GET /store/v1/services?q=` and the console's `/admin/search/*` tools; everything of it is in `search/` (its own README) and section
"Feature 29: search" below.

Layout: `contracts/` (one file per route group, `shared.ts` for the field schemas), `controllers/` (thin), `application/` (one
service per group, `storefront-catalog.service.ts`, `storefront-quotes.ts`, `storefront-policies.ts`, `legal-documents.ts`,
`public-content.service.ts`), `domain/` (pure rules with specs: the retail price arithmetic, slugs, listing locks and floors, legal
types, the derived help slug), `infra/` (Drizzle queries; `foreign-reads.repository.ts` holds the only reads of other modules'
tables).

### The public catalog (feature 14a)

- **What is public** (`application/storefront-catalog.service.ts`): a listing is public only when `is_listed` is on AND its service is
  one the catalog says the retail group may buy (live, `active`, in an active category whose allowed groups are empty or include the
  retail group: catalog's `StorefrontServices`, the merchant catalog's visibility rule, catalog-3) AND staff priced it for the
  retail group (a `service_group_prices` row: without it the shop would fall back to the B2B base price, which is not a retail
  price). `StorefrontQuotes.listedSellable` is the one rule behind the list, the page, the checkout and the pre-order IMEI check:
  sellable for the retail group AND a `service_listings` row with `is_listed` on (in any language), so an unlisted service cannot be
  bought by guessing its id. The list's total is exact (the sellable ids go into the SQL). Nothing staff-only is ever sent: no cost, supplier, floor,
  `locked` flag or supplier field name.
- **The price** (`application/storefront-quotes.ts`, `domain/retail-quote.ts`): the retail price staff set for the `b2c_retail` group,
  lifted to the storefront floor, as net USD. The floor is the one catalog's `RetailPrices.quotes` works out,
  `max(round(base x 1.10, 2), effective cost + minimum profit)` (catalog-12, b2c-7): the same function the console's listing admin
  shows, so the console, the public list, the service page and the checkout never disagree. Tax is the window of the buyer's country
  at the moment (`StorefrontMoney.taxInForce`, rounded half up to cents like the demo's `taxFor`; no country or no window means no
  tax); the buyer's currency is converted with the currency's `rate_to_base` and its markup, `rate x (1 + markup / 100)` with 8
  decimals (this is the rate a checkout locks); gross and tax are converted and rounded to the currency's decimals and net is what is
  left, so the three add up. Charm rounding is not applied: a session locks USD amounts and the rate, and the charged amount's
  rounding belongs to feature 16.
- **Price protection** (user rule 9): the merchant lists remember the last price shown to a merchant in `listed_prices`, which is
  keyed by merchant and service. A storefront visitor has no merchant, so the public lists write nothing there; the same guarantee
  (what the buyer saw is what is charged) is kept by the checkout session, which locks the net, the tax rate and the exchange rate
  at the moment it opens and never recomputes them, and by `StorefrontQuotes`, which prices the list, the page and the session.
- **Wire** (money is 4-decimal text): the list row is `{ id (the service id), slug, locale, title, summary, brand, network, country,
  isFeatured, type, deliveryTime, price: { currency, fxRate, net, tax, gross, taxRate, taxCountry } }`; the page adds
  `descriptionMd, etaText, requirementsMd, seoTitle, seoDescription, quantity { min, max, options }, fields [{ key, label, fieldType,
  options, required }], faqs [{ question, answerMd }]` (the published help articles linked to the service, in the page's language).
  The list is the simple-rest dialect (`_start`, `_end` up to 100 rows, `_sort` featured|sort|title, default featured first, then
  `sort`, then title; filters `brand`, `network`, `country` (case-insensitive), `featured`, `locale` (default `en`); `q` over
  title, summary, brand and network) with `x-total-count`; the buyer's `buyerCountry`, `region` and `currency` are extra query
  parameters. `GET /store/v1/config` answers the offered currencies with their locked rate, the tax windows in force, the active
  B2C payment gateways (`code`, `name`, `supports3ds`), the three policy switches and the current legal documents. The three
  answers carry `Cache-Control: public, max-age=30`; nothing is cached server side.
- **Policies** (`application/storefront-policies.ts`): `guestCheckout`, `withdrawalWaiver` and `imeiPrecheck` are flat keys of the
  `settings` table (RULES settings 5; feature 16 builds the route that writes them), read through the platform's `SettingsService`;
  a key that is unset or not a boolean means on.
- **Legal documents** (`application/legal-documents.ts`): the one read of the version in force. `CurrentLegalDocuments.current(db,
  type, locale)` is the current version of a document in a language, falling back to English (what a consent records);
  `currentWithBody` is the version in force in exactly one language with its text (the public page route, 404 otherwise); `find`
  reads a version by id; `listCurrent` feeds the storefront config. The console's Legal page publishes into the same
  `is_current` flag, so a consent always references the version the console shows as current.

- **Policies** (feature 16, `PATCH /admin/storefront/settings`, permission `settings:storefront`): `StorefrontSettingsService` writes the eight policy keys of the console's Policies tab as flat keys of the settings table: the switches `guestCheckout`, `require3ds`,
  `withdrawalWaiver`, `autoRefundFailed`, `imeiPrecheck` (JSON booleans) and the numbers `refundHoursBeforeDispatch` (0 to 72), `abandonedMinutes` (5 to 1440), `imeiRetentionDays` (0 to 3650, the same check as `PATCH /admin/settings`). Any other key or a value that does not fit is
  `422` on that key (`This is not a storefront setting.`), and one bad key writes none. Every changed key writes its own audit row in the demo's words (`turned on policy`, `turned off policy`, `changed policy`, entity type `setting`, the row label as `entityLabel`);
  an unchanged value writes nothing. The answer is the policies that have a value after the change, the same ones `GET /admin/settings` shows; the settings snapshot is cleared after the commit. The checkout reads `guestCheckout`, `withdrawalWaiver` and `imeiPrecheck`
  through `StorefrontPolicies`, and `POST .../pay` reads `require3ds`, so a change reaches them at once. **A `require3ds` change should also flip the risk rule of that name: that rule belongs to the risk feature (18) and plugs in right after the write in `StorefrontSettingsService.update`.**
  `StorefrontPolicies.autoRefundFailed` reads `autoRefundFailed` for the order engine (a supplier-rejected storefront order is refunded by the system while it is on, which is the default; off, the rejection opens a refund request for staff). The other policy keys (`refundHoursBeforeDispatch`, `abandonedMinutes`) are stored here and read by the features that use them (the self-cancel window, the abandoned-checkout reminder).

## Public API (`index.ts`)

`StorefrontQuotes` (retail group, buyer context, priced services, the amounts of a purchase), `CurrentLegalDocuments` (with
`FALLBACK_LOCALE` and the one `LegalDocumentRef`), `StorefrontPolicies`, `inCurrency`, the request schemas `zCountryCode`,
`zCurrencyCode`, `zLocale`, `LEGAL_DOCUMENT_TYPES`, `LEGAL_TYPE_LABEL`, and the modules: `StorefrontModule` (global, no connection
needed; it provides `CurrentLegalDocuments` and imports `StorefrontPublicModule`), `StorefrontPublicModule` (the public catalog
routes; it needs the database) and `StorefrontContentModule` (the admin and public content routes; it needs the database, so a test
app built without one leaves it out, like `CatalogAdminModule`). Other modules import only `src/modules/storefront/index.ts` (lint
rule `gsm/module-boundaries`); the customers module prices and locks a checkout session with these.

Cross-module calls: catalog's `RetailPrices` (the retail price, the storefront floor, the service lock; the console's listings and
the public prices both use it), `StorefrontServices`, `CatalogPriceVersion`, money's `StorefrontMoney`, platform's `AuditService`
and `SettingsService`, identity's `CurrentStaff`. The reads of `services`, `service_categories`, `client_groups`, `orders` and
`consent_records` are plain selects in one file with a note (`infra/foreign-reads.repository.ts`); the retail price is only
read and written through `RetailPrices`.

## Owned tables

Only this module reads and writes these 4 tables (`scripts/module-map.mjs`); other modules call its public service. Schema: `db/schema.ts`.

| Table | What it holds |
|---|---|
| `service_listings` | The public service page in the storefront: title, slug, content and SEO fields per language; the facts of the service (brand, carrier, country, featured, position) are kept equal on every language row; `listed_at`, `sales_30d` (job only) and `image_file_id` (feature 22). |
| `content_pages` | Landing pages, static pages and the blog, in several languages. |
| `help_articles` | The help centre and FAQ; an article can be linked to a service. |
| `legal_documents` | Terms, privacy, refund and cookie documents, with archived versions. |

## Routes

25 endpoints (admin 19, store 6). Source: `docs/slices/storefront.json`. Built by feature 15: the 20 below; built by feature 14a:
`GET /store/v1/config`, `GET /store/v1/services`, `GET /store/v1/services/:slug` (described above); built by feature 19:
`POST /admin/content-pages/generate` (below, "Landing-page generator"). Not built: `PATCH /admin/storefront/settings` (16).

### Admin console (17 of 19, plus the two picture routes of feature 22)

| Route | Permission | What it does |
|---|---|---|
| `GET /admin/service-listings` | `storefront:read` | Listings with the service join, retail price, storefront floor, margin, 30-day storefront sales, the lock and the content fields (no Markdown bodies); filters `isListed`, `locked`, `isFeatured`; sorts include `listedAt`, `sort`. |
| `GET /admin/service-listings/:id` | `storefront:read` | One listing with `descriptionMd` and `requirementsMd`. |
| `POST /admin/service-listings` | `storefront:create` | A service on the storefront in one language, not on the site yet, with optional content (`LISTING_EXISTS`, `LISTING_LOCKED`). |
| `PATCH /admin/service-listings/:id` | `storefront:update` | The "On the site" switch, the retail price (floor 422, `SERVICE_DISABLED`, `LISTING_LOCKED`) and the content: title, slug (`LISTING_EXISTS` on `slug`), summary, description, requirements, delivery note, SEO (this language) and brand, carrier, country, featured, position (every language of the service). |
| `POST /admin/service-listings/:id/image` | `storefront:update` | (22) Multipart part `file`: a JPEG, PNG or WebP of at most 2 MiB, 200 to 4096 px, checked and cleaned by `PublicImages`; becomes the picture of the service in every language. `422` on `file` with the refusal code, `413` over 2 MiB. Audited `uploaded image for`. |
| `DELETE /admin/service-listings/:id/image` | `storefront:update` | (22) Removes the picture from every language (`204`, also when there was none); the file stays. Audited `removed image of`. |
| `GET /admin/content-pages` | `storefront:read` | Landing and content pages; filters `kind` (repeatable), `status`, `locale`; `q` over title and slug. |
| `GET /admin/content-pages/:id` | `storefront:read` | One page. |
| `POST /admin/content-pages` | `storefront:create` | A draft written by the signed-in staff member (`SLUG_TAKEN`). |
| `PATCH /admin/content-pages/:id` | `storefront:update` | Text, slug, language and SEO; never kind or status. |
| `POST /admin/content-pages/:id/publish` | `storefront:publish` | Publish or hide (`published` boolean). |
| `POST /admin/content-pages/generate` | `storefront:create` | Draft landing pages for brand x model x network (`422` over 50 new drafts); feature 19. |
| `GET /admin/help-articles` | `storefront:read` | Articles with votes; filters `isPublished`, `category`, `locale`. |
| `GET /admin/help-articles/:id` | `storefront:read` | One article. |
| `POST /admin/help-articles` | `storefront:create` | A new article, last in the order. |
| `PATCH /admin/help-articles/:id` | `storefront:update` | Edit, and the publish switch (`isPublished`, B58). |
| `GET /admin/legal-documents` | `legal:read` | Every version with `acceptedCount`. |
| `GET /admin/legal-documents/:id` | `legal:read` | One version. |
| `POST /admin/legal-documents` | `legal:create` | A draft version (`VERSION_EXISTS`); a version's text is never edited. |
| `POST /admin/legal-documents/:id/publish` | `legal:publish` | Makes a draft the version in force (`ALREADY_CURRENT`, `NOT_A_DRAFT`). |

### Storefront (B2C), public reads (3 of 6, plus the three of feature 22)

| Route | What it does |
|---|---|
| `GET /store/v1/pages/:slug?locale=` | A live content page (`published`, or `noindex` with `noindex: true`), or the legal document in force for the slugs `terms`, `privacy`, `refund`, `cookies` (`kind: legal`, with the version a consent references). A draft is 404. |
| `GET /store/v1/help?locale=&q=&category=` | The published articles of one language, in staff order, with the derived slug and the votes. |
| `GET /store/v1/help/:slug` | One published article; only the id at the start of the slug counts. |
| `GET /store/v1/pages?locale=&kind=&q=&_sort=` | (22) The live pages of a language without their bodies (`published`, or `noindex` with `noindex: true`); never drafts or legal documents; sorts `publishedAt` (default, newest first), `title`; up to 100 rows. |
| `POST /store/v1/help/:slug/vote` | (22) `{ helpful }` -> `204`; one counted vote per visitor IP and article per day, repeats accepted and ignored with the same `204`; `updatedAt` does not move. |
| `GET /store/v1/categories?locale=` | (22) The catalog categories that hold a listed, sellable, priced service in the language, with `serviceCount`, in category order. |

## Rules built

- **Retail price and floor** (b2c-7, catalog-12): `floorPrice` = `max(round(base x 1.10, 2), effective cost + minimum profit for the
  b2c_retail group)` from `RetailPrices.quotes`, the same function the group-price page uses for its retail row; `service.cost` is
  the effective cost, so cost, `marginPct` and `floorPrice` agree. `retailPrice` is the retail group row of `service_group_prices`
  (every language shares it). A price of zero or less, or under the floor, is 422 on `retailPrice`.
- **Locked** (B53): the service's category lists groups and the retail group is not among them ("B2B only ..."), or the service is
  not active ("Service disabled"). Create is 409 `LISTING_LOCKED`; switching a disabled service on is `SERVICE_DISABLED` (checked
  first), a B2B-only one `LISTING_LOCKED`; pricing a locked service is `LISTING_LOCKED`; switching off is always allowed. The SQL
  twin of the rule filters `locked=true|false` (a test keeps the two equal).
- **Locking**: every writer of a listing takes the service row first (`FOR UPDATE` to price or switch, `FOR SHARE` to create), so a
  service delete (archive vs delete) and the group-price replace never interleave with it. An archived service is gone: its
  listings are absent from the lists and 404 on show and change (catalog-3).
- **Slugs**: lower-case words joined by hyphens, at most 120 characters; made from the title with the demo's `slugOf` when not
  typed, refused (not changed) when typed wrongly, 422 on `slug` when the title has no Latin letter or digit. Unique per language
  (409 `SLUG_TAKEN` for pages, `LISTING_EXISTS` for listings) and checked again from the unique index, so a race answers 409. A
  content page may not use `terms`, `privacy`, `refund` or `cookies`: the public pages route serves the legal documents under them.
- **Pages**: always created as drafts; `published_at` is set from the injected clock on every publish (a page that is already live
  gets the new time) and kept when the page is hidden; hiding sets `draft`. No route sets `noindex`. The admin row carries
  `canonicalUrl` (ANSWERS storefront Q8).
- **Help**: a new article goes last (`sort` = max + 1 in the insert statement). The table has no slug column, so the public slug is
  `<id>-<words of the question>` and only the id counts when it is read back.
- **Legal**: a version's text never changes. Publish swaps the current version of its type and language in one transaction
  serialised by an advisory lock per type and language (`ALREADY_CURRENT`, `NOT_A_DRAFT`); `acceptedCount` counts granted consents
  and is null for a version never published.
- **Audit** (demo phrases, ANSWERS audit Q3): `created listing for`, `listed on storefront`, `unlisted from storefront`, `changed
  retail price of`, `edited listing of` (entity `listing`); `created page`, `edited page`, `published page`, `unpublished page` (`content_page`);
  `created help article`, `edited help article`, `published help article`, `unpublished help article` (`help_article`);
  `created legal document`, `published legal document` (`legal`, label `Terms of service (EN) 3.2`); `generated landing pages` (`content_page`,
  label `12 drafts`, feature 19).
- **Seed** (`scripts/seed/storefront.ts`, last in the order; one seeder, reports in this order): the 14 retail prices, the mock's 14
  listings (ids 1 to 14), the 8 TAC catalogue entries, 14 landing and 6 content pages, 12 help articles and 7 legal versions (one
  draft refund policy 1.5).

## Feature 22: the storefront catalog backend (`docs/briefs/22-store-catalog.md`)

- **Listing content.** `PATCH /admin/service-listings/:id` and `POST` write the content of a listing. Per language: `publicTitle`,
  `slug`, `summary`, `descriptionMd`, `requirementsMd`, `etaText`, `seoTitle`, `seoDescription`. Facts of the service, written to
  **every language row** under the service lock (like `retailPrice`): `brand`, `carrier`, `country` (upper case), `isFeatured`, `sort`;
  a new listing copies them from the service's oldest listing. Lock order: the service row, then every listing row of the service in id
  order (the popularity job locks rows in the same order). Every refusal is decided before the first write. The audit row
  `edited listing of` keeps the fields that changed; Markdown bodies are recorded as `{ length }`, never as text. Changing the slug
  changes the public address (staff are told in the console).
- **`listed_at`** is the first publication: set by the first switch-on (`coalesce`), never reset by off and on. The migration back-fills
  rows already on the site with `created_at`.
- **Cards** gain `category { id, slug, name }` (`<id>-<words>` from the English name, the Arabic name for `ar` when staff set one),
  `availability`, `deliveryMinutes` (`services.sla_minutes`), `etaText` (the listing's delivery note), `listedAt`. The service page also
  carries `alternates` (listed pages of the same service in the other language).
- **Availability** is a flag, never a count: `in_stock` when the available inventory codes cover the smallest order (the smallest pack,
  else `min_qty`), else `on_request`; both can be bought. The SQL test `IN_STOCK_SQL` (catalog, bounded by the smallest order on the
  partial index) is the twin of `coversSmallestOrder`; the `availability` filter narrows the sellable ids in SQL.
- **Filters and sorts** of `GET /store/v1/services`: `type`, `categoryId` (repeatable), `availability`, `minPrice`/`maxPrice`
  (inclusive, against `price.gross` in the chosen currency; `minPrice` above `maxPrice` is 422 on `maxPrice`), sorts `popular`,
  `listedAt`, `price`. A request without a price bound or price sort is one SQL page. One with them reads all matches (at most
  10 000), prices them with `StorefrontQuotes` (so the filtered price is the shown and charged one), filters, sorts by price (stable;
  rows tied on the keys before `price` are re-ordered) and slices the page itself, so `x-total-count` stays exact.
- **Popularity** (`jobs/popularity*.ts`): queue `maintenance`, job `storefront_popularity`, scheduler `storefront-popularity`, every 30
  minutes. It stores the non-rejected orders of the last 30 days (every channel, counted by `salesCountsByService` in `infra/foreign-reads.repository.ts`, a documented foreign read: importing the orders barrel from here closed a load-order cycle, decision 032) in
  `service_listings.sales_30d`, in one statement that writes only the rows whose value changed and never moves `updated_at`. The
  shop shows the order only (`_sort=popular`), never the number.
- **Page list, alternates, vote.** See the routes above. The vote consumes the limiter `help-vote` first; a refused point does nothing
  and answers `204` like a counted one.
- **Service picture** (slice C). `service_listings.image_file_id` points at a `files` row the platform's `PublicImages` stored
  (`media/<sha256>.<ext>` in the private bucket, owner `staff`). Like the other facts it describes the service: an upload or a removal
  writes every language row under the service lock and the rows' locks (id order); a new listing copies it from the oldest one.
  `uploadImage` checks the listing, stores the picture outside the transaction (object, then the row; the same bytes are one object and
  one row), then links it. A replaced or removed picture's file stays (content-addressed; another service may show it; a purge job is
  out of scope). The audit rows carry the picture's name (`before`/`after`), its dimensions and size. Rows, cards and the service page
  carry `imageUrl` (`/store/v1/media/<name>` or `null`), read with one batched query per page (`PublicImages.urlsOf`). The bytes are
  served by the platform's `GET /store/v1/media/:name` (platform README).

## Landing-page generator (feature 19)

`POST /admin/content-pages/generate` (`storefront:create`, B57; `contracts/page-generator.contracts.ts`, `application/page-generator.service.ts`,
`domain/page-generator.ts`, `infra/page-generator.repository.ts`). Body `{ brands, models, networks }`, each a list of names (at most 100 of at most
60 characters); the server trims, splits on commas and new lines, and drops blanks and repeats (ignoring case). Empty lists mean everything the site
knows: every brand of the TAC catalogue, every model of those brands (marketing name, else the model code), every distinct carrier of the service
listings (a read of `tac_catalog` in `infra/foreign-reads.repository.ts`, the only read of another module's table; `service_listings` is this module's).
A typed model is generated as typed; the brand in `template_params` is the catalogue's (the typed brands first when two share a name), else the one
brand typed, else empty.

For each model x network (model by model): title `Unlock <model> on <network>`, slug `slugOf(title)`, language `en`, kind `model`, status `draft`,
`template_params { brand, model, network }`, `author_id` the signed-in staff member, a short Markdown body. Combinations that repeat
an earlier one of the run (`iPhone 13` and `iPhone-13`) are merged before counting; the distinct combinations whose slug exists in `en`, or that a
parallel run made first, are skipped and counted in `skipped`. A catalogue model with no Latin letter or digit cannot make a slug: it is left out and
counted in `unusableModels` (in the answer only when above 0, and always in the audit entry), never a `422`; a listing carrier with no Latin letter or
digit is left out of an "all networks" run the same way and counted in `unusableNetworks`. If more than `STOREFRONT_GENERATE_MAX_PER_RUN` (50, a code
constant, b2c-15) new drafts remain, nothing is created: `422 VALIDATION_FAILED`, detail `This run would create N pages; the limit is 50 per run. Narrow
the lists.`, `errors: []` (no field). The same `422` and sentence (N = the combinations) cover more than 20 000 combinations (a safety bound), and an "all models" run whose catalogue read returns more than 20 000 models (the read stops
at 20 001, N = 20001; judged before any unusable name is dropped, or a cut-off catalogue would pass); a typed
model or network with no Latin letter or digit is `422` on `models` or `networks` (it cannot make a slug). The insert is `ON CONFLICT (locale, slug) DO NOTHING`, so two requests at once
never create a page twice and never answer an error. One audit entry `generated landing pages` (entity `content_page`, label `N drafts`, ids in `after`),
also when nothing was created. Nothing is published.

## Feature 29: search

The English storefront search (`search/README.md` has the flow, the fallback and the statistics). Public routes and the console's
`/admin/search/*` tools share `SearchHttpModule`; the index side (documents, sync, rebuild, terms) is `SearchIndexModule` and
`SearchWorkerModule`. `GET /store/v1/services` keeps its contract; `relevance` is a new sort (the first of the default order, skipped
without `q`, on `locale=ar` and on fallback) and `x-search-engine` / `x-search-truncated` are new response headers.

**Ranking values after tuning on the golden set** (`test/search/golden.test.ts`; all in `search/domain/ranking.ts`): `query_by`
`title,title_words,codes,joins,models,brand,carrier,networks,country_names,category,summary` with weights `10,9,10,8,6,6,5,4,5,4,2`;
`num_typos` `0,2,0,0,0,1,1,1,1,1,1` (nearby `0,2,0,0,0,2,2,2,2,2,2`); `prefix` true except `summary`; `max_candidates` 16;
`drop_tokens_threshold` 0 for the suggest services and the completions, 6 for the nearby search, 1 for the results page;
`typo_tokens_threshold` 6 on the nearby search only; `prioritize_exact_match` true; `sort_by`
`_text_match:desc,_eval(in_stock:true):desc,popularity:desc`. Changed from the plan: `synonym_num_typos` 0 (was 1: with 1 the query
`uk unlock` matched every unlock service through the phrase `sim unlock`), and the completion search takes no typo when the typed text
holds a digit.

## Scenarios

None of the 13 map scenarios (`docs/slices/` → `scenarios`) touches this module's tables.

## Permissions

Staff permissions the map requires on this module's admin routes: `legal:*`, `legal:publish`, `settings:storefront`, `storefront:*`, `storefront:publish`.

As built (CRUD rows expand per ALIGNMENT § 4; the generator needs `storefront:create`): `storefront:read`, `storefront:create`, `storefront:update`, `storefront:publish`,
`legal:read`, `legal:create`, `legal:publish`. The public routes need none. Keep this list in step with the contracts
(`permission` of each `defineRoute`).

## Events

Outbox events produced (feature 29; payloads are ids only): `storefront.listing_changed { serviceIds }` (`ListingAdminService` create and
update, at most 50 ids an event), `search.settings_changed { kind }` (the console's synonym, pin and hidden-term writes) and
`search.rebuild_requested { staffId, runId }` (`POST /admin/search/index/rebuild`). Consumed: the three above, by the worker's
`search-index` and `maintenance` queues (`search/jobs/search-outbox-routes.ts`); catalog's `catalog.services_changed` and
`catalog.category_changed` also reach the `search-index` queue.

## Jobs and schedules

`storefront_popularity` (queue `maintenance`, scheduler `storefront-popularity`, every 30 minutes, `jobs/popularity.ts`): refreshes
`service_listings.sales_30d`. Idempotent, written to `job_runs` (`processed` = rows changed, `result` = `{ services, changed }`).
Documented in `docs/queues.md`.

Search (feature 29, `search/jobs`): on `search-index` `search_sync` (the only writer of documents through the live alias) and
`search_settings`; on `maintenance` `search_reconcile` (every `SEARCH_RECONCILE_MINUTES`), `search_rebuild` (03:40 UTC and on demand),
`search_terms_build` (hourly at :20), `search_terms_flush` (every 15 minutes) and `search_terms_purge` (04:10 UTC). All idempotent and
recorded in `job_runs`.

## Cache keys

The catalog routes (`/store/v1/config`, `/store/v1/services`, `/store/v1/services/:slug`, `/store/v1/categories`) read Postgres on every
request (only the browser caches the answers, 30 s): the legal page must always show the version a consent will reference, and the
per-IP limit protects the reads. The search keeps display-only keys, all registered in `docs/cache-keys.md`: `search-card:{serviceId}`,
`suggest:{sha1(p)}`, `search-facet-labels` (under the `search` version), `search-popular`, the two index locks and the day counters of the
statistics. Prices, availability and the searchable rule are never cached. A listing's retail price write moves the
catalog price version after its commit (owner: catalog). A server-side cache with keys per language, country and currency, deleted
after the commit of listing, price, tax or currency changes, is the next step if the public routes need it.

## Audit resolutions

The pre-Phase-3 audit of the console endpoints (`docs/contract/RESOLUTIONS.md`, machine-readable `docs/contract/resolutions.json`) settled the points below for this module's routes. Where they differ from older text in this README or the endpoint docs, the resolution wins; the endpoint docs, `RULES.md`, `ANSWERS.md` and `MISMATCHES.md` were updated to match.

- `catalog-3` · DELETE /admin/services/:id (an archived or disabled service is never listed or sold)
- `b2c-7` · GET /admin/service-listings, PATCH /admin/service-listings/:id
- `b2c-14` · GET /admin/checkouts/abandoned, GET /admin/customers/:id, GET /admin/legal-documents
- `b2c-15` · POST /admin/content-pages/generate
