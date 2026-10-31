# Storefront & content module (`storefront`)

Map domain H. The content of the public storefront: service listings, content pages, help articles and legal documents.

Layout, boundaries and the request pipeline: `docs/ARCHITECTURE.md` §§ 2-3 and decision 016. Every route is a zod contract (decision 008); how to add one: `CONTRIBUTING.md`.

Decisions that shape this module: 022 caching. Common to all modules: 008 route contracts, 016 layout and boundaries, 027 database conventions.

## Status

Not built yet: the module is an empty shell (`storefront.module.ts`, `index.ts`). Its feature adds controllers, services, repositories and the owned tables.

## Public API (`index.ts`)

Exports `StorefrontModule` only. Add the services other modules may call here, and nothing else: other modules import only `src/modules/storefront/index.ts` (lint rule `gsm/module-boundaries`).

## Owned tables

Only this module reads and writes these 4 tables (`scripts/module-map.mjs`); other modules call its public service. Schema: `db/schema.ts` once the data layer exists.

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

Outbox events produced (types, payload ids): none yet. Consumed: none yet. Record each outbox type and the queue it maps to here and in `docs/queues.md`.

## Jobs and schedules

None yet. List each queue, job, schedule, idempotency key and retry policy here and in `docs/queues.md` (see `CONTRIBUTING.md` → "Add a job").

## Cache keys

None yet. Register each key family (owner, TTL, invalidation after commit) in `docs/cache-keys.md` (see `CONTRIBUTING.md` → "Add a cache key").
