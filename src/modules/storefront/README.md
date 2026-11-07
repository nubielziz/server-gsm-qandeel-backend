# Storefront & content module (`storefront`)

Map domain H. The content of the public storefront: service listings, content pages, help articles and legal documents.

Layout, boundaries and the request pipeline: `docs/ARCHITECTURE.md` §§ 2-3 and decision 016. Every route is a zod contract (decision 008); how to add one: `CONTRIBUTING.md`.

Decisions that shape this module: 022 caching, 034 Turnstile. Common to all modules: 008 route contracts, 016 layout and boundaries, 027 database conventions.

## Status

Built (feature 14a, storefront-checkout): the public catalog, 3 of the 6 storefront routes (`GET /store/v1/config`,
`GET /store/v1/services`, `GET /store/v1/services/:slug`) and the demo seed (`scripts/seed/storefront.ts`). The admin routes
(listings, pages, legal documents) are feature 15, pages and help routes 15, the storefront settings route 16.

- **What is public** (`application/storefront-catalog.service.ts`): a listing is public only when `is_listed` is on AND its service is
  one the catalog says the retail group may buy (live, `active`, in an active category whose allowed groups are empty or include the
  retail group: catalog's `StorefrontServices`, the merchant catalog's visibility rule, catalog-3) AND staff priced it for the
  retail group (a `service_group_prices` row: without it the resolver would fall back to the B2B base price, which is not a retail
  price). `StorefrontQuotes.listedSellable` is the one rule behind the list, the page, the checkout and the pre-order IMEI check:
  sellable for the retail group AND a `service_listings` row with `is_listed` on (in any language), so an unlisted service cannot be
  bought by guessing its id. The list's total is exact (the sellable ids go into the SQL). Nothing staff-only is ever sent: no cost, supplier, floor,
  `locked` flag or supplier field name.
- **The price** (`application/storefront-quotes.ts`, `domain/retail-quote.ts`): the catalog resolver's price for the `b2c_retail`
  group, lifted to the storefront floor `storefrontFloor(base, floor)` = `max(round(base x 1.10, 2), effective cost + minimum
  profit)` (catalog-12, b2c-7), as net USD; tax is the window of the buyer's country at the moment (`StorefrontMoney.taxInForce`,
  rounded half up to cents like the demo's `taxFor`; no country or no window means no tax); the buyer's currency is converted with
  the currency's `rate_to_base` and its markup, `rate x (1 + markup / 100)` with 8 decimals (this is the rate a checkout locks);
  gross and tax are converted and rounded to the currency's decimals and net is what is left, so the three add up. Charm rounding is
  not applied: a session locks USD amounts and the rate, and the charged amount's rounding belongs to feature 16.
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
- **Legal documents** (`application/legal-documents.ts`): `CurrentLegalDocuments.current(db, type, locale)` is the current version
  of a document in a language, falling back to English.

## Public API (`index.ts`)

`StorefrontQuotes` (retail group, buyer context, priced services, the amounts of a purchase), `CurrentLegalDocuments`,
`StorefrontPolicies`, `inCurrency`, the request schemas `zCountryCode`, `zCurrencyCode`, `zLocale`, the modules. Other modules
import only `src/modules/storefront/index.ts` (lint rule `gsm/module-boundaries`); the customers module prices and locks a checkout
session with these.

## Owned tables

Only this module reads and writes these 4 tables (`scripts/module-map.mjs`); other modules call its public service. Schema: `db/schema.ts`.

| Table | What it holds |
|---|---|
| `service_listings` | The public service page in the storefront: title, slug and SEO fields per language. |
| `content_pages` | Landing pages, static pages and the blog, in several languages. |
| `help_articles` | The help centre and FAQ; an article can be linked to a service. |
| `legal_documents` | Terms, privacy, refund and cookie documents, with archived versions. |

## Routes

25 endpoints (admin 19, store 6). Source: `docs/slices/storefront.json` (generated from the map; `bun run routes:build`). Each route becomes a contract under `contracts/` when its feature is built.

### Admin console (19)

| Route | Access | What it does | Stage |
|---|---|---|---|
| `GET /admin/content-pages` | staff-permission · `storefront:*` | Landing and content pages: draft, then publish. | 15 |
| `GET /admin/content-pages/:id` | staff-permission · `storefront:*` | Landing and content pages: draft, then publish. | 15 |
| `GET /admin/help-articles` | staff-permission · `storefront:*` | Help center articles. | 15 |
| `GET /admin/help-articles/:id` | staff-permission · `storefront:*` | Help center articles. | 15 |
| `GET /admin/legal-documents` | staff-permission · `legal:*` | Versions of the terms, privacy policy and refund policy. | 15 |
| `GET /admin/legal-documents/:id` | staff-permission · `legal:*` | Versions of the terms, privacy policy and refund policy. | 15 |
| `GET /admin/service-listings` | staff-permission · `storefront:*` | Services listed in the storefront and the retail price of each service; selling below the minimum price is blocked. | 15 |
| `GET /admin/service-listings/:id` | staff-permission · `storefront:*` | Services listed in the storefront and the retail price of each service; selling below the minimum price is blocked. | 15 |
| `PATCH /admin/content-pages/:id` | staff-permission · `storefront:*` | Landing and content pages: draft, then publish. | 15 |
| `PATCH /admin/help-articles/:id` | staff-permission · `storefront:*` | Help center articles. | 15 |
| `PATCH /admin/service-listings/:id` | staff-permission · `storefront:*` | Services listed in the storefront and the retail price of each service; selling below the minimum price is blocked. | 15 |
| `PATCH /admin/storefront/settings` | staff-permission · `settings:storefront` | Storefront payment methods, policies (guest checkout, refund window) and customer email templates. | 16 |
| `POST /admin/content-pages` | staff-permission · `storefront:*` | Landing and content pages: draft, then publish. | 15 |
| `POST /admin/content-pages/:id/publish` | staff-permission · `storefront:publish` | Publish a page or hide it. | 15 |
| `POST /admin/content-pages/generate` | staff-permission · `storefront:*` | Landing-page generator (brand x model x network): produces drafts for review only. | 19 |
| `POST /admin/help-articles` | staff-permission · `storefront:*` | Help center articles. | 15 |
| `POST /admin/legal-documents` | staff-permission · `legal:*` | Versions of the terms, privacy policy and refund policy. | 15 |
| `POST /admin/legal-documents/:id/publish` | staff-permission · `legal:publish` | Approve a new version; it appears in later consents. | 15 |
| `POST /admin/service-listings` | staff-permission · `storefront:*` | Services listed in the storefront and the retail price of each service; selling below the minimum price is blocked. | 15 |

### Storefront (B2C) (6)

| Route | Access | What it does | Stage |
|---|---|---|---|
| `GET /store/v1/config` | public | Countries, currencies, tax and enabled payment methods. | 14 |
| `GET /store/v1/help` | public | Help center articles, with search. | 15 |
| `GET /store/v1/help/:slug` | public | One help article. | 15 |
| `GET /store/v1/pages/:slug` | public | A content, landing or legal page in its current version. | 15 |
| `GET /store/v1/services` | public | Listed services at the retail price including tax, in the customer's currency; filter by brand, network and country. | 14 |
| `GET /store/v1/services/:slug` | public | Service page: description, duration, order fields and FAQs. | 14 |

## Scenarios

None of the 13 map scenarios (`docs/slices/` → `scenarios`) touches this module's tables.

## Permissions

Staff permissions the map requires on this module's admin routes: `legal:*`, `legal:publish`, `settings:storefront`, `storefront:*`, `storefront:publish`.

Keep this list in step with the contracts (`permission` of each `defineRoute`).

## Events

Outbox events produced (types, payload ids): none. Consumed: none.

## Jobs and schedules

None.

## Cache keys

None: the public answers are read from Postgres on every request (only the browser caches them, 30 s). A server-side cache with
keys per language, country and currency, deleted after the commit of listing, price, tax or currency changes, is the next step if
the public routes need it.

## Audit resolutions

The pre-Phase-3 audit of the console endpoints (`docs/contract/RESOLUTIONS.md`, machine-readable `docs/contract/resolutions.json`) settled the points below for this module's routes. Where they differ from older text in this README or the endpoint docs, the resolution wins; the endpoint docs, `RULES.md`, `ANSWERS.md` and `MISMATCHES.md` were updated to match.

- `catalog-3` · DELETE /admin/services/:id (an archived or disabled service is never listed or sold)
- `b2c-7` · GET /admin/service-listings, PATCH /admin/service-listings/:id
- `b2c-14` · GET /admin/checkouts/abandoned, GET /admin/customers/:id, GET /admin/legal-documents
- `b2c-15` · POST /admin/content-pages/generate
