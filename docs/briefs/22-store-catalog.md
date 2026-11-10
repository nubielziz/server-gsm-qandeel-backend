# Feature 22: Storefront catalog backend (owner list D, `storefront/docs/BACKEND-NEEDS.md`, D6 D-15)

Plan by Fable 5.2 (planner), 2026-11-10, against backend `main` @ `bd32229`. Implementer: one Sonnet 5.5, slices A to E in
order. Worktrees (LEAD-DECISIONS §1): backend `../backend-22` on `feat/backend-22`, console `../frontend-admin-22` on
`feat/console-22`, test database `gsm_22_test`, Redis DB 3. Branch after W0 is merged (new routes are W0 map additions).
Read first: `backend/CLAUDE.md`, `docs/briefs/_common.md` (its frontend-cwd and Serena lines are stale), `_feature.md`,
`CONTRIBUTING.md`, `scripts/map-additions/README.md` (W0), `src/modules/storefront/README.md`, `src/modules/catalog/README.md`;
for slice E `frontend-admin/CLAUDE.md`. Paths are backend-relative; `FA/` = the console worktree, `SF/` = `../storefront`
(READ ONLY: never edit it; its needs are §9).

Rules that bind every slice (LEAD-DECISIONS §7): work only in the two worktrees; never run `docker compose`, `db:migrate`,
`db:seed`, `src/main.ts` or `scripts/ci.sh` there; never touch :3000, :3100, the `gsm` or `gsm_storefront` databases; no git
command that changes state; no agents. Targeted tests while developing (`bun test --timeout 15000 <files>`), heavy runs through
`bash scripts/with-slot.sh …`, `bun run check` once at the end in the foreground.

## 1. What exists and what is missing

| # | Requirement | Status | Evidence (verified in the code) |
|---|---|---|---|
| R1 | Availability and stock filter | missing (data exists) | Card has no stock field (`storefront/contracts/storefront-public.contracts.ts:42-55`); list filters are `brand, network, country, featured, locale` (`:190-196`). Stock = `inventory_codes.status = 'available'`, partial index `inventory_codes_available_idx (service_id, id)` (`catalog/db/schema.ts:562-564`). An order with fewer codes than its quantity still places and goes to a supplier or the manual queue (`catalog/application/inventory-stock.ts:20-23,39-47`) |
| R2 | Real categories with counts | partial | `service_categories` has one `name`, a `type`, no slug (`catalog/db/schema.ts:196-215`). `SellableService.categoryName` is loaded for every card and dropped (`catalog/application/storefront-services.ts:20`; `storefront-catalog.service.ts:57-72`). No category route on any surface; admin CRUD exists (`catalog/contracts/categories.contracts.ts`) |
| R3 | Listing content editable in the console | missing (columns exist) | `service_listings` has `summary, description_md, eta_text, requirements_md, brand, carrier, country, is_featured, sort, seo_title, seo_description` (`storefront/db/schema.ts:45-76`). `PATCH` takes only `isListed, retailPrice` (`contracts/listings.contracts.ts:139-144`), `POST` only `serviceId, locale, publicTitle, slug?` (`:110-115`); rows return none of the content (`:17-39`). Only `scripts/seed/storefront.ts` writes it |
| R4 | Localized delivery time | partial | Card `deliveryTime` = `services.delivery_time`, English or the supplier's raw text (`storefront-catalog.service.ts:69`). `services.sla_minutes` (int > 0) is loaded per card (`storefront-services.ts:25`) and not sent. `etaText` (per language) is on the page only and not editable |
| R5 | Best sellers, popularity sort | missing | Sorts are `featured, sort, title` (`storefront-public.contracts.ts:184-189`). Admin `orders30d` is computed live per page by `salesOf` (`storefront/infra/foreign-reads.repository.ts:167-186`: B2C, not rejected, `placed_at` in 30 days) |
| R6 | New arrivals, publication sort | missing | No publication time: `setListed` writes only `is_listed` (`storefront/infra/listing.repository.ts:179-182`); a listing is created switched off |
| R7 | Service images, staff upload | missing | No image column except the unused `og_file_id` (`storefront/db/schema.ts:65`). Uploads are merchant-only (`platform/application/file-upload.service.ts:99-135`: declared mime trusted, 25 MiB), multipart on 3 routes (`common/multipart.ts:22`). Downloads are 5-minute presigned redirects, `no-store`. One private bucket (`infra/storage/storage.service.ts:149`); `put` sets only the content type (`:46-53,201-209`). helmet sends CSP `default-src 'none'` and its default CORP `same-origin` (`app.bootstrap.ts:159-165`) |
| R8 | Price, type, category, availability filters | missing | See R1/R2; the price is computed in code: `max(retail row, floor)` through `RetailPrices.quotes` (`storefront/application/storefront-quotes.ts:152-168`, `catalog/application/retail-prices.ts:106`), so it cannot be a SQL filter |
| D-15a | Public page list | missing | Only `GET /store/v1/pages/:slug` (`storefront/contracts/public-content.contracts.ts:74-90`) |
| D-15b | Slug of the other language | missing | Listings are unique per `(service_id, locale)` and `(locale, slug)` (`storefront/db/schema.ts:70-71`); no route returns the sibling |
| D-15c | Help "helpful" vote | missing | `help_articles.helpful_yes/no` exist (`storefront/db/schema.ts`), nothing writes them from the store |
| Console | Content editor, image control, category names | missing | `FA/src/features/storefront/types/listing.ts:44-48` (`UpdateListingBody = {isListed?, retailPrice?}`); dialogs are create and price only; `FA/src/features/services/components/CategoryDialog.tsx` has one name |

Constraints verified: nothing is cached on the server for the store catalog (`storefront-catalog.service.ts:81`), answers carry
`Cache-Control: public, max-age=30` (`controllers/storefront-public.controller.ts:10`); a list request with an undeclared
parameter is `422`; every staff write must record an audit row (`AuditEnforcementInterceptor`); every writer of a listing locks
the service row first (`listing-admin.service.ts:195-198`); time comes from the injected `CLOCK`.

## 2. Design

### 2.1 Ownership

| Module | Changes | Why here |
|---|---|---|
| storefront | listing content, `listed_at`, `sales_30d`, `image_file_id`, public card fields, filters and sorts, categories route, page list, alternates, help vote, the popularity job, the two admin image routes | owns `service_listings`, `content_pages`, `help_articles` |
| catalog | `service_categories.name_ar`; `StorefrontServices` gains a sellable filter, in-stock ids and category counts | owns categories, services, inventory; the storefront reads them only through `StorefrontServices` (decision 016) |
| orders | one read-only public class `OrderSalesCounts` (LEAD-DECISIONS §5) | owns `orders` |
| platform | `PublicImages` (inspect, store, read) and the public media route | owns `files` and is the only user of `StorageService` for uploads |
| infra/common (small, named edits) | `MULTIPART_ROUTES` + its spec, two limiters, the admin large-body rule | shared hot files, append-only |

No new module, no new table, no new error code, no new permission, no new audit word (`listing`, `category` exist), no new
cache key, no new queue, no outbox type, no notification event.

### 2.2 Decisions that shape the design (defaults in §8)

1. **Language-neutral facts are service-wide.** `brand`, `carrier`, `country`, `isFeatured`, `sort` and the image describe the
   service, not a translation. They stay columns of `service_listings` (no new table), and every writer sets them on **every
   listing row of the service** under the service row lock, exactly as `retailPrice` already "applies to the listing of every
   language". A new listing inherits them from the service's oldest sibling. Per-language fields: `publicTitle`, `slug`,
   `summary`, `descriptionMd`, `requirementsMd`, `etaText`, `seoTitle`, `seoDescription`, `isListed`, `listedAt`.
2. **Availability is a flag, never a count:** `in_stock` when the available codes cover the smallest orderable quantity
   (`min(qty_options)` when packs are set, else `min_qty`), else `on_request`. Every listed service stays orderable.
3. **Categories are the catalog's**, with an optional Arabic name (`name_ar`, falls back to `name`). The public slug is derived
   (`<id>-<words>`, only the id counts), so nothing new is stored and a rename never breaks a link.
4. **Popularity is stored, not computed per request:** `service_listings.sales_30d`, refreshed by a scheduled job from all
   non-rejected orders of the last 30 days. Only the order of the list leaks, never a number.
5. **`listed_at` is the first publication** and never resets.
6. **Images: content-addressed objects in the private bucket, served by a backend route** (justified in §2.6).
7. **No image library:** type sniffing, dimension parsing and metadata stripping are done on the container bytes without
   decoding pixels (§2.6). `sharp` would add a native dependency and decode memory on a tight box for no extra safety here.
8. **No server cache is added.** Stock, content and sales changes therefore need no invalidation; staleness stays 30 s at the
   API plus the site's own cache.

### 2.3 Catalog module (`src/modules/catalog`)

`application/storefront-services.ts` and `infra/storefront-services.repository.ts`:
- `SellableService` gains `categoryId: number` and `categoryNameAr: string` (`findSellableServices` selects
  `serviceCategories.id` and `.nameAr`).
- `export interface SellableFilter { types?: readonly ServiceType[]; categoryIds?: readonly number[]; inStock?: boolean }`.
  `priced(db, groupId, filter?)` → `findPricedServiceIds(db, groupId, filter)` adds `inArray(services.type, …)`,
  `inArray(services.categoryId, …)` and `IN_STOCK_SQL` (or its negation for `inStock: false`); an empty `types` or
  `categoryIds` list means no restriction. Existing callers pass no filter and behave as today.
- `IN_STOCK_SQL` (one exported SQL fragment, reused by both functions below; bounded count on the partial index):
  `(select count(*) from (select 1 from inventory_codes ic where ic.service_id = services.id and ic.status = 'available'
  limit NEED) s) >= NEED` with `NEED = coalesce((select min(q) from unnest(services.qty_options) q), services.min_qty)`.
- `inStockIds(db, ids): Promise<Set<number>>`: the ids among `ids` for which `IN_STOCK_SQL` holds (one query; empty in, empty out).
- `categoriesOf(db, serviceIds): Promise<SellableCategory[]>` with `SellableCategory { id, name, nameAr, type, sort,
  serviceCount }`: `services ⋈ service_categories where services.id in (…) group by category`, ordered by `sort, id`.
- Pure domain function `domain/storefront-availability.ts`: `smallestOrder(minQty, qtyOptions): number` with a spec (the SQL
  twin is tested against it in the integration test).

Categories admin (`contracts/categories.contracts.ts`, `application/category-admin.service.ts`, repository): `CategoryRow`
gains `nameAr: string`; `POST` and `PATCH` accept `nameAr?: string` (trimmed, at most 80, `''` clears); the existing audit
`before/after` include it; the existing price-version bump stays.

### 2.4 Orders module

New `src/modules/orders/application/order-sales-counts.ts`, exported from `orders/index.ts`:

```ts
/** Counts non-rejected orders per service since a moment (every source). Reads only; takes the caller's db handle. */
@Injectable() export class OrderSalesCounts {
  byService(db: DbExecutor, since: Date): Promise<Map<number, number>>;
}
```
SQL in `infra/order.repository.ts` (or a new small repository file): `select service_id, count(*)::int from orders where
created_at >= $since and status <> 'rejected' group by service_id` (`orders_created_idx`; `created_at` equals `placed_at` at
placement). It has no constructor dependency, so the storefront job module lists it in its own `providers`.

### 2.5 Storefront module

**Listing writes** (`application/listing-admin.service.ts`, `infra/listing.repository.ts`):
- New repository functions: `lockServiceListings(tx, serviceId)` (`select … where service_id = $1 order by id for update`),
  `updateListingFields(tx, id, perLanguageChanges)`, `updateServiceFacts(tx, serviceId, neutralChanges)` (all rows of the
  service), `setListed(tx, id, isListed, now)` (when switching on: `listed_at = coalesce(listed_at, $now)`), `setServiceImage(tx,
  serviceId, fileId | null)`, `siblingFacts(tx, serviceId)` (oldest row's neutral facts), `findSiblingSlugs(db, serviceId,
  exceptLocale)` (listed rows only), `allListings(db, serviceIds, query, cap)` (the unpaged twin of `pageListings`).
- `update(id, changes)`: same transaction and order as today, extended: find listing → `lockLiveService` (service row,
  `FOR UPDATE`) → `lockServiceListings` → decide **every** refusal (existing ones; `slug` through `chooseSlug` → `422` on `slug`;
  slug used by another row of the locale → `409 LISTING_EXISTS` on `slug`, also on the unique violation
  `service_listings_slug_uq`) → writes → audit → fresh view. Audit rows: the three existing phrases unchanged, plus one
  `edited listing of` (entity `listing`, label = service name) when any content or fact field was sent, with `before/after` of
  the fields that changed; for `descriptionMd` and `requirementsMd` record `{ length }` only, never the text; add
  `appliedToLocales` when a neutral fact changed. A request that sends content fields equal to the stored values still writes
  the audit row (the enforcement interceptor needs one).
- `create(input)`: accepts the content fields too; neutral facts not sent are copied from `siblingFacts`; neutral facts sent are
  applied to all rows (the caller holds the service lock in `share` mode today: take `update` mode when facts are sent).
- `uploadImage(id, file)`: outside any transaction call `PublicImages.store(…)` (object first, `files` row second); then one
  transaction: find listing → lock service row → `lockServiceListings` → `setServiceImage` → audit `uploaded image for` (after:
  `{ image: name, width, height, size }`). `removeImage(id)`: same locks, `setServiceImage(null)`, audit `removed image of`.
  A replaced image's `files` row and object stay (content-addressed and deduplicated; a purge is a later job).
- `ListingView` gains the fields of §3.2; `views()` adds one `PublicImages.urlsOf` call per page.

**Public reads** (`application/storefront-catalog.service.ts`):
- `list(query)`: take `type`, `categoryId` and `availability` out of `query.filters` (they are not listing columns; `listWhere`
  would throw) into a `SellableFilter`; `ids = services.priced(db, group, filter)`. **SQL path** (no price parameter, no
  `price` sort): `pageListings` as today, with `popular → sales_30d` and `listedAt → listed_at` added to its `COLUMNS`.
  **Price path** (`minPrice`, `maxPrice` or `_sort=price`): `allListings` (same where and order, `price` sort key removed, cap
  10 000) → `quotes.priced` for all → display gross per row (`quotes.amounts(context, unitNet, 1).display.gross`) → keep
  `minPrice <= gross <= maxPrice` (Money comparison, inclusive) → stable sort by gross when `_sort=price` (ties keep the SQL
  order) → slice the range; `total` = the filtered length.
- `cardOf` gains `category`, `availability` (from `services.inStockIds(db, pageIds)`), `deliveryMinutes`, `etaText`, `listedAt`,
  `imageUrl` (from `PublicImages.urlsOf`). The category name is `categoryNameAr || categoryName` for `ar`.
- `page(…)` adds `alternates` from `findSiblingSlugs`.
- `categories(locale)`: retail group → `priced` ids → the ids with a listed row in `locale` (new repository read) →
  `services.categoriesOf` → rows with the derived slug. New `domain/category-slug.ts` (`categorySlug(id, name)`, the rule of
  `domain/help-slug.ts`; a name without Latin letters or digits gives the bare id) with a spec.

**Public content** (`application/public-content.service.ts`): `pages(query)` lists content pages with status `published` or
`noindex` of one locale (repository `listLivePages`); `vote(slug, helpful, ip)`: id from the slug (existing parser) →
`RateLimitService.consume('help-vote', compositeKey(ip, String(id)))` → when the point is refused do nothing and answer `204`
(no oracle, idempotent for the visitor) → else `update help_articles set helpful_yes|helpful_no = … + 1 where id = $1 and
is_published` without moving `updated_at` (set it to itself); no row → `404`.

**Popularity job** (new `jobs/popularity.ts`, `popularity.processor.ts`, `popularity.module.ts`; pattern
`orders/jobs/idempotency-purge.*`): scheduler id `storefront-popularity`, queue `maintenance`, job `storefront_popularity`,
`pattern: '*/30 * * * *'`, wrapped in `JobRunsService.run` (schedule and manual `runId`), result `{ services, changed }`.
`PopularityRefresh.refresh()`: `since = clock.now() − 30 d` → `OrderSalesCounts.byService` → one statement, raw SQL so
`updated_at` does not move, rows locked in id order, only changed rows written:

```sql
update service_listings l set sales_30d = v.n
  from (select l2.id, coalesce(c.n, 0) as n from service_listings l2
          left join unnest($1::bigint[], $2::int[]) as c(service_id, n) on c.service_id = l2.service_id
         where l2.sales_30d is distinct from coalesce(c.n, 0) order by l2.id for update of l2) v
 where l.id = v.id
```
The module is imported by `src/worker.module.ts` (one appended line; the lead resolves that hot file) and re-exported from
`storefront/index.ts`. Document it in `docs/queues.md` (a section under `maintenance` and a row in "Schedulers").

### 2.6 Images: the choice and the pipeline (platform module)

**Delivery: a backend route, `GET /store/v1/media/:name`, over the private bucket.** Compared options:

| Option | Verdict |
|---|---|
| Public prefix or second public bucket | Refused. `gsm-files` also holds KYC documents and order files: one wrong bucket policy exposes them; it needs new infrastructure in dev, test and production (policy, public S3 endpoint through Caddy, a new env variable) and `StorageService.put` cannot set `Cache-Control` |
| Presigned redirect | Refused. The URL changes on every answer (at most 7 days), so neither browsers nor a CDN nor Next's optimizer can cache it; it exposes the storage host |
| **Backend route (chosen)** | The bucket stays fully private; works the same in dev, test and production with no new infrastructure or env; the name is the SHA-256 of the bytes, so the answer is immutable and carries `Cache-Control: public, max-age=31536000, immutable`: browsers, Caddy and a CDN fetch each image once. The API streams at most 2 MiB per miss; the route reads no database row. The "API never proxies the bytes" note in `file-access.service.ts:2` is about private files (credentials, `no-store`); record the exception in the platform README |

New `src/modules/platform/files/image-inspect.ts` (pure, no dependency, unit-tested with small fixtures):
`inspectImage(bytes: Uint8Array): { ok: true; format: 'jpeg'|'png'|'webp'; ext: 'jpg'|'png'|'webp'; mime; width; height;
bytes: Uint8Array } | { ok: false; code; message }`. Rules, in this order:
1. Size 1 byte to **2 MiB** (`PUBLIC_IMAGE_MAX_BYTES`), else `too_large`.
2. Type from the **magic bytes only** (JPEG `FF D8 FF`; PNG 8-byte signature; WebP `RIFF….WEBP`). The declared media type and
   the file name are ignored. Anything else (SVG, GIF, HTML, PDF, BMP, AVIF) → `unsupported_type`.
3. Structure walk without decoding pixels: JPEG segments to the first SOF marker (width, height) and on to EOI; PNG chunks
   (`IHDR` first, `IEND` last); WebP RIFF chunks (`VP8X`, `VP8 `, `VP8L` headers). A truncated or inconsistent structure →
   `corrupt`. Animated input (`acTL` chunk, WebP `ANIM` flag) → `animated`.
4. Dimensions **200 to 4096 px** per side, else `too_small` / `too_large_dimensions`.
5. Metadata is removed by re-writing the container: JPEG drops `APP1` (EXIF, XMP), `APP13` (IPTC) and `COM` and keeps `APP0`,
   `APP2` (ICC), `APP14`; PNG drops `tEXt`, `zTXt`, `iTXt`, `eXIf`, `tIME` (kept chunks keep their CRC); WebP drops `EXIF` and
   `XMP ` chunks, clears their `VP8X` flags and fixes the RIFF size. Bytes after the end marker are cut (polyglot tails).
6. A JPEG whose EXIF orientation is 2 to 8 → `rotated` ("Save the picture upright and upload it again."): dropping EXIF would
   otherwise show it turned.

New `src/modules/platform/files/public-images.ts` (`@Injectable() PublicImages`, exported from `platform/index.ts`, provided
and exported by `files.module.ts`):
- `store(db, { bytes, filename, staffId }) → { fileId, name, mime, width, height, size }`: `inspectImage` (a failure is
  `VALIDATION_FAILED` on `file` with the code above; over 2 MiB is `PAYLOAD_TOO_LARGE`) → `sha256` of the cleaned bytes →
  key `media/<sha256>.<ext>` → when a `files` row with that bucket and key exists, reuse it; else `StorageService.put(key,
  bytes, { contentType: mime, maxBytes })` then insert the `files` row (`owner_type 'staff'`, cleaned file name via the
  existing `cleanUploadName`); on an insert failure delete the object like `file-upload.service.ts` does.
- `urlsOf(db, fileIds) → Map<fileId, string>`: `'/store/v1/media/' + key.slice('media/'.length)` for rows whose key matches
  `PUBLIC_IMAGE_NAME`; others are absent.
- `read(name) → { bytes, mime } | undefined`: `name` must match `PUBLIC_IMAGE_NAME = /^[0-9a-f]{64}\.(jpg|png|webp)$/`, else
  `undefined` with no storage call; `StorageService.get('media/' + name)`; the mime comes from the extension.
Only this class writes keys under `media/`; `StoredFiles` keys (`<area>/<owner>-<id>/<uuid>`) and upload keys
(`files/Y/M/<uuid>`) can never match the name pattern, so the route cannot reach a private file.

Route plumbing: `'/admin/service-listings/:id/image'` joins `MULTIPART_ROUTES` (`src/common/multipart.ts:22`, pinned list in
`multipart.spec.ts:84`). `publicLimiterFor` (`src/infra/rate-limit/public-ip-limit.ts`): an `admin` request with a large body is
charged to `upload` (as `client` already is), and a `store` path under `/store/v1/media/` is charged to the new limiter
`media` instead of `ip`. New limiters in `limiters.ts`: `media` 1200 per 60 s per IP (a first catalog view fetches up to 100
pictures; they must not eat the 300/min API budget), `help-vote` 1 per 86 400 s per IP + article. Update the rate-limit
README and any spec that pins the limiter names.

### 2.7 Seed

`scripts/seed/storefront.ts`: set `listedAt` (the seed's clock) on rows it inserts listed. `scripts/seed/catalog.ts`: Arabic
names for the demo categories. No image is seeded (it needs storage); adjust `test/integration/storefront-seed.test.ts` only
where its exact expectations name the new columns.

## 3. Database and API

### 3.1 Migrations (LEAD-DECISIONS §4: generated in the worktree as `0020_*`; the lead renumbers at merge)

Slice A generates **the one migration of the feature** with every column (later slices only use them):
`bun run db:generate --name store_catalog`:

| Table | Column | Type | Note |
|---|---|---|---|
| `service_listings` | `listed_at` | `timestamptz(3)` null | first publication |
| `service_listings` | `sales_30d` | `integer not null default 0` | written only by the job |
| `service_listings` | `image_file_id` | `bigint` null → `files(id)` on delete restrict | + index `service_listings_image_file_id_idx` (FK index rule) |
| `service_categories` | `name_ar` | `text not null default ''` | |

Custom migration `bunx --bun drizzle-kit generate --custom --name store_catalog_backfill`:
`update service_listings set listed_at = created_at where is_listed and listed_at is null;`

Also: `test/schema/structure.test.ts` `ADDITIONS` gains `service_listings: ['listed_at', 'sales_30d', 'image_file_id']` and
`service_categories: ['name_ar']`; any spec that names these migration files reads the name from one constant. The console's
generated `schema.gen.ts` comes from the map and does not gain these columns: console types add them by hand (§4).

### 3.2 Changed routes (all additive; keys unchanged)

**`GET /admin/service-listings`** (`storefront:read`): row gains `summary: string`, `etaText: string`, `brand: string`,
`carrier: string`, `country: string` (ISO-2 or `''`), `sort: number`, `seoTitle: string`, `seoDescription: string`,
`listedAt: IsoDateTime | null`, `imageUrl: string | null`, `updatedAt: IsoDateTime`. New sorts `listedAt`, `sort`; new filter
`isFeatured` (boolean).

**`GET /admin/service-listings/:id`, `POST`, `PATCH`** answer `ListingDetail` = the row plus `descriptionMd: string`,
`requirementsMd: string` (the list leaves the two Markdown bodies out to keep pages small).

**`PATCH /admin/service-listings/:id`** (`storefront:update`, CSRF, audited): the body keeps `isListed?`, `retailPrice?` and
gains, all optional, "at least one field" still required:

| Field | Rule | Scope |
|---|---|---|
| `publicTitle` | `titleField` (1 to 200) | this language |
| `slug` | `SlugField`, form checked by `chooseSlug` (`422` on `slug`); taken in the locale → `409 LISTING_EXISTS` on `slug` | this language |
| `summary` | trimmed, one line (no control characters), at most 300 | this language |
| `descriptionMd` | `markdown(20_000)` | this language |
| `requirementsMd` | `markdown(10_000)` | this language |
| `etaText` | trimmed, one line, at most 80 | this language |
| `seoTitle`, `seoDescription` | `SeoTitleField`, `SeoDescriptionField` | this language |
| `brand`, `carrier` | trimmed, one line, at most 80 | every language of the service |
| `country` | `''` or two letters, stored upper case | every language |
| `isFeatured` | boolean | every language |
| `sort` | integer 0 to 1 000 000 | every language |

Errors unchanged plus `LISTING_EXISTS`. Audit: existing phrases plus `edited listing of`.
**`POST /admin/service-listings`** (`storefront:create`): the body gains the same optional fields except `slug` (already there).

**`GET|POST|PATCH /admin/service-categories…`** (`catalog:read|create|update`): row gains `nameAr: string`; `POST`/`PATCH`
accept `nameAr?` (at most 80, `''` clears). No new error.

**`GET /store/v1/services`** (public, no Turnstile, limiter `ip`, `Cache-Control: public, max-age=30`):
- card gains `category: { id: number, slug: string, name: string }`, `availability: 'in_stock' | 'on_request'`,
  `deliveryMinutes: number` (integer > 0), `etaText: string` (`''` when none; moved from the page to the card),
  `listedAt: IsoDateTime | null`, `imageUrl: string | null` (root-relative, `/store/v1/media/<name>`). `deliveryTime` stays.
- filters: `type` (enum `imei|server|remote|file`, `eq`, repeatable), `categoryId` (id, `eq`, repeatable), `availability`
  (enum, `eq`). Extras: `minPrice`, `maxPrice` (decimal text ≥ 0, at most 4 decimals, in the requested `currency`, compared
  with `price.gross`; `minPrice > maxPrice` is `422` on `maxPrice`).
- sorts: `popular`, `listedAt`, `price` join `featured`, `sort`, `title` (default order unchanged; the id breaks ties).
**`GET /store/v1/services/:slug`**: the card additions plus `alternates: [{ locale: 'en'|'ar', slug: string }]` (the listed
pages of the same service in the other languages; empty when none).

### 3.3 New routes (rows of `scripts/map-additions/22.mjs`, stage 22)

| Key | Access | Request → answer | Errors | Limits |
|---|---|---|---|---|
| `GET /store/v1/categories` | public | query `locale` (`en` default) → `200 { locale, categories: [{ id, slug, name, type, serviceCount }] }`: categories with at least one listed, sellable, priced service in the language, in category order, at most 500; `Cache-Control: public, max-age=30` | `VALIDATION_FAILED` | `ip` |
| `GET /store/v1/media/:name` | public | `200` image bytes (`success.contentType: 'image/*'`; if `defineRoute` refuses the wildcard declare `application/octet-stream`; the controller always sets the real type). Headers: `Content-Type`, `Cache-Control: public, max-age=31536000, immutable`, `ETag: "<sha256>"`, `Content-Disposition: inline`, `Cross-Origin-Resource-Policy: cross-origin`, `X-Content-Type-Options: nosniff`. A name that does not match the pattern or has no object → `404` | `NOT_FOUND`, `UNAVAILABLE` | `media` |
| `GET /store/v1/pages` | public | list dialect: `locale` extra (`en` default), filter `kind` (enum of `CONTENT_PAGE_KINDS`, `eq`, repeatable), `q` over `title`, sorts `publishedAt` (default desc), `title`, pages of at most 100 → rows `{ kind, slug, locale, title, seoDescription, noindex, publishedAt, updatedAt }` (status `published` or `noindex`; legal documents are not listed); `x-total-count`; `max-age=30` | `VALIDATION_FAILED` | `ip` |
| `POST /store/v1/help/:slug/vote` | public (store CSRF rule as every public store POST: a signed-in customer sends the token) | body `{ helpful: boolean }` → `204`; a repeat within 24 h from the same IP is accepted and ignored | `VALIDATION_FAILED`, `NOT_FOUND`, `CSRF_FAILED` | `ip` + `help-vote` |
| `POST /admin/service-listings/:id/image` | `storefront:update`, CSRF, audited (`uploaded image for`) | multipart, one part `file` → `200 ListingDetail` | `UNAUTHORIZED`, `FORBIDDEN`, `CSRF_FAILED`, `NOT_FOUND`, `VALIDATION_FAILED` (on `file`: `empty`, `unsupported_type`, `corrupt`, `animated`, `too_small`, `too_large_dimensions`, `rotated`), `PAYLOAD_TOO_LARGE`, `UNSUPPORTED_MEDIA_TYPE`, `UNAVAILABLE` | `upload` (20/min per IP) |
| `DELETE /admin/service-listings/:id/image` | `storefront:update`, CSRF, audited (`removed image of`) | → `204` (also when there was none: still audited) | `UNAUTHORIZED`, `FORBIDDEN`, `CSRF_FAILED`, `NOT_FOUND` | — |

No Turnstile on any of them (reads, a staff route, and a vote whose worst abuse is a skewed counter).

```js
// scripts/map-additions/22.mjs
import { R } from '../lib/map-additions.mjs';
export const rows = [
  R('store', 'catalog', 'GET', '/store/v1/categories', 'تصنيفات المتجر مع عدد الخدمات المعروضة في كل تصنيف', 'عام', 22,
    ['service_categories', 'service_listings', 'services'],
    { en: 'List the storefront categories with their listed service counts.', module: 'storefront', spec: 'B-TBD store-categories' }),
  R('store', 'catalog', 'GET', '/store/v1/media/:name', 'صورة خدمة عامة (ملف ثابت يُخزَّن طويلاً)', 'عام', 22, ['files'],
    { en: 'Serve a public service image (immutable, long cache).', module: 'platform', spec: 'B-TBD store-media' }),
  R('store', 'content', 'GET', '/store/v1/pages', 'قائمة الصفحات المنشورة', 'عام', 22, ['content_pages'],
    { en: 'List the published content pages.', module: 'storefront', spec: 'B-TBD store-page-list' }),
  R('store', 'content', 'POST', '/store/v1/help/:slug/vote', 'تصويت «هل كان هذا مفيداً؟» على مقال مساعدة', 'عام', 22, ['help_articles'],
    { en: 'Vote whether a help article was helpful.', module: 'storefront', spec: 'B-TBD help-vote' }),
  R('admin', 'storefront', 'POST', '/admin/service-listings/:id/image', 'رفع صورة الخدمة', 'storefront:update', 22,
    ['service_listings', 'files', 'audit_logs'],
    { en: 'Upload the picture of a listed service.', module: 'storefront', spec: 'B-TBD listing-image', successStatus: 200 }),
  R('admin', 'storefront', 'DELETE', '/admin/service-listings/:id/image', 'إزالة صورة الخدمة', 'storefront:update', 22,
    ['service_listings', 'audit_logs'],
    { en: 'Remove the picture of a listed service.', module: 'storefront', spec: 'B-TBD listing-image', successStatus: 204 }),
];
```
Check the group ids against `groups` of the map when writing the file (`catalog` and `content` on `store`, `storefront` on
`admin` are what `docs/route-manifest.json` shows for the sibling routes). After adding rows: `bun run routes:build`; after
building the routes `bun run contract:docs`, `bun run docs:openapi`, `bun run coverage:build`.

## 4. Admin console (`FA/`, slice E; rules of `FA/CLAUDE.md`: fetch through `src/lib/api`, components ≤ ~200 lines, one
exported function per endpoint with `@route`, mocks updated, the server's error text shown)

- `src/features/storefront/types/listing.ts`: `ServiceListing` gains the row fields of §3.2 (typed by hand, with a comment that
  the map's generated row lacks `listedAt`/`imageUrl`); new `ServiceListingDetail` (+ `descriptionMd`, `requirementsMd`);
  `UpdateListingBody` and `CreateListingBody` gain the optional fields.
- `api/listings.ts`: `getListing`, `createListing`, `updateListing` return `ServiceListingDetail`; new
  `uploadListingImage(id, file: File)` (`FormData` with `file`; `@route POST /admin/service-listings/:id/image`) and
  `removeListingImage(id)` (`@route DELETE /admin/service-listings/:id/image`).
- Hooks: `useListing(id)` (detail query for the dialog), `useUpdateListingContent`, `useUploadListingImage`,
  `useRemoveListingImage` in `hooks/useListingMutations.ts` (same invalidation keys as the existing two).
- Components: `ListingEditDialog.tsx` (opened from a new row action "Edit listing" in `ListingTable.tsx`), split so no file
  passes ~200 lines: `ListingContentFields.tsx` (title, slug with the hint "changing it changes the public link", summary,
  description and requirements as Markdown textareas like `ContentPageDialog.tsx`, delivery note), `ListingFactsFields.tsx`
  (brand, carrier, country, featured, position, under the note "These apply to every language of this service"),
  `ListingSeoFields.tsx`, `ListingImageField.tsx` (preview of `imageUrl`, file input `accept="image/jpeg,image/png,image/webp"`,
  a client check of 2 MiB before sending, upload and remove buttons, the server's field error under the control). The dialog
  sends only changed fields. `ListingTable.tsx`: a small thumbnail in the Service cell and a "Listed on" value where it fits.
- `src/features/services`: `types/catalog.ts` (`nameAr`), `components/CategoryDialog.tsx` (field "Arabic name (storefront)",
  optional), `api/categories.ts` bodies, mocks.
- Mocks (`mocks/dto.ts`, `listingRoutes.ts`, `seed.ts`, services `categoryRoutes.ts`): accept and return the new fields; the
  image routes keep an object URL in the mock store. Tests beside the changed components and hooks.
- Feature `HANDOFF.md`: rows for the two new routes (assumed contracts → real ones) and anything shared it needed.
- After the console merge the backend lead runs `routes:build && contract:extract && contract:docs`; the two admin additions
  already carry `successStatus`, so shape parity finds them. The console's own manifest reports the two tags as unknown
  (accepted, LEAD-DECISIONS §2).

## 5. Risks and how the design closes them

| Area | Risk | Closure |
|---|---|---|
| Security | Uploaded file is not what it claims (SVG or HTML with script, polyglot) | type from magic bytes only; three raster formats; structure walked and re-written; tail cut; served with the sniffed type, `nosniff`, CSP `default-src 'none'`, `Content-Disposition: inline`; never the client's type or name |
| Security | Decompression bomb, memory | pixels are never decoded; 2 MiB and 4096 px caps; multipart bodies are already bounded and now counted by `upload` on `/admin` |
| Security | The media route reads a private object | the key is built only from a name matching `^[0-9a-f]{64}\.(jpg\|png\|webp)$` under `media/`; only `PublicImages` writes there; test tries `..`, encoded slashes, a KYC key |
| Privacy | EXIF/GPS in photos | metadata segments removed before storing |
| Privacy/business | Stock or sales volumes leak | a two-state flag; no count; popularity is an order only |
| Integrity | Neutral facts drift between languages | one writer path under the service lock writes all rows; create inherits; test asserts both rows after a PATCH on one |
| Concurrency | Job and staff edits deadlock on listing rows | both lock listing rows in id order; the job never takes the service lock; one statement |
| Concurrency | Two uploads of the same image | same key and bytes: `put` is idempotent; the `files` row is looked up first, a rare duplicate row is harmless |
| Concurrency | `listed_at` set twice | `coalesce(listed_at, $now)` in the guarded update under the service lock |
| Performance | Price path is O(listed services of the language) | used only with `minPrice`, `maxPrice` or `_sort=price`; capped at 10 000; 30 s public cache and the `ip` limiter bound it; if it shows in metrics, cache unit prices per catalog version (decision 022) in a later change |
| Performance | Extra reads per list page | two batched queries (in-stock ids, image names); the category comes with the existing join |
| Performance | Pictures eat the API rate budget | own limiter `media`; immutable caching; Caddy or a CDN may cache (24D) |
| Compatibility | Site sends new parameters before the API has them → `422` | deploy the backend first (§9); every response change is additive; keys and `operationId`s unchanged |
| Compatibility | Console sends only `isListed` or `retailPrice` | still valid; show/POST/PATCH answers only gain fields |
| Content | B2B or supplier category names ("Imported") become public | staff rename or set `nameAr`; the console labels the field; noted in the README |
| Content | A changed slug breaks links | allowed, with a console hint; `alternates` and the id let the site recover |

Financial integrity: no ledger, price or order write changes. `retailPrice` handling is untouched; the price path reuses
`StorefrontQuotes` so a filtered price equals the shown and charged one.

## 6. Slices (one implementer, in order; each ends with its targeted tests green)

**A. Content, delivery time, publication, filters and sorts, categories (large).** Files: `scripts/map-additions/22.mjs`
(rows of A only if you prefer; all six rows may land here with unbuilt keys in `test/contract/pending.ts`);
`drizzle/0020_store_catalog.sql` + snapshot + journal, `drizzle/0021_store_catalog_backfill.sql`; `storefront/db/schema.ts`,
`catalog/db/schema.ts`; `test/schema/structure.test.ts`; catalog `storefront-services.ts`, `storefront-services.repository.ts`,
`categories.contracts.ts`, `category-admin.service.ts` + its repository; storefront `contracts/listings.contracts.ts`,
`contracts/storefront-public.contracts.ts`, `application/listing-admin.service.ts`, `application/storefront-catalog.service.ts`,
`infra/listing.repository.ts`, `infra/foreign-reads.repository.ts` (admin sorts/filter), `domain/category-slug.ts` (+ spec),
`controllers/storefront-public.controller.ts` (categories), `controllers/listings.controller.ts`; seeds; READMEs.
Acceptance: PATCH/POST write every field with the scopes of §3.2 and audit; `listedAt` set once; cards carry `category`,
`deliveryMinutes`, `etaText`, `listedAt`; filters `type`, `categoryId`, price and sorts `listedAt`, `price` work with exact
totals; `GET /store/v1/categories` counts match the list totals per category; old requests answer as before.

**B. Availability and popularity (medium).** Files: catalog `domain/storefront-availability.ts` (+ spec),
`storefront-services*.ts` (`IN_STOCK_SQL`, `inStockIds`, the `inStock` filter); orders `application/order-sales-counts.ts`,
repository read, `index.ts`; storefront `jobs/popularity*.ts`, `index.ts`, card `availability`, filter `availability`, sort
`popular`; `src/worker.module.ts` (one import); `docs/queues.md`.
Acceptance: the flag follows imports, voids and sales; `availability=in_stock` pages and counts in SQL; the job is idempotent,
writes `job_runs`, never moves `updated_at`; `_sort=popular` orders by it.

**C. Images (large).** Files: platform `files/image-inspect.ts` (+ spec + fixtures under `test/fixtures/images/`),
`files/public-images.ts`, `files.module.ts`, `index.ts`, `contracts/public-media.contracts.ts`,
`controllers/public-media.controller.ts` (registered where `FilesController` is, `platform-admin.module.ts`, or a small
public module imported by the platform root; it needs storage only), `README.md`; `src/common/multipart.ts` (+ spec);
`src/infra/rate-limit/limiters.ts`, `public-ip-limit.ts` (+ specs, README); storefront image use cases, contracts, controller,
`imageUrl` on rows and cards.
Acceptance: every refusal of §2.6 answers `422` on `file` with its code; a valid upload is stored once, linked to every language
row, served by the media route with the headers of §3.3; removal clears every row; nothing private is reachable.

**D. Page list, alternates, help vote (small).** Files: `storefront/contracts/public-content.contracts.ts`,
`application/public-content.service.ts`, `infra/content-page.repository.ts`, `infra/help-article.repository.ts`,
`controllers/public-content.controller.ts`, `showStoreService` contract + service (`alternates`), limiter `help-vote`.
Acceptance: drafts and legal documents never listed; `alternates` only names listed siblings; a second vote from one IP does
not count and still answers `204`; `updatedAt` of the article does not move.

**E. Console (medium, in `../frontend-admin-22`, after A and C are done in the backend worktree).** Files of §4.
Acceptance: every content field and the image can be edited and removed from the dialog; the category dialog saves `nameAr`;
`npm run typecheck && npm run lint && npm run build && npm test` green.

End of the backend work: remove built keys from `test/contract/pending.ts`; `bun run routes:build`, `bun run contract:docs`,
`bun run docs:openapi`, `bun run coverage:build`, `bun run format`, then `bun run check` (foreground). Report: files by folder,
spec decisions (§8), migrations, anything blocked.

## 7. Tests (by file)

| File | Covers |
|---|---|
| `src/modules/platform/files/image-inspect.spec.ts` | each format accepted with exact width/height; SVG, GIF, HTML, PDF, empty, truncated, animated PNG/WebP, 199 px, 4097 px, over 2 MiB, rotated JPEG refused with its code; EXIF/XMP/text chunks gone and the output still parses; a tail after EOI/IEND is cut; output is deterministic |
| `src/modules/catalog/domain/storefront-availability.spec.ts`, `src/modules/storefront/domain/category-slug.spec.ts` | smallest order with and without packs; slug with Latin, Arabic-only and empty names |
| `test/integration/storefront-listings.test.ts` (extend) | PATCH each field: success, limits (`422` with the field), slug conflict `409`, neutral facts written to both language rows, create inherits them, one audit row with changed fields and no Markdown text, `listedAt` set on first switch-on and kept after off/on, admin sorts/filter, `403` without `storefront:update`, old bodies unchanged |
| `test/integration/storefront-catalog.test.ts` (extend) | new card fields; `type`, `categoryId` (repeated), `availability` filters with `x-total-count`; `minPrice`/`maxPrice` bounds inclusive in a non-USD currency and with `buyerCountry`; `_sort=price|popular|listedAt` both orders with stable paging; `minPrice > maxPrice` `422`; unknown parameter still `422`; `alternates`; categories route counts and Arabic names; B2B-only and inactive categories never appear |
| `test/integration/storefront-availability.test.ts` | flag after an inventory import, a void and a sale that empties the stock; packs; SQL twin equals the domain function |
| `test/integration/storefront-popularity.test.ts` | counts by service from mixed sources, rejected excluded, 30-day edge with `TestClock`; run twice = same rows and `updated_at` unchanged; `job_runs` row; a manual `runId` |
| `test/integration/storefront-images.test.ts` | upload success (file row owner staff, key `media/<sha>.<ext>`, both language rows linked, audit), same bytes twice = one object, each refusal, `413`, non-multipart `415`, `403`, `404`; delete; media route headers and bytes; bad names (`..%2f`, upper case, wrong extension, a private key) are `404`; limiter `media` is the one charged |
| `test/integration/storefront-public-content.test.ts` (extend) | page list filters, search, sort, paging, locale, drafts and legal excluded; vote counts once per IP and article, `404` for unpublished, `updatedAt` kept |
| `test/integration/catalog-categories.test.ts` (or the existing categories test) | `nameAr` create, change, clear, audit |
| `src/common/multipart.spec.ts`, rate-limit specs | the new multipart route; `media`, `help-vote`, admin large body → `upload` |
| Contract suite (`bun test test/contract`) | route, access, Turnstile parity for the six additions; OpenAPI examples validate |
| Console | dialog fields and changed-only body, image field (type and size guard, upload, remove, server error), category dialog, mocks |

## 8. Decisions

Owner decisions taken with defaults (the owner may change them; the final report lists them):
1. Availability shows `in_stock` / `on_request` only; no stock number, no "low stock". A stock-only service with no codes keeps
   selling to the manual queue, as today.
2. Storefront categories are the catalog's categories with an optional Arabic name; no separate storefront taxonomy.
3. Brand, carrier, country, featured, position and the picture apply to every language of a service.
4. The customer-facing delivery time is `sla_minutes` (staff correct it in the service form); `etaText` overrides it per language.
5. Best sellers count every non-rejected order of the last 30 days from every channel (merchants included), refreshed every
   30 minutes; the shop shows the order only.
6. "New" means first published; switching a listing off and on does not make it new again.
7. Pictures: JPEG, PNG or WebP, at most 2 MiB, 200 to 4096 px, one per service; a replaced picture's file is kept.
8. Price filters compare the price the visitor sees (`gross`, tax included when the country is known) in the chosen currency.
9. One "helpful" vote per visitor IP per article per day.

Spec decisions for the lead's B-entries: (a) schema additions `service_listings.listed_at, sales_30d, image_file_id` and
`service_categories.name_ar` (precedent B116); (b) six routes beyond the map (§3.3); (c) public images are served by the API
from the private bucket under `media/`, an exception to "the API never proxies bytes"; (d) neutral listing facts are written
to every language row; (e) limiters `media` and `help-vote`, large admin bodies counted by `upload`; (f) the admin list omits
the two Markdown bodies; (g) `etaText` moved from the page schema to the card (the page still has it); (h) storefront
popularity reads orders through `OrderSalesCounts` (no new foreign read); (i) no image library, metadata stripped by container
rewrite.

Out of scope, recorded: a translation key for content pages (pages of two languages cannot be paired; D6 #6, size M); localized
service titles and delivery times inside the checkout session and tracking answers (customers and orders modules, not 22's);
`og_file_id` share images; server-side facet counts other than categories; purging unreferenced images; redirects for changed
slugs; resizing or thumbnails (the site's image optimizer does it).

## 9. Storefront handoff (wire facts for the site; deploy the backend before the site uses them)

- Cards (`GET /store/v1/services`, also inside `/services/:slug`) gain: `category {id, slug, name}` (name in the requested
  `locale`), `availability` (`in_stock` = delivered at once from stock; `on_request` = processed after the order; both can be
  bought), `deliveryMinutes` (format per language; show `etaText` instead when it is not empty; `deliveryTime` stays but is
  English), `etaText`, `listedAt`, `imageUrl` (root-relative path or `null`; keep the type picture as the fallback).
- New list parameters: `type` (repeatable), `categoryId` (repeatable; the id is the number before the first `-` of a category
  slug), `availability=in_stock`, `minPrice`, `maxPrice` (in `currency`, against `price.gross`), `_sort=popular|listedAt|price`.
  Sending them to an older API answers `422`.
- `GET /store/v1/categories?locale=` → `{ locale, categories: [{ id, slug, name, type, serviceCount }] }` for the menu, the
  tiles and the sidebar counts. Brand, network, country and type counts stay client-side.
- `GET /store/v1/services/:slug` gains `alternates: [{ locale, slug }]` for the language switch (trap 16 of the handoff).
- `GET /store/v1/pages?locale=&kind=&_sort=publishedAt&_order=desc` lists published pages (blog index, sitemap; skip
  `noindex: true` rows in the sitemap). `POST /store/v1/help/:slug/vote {helpful}` → `204`.
- Images: `GET /store/v1/media/<name>` is immutable (one year); it goes through the existing `/store/v1/*` rewrite. For
  `next/image` add `images.localPatterns: [{ pathname: '/store/v1/media/**' }]` and use `fill` (the API sends no dimensions);
  no query string is ever needed. Under an `api.` host topology prefix the API origin and use `remotePatterns`.
- Regenerate `lib/api/schema.gen.ts` from `docs/contract/openapi.json` after the merge; no `operationId` changed.
- Staff can now write summaries, descriptions, brands and Arabic content in the console, so the SQL copy of English facts
  into Arabic rows is no longer needed (facts are shared by both languages).

## 10. Review against the code, and approval

Checked in the code, not only in the reports: the contracts and use cases of both listing surfaces, `pageListings` and its
filter handling, `StorefrontServices` and its repository, `visibleTo`, `StorefrontQuotes.priced/amounts`, `salesOf`, the
`service_listings`, `service_categories`, `inventory_codes`, `help_articles` and `content_pages` tables, the list dialect's
filter types (`id`, `enum`, repeatable `eq`), `listOrderBy` (nulls last, id tie-break), `StoredFiles`, `FileUploadService.upload`,
`StorageService.put/get`, `MULTIPART_ROUTES`, `publicLimiterFor`, `RATE_LIMITERS`, helmet's options, the binary route pattern
(`order-tracking.controller.ts:55-66`), the scheduled job pattern (`idempotency-purge.*`), `AUDIT_ENTITY_TYPES` (`listing`,
`category`, `help_article` exist), the structure test's `ADDITIONS`, the manifest rows of the sibling routes, the W0 additions
format, and the console's listing types, API functions and mutation hooks.

Corrections to D4: the report suggests a `service_popularity` table and a `service_media` table; this plan needs neither (two
columns, same ownership, no join). It suggests an image check that only validates; this plan also strips metadata without a
library. It lists a public bucket as option (a); refused above. No lead decision conflicts with the design; the edits outside
22's modules are the small, named ones of §2.6 (`multipart.ts`, rate-limit files) and one line in `worker.module.ts`.

Open points the implementer must confirm while building (none blocks): whether `defineRoute` accepts `image/*` as
`success.contentType`; whether `files` has a unique `(bucket, key)` (if not, look the row up by key before inserting);
the exact name of the catalog categories integration test.

**Approved by Fable 5.2**
