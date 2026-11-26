# Storefront & content module (`storefront`)

Map domain H. The content of the public storefront: service listings, content pages, help articles and legal documents.

Layout, boundaries and the request pipeline: `docs/ARCHITECTURE.md` §§ 2-3 and decision 016. Every route is a zod contract (decision 008); how to add one: `CONTRIBUTING.md`.

Decisions that shape this module: 022 caching, 034 Turnstile, 038 search on Typesense, 068 the landing pages are retired, 070 order forms draw only the custom fields, 073 IMEI is a field type. Common to all modules: 008 route contracts, 016 layout and boundaries, 027 database conventions.

## Status

Built: the public catalog (feature 14a, storefront-checkout: 3 of the 6 storefront routes `GET /store/v1/config`,
`GET /store/v1/services`, `GET /store/v1/services/:slug`) and the admin and content parts (feature 15: the admin routes of the
listings, content pages, help articles and legal documents and the three public content routes, 20 routes), with the one demo seed
(`scripts/seed/storefront.ts`); the page generator of feature 19 (`POST /admin/content-pages/generate`) was retired by decision 068. Feature 16 built
`PATCH /admin/storefront/settings` (below). Feature 22 (the storefront catalog backend) added the listing content editor, the
catalog filters and sorts, `GET /store/v1/categories`, the availability flag, the popularity job, the public page list, the slug
alternates (removed by feature 30), the help vote and the service picture (upload, removal, `imageUrl`; section "Feature 22" below).

Feature 30 (English only, decision 039, B224) made the listings and the catalog English only: a service has one listing, a slug is
unique for the site, no listing or catalog route takes or answers a language, and the old addresses of content that existed only in
another language are answered by `GET /store/v1/legacy-slugs/:kind/:slug` (section "Feature 30: old addresses" below). The same feature
made pages, help articles and legal documents English only (migration 0037): a page slug is unique for the site, no page or article
has a language, and `legal_documents.locale` stays only as an archive tag (section "Legal documents: the one exception" below).

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
  price). `StorefrontQuotes.listedSellable` is the one rule behind the list, the page and the checkout:
  sellable for the retail group AND its one `service_listings` row with `is_listed` on, so an unlisted service cannot be
  bought by guessing its id. The search asks the same `listedServiceIds`, so what it shows and what can be bought agree. The list's total is exact (the sellable ids go into the SQL). Nothing staff-only is ever sent: no cost, supplier, floor,
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
- **Wire** (money is 4-decimal text): the list row is `{ id (the service id), slug, title, summary, brand, network, country,
  isFeatured, type, deliveryTime, price: { currency, fxRate, net, tax, gross, taxRate, taxCountry } }`; the page adds
  `descriptionMd, etaText, requirementsMd, seoTitle, seoDescription, quantity { min, max, options }, fields [{ key, label, fieldType,
  options, required, isMainInput }], faqs [{ question, answerMd }]` (the published help articles linked to the service). `fields` is
  every field of the service in form order (decision 070: the order form draws only these; on an IMEI service the main input is typed into
  the one with `isMainInput`, which is no longer left out). `fieldType` is `text`, `number`, `select`, `textarea` or `imei` (decision 073:
  one IMEI, 15 digits with Luhn, checked at the checkout).
  The list is the simple-rest dialect (`_start`, `_end` up to 100 rows, `_sort` featured|sort|title, default featured first, then
  `sort`, then title; filters `brand`, `network`, `country` (case-insensitive), `featured`; `locale` is an unknown parameter (422); `q` over
  title, summary, brand and network) with `x-total-count`; the buyer's `buyerCountry`, `region` and `currency` are extra query
  parameters. `GET /store/v1/config` answers the offered currencies with their locked rate, the tax windows in force, the active
  B2C payment gateways (`code`, `name`, `supports3ds`), the two policy switches and the current legal documents. The three
  answers carry `Cache-Control: public, max-age=30`; nothing is cached server side.
- **Policies** (`application/storefront-policies.ts`): `guestCheckout` and `withdrawalWaiver` are flat keys of the
  `settings` table (RULES settings 5; feature 16 builds the route that writes them), read through the platform's `SettingsService`;
  a key that is unset or not a boolean means on.
- **Legal documents** (`application/legal-documents.ts`): the one read of the version in force. `CurrentLegalDocuments.current(db,
  type)` is the current version of a document (what a consent records); `currentWithBody` is the same version with its text (the
  public page route, 404 otherwise); `find` reads a version by id (a retired version too); `listCurrent` feeds the storefront config. The console's Legal page publishes into the same
  `is_current` flag, so a consent always references the version the console shows as current.

- **Policies** (feature 16, `PATCH /admin/storefront/settings`, permission `settings:storefront`): `StorefrontSettingsService` writes the five policy keys of the console's Policies tab as flat keys of the settings table: the switches `guestCheckout`, `require3ds`,
  `withdrawalWaiver`, `autoRefundFailed` (JSON booleans) and the number `refundHoursBeforeDispatch` (0 to 72). Any other key or a value that does not fit is
  `422` on that key (`This is not a storefront setting.`), and one bad key writes none. Every changed key writes its own audit row in the demo's words (`turned on policy`, `turned off policy`, `changed policy`, entity type `setting`, the row label as `entityLabel`);
  an unchanged value writes nothing. The answer is the policies that have a value after the change, the same ones `GET /admin/settings` shows; the settings snapshot is cleared after the commit. The checkout reads `guestCheckout` and `withdrawalWaiver`
  through `StorefrontPolicies`, and `POST .../pay` reads `require3ds`, so a change reaches them at once. **A `require3ds` change should also flip the risk rule of that name: that rule belongs to the risk feature (18) and plugs in right after the write in `StorefrontSettingsService.update`.** Sending `require3ds` also needs `risk:*` (decision 046).
  `StorefrontPolicies.autoRefundFailed` reads `autoRefundFailed` for the order engine (a supplier-rejected storefront order is refunded by the system while it is on, which is the default; off, the rejection opens a refund request for staff). The other policy key (`refundHoursBeforeDispatch`) is stored here and read by the feature that uses it (the self-cancel window).

## Public API (`index.ts`)

`StorefrontQuotes` (retail group, buyer context, priced services, the amounts of a purchase), `CurrentLegalDocuments` (with
the one `LegalDocumentRef`), `StorefrontPolicies`, `inCurrency`, the request schemas `zCountryCode`,
`zCurrencyCode`, `LEGAL_DOCUMENT_TYPES`, `LEGAL_TYPE_LABEL`, and the modules: `StorefrontModule` (global, no connection
needed; it provides `CurrentLegalDocuments` and imports `StorefrontPublicModule`), `StorefrontPublicModule` (the public catalog
routes; it needs the database) and `StorefrontContentModule` (the admin and public content routes; it needs the database, so a test
app built without one leaves it out, like `CatalogAdminModule`). Other modules import only `src/modules/storefront/index.ts` (lint
rule `gsm/module-boundaries`); the customers module prices and locks a checkout session with these.

Cross-module calls: catalog's `RetailPrices` and `RetailPricing` (feature 31: the rule of a service and its price) (the retail price, the storefront floor, the service lock; the console's listings and
the public prices both use it), `StorefrontServices`, `CatalogPriceVersion`, money's `StorefrontMoney`, platform's `AuditService`
and `SettingsService`, identity's `CurrentStaff`. The reads of `services`, `service_categories`, `client_groups`, `orders` and
`consent_records` are plain selects in one file with a note (`infra/foreign-reads.repository.ts`); the retail price is only
read and written through `RetailPrices`.

## Owned tables

Only this module reads and writes these 4 tables (`scripts/module-map.mjs`); other modules call its public service. Schema: `db/schema.ts`.

| Table | What it holds |
|---|---|
| `service_listings` | The public service page in the storefront, one per service: title, slug (unique for the site), content, SEO fields and the facts of the service (brand, carrier, country, featured, position); `listed_at`, `sales_30d` (job only) and `image_file_id` (feature 22). The map's `locale` column is dropped (feature 30, migration 0036). |
| `content_pages` | Static pages and the blog (`kind` `static` or `blog`, the check `content_pages_kind_check`; the five landing kinds were retired by decision 068); the slug is unique for the site. `template_params` is unused since the generator went. The map's `locale` column is dropped (feature 30, migration 0037). |
| `help_articles` | The help centre and FAQ; an article can be linked to a service. The map's `locale` column is dropped (feature 30, migration 0037). |
| `legal_documents` | Terms, privacy, refund and cookie documents, with archived versions. `locale` stays as an archive tag (feature 30, section "Legal documents: the one exception"). |

## Routes

25 endpoints (admin 19, store 6). Source: `docs/slices/storefront.json`. Built by feature 15: the 20 below; built by feature 14a:
`GET /store/v1/config`, `GET /store/v1/services`, `GET /store/v1/services/:slug` (described above); built by feature 19:
`POST /admin/content-pages/generate` was retired by decision 068 (section "Landing pages, retired"). Not built: `PATCH /admin/storefront/settings` (16).

### Admin console (17 of 19, plus the two picture routes of feature 22)

| Route | Permission | What it does |
|---|---|---|
| `GET /admin/service-listings` | `storefront:read` | Listings with the service join, retail price (and, feature 31, `retailPriceSource`, `retailPriceRule`, `retailPriceWaiting`), storefront floor, margin, 30-day storefront sales (`orders30d`, `revenue30d`: the non-rejected orders of the shop's door, `orders.source = 'store'`, whatever rank the buyer holds now, decision 064), the lock and the content fields (no Markdown bodies); filters `isListed`, `locked`, `isFeatured`; sorts include `listedAt`, `sort`. |
| `GET /admin/service-listings/:id` | `storefront:read` | One listing with `descriptionMd` and `requirementsMd`. |
| `POST /admin/service-listings` | `storefront:create` | A service on the storefront, not on the site yet, with optional content (`LISTING_EXISTS`: the service already has a listing, or the slug is taken; `LISTING_LOCKED`). |
| `PATCH /admin/service-listings/:id` | `storefront:update` | The "On the site" switch, the retail price (floor 422, `SERVICE_DISABLED`, `LISTING_LOCKED`; feature 31: `retailPricing: 'rule'` prices by the retail price rule and follows it, 422 on `retailPricing` `conflict`, `no_rule`, `no_cost`; a typed price stops following) and the content: title, slug (`LISTING_EXISTS` on `slug`), summary, description, requirements, delivery note, SEO, brand, carrier, country, featured, position. Switching on also needs `storefront:publish`; `retailPrice` and `retailPricing` also need `pricing:update` (decision 046). |
| `POST /admin/service-listings/:id/image` | `storefront:update` | (22) Multipart part `file`: a JPEG, PNG or WebP of at most 2 MiB, 200 to 4096 px, checked and cleaned by `PublicImages`; becomes the picture of the service. `422` on `file` with the refusal code, `413` over 2 MiB. Audited `uploaded image for`. |
| `DELETE /admin/service-listings/:id/image` | `storefront:update` | (22) Removes the picture of the service (`204`, also when there was none); the file stays. Audited `removed image of`. |
| `GET /admin/content-pages` | `storefront:read` | Static pages and blog posts; filters `kind` (repeatable), `status`; `q` over title and slug. |
| `GET /admin/content-pages/:id` | `storefront:read` | One page. |
| `POST /admin/content-pages` | `storefront:create` | A draft written by the signed-in staff member (`SLUG_TAKEN`). |
| `PATCH /admin/content-pages/:id` | `storefront:update` | Text, slug and SEO; never kind or status. |
| `POST /admin/content-pages/:id/publish` | `storefront:publish` | Publish or hide (`published` boolean). |
| `GET /admin/help-articles` | `storefront:read` | Articles with votes; filters `isPublished`, `category`. |
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
| `GET /store/v1/pages/:slug` | A live static page or blog post (`published`, or `noindex` with `noindex: true`), or the legal document in force for the slugs `terms`, `privacy`, `refund`, `cookies` (`kind: legal`, with the version a consent references). A draft is 404. |
| `GET /store/v1/help?q=&category=` | The published articles, in staff order, with the derived slug and the votes. |
| `GET /store/v1/help/:slug` | One published article; only the id at the start of the slug counts. |
| `GET /store/v1/pages?kind=&q=&_sort=` | (22) The live pages without their bodies (`published`, or `noindex` with `noindex: true`); never drafts or legal documents; sorts `publishedAt` (default, newest first), `title`; up to 100 rows. |
| `POST /store/v1/help/:slug/vote` | (22) `{ helpful }` -> `204`; one counted vote per visitor IP and article per day, repeats accepted and ignored with the same `204`; `updatedAt` does not move. |
| `GET /store/v1/categories` | (22) The catalog categories that hold a listed, sellable, priced service, with `serviceCount`, in category order (one name per category since feature 30). |
| `GET /store/v1/legacy-slugs/:kind/:slug` | (30) Where an old address in another language leads now: `{ path, slug }` (section "Feature 30: old addresses"). |

## Rules built

- **Retail price and floor** (b2c-7, catalog-12): `floorPrice` = `max(round(base x 1.10, 2), effective cost + minimum profit for the
  b2c_retail group)` from `RetailPrices.quotes`, the same function the group-price page uses for its retail row; `service.cost` is
  the effective cost, so cost, `marginPct` and `floorPrice` agree. `retailPrice` is the retail group row of `service_group_prices`
  (it belongs to the service and its one listing). A price of zero or less, or under the floor, is 422 on `retailPrice`.
- **Typed or following** (feature 31, decision 040, B229): every write goes through catalog's `RetailPrices.set` with its origin: a
  typed `retailPrice` is `manual` (the service stops following a rule); `retailPricing: 'rule'` reads `RetailPricing.targets` under
  the service lock and writes the rule price of now with the origin `rule` (the price then follows the rule: catalog's follow pass).
  The refusals (`conflict` with `retailPrice`, `no_rule`, `no_cost`, `LISTING_LOCKED`) come before the first write; the
  audit row `changed retail price of` adds `pricing: 'rule'`, the rule id and the cost. Each row says `retailPriceSource` (`rule`,
  `manual`, or `null` without a price), `retailPriceRule` (`{ id, label }` of the rule a following price came from, also after the
  rule was deleted) and `retailPriceWaiting` (a proposal for the price waits for staff), read with `RetailPrices.sources` for the page.
- **Locked** (B53): the service's category lists groups and the retail group is not among them ("B2B only ..."), or the service is
  not active ("Service disabled"). Create is 409 `LISTING_LOCKED`; switching a disabled service on is `SERVICE_DISABLED` (checked
  first), a B2B-only one `LISTING_LOCKED`; pricing a locked service is `LISTING_LOCKED`; switching off is always allowed. The SQL
  twin of the rule filters `locked=true|false` (a test keeps the two equal).
- **Locking**: every writer of a listing takes the service row first (`FOR UPDATE` to price or switch, `FOR SHARE` to create), so a
  service delete (archive vs delete) and the group-price replace never interleave with it. An archived service is gone: its
  listings are absent from the lists and 404 on show and change (catalog-3).
- **Slugs**: lower-case words joined by hyphens, at most 120 characters; made from the title with the demo's `slugOf` when not
  typed, refused (not changed) when typed wrongly, 422 on `slug` when the title has no Latin letter or digit. Unique for the site
  (409 `SLUG_TAKEN` for pages, `LISTING_EXISTS` for listings) and checked again from the unique index, so a race answers 409. A
  content page may not use `terms`, `privacy`, `refund` or `cookies`: the public pages route serves the legal documents under them.
- **Pages**: always created as drafts; `published_at` is set from the injected clock on every publish (a page that is already live
  gets the new time) and kept when the page is hidden; hiding sets `draft`. No route sets `noindex`. The admin row carries
  `canonicalUrl` (ANSWERS storefront Q8).
- **Help**: a new article goes last (`sort` = max + 1 in the insert statement). The table has no slug column, so the public slug is
  `<id>-<words of the question>` and only the id counts when it is read back.
- **Legal**: a version's text never changes. Publish swaps the current version of its type in one transaction serialised by an
  advisory lock per type (`ALREADY_CURRENT`, `NOT_A_DRAFT`); `acceptedCount` counts granted consents and is null for a version never
  published. English only: a new version is always `en`, one version is in force per type and it is English (section "Legal
  documents: the one exception").
  
- **Audit** (demo phrases, ANSWERS audit Q3): `created listing for`, `listed on storefront`, `unlisted from storefront`, `changed
  retail price of`, `edited listing of` (entity `listing`); `created page`, `edited page`, `published page`, `unpublished page` (`content_page`);
  `created help article`, `edited help article`, `published help article`, `unpublished help article` (`help_article`);
  `created legal document`, `published legal document` (`legal`, label `Terms of service 3.2`); a row written by the retired generator keeps its audit entry `generated landing pages` (`content_page`).
- **Seed** (`scripts/seed/storefront.ts`, last in the order; one seeder, reports in this order): the 14 retail prices, the mock's 14
  listings (ids 1 to 14), the 8 TAC catalogue entries, 6 content pages (static pages and blog posts; the demo's landing pages are not seeded), 12 help articles and 6 legal versions (one
  draft refund policy 1.5). The console's demo file also has an Arabic version of the terms (`lang` `AR`): the seed skips a demo legal row
  whose `lang` is present and not `EN`, so every seeded version is English.

## Feature 22: the storefront catalog backend (`docs/briefs/22-store-catalog.md`)

- **Listing content.** `PATCH /admin/service-listings/:id` and `POST` write the content of a listing: `publicTitle`, `slug`,
  `summary`, `descriptionMd`, `requirementsMd`, `etaText`, `seoTitle`, `seoDescription` and the facts of the service `brand`,
  `carrier`, `country` (upper case), `isFeatured`, `sort`, all on the service's one row (feature 30: before it the facts were copied to
  every language row). Lock order: the service row, then the listing row (the popularity job locks listing rows only, in id order).
  Every refusal is decided before the first write. The audit row
  `edited listing of` keeps the fields that changed; Markdown bodies are recorded as `{ length }`, never as text. Changing the slug
  changes the public address (staff are told in the console).
- **`listed_at`** is the first publication: set by the first switch-on (`coalesce`), never reset by off and on. The migration back-fills
  rows already on the site with `created_at`.
- **Cards** gain `category { id, slug, name }` (`<id>-<words>` from the name), `availability`, `deliveryMinutes`
  (`services.sla_minutes`), `etaText` (the listing's delivery note), `listedAt`. (The service page's `alternates` and the category's
  second name went with feature 30.)
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
- **Page list, vote.** See the routes above. The vote consumes the limiter `help-vote` first; a refused point does nothing
  and answers `204` like a counted one.
- **Service picture** (slice C). `service_listings.image_file_id` points at a `files` row the platform's `PublicImages` stored
  (`media/<sha256>.<ext>` in the private bucket, owner `staff`). Like the other facts it describes the service: an upload or a removal
  writes the listing row under the service lock and the row's lock.
  `uploadImage` checks the listing, stores the picture outside the transaction (object, then the row; the same bytes are one object and
  one row), then links it. A replaced or removed picture's file stays (content-addressed; another service may show it; a purge job is
  out of scope). The audit rows carry the picture's name (`before`/`after`), its dimensions and size. Rows, cards and the service page
  carry `imageUrl` (`/store/v1/media/<name>` or `null`), read with one batched query per page (`PublicImages.urlsOf`). The bytes are
  served by the platform's `GET /store/v1/media/:name` (platform README).

## Landing pages, retired (decision 068)

The owner removed the landing pages and the TAC catalogue from the console's Shop content page. A page is now a static page or a blog post and
nothing else: `CONTENT_PAGE_KINDS` is `['static', 'blog']` (`db/schema.ts`), so the contracts, the filters and the examples know only those two, and
creating a page of any other kind is `422` on `kind` (a change never carries a kind). A filter `kind=country` (or `model`, `brand`, `carrier`, `tool`) on the
admin list or on `GET /store/v1/pages` is `422` too, and the slug of an old landing page is `404`. Every read of `infra/content-page.repository.ts` also
keeps to the two kinds (`isKnownKind`), so a landing row left in a database that the migration has not reached yet, or in a backup restored from before
it, is never answered.

Gone with them: `POST /admin/content-pages/generate` (a row of the map, so it stays in the route manifest and is listed in `test/contract/retired.ts`;
no contract, controller method or use case serves it), `domain/page-generator.ts`, `application/page-generator.service.ts`, the carriers read, the
storefront's read of the TAC names (`listTacNames`) and the permission wording "the generator needs `storefront:create`". The audit action
`generated landing pages` stays readable in old audit rows. *Kept:* the table `content_pages` (its column `template_params` is unused), `visits30d` and
`orders30d` on the admin row (still `null`), and the table `tac_catalog` (the risk queue reads it). The migration (0069) deletes the rows of the five landing
kinds and narrows `content_pages_kind_check` to the two kinds; no other table has a foreign key to `content_pages`.

## Feature 29: search

The English storefront search (`search/README.md` has the flow, the fallback and the statistics). Public routes and the console's
index tools (`GET /admin/search/index`, `POST /admin/search/index/rebuild`) share `SearchHttpModule`; the index side (documents, sync, rebuild, terms) is `SearchIndexModule` and
`SearchWorkerModule`. `GET /store/v1/services` keeps its contract; `relevance` is a new sort (the first of the default order, skipped
without `q` and on fallback) and `x-search-engine` / `x-search-truncated` are new response headers. Decision 068 retired the console's
synonym, pin, hidden-term, report and preview tools: the five synonyms of migration 0033 stay in the engine, read only, and the services
schema version 2 links no curation set (the worker's first rebuild after the deploy deletes the old one).

**Ranking values after tuning on the golden set** (`test/integration/storefront/search-golden.test.ts`; all in `search/domain/ranking.ts`): `query_by`
`title,title_words,codes,joins,models,brand,carrier,networks,country_names,category,summary` with weights `10,9,10,8,6,6,5,4,5,4,2`;
`num_typos` `0,2,0,0,0,1,1,1,1,1,1` (nearby `0,2,0,0,0,2,2,2,2,2,2`); `prefix` true except `summary`; `max_candidates` 16;
`drop_tokens_threshold` 0 for the suggest services and the completions, 6 for the nearby search, 1 for the results page;
`typo_tokens_threshold` 6 on the nearby search only; `prioritize_exact_match` true; `sort_by`
`_text_match:desc,_eval(in_stock:true):desc,popularity:desc`. Changed from the plan: `synonym_num_typos` 0 (was 1: with 1 the query
`uk unlock` matched every unlock service through the phrase `sim unlock`), and the completion search takes no typo when the typed text
holds a digit.

## Feature 30: old addresses (English only, decision 039, `docs/briefs/30-english-only.md` section 4.5)

`legacy_slugs` (this module's `additionalTables`; `kind` `service|page|help`, `slug`, `service_id` NULL or a service, cascading) holds
the addresses migration 0035 took from the listings, live pages and published help articles it deleted (for `help` the article id the
address starts with). Nothing writes it afterwards; the demo seed adds `legacy-demo-service` (the service of the seeded listing
`icloud-clean-lost-check`) and `legacy-demo-gone` (no service) for the website's e2e. `GET /store/v1/legacy-slugs/:kind/:slug`
(public, the store's `ip` limiter, no cache header, like `GET /store/v1/pages/:slug`; a strict query: any parameter is 422) answers
`{ path, slug }`: a service whose page answers now (switched on, sellable and priced, `StorefrontQuotes.onSale`) gives
`/services/<slug>`, any other service `/services` with `slug: null`; a page gives `/`, a help article `/help` (only the leading id of
the slug counts). An address that was never retired is 404. The website asks only after its own lookup found nothing.

## Legal documents: the one exception (English only, decision 039, `docs/briefs/30-english-only.md` section 4.4)

A legal document version in another language that a consent record references is the proof of what a person accepted
(`consent_records.legal_document_id`, `ON DELETE RESTRICT`), so migration 0035 retires it (`is_current = false`, the text and the dates
unchanged) instead of deleting it, and migration 0037 keeps `legal_documents.locale` as an archive tag. The rules from then on:

- `legal_documents_locale_check`: a version in force is English (`locale = 'en' OR NOT is_current`); `legal_documents_current_uq` is one
  version in force per type; `legal_documents_version_uq (type, locale, version)` is unchanged, so a retired version and an English one may
  carry the same text (`3.2`).
- `POST /admin/legal-documents` takes no language and writes `en` (the repository sets it); `VERSION_EXISTS` looks at English versions only.
  Publish works on a draft only: a retired version answers `409 NOT_A_DRAFT`. `findCurrent(type)`, `retireCurrent(type)` and the publish
  lock (`pg_advisory_xact_lock` on the type) take no language.
- Staff see a retired version in `GET /admin/legal-documents` (an "earlier" row: not current, `effectiveFrom` set; its read-only `locale` is
  not `en`; `acceptedCount` is its consents) and `GET /admin/legal-documents/:id` (its text). `/store/v1/config`, `/store/v1/pages/<type>`
  and the checkout consents read the version in force, which is English. Evidence packs and the data export print type and version only.

## Feature 31: bulk publish (`publish/`, decision 040, `docs/briefs/31-bulk-publish.md`)

Staff put services on the shop in bulk: a **draft** kept on the server (a run in `listing_publish_runs` and its rows in
`listing_publish_items`) is prepared by a background job, corrected row by row, and applied by a second job that publishes one service per
transaction. The module is `publish/` (see its `README.md`); its routes are the nine of `/admin/publish-runs` (spec B228,
`scripts/map-additions/31.mjs`): create (`POST`, also "Check again"), list, show, the rows (`GET .../items`), edit a row (`PATCH
.../items/:itemId`), change many rows (`POST .../items/bulk`), apply (with the resume), cancel and the run switch (`POST .../listed`).
Permissions: `storefront:read` to read, `storefront:create` to prepare, edit and cancel a preview, `storefront:publish` to apply, to switch
and to stop a run that is publishing; a price key of a row edit also needs `pricing:update`. Events written: `storefront.publish_prepare`,
`storefront.publish_apply`, `storefront.publish_set_listed` (ids and one flag only), consumed by the `imports` queue
(`publish/jobs/publish-outbox-routes.ts`; `docs/queues.md`); consumed from the suppliers module: `supplier.quick_add_done` (a Quick add run
that asked to publish; job `publish_from_quick_add` makes and prepares the automatic run of it). A preview (create, edit, bulk, "Check again") writes only the two publish
tables, plus the audit row of the draft "Check again" cancels; apply, cancel and the run switch are audited (`publish_run`). A published
service writes what a hand-made listing writes (the listing, its retail price, `storefront.listing_changed`), in one transaction.

## Scenarios

None of the 13 map scenarios (`docs/slices/` → `scenarios`) touches this module's tables.

## Permissions

Staff permissions the map requires on this module's admin routes: `legal:*`, `legal:publish`, `settings:storefront`, `storefront:*`, `storefront:publish`.

As built (CRUD rows expand per ALIGNMENT § 4): `storefront:read`, `storefront:create`, `storefront:update`, `storefront:publish`,
`legal:read`, `legal:create`, `legal:publish`. The public routes need none. Keep this list in step with the contracts
(`permission` of each `defineRoute`).

## Events

Outbox events produced (feature 29; payloads are ids only): `storefront.listing_changed { serviceIds }` (`ListingAdminService` create and
update and every service a publish run publishes or switches, at most 50 ids an event) and
`search.rebuild_requested { staffId, runId }` (`POST /admin/search/index/rebuild`). Consumed: both, by the worker's
`search-index` and `maintenance` queues (`search/jobs/search-outbox-routes.ts`); catalog's `catalog.services_changed` and
`catalog.category_changed` also reach the `search-index` queue.

## Jobs and schedules

`storefront_popularity` (queue `maintenance`, scheduler `storefront-popularity`, every 30 minutes, `jobs/popularity.ts`): refreshes
`service_listings.sales_30d`. Idempotent, written to `job_runs` (`processed` = rows changed, `result` = `{ services, changed }`).
Documented in `docs/queues.md`.

Search (feature 29, `search/jobs`): on `search-index` `search_sync` (the only writer of documents through the live alias; decision 068
retired `search_settings`); on `maintenance` `search_reconcile` (every `SEARCH_RECONCILE_MINUTES`), `search_rebuild` (03:40 UTC and on demand),
`search_terms_build` (hourly at :20), `search_terms_flush` (every 15 minutes) and `search_terms_purge` (04:10 UTC). All idempotent and
recorded in `job_runs`.

## Cache keys

The catalog routes (`/store/v1/config`, `/store/v1/services`, `/store/v1/services/:slug`, `/store/v1/categories`) read Postgres on every
request (only the browser caches the answers, 30 s): the legal page must always show the version a consent will reference, and the
per-IP limit protects the reads. The search keeps display-only keys, all registered in `docs/cache-keys.md`: `search-card:{serviceId}`,
`suggest:{sha1(p)}`, `search-facet-labels` (under the `search` version), `search-popular`, the two index locks and the day counters of the
statistics. Prices, availability and the searchable rule are never cached. A listing's retail price write moves the
catalog price version after its commit (owner: catalog). A server-side cache with keys per country and currency, deleted
after the commit of listing, price, tax or currency changes, is the next step if the public routes need it.

## Audit resolutions

The pre-Phase-3 audit of the console endpoints (`docs/contract/RESOLUTIONS.md`, machine-readable `docs/contract/resolutions.json`) settled the points below for this module's routes. Where they differ from older text in this README or the endpoint docs, the resolution wins; the endpoint docs, `RULES.md`, `ANSWERS.md` and `MISMATCHES.md` were updated to match.

- `catalog-3` · DELETE /admin/services/:id (an archived or disabled service is never listed or sold)
- `b2c-7` · GET /admin/service-listings, PATCH /admin/service-listings/:id
- `b2c-14` · GET /admin/customers/:id (answers `410` since decision 064; the account detail is `GET /admin/clients/:id`), GET /admin/legal-documents
- `b2c-15` · POST /admin/content-pages/generate (retired by decision 068)
