# Feature 31: publish services to the shop in bulk (a preview, one step from Quick add, retail price rules that follow the cost)

Written by Fable 5.2 (planner), 2026-11-16, against backend `main` @ `121e83e`, console `main` @ `939ae2b`, website `main` @
`68eb019`, **read as the state after feature 30** (`docs/briefs/30-english-only.md`: English only, one listing per service, one
slug for the site, no `locale`, no `nameAr`, migrations 0034-0039 and B224-B227 taken, the `english:check` guard). Owner request
(2026-11-16, `/home/saifi/gsm-project/.bulk-publish/OWNER-REQUEST.md`): publish services to the shop in bulk with a preview, let
Quick add publish what it adds, and price the shop by rules that follow the supplier's cost; the owner is away and wants the
feature finished, so every open point has a default (section 13). Inputs: the three scout inventories in
`/home/saifi/gsm-project/.bulk-publish/audit/`, cited as **A1** (backend, `1-backend.md`), **A2** (console, `2-console.md`) and
**A3** (the study of the 1157 real supplier names, `3-names.md`, with its prototype `audit/tmp/prototype.ts`). The audits are the
file lists: this brief cites their sections, and an implementer opens the cited section before editing. Read first:
`backend/CLAUDE.md`, `docs/briefs/_common.md`, `_feature.md`; console slices also `frontend-admin/CLAUDE.md`. Paths are
backend-relative; `FA/` = the console worktree. No agent commits, runs git that changes state, spawns agents, or touches the
databases `gsm` and `gsm_storefront` (only the lead does, section 10). The website needs no change (fact 6).

**Revised on 2026-11-16 after two adversarial reviews.** Section 15 lists every finding, what changed and why. The parts
that changed most: 3.2, 4.2, 5.2, 6.2, 6.5, 6.7 (new), 8.3 and the slices of section 9.

**Line numbers are of today's `main`.** Feature 30 edits several of the files cited (A1 section 0 lists them); the lead's step
L0 re-reads the merged tree and corrects a name here where slice B1 of feature 30 chose another one.

**L0 correction (lead, 2026-11-17, on `main` @ `f354855`, feature 30 merged).** One name differs: feature 30 removed
`lockServiceListings(db, serviceId)` (a service has one listing now); `storefront/infra/listing.repository.ts` has only
`lockListing(db, id)`. Where this brief says `lockServiceListings` (6.2 step 5, 6.7 step 2), **slice B3a adds
`lockListingOfService(db, serviceId)`** to that file (`SELECT ... WHERE service_id = $1 FOR UPDATE`, at most one row, the
row or `undefined`) and both callers use it. Every other symbol named here exists under its name: `ListingAdminService.create`
/ `update`, `listingConflict`, `slugTaken`, `findServiceFacts`, `lockOf`, `ServiceImporter.categoryFor`,
`CategoryAdminService.remove`, `RetailPrices`, `storefrontFloor`, `groupPriceProblems`, the constraints
`service_listings_service_uq` and `service_listings_slug_uq`, the row shape of `scripts/map-additions/30.mjs` (an `en`
sentence, `module`, `spec`, `successStatus`), and `notification_templates (event, channel, audience, subject, body,
is_active)` with the unique key `notification_templates_event_uq (event, channel, audience)` for the rows `0043` inserts.
The rulings B228-B231 are in `docs/contract/lead-decisions.json` (`extra` indexes 123-126). Migrations start at **0040**
(the journal ends at `0039_english_only_accounts`).

**Decisions after the review of B2 (lead, 2026-11-17; they change 3.5 and 8.2 below).**
- **The cut (R13) never drops a restriction.** A trailing clause that holds `not`, `no`, `non`, `only`, `without`, `except`
  or `wrong` stops the cut: a new listing has no description yet, so the title is the only place a customer reads "No
  refund" or "7/7+ not supported". Such a title may stay over 80 characters (81-100: the soft flag `title_81_100`; over
  100: the hard flag `title_long`). For that reason the floor of section 8.2 "a title that is not empty and at most 80
  characters" is **1070**, not 1076; "at most 60 names wait" stays.
- **R7 (marketing words)** keeps a marketing word only right after `not` or `no`. The sentence of 3.5 also names `only`;
  on the real names that made three titles worse (#489, #490, #1097), so `only` is left out.
- **Letters that look Latin** (the Turkish dotted and dotless i, a Cyrillic O inside a Latin word) become their Latin
  letter in R1, so a slug never breaks inside such a word.
- `nameAll` takes an optional `fixedTitle` per row (an edited row copied by "Check again", 6.1 step 4). The facts are still
  detected from the name: **slice B4a puts an edited row's own brand, carrier and country back** after naming.

**Resume (lead, 2026-11-18, after `main` @ `35ce78e` was merged into both branches).** The owner postponed the feature on
2026-11-17 and resumed it on 2026-11-18. Main moved meanwhile: feature 32 (migration 0040, decision 041, B232, M266), feature 33
(decision 042, B233, M267: a supplier sync can turn a service into `server` and make its fields required) and the IMEI-HUB
brand. **The migrations of this feature are one number higher than this brief says:** `0041_retail_price_rules` (brief: 0040),
`0042_listing_publish_runs` (0041), then 0043 (0042), 0044 (0043, the templates) and 0045 (0044, Quick add). Decision 040,
B228-B231 and M265 stay. `test/fixtures/publish/supplier-names.json` no longer holds the owner's real costs (the repository
is public): its costs are made-up figures of every size, so "the 1157 real costs" of 8.1 and risk 1 now means the fixture's
1157 costs; zero stays zero, and the names are the real ones.

**Plan corrections after the merge (lead, 2026-11-18, from a check of this plan against the merged code; they override the
sections below).**
1. **Naming a service that feature 33 moved to `server`** (3.5, 6.1; slice B4a). Decision 042 makes an IMEI supplier service
   whose main box is not an IMEI a catalog `server` service: 352 of the owner's 880 `server` services today. The rows are
   named as **`imei` when the service's type is `imei` or it has a main-box field** (`isMainInputKey(resolvedSupplierKey(field))`
   of `src/common/dhru`), so they keep their carrier and device brand. `publishFactsOf` carries the flag; the naming code of B2
   does not change. A test: such a `server` service keeps its carrier and brand.
2. **A draft evaluation** (B4a, B4b): `evaluateItem` throws `RangeError` on a `cost_moved` decision, so every evaluation of a
   draft calls it with the row's cost equal to the cost of now. Only the publisher can reach `cost_moved`.
3. **The follow pass when the service moved and the rules did not** (3.4, 6.4; B5). A sync adoption changes a service's type
   and category without any staff action, so the rule that prices it can change unattended. When the rule of now differs from
   the follow row's rule, and that follow rule is still live, active and unchanged since `applied_at`, the pass **opens a
   proposal with the reason `rule_changed`** and leaves the price alone. A rule staff edited, switched off or deleted applies
   at once, as 3.4 says.
4. **The hourly message** (6.4; B5): the dedupe key is per channel, `retail-follow:<first unnotified id>:<channel>`, because
   `notifications_dedupe_key_uq` covers the key alone. A test: email and Telegram each get a row.
5. **The templates migration** (4, row B5; it is 0044 now): `test/support/applied-templates.ts` is part of the slice (its reader
   must accept an insert without `locale`, and the migration joins its `MIGRATIONS`); the staff assertions of the default
   templates' spec narrow to `alert.*`; `STAFF_SAMPLE` gains the new placeholders; the SQL comes from `templatesInsertSql`.
6. **The job `retail_price_follow`** (6; B5): the Jobs tab lists every scheduler and its manual run queues `{ runId }`. The
   processor reads `data.runId` and records manual and scheduled runs in `job_runs` (`job.repeatJobKey` marks the hourly one),
   as `FxRefreshProcessor` does; the delayed job runs unrecorded.
7. **`categoryFor`** (3.5; B6): it now also serves the adoption of decision 042. The raw-then-cleaned lookup and the cleaned name
   apply only on the import's path from `create`; the adoption keeps its exact-name lookup.
8. **`replaceChain`** (4.3; B6) deletes and reinserts a service's links: `KeptLink` keeps `importRunId`, with a test, or saving a
   chain would drop the service from its Quick add run.
9. **Quick add's wire** (5.5, 7.4; B6, C4): section 5.5 stands (the tick needs `storefront:publish`; the run says `publish`; the
   publish run is found with `GET /admin/publish-runs?quickAddRunId=`). Ruling B231 is corrected to say the same.
10. **6.5, the sync row:** the sync now also takes `FOR UPDATE` on each service it adopts or repairs, in id order, and `FOR SHARE`
    on the target category. There is no cycle: a publish holds one service row and takes no category lock. An apply can therefore
    meet a new type, category or rule; `publishLocked` re-reads them under the service lock, and `resultDetail` says when the price
    differs from the preview.
11. **What an IMEI rule covers** (3.3; C4): a type rule for `imei` covers only services that take a real IMEI; services that ask
    for an ECID or a serial are `server`. The rule dialog says so in a hint.
12. **Not changed, on purpose:** a required `select` field with no options cannot be ordered, but the owner's data has none
    (counted on 2026-11-18), so there is no new blocking reason.
13. **`GET /admin/publish-runs?quickAddRunId=`** (5.2, 7.4; B6): the filter also finds a run staff started with the scope
    `{ kind: 'quickAddRun', runId }` ("Prepare the shop preview"), not only the automatic one (`source_run_id`), so Quick add's
    step 3 shows that run when the dialog is opened again.
14. **`replaced_by_run_id`** (4.2, 5.2): it is set with the cancel, and **"Prepare again" after a dead "Check again" repoints it**: when
    the replacement has no `prepared_at` and failed, was cancelled or stalled while preparing, the old draft is copied again and
    linked to the new run. Any other replacement still answers `409`. A scope of ticked services that are all already listed answers
    `422 nothing_to_publish`. A resume closes a stalled switch as `failed`.
15. **Approving a price change** (5.4; console `RetailChangesSection`): `POST /admin/retail-price-changes/resolve` with `action: 'apply'`
    **requires `seen: [{ id, newPrice: Money | null }]`**, one entry per id: the figure staff saw. A difference under the service lock
    answers `skipped: 'changed'` and writes no price, because the follow pass may rewrite a proposal between the list and the click.
    `keep` takes no `seen`. A sync adoption sets the follow row's `applied_at` to now, so correction 3 holds for a rule edited earlier.
16. **After the final reviews (lead, 2026-11-19).** Buyers see the published title at checkout, in tracking, in account orders and
    on receipts (`coalesce(public_title, services.name)`). `PUT /admin/services/:id/group-prices` takes an optional
    `retailPriceSeen` (the retail price the form loaded): a retail row equal to it is not written, so a stale form never undoes a
    following price. A reset of a row that would drop a price staff chose needs `storefront:update`. A group with no usable text
    (category `Imported`) gives no brand. A succeeded run keeps a scope-cut note in `error`. **The owner decided on 2026-11-19 to
    clean the existing category names once** (migration 0046 queues the job `category_names_clean`; 19 of the owner's 302 names
    change, a name another category has is skipped, a name written only in Arabic script keeps its name, each rename is audited).

## 1. What exists (verified in the code on 2026-11-16; the design rests on these)

| # | Fact | Evidence |
|---|---|---|
| 1 | Putting one service on the shop takes two requests and three audit rows: `POST /admin/service-listings` creates the listing switched off with no price (`created listing for`), then `PATCH` with `{ isListed, retailPrice }` writes `changed retail price of` and `listed on storefront`. Both lock the `services` row first (`FOR UPDATE`; a create without facts takes `FOR SHARE`), then the listing rows in id order, and decide every refusal before the first write. Each writes the outbox event `storefront.listing_changed` | `storefront/application/listing-admin.service.ts:220-293` (create), `:299-410` (update), `storefront/search/application/search-signals.ts:69` |
| 2 | A listing is public only when it is on **and** the service is sellable **and** a retail price row exists. A listing switched on without a price is "on" in the console and invisible on the shop, with no error | `storefront/application/storefront-quotes.ts:171-190`; A1 section 1.5 |
| 3 | The retail price is the `b2c_retail` row of `service_group_prices` (net USD before VAT, catalog owns it). Its low-level writer `RetailPrices.set` has **no floor check** ("the caller's check"), no audit and no signal; the checks live in its callers (`ListingAdminService.update`, `GroupPriceAdminService.replace`). Nothing records whether a price was typed by a person. **The group price page writes a retail price for any live service, listed or not** (replace-all: delete, then insert), so a typed price can appear at any moment on a service that has no listing | `catalog/application/retail-prices.ts:142-155`; `listing-admin.service.ts:325-333,348-359`; `catalog/application/group-price-admin.service.ts:68-124`; `catalog/infra/service.repository.ts:431-443` |
| 4 | The storefront floor is `max(round_half_up(base_price x 1.10, 2), effective_cost + min_profit)`; the shop charges `max(retail, floor)` rounded **up** to the cent, so a stored price that falls under a risen floor is never sold under it. For a Quick add service (base = cost + 6 %, at least 0.02) the floor is about cost x 1.166: cost 10.0000 gives 11.66, cost 0.50 gives 0.58, cost 0.0030 gives 0.03. A margin under 16.6 % is therefore always lifted to the floor | `catalog/domain/price-resolution.ts:205-216,241-244`; `storefront/domain/retail-quote.ts:30-33`; `catalog/domain/service-figures.ts:24`; `suppliers/application/imported-service.ts:48`; A1 section 1.6 |
| 5 | The sellable rule checks the service (live, `active`), its category (active, open to the retail group) and nothing of the supplier: a service with no usable supplier link can be listed and sold, and the order then waits in `needs_attention` after the customer paid. A `file` service is refused at checkout (`422 not_orderable`). The lock rule of the listing routes (`lockOf` over `findServiceFacts`) reads the service's status and the category's allowed groups but **not the category's `is_active`**, which the sellable rule does read: a listing of a service in a switched-off category is "on" and invisible | `suppliers/domain/link-selection.ts:51-73`; `customers/application/checkout-session.service.ts:128-134`; `catalog/infra/merchant-catalog.repository.ts:24-31`; `storefront/domain/listing-rules.ts:32-44`; `storefront/infra/foreign-reads.repository.ts:143-157`; A1 section 1.7 |
| 6 | The website already sells services that are not IMEI: its order form shows the service's own fields and quantity for any type. Listings reach it through `GET /store/v1/services`, `/categories` and the search with no change | `storefront/components/checkout/checkout-form.tsx:137,147,252-254`; A1 section 1.8 |
| 7 | A slug is lower-case Latin letters, digits and single hyphens, at most 120, unique for the site (after feature 30). There is no automatic suffix: a clash answers `409 LISTING_EXISTS` with the field `slug`. `&` becomes `and`, `$` is dropped. A slug is a public address and nothing redirects after a rename | `storefront/domain/slug.ts:5,23-29,40,55`; A1 section 1.4 |
| 8 | A Quick add service gets the supplier's name **verbatim**, a category named after the supplier's group **verbatim** (entities, emoji and all), cost, a B2B base price, fields, a first supplier link. It has no retail price, no listing, no title, slug, brand, carrier or country. **Nothing records which services a run created**. The importer finds the category by `lower(name)` of the raw group text and creates it when that finds none (`categoryFor`) | `suppliers/application/imported-service.ts:66-92`; `catalog/application/service-importer.ts:68-149` (`categoryFor`: `:126-143`); A1 sections 2.1, 2.3 |
| 9 | The Quick add engine is the model of a staff-started background run: a run table with one live run per supplier (partial unique index), an outbox event with ids only, the queue `imports` (concurrency 2, **1 attempt, no stalled re-run**), a claim by a guarded update, chunks of 100 in one transaction each under the supplier row lock, a guarded progress update, a 5 minute heartbeat rule, "start again continues with what is left", one audit row by the staff member at the start and one by `system` at the close. **A restart never reuses a run**: it closes the stalled run and inserts a new one, and the progress update is guarded on the worker's own run, so two workers never share a run id | `suppliers/application/quick-add.service.ts:109-173` (the close and the new run: `:121-154`), `quick-add-runner.ts:87-235`, `quick-add-outbox.ts:24-49`; `suppliers/db/schema.ts:284-329`; `src/infra/queues/queue-definitions.ts:96-101` |
| 10 | `effective_cost = greatest(services.cost, credit x credit_rate of the first active link)`. The sync stores whatever credit the supplier reports, up or down (`credit = excluded.credit`), and recomputes at once: a supplier price **rise** reaches the effective cost at the next price sync (15 minutes), and a **drop** lowers it again, but never under `services.cost`, the cost written at import (only a re-import or a staff edit lowers that). A wrong credit reported for one sync is the effective cost until the next one. `recomputeEffectiveCost` has six callers; it returns the ids that moved, and the callers use them only to bump the catalog price version. No event carries the ids | `catalog/application/effective-cost.ts:24-59`; `suppliers/infra/supplier-catalogue.repository.ts:158-172`; callers: `suppliers/application/supplier-sync.ts:124`, `quick-add-runner.ts:194`, `supplier-catalogue.service.ts:239,290`, `catalog/application/service-admin.service.ts:369,399` |
| 11 | Every writer of something that can move a price bumps `CatalogPriceVersion`; the bump tells `PriceVersionListeners`. `PriceChangeScan` is the pattern of a job that follows it: a delayed job on `maintenance`, at most one a minute (job id per minute, delay 60 s), that re-reads state and writes only differences. It tells **merchants**; nothing tells staff or changes a retail price. The scan (the listener and its `schedule`) is a provider of the global `CatalogPricesModule`, which the API and the worker both load; the worker-only module holds only the processor | `catalog/application/catalog-price-version.ts:55-67`, `price-version-listeners.ts:19-42`, `price-change-scan.ts:48-91`; `catalog/catalog-prices.module.ts:17-21`; `src/worker.module.ts:86` |
| 12 | The B2B `pricing_rules` adjust the **base price** for merchant groups and never read the cost; the shop reads only the fixed retail row. There is no store and no evaluator for "cost plus a margin" | `catalog/domain/price-resolution.ts:256-267,299+`; A1 section 3.2 |
| 13 | The bulk price change is the preview/apply pattern of this code base: the preview writes nothing and is not a token; apply re-reads and recomputes inside its transaction after locking the services in id order, and writes one audit row. It runs inside the request and prices the base price only | `catalog/application/bulk-price-admin.service.ts:99-130`; A1 section 3.1 |
| 14 | An outbox payload carries ids only: at most 20 keys, 50 list items, 2048 bytes, strings of 64 characters, no decimals. A staff body is limited to 1 MiB; 1157 edited rows are about 0.5 MB | `platform/outbox/outbox-payload.ts:12-15`; A1 section 7 hazard 15 |
| 15 | An audit row written in the worker has the actor `system`; the entity type must be in the closed list `AUDIT_ENTITY_TYPES` (it has `listing`, `service`, `supplier`, `pricing_rule`, `setting`; no type for a publish run or a retail rule). A staff write route without an audit row fails in development and test unless its contract says `audit: false` with the reason | `platform/audit/audit.service.ts:75-83`, `audit-entity-types.ts:41-73` |
| 16 | One permission per route, checked by the guard; code may check another with `grants(principal.permissions, ...)` (three precedents). In use: `storefront:read/create/update/publish`, `pricing:read/create/update/delete`, `catalog:create` (Quick add). A retail price and the "On the site" switch need `storefront:update` today (`PATCH /admin/service-listings/:id`) | `identity/security/permission.guard.ts:26-36`, `permission-grammar.ts:51`, `identity/index.ts:12`; `identity/application/client-views.ts:114`; `storefront/contracts/listings.contracts.ts:242-243` |
| 17 | Import directions: `suppliers` imports `orders`, `orders` imports `storefront`; `storefront` imports `catalog`, `money`, `identity`, `platform`, `health` and never `suppliers`. A storefront import of `suppliers` would close a cycle (decision 032). The catalog already reads the suppliers' three tables in SQL (`effective-cost.ts`) | grep of the module imports, 2026-11-16; `catalog/application/effective-cost.ts:33-41` |
| 18 | A staff event (`alert.fired`) is sent to the ops recipients of the configuration (`ALERTS_EMAIL_TO`, the Telegram chat) through `NotificationService.enqueueToAddress` with a dedupe key; its default templates are rows a migration inserts. The console's address is `config.http.consoleBaseUrl` | `platform/notifications/notification-events.ts:112-124,268-283`; `health/application/alert-notifier.ts:125-152`; `drizzle/0015_alert_templates.sql`; `src/config/env.ts:68` |
| 19 | A checkout session locks its amounts when it opens and lives 30 minutes; paying reads no price | `customers/domain/checkout.ts:6`; `customers/application/checkout-session.service.ts:154-179` |
| 20 | `runInTransaction` does not retry a deadlock or a serialization failure; a nested `tx.transaction` is a savepoint that shares the commit scope. A unique violation aborts the whole transaction | `src/infra/db/transaction.ts:47,67`; A1 section 7 hazards 4, 6 |
| 21 | Every table needs an identity `id`, `created_at` and `updated_at`; a column added to a map table is listed in `ADDITIONS` of the structure test; a table beyond the map is an `additionalTables` entry of its module. **A module has one schema file**: the lint rule `gsm/module-boundaries` allows foreign key imports between schema files, and the barrel's re-export, only for `<module>/db/schema.ts`, and the structure test reads a module's tables from that file alone (feature 29 put its five search tables in `storefront/db/schema.ts`). A partial index does not count as the index behind a foreign key; an upper-case array exported from a schema file must be the value list of a CHECK | `test/schema/structure.test.ts:18,73,163-174,200,206-220,245,259-274`; `scripts/eslint/module-boundaries.mjs:18,52-61`; `storefront/db/schema.ts:256-394`; `scripts/module-map.mjs` |
| 22 | The shop's SQL list reads at most the first 10 000 priced service ids | `catalog/infra/storefront-services.repository.ts:80,138` |
| 23 | Console: no wizard, no editable table, no windowed table; dialogs are 520 or 760 px wide; a selection is one page of 25; menus of services and categories are cut at 200 without a word; the console does **no** price arithmetic (M92); Quick add polls its run every 1.5 s and resumes from `latestRun`; an API function is compared with the backend by its `@route`, a parameter named `body` and one named `query`; every new GET and every mutation that answers a body needs a mock for the harvest; the next mismatch id is M265; the listings table ("Services on sale") has **no row selection** and 25 rows a page | A2 sections 0, 1.3, 2.4, 2.5, 4.3, 5.2-5.4 |
| 24 | The real names (1157 services, 254 groups; 627 IMEI, 530 SERVER): 46.5 % are already clean; the prototype finds a brand for 1054 (91.1 %), a carrier for 188 (30.0 % of IMEI), a country for 277 (23.9 %), a title of at most 80 characters for 1082 (93.5 %); 1149 slugs are distinct before any suffix and the 8 colliding pairs are exact duplicate names; 59 names (5.1 %) need a person; 6 cost 0; 6 hold Arabic script (1 has nothing else); 179 cost 1.00 or less, so ".99" on every price would multiply cheap prices by 10 to 300. The prototype **learns tool names from the batch it is given** (`learnTools`) and reads brand, carrier and country from the cut title; the port removes both (section 3.5). Its types are `IMEI` and `SERVER` only | A3 sections 0, 6, 8; `audit/tmp/prototype.ts:306-314,437-470` |
| 25 | `english:check` (after feature 30) reads the files **git tracks** under `src`, `test`, `scripts`, `deploy`, `drizzle` and fails on Arabic script (R1), a quoted lower-case `ar` literal or an `/ar` path (R2) and `dir="rtl"` (R3). A new file is not read until the lead stages it | `docs/briefs/30-english-only.md` section 9.4 |

## 2. Decision 040 (text for `docs/decisions/040-retail-price-rules.md`; the lead writes the file)

**Decision.**
- **The shop's price can come from a rule.** A retail price rule says: effective cost, plus a percent, plus a fixed amount,
  rounded up to a style, never under the storefront floor. Rules are a general one, one per service type and one per category;
  the most specific active rule prices a service. They are a store of their own (`retail_price_rules`), not rows of the B2B
  `pricing_rules`: those adjust the base price for merchants and never read the cost (fact 12), and one table for two meanings
  would make every B2B reader filter. A deleted rule keeps its row (`deleted_at`): the history of price changes keeps its
  name, and a delete never waits on, or deadlocks with, a transaction that is pricing by it.
- **A price is either typed or following.** A service whose retail price a rule wrote has a row in `retail_price_follows`; a
  price a person typed has none. The retail row has two writers and no third. `RetailPrices.set` (the listing route, the
  publisher, the follow pass, the approval of a proposal) now takes the origin of the price and the quote the caller read
  under the service lock, **refuses a price under the floor itself**, and keeps the follow row in step. The group price
  page's replace-all keeps its own floor check (`groupPriceProblems`, the same `storefrontFloor`) and turns following off
  when it changes or removes the row. **A rule never overwrites a typed price unless a person asks for that exact price to
  be replaced**: per service ("Follow the pricing rule" in the price dialog), or in a publish preview by choosing the rule
  over the typed price the row shows. The row then remembers the figure it showed (`replaces_price`), and the publisher
  replaces a typed price only when it is still that figure (section 6.2); a price typed anywhere after that is kept.
- **A following price moves by itself, inside limits.** When the effective cost, the floor or the rule changes, a job
  recomputes the price and writes it when it differs. A cost that moved by more than the rule's limit since the price was
  last set (default 25 %, up or down), or fell to zero, is **not** applied: it becomes a proposal that staff approve or turn
  into a typed price. Until then the stored price stays and the sale-time rule (fact 4) keeps every sale at or above the
  floor. Approving writes the figure staff saw and nothing else: a proposal whose figure moved since is shown again.
- **The same limit guards a publish.** A row that a rule prices is refused (`cost_moved`) when the cost moved by more than
  the rule's limit between its preview and its publication: a supplier's wrong cost for one sync never becomes a first shop
  price that nobody saw.
- **Publishing in bulk is a run over a stored draft.** The preview is a draft kept on the server (a run and its rows); it
  changes nothing a visitor or a merchant can see. Applying is a background job that publishes one service per transaction
  through the listing writer and the retail price writer, and writes each row's result. A finished run can be switched off
  the shop, or back on, as a whole: that is the undo of a mistaken run (nothing is deleted, no price changes).
- **Staff are told.** Every automatic change and every proposal is a row of `retail_price_changes` (the console's "Price
  changes" list) and an audit row; at most once an hour a message with the counts goes to the ops recipients (fact 18).

**Why automatic and not only proposals.** The owner asked that the shop price follows the rule. A rise of the cost that is
not followed sells at the floor (cost plus the minimum profit), which is the smallest margin the system allows: following is
the safe direction. The limit exists for supplier mistakes (a cost 10 times higher for one sync).
**Why the cost move and not the price move is limited.** A rule edit by staff is a decision that was previewed; it must
apply whole. Only the supplier's side is unattended.
**What a supplier price drop does.** The effective cost follows the supplier's price down as well as up, but never under
`services.cost`, the cost written when the service was imported (fact 10). A following price falls with it, inside the
same limit. Lowering `services.cost` itself on a drop is a B2B decision outside this feature: it is the floor of every
merchant price (catalog-1; owner question 8).

**Consequences.** `RetailPrices.set` changes its signature (one caller today, `ListingAdminService.update`; three new ones: the publisher, the
follow pass and the approval of a proposal). The group price page turns following off when it
changes or removes the retail row. A following price can change without a staff action: the audit log shows the actor
`system` with the reason, the rule and both costs. The public catalog, the checkout and the search are unchanged (they read
the retail row as before).

**CLAUDE.md clause (the lead adds it under Architecture, after the Money line).** "Retail prices (decision 040): written only
through `RetailPrices.set` (it refuses a price under the floor and records typed or following) and the group price page's
replace (the same floor; it turns following off); a rule never overwrites a typed price unless staff asked for that exact
price to be replaced; automatic changes are rows of `retail_price_changes`."

## 3. The rules of the feature

### 3.1 What "publish" means

- **To publish a service** is, in **one transaction**: create its one listing (title, slug, brand, carrier, country), set its
  retail price, switch the listing on (`is_listed`, `listed_at`), write the audit row and the search signal. There is no
  state in between: never "on with no price", never a price with no listing from this feature.
- **Default: listed at once.** The owner asked that the services "appear on the shop and in search"; the preview is the
  review. A run may instead be applied with `listed: false`: everything above except the switch (the listing is priced and
  off). Staff then switch the whole run on with one button on its result page, or one listing at a time in "Services on
  sale".
- **The undo.** A finished run can be taken off the shop, and put back, as a whole: `POST /admin/publish-runs/:id/listed`
  switches every listing that run published (section 6.7). Nothing is deleted and no price changes; the listings stay,
  switched off. Without it a mistaken run of a few hundred services would be undone one switch at a time (the listings
  table has no selection, fact 23).
- **Only included rows are published.** A row is included by default only when its state is `ready`. A row that needs a
  person (`review`) waits until staff tick it; a row that cannot be published (`blocked`) cannot be ticked.
- **A preview changes nothing.** Creating, editing and checking a draft again write only `listing_publish_runs` and
  `listing_publish_items` (and, for "Check again", the audit row of the draft it replaces). No service, listing, price,
  search document or cache key is touched before apply (a test counts the rows of those tables before and after).
- **A preview can be checked again.** Rows are evaluated when the draft is prepared and when staff edit a row. After staff
  fix something outside the preview (make a rule, enable a service, open a category, link a supplier), **Check again**
  makes a new draft from the old one, with every staff edit kept and every row evaluated afresh (section 5.2, scope `run`).
- **What a new listing gets:** `sort` 0, not featured, no picture, empty summary, description, requirements, SEO fields and
  delivery note (staff fill them later in the listing editor; default pictures are a later feature). `listed_at` is the
  clock's time of its transaction.
- **Types:** IMEI, server and remote services can be published (fact 6); a `file` service cannot be ordered online (fact 5)
  and is blocked. This ends the console's sentence "Only IMEI services are sold to the public" (owner question 2).

### 3.2 The state of a row, and what happens to each hard case

`evaluateItem` (pure, `storefront/publish/domain/publish-item.ts`) gives every row a state, at most one blocking reason and a
list of flags. It runs when the draft is prepared (also the draft of "Check again"), after every edit of the row, and again
inside the apply transaction on the locked service (the stored state is never trusted for a write).

| State | Meaning | Included by default | Staff can include |
|---|---|---|---|
| `ready` | publishable as it stands (soft flags allowed) | yes | (can leave out) |
| `review` | publishable, but a person should look: a hard flag is set | no | yes |
| `blocked` | cannot be published now: `blockedReason` says why | no | no (422) |

**Blocking reasons** (the first that applies, in this order; `PUBLISH_BLOCK_REASONS`):

| `blockedReason` | When | Staff fix |
|---|---|---|
| `already_listed` | the service has a listing | none: it is on the Listings tab |
| `service_disabled` | `services.status` is not `active` | enable the service |
| `category_inactive` | its category is switched off (`service_categories.is_active`): the listing would be on and invisible (fact 5) | switch the category on |
| `b2b_only` | its category is not open to the retail group (`lockOf`) | open the category |
| `not_orderable` | type `file` | none |
| `supplier_unavailable` | fulfilment `auto` and no active link whose supplier is `active` and still lists the service (the rule of `pickLink` without the price test) | link or resume the supplier |
| `title_missing` | the cleaned title is empty (a name with no Latin word: 1 of 1157) and staff typed none | type a title in the row |
| `title_too_long` | the title is over 200 characters (1 of 1157) | shorten it in the row |
| `price_missing` | a rule must price the row and gives no price: no active rule matches (flag `no_rule`) or the effective cost is 0 (flag `no_cost`, 6 of 1157) | make a rule, or type a price |
| `below_floor` | the price staff typed in the row is under the floor of now (the floor rose after they saved it) | type a price at or above the floor, or use the rule |
| `slug_taken` | the address staff typed in the row is held by a listing now | type another, or empty the field |

A fix made in the row (a title, a price, an address) is re-evaluated by the row's own `PATCH`. A fix made **outside** the
preview (a service enabled, a category switched on or opened, a supplier linked or resumed, a rule made) is picked up by
**Check again**. The owner's first run meets
this at once: no rule exists (owner question 3), so every row without a price reads `blocked: price_missing` until a rule
is made and the preview is checked again (the console says so, section 7.2).

A typed price under the floor and a slug another row or listing holds are refused when staff save the row (`422`). A floor
that rises later, or a listing that takes the address later, shows at the next evaluation as `below_floor` or `slug_taken`
(what staff typed is never changed for them), and apply refuses the row with the same reason. **A cost of 0 is never priced
by a rule**: four of the six real ones are not products (A3 section 8), and a product the supplier may charge for later
must be priced by a person. **Arabic script is not an error**: the title rules drop it from the title (the service keeps
its name); only a name with nothing else waits for a typed title.

**Flags** (the closed list `PUBLISH_FLAGS` of `publish/domain/publish-item.ts`; no CHECK holds it, so it does not live in
the schema file, fact 21).
**Hard flags** (state `review`): `title_long` (over 100 characters: the end of such a name is what tells its variants
apart), `duplicate_name` (another row of the run has the same supplier name: 8 pairs; both wait, staff choose one or both,
the second then gets the slug suffix `-2`), `title_taken` (the title, compared without case and repeated spaces, is the
title of a listing already in the table or of another row of the run with a different supplier name: a likely twin; none
on the 1157 names taken as one run), `quantity_text` (`1 QNT = 1000` and the like: the unit is inside the sentence),
`multi_country` (more than three countries named and none chosen).
**Soft flags** (state stays `ready`; the console shows a neutral mark): `title_81_100`, `title_lacks_brand`,
`brackets_repaired`, `marketing_kept` (the uniqueness ladder of 3.5 kept words it would have removed), `slug_suffixed`,
`price_at_floor` (the rule price was lifted to the floor), `no_brand`, `country_from_group`, `carrier_no_country`,
`price_kept` (the service already has a retail price and it is kept).
**Detail flags of a blocked row:** `no_rule`, `no_cost` (which half of `price_missing`).
`reflag` (pure, same file) recomputes after an edit the flags that derive from the edited fields: `title_long`,
`title_81_100`, `title_lacks_brand`, `no_brand`, `carrier_no_country`; `multi_country` is kept only while the country is
empty; a detection flag (`country_from_group`, `brackets_repaired`, `marketing_kept`, `slug_suffixed`) is kept only while
the field it speaks of still holds the detected value; `title_taken` comes from the caller (one read of the listings).

**The tick (`included`) after an evaluation.** A row that becomes `blocked` loses its tick in the same write (the CHECK of
4.2 would refuse it otherwise). A row that leaves `blocked` gets the default of its new state (`ready`: ticked). In every
other case the tick stays as staff left it.

**At apply** a row ends as one of:

| `result` | `resultReason` | Meaning |
|---|---|---|
| `published` | | listing created, priced, on the shop (or off, for `listed: false`); `resultDetail` says when the slug got a suffix, the price differs from the preview, or a price typed since the preview was kept |
| `skipped` | `left_out`, or the row's `blockedReason` at the start of the run | not included: nothing was tried |
| `skipped` | `already_listed` | someone listed the service since the preview: nothing changed |
| `refused` | `service_gone`, `service_disabled`, `category_inactive`, `b2b_only`, `not_orderable`, `supplier_unavailable`, `title_missing`, `title_too_long`, `price_missing`, `below_floor`, `cost_moved`, `slug_taken` | the re-check on the locked service failed: nothing was written for this row |
| `refused` | `failed` | an unexpected error (the constraint name in `resultDetail`, the full error in the log); 20 of them end the run `failed` |

`cost_moved`: the cost a rule would price from moved by more than the rule's limit since the preview (section 6.2);
`resultDetail` holds both costs. The reasons are the closed list `PUBLISH_RESULT_REASONS` (same domain file).

A slug collision: the preview gives every row a slug that is free among the listings and among the rows of the run (suffix
`-2`, `-3` in service id order). At apply a slug the server proposed that is taken meanwhile gets the next free suffix; a
slug **staff typed** that is taken is `refused: slug_taken` (their choice cannot be kept, so they decide again).

### 3.3 Retail price rules

**Storage.** `retail_price_rules` (catalog, section 4.1). At most one rule per target: one `global`, one per service type
(`imei`, `server`, `remote`, `file`), one per category. A deleted rule keeps its row (`deleted_at`) and counts nowhere.
**Precedence:** the active rule of the service's category, else of its type, else the global one, else none. The owner's
example "IMEI +30 %, server +20 %" is two type rules.

**The price of a rule** (`evaluateRetailRule`, pure, `catalog/domain/retail-rule.ts`; `decimal.js`, never floats):
1. `cost` is the effective cost of `RetailPrices.quotes` (the figure the floor uses; USD). `cost = 0` gives no price
   (`no_cost`).
2. `raw = cost x (1 + percent / 100) + fixed`.
3. `base = max(raw, floor)` with the storefront floor of the same quote; `atFloor = raw < floor`.
4. `cents = base` rounded **up** to 2 decimals (the shop charges cents rounded up, fact 4).
5. The rounding style, always upwards, applied only when `cents >= roundFrom` (default 5.00), else the price is `cents`:
   `cent` (nothing more), `step_0.05`, `step_0.10` (the next multiple), `ends_99` (the smallest `n.99` that is not below).
6. The result is a whole number of cents, never under the floor, never under `raw`.

Worked numbers (default floor policy; the unit tests reproduce them): cost 10.0000 (floor 11.66), +30 %, `ends_99` gives
13.00 then **13.99**; +10 % gives 11.00, lifted to 11.66, then **11.99** (`atFloor`); cost 26.50, +30 % gives 34.45 then
**34.99**; cost 100, +30 % gives 130.00 then **130.99**; a raw of 17.995 gives 18.00 then **18.99** (never down, the trap of
`applyRounding`'s `floor() + 0.99`); cost 0.50 (floor 0.58), +30 % gives **0.65** (under `roundFrom`); cost 0.0030 (floor
0.03), +30 % gives 0.0039, lifted to **0.03**; cost 0.011, +30 % and `fixed` 0.50 gives 0.5143 then **0.52**; cost 0 gives
no price.

**Limits of a rule:** `percent` 0 to 1000 (4 decimals), `fixed` 0 to 100 000, `roundFrom` 0 to 100 000,
`autoFollowPercent` 0 to 1000 (whole number, default 25; 0 means every cost change waits for approval). The same
figure is the limit of a publish (`cost_moved`, section 6.2).
**Currency and tax:** a retail price is net USD before tax; the buyer's currency and VAT are worked out at sale as today, and
".99" is a property of the USD price only (the storefront README says so already).

**Typed against following.**
- A price is **following** when `retail_price_follows` has a row for the service, else **typed** (or absent).
- `RetailPrices.set(db, serviceId, price, { origin, quote })` is the writer of every path but the group price page
  (decision 040). `origin` is
  `{ kind: 'manual' }` or `{ kind: 'rule', ruleId, cost }`; `quote` is the `RetailQuote` the caller read in the same
  transaction after locking the service row. It throws `RetailFloorError` when `price < quote.floor` (the callers' own
  `422` checks stay and answer first; this is the invariant no new writer can skip), upserts the price row as today, and
  then deletes the follow row (`manual`) or upserts it with `applied_price`, `applied_cost`, `applied_at` (`rule`).
- The listing price dialog writes `manual`. `PATCH /admin/service-listings/:id` with `retailPricing: 'rule'` computes the
  rule price now and writes `rule`: this is how staff **ask** for a typed price to follow.
- `PUT /admin/services/:id/group-prices` writes the retail row itself (replace-all); after its write it deletes the follow
  row when the retail price changed or the row is gone, and keeps it when the price is the same (the page re-sends every
  group).
- A bulk publish writes `rule` for rows priced by the rule and `manual` for rows staff priced in the preview; a service
  that already had a retail price keeps it untouched unless staff, in the row, chose the rule over that exact price or
  typed another one (section 6.2).
- Deleting or switching off a rule moves its followers to the next rule by precedence at the next follow pass; with no
  rule left their prices stay as they are and keep their follow row (a new rule picks them up again).

### 3.4 When the supplier's cost changes

The follow pass (section 6.4) runs at most a minute after any price version bump (fact 11: the sync, a service edit, a
B2B rule, a category, a retail rule) and every hour. For each following service, under the service row lock:

| What it finds | What it does |
|---|---|
| the service is archived, or has no retail row any more | deletes the follow row |
| the stored price is not the price it last wrote (`applied_price`) | someone wrote the row another way: deletes the follow row, records `detached`; the price is now a typed one |
| no active rule matches | nothing (the price stays) |
| the rule price equals the stored price | records the new cost as `applied_cost`; closes an open proposal as `superseded` |
| the effective cost is 0 | opens a proposal, reason `no_cost`; the price stays |
| the cost moved by more than the rule's `autoFollowPercent` since `applied_cost` | opens a proposal, reason `cost_jump`, with the price it would set; the price stays. An open proposal is rewritten **only when its figures differ** (`new_price`, `new_cost` or the rule), and its `notified_at` is kept, so the hourly message never repeats a proposal that did not change |
| otherwise | **writes the rule price at once**, records `followed` with the reason (`cost_changed`, `rule_changed`, `floor_changed`), writes an audit row |

- **The limit, exactly** (`costMoved(from, to, percent)`, pure, `catalog/domain/retail-rule.ts`): a cost jump is
  `abs(to - from) x 100 > from x percent`, in exact decimals and with no division. A move of exactly the limit is followed;
  a `from` of 0 makes any other cost a jump, and a limit of 0 makes any move a jump (the safe side). The follow pass calls
  it with `applied_cost` and the cost of now; the publisher calls it with the row's previewed cost and the cost of now
  (section 6.2).
- **The reason of a `followed` row**: `cost_changed` when the cost differs from `applied_cost`; else `rule_changed` when the
  rule that prices the service is not the follow row's `rule_id` or its `changed_at` is after `applied_at`; else
  `floor_changed` (a base price, a minimum profit or a B2B rule window moved the floor).
- **Up and down alike**: the rule price is recomputed from the cost, so it falls when the effective cost falls. The
  effective cost follows the supplier's price in both directions, down to `services.cost`, the cost written at import
  (fact 10): a supplier's price drop lowers a following price inside the limit, and a fall of more than the limit waits as
  a proposal exactly like a rise. Lowering `services.cost` itself stays what it is today (a re-import or a staff edit;
  owner question 8).
- **A proposal** is resolved by staff. **Apply** writes the rule price of that moment **only when it equals the proposal's
  `new_price`**, the figure staff saw (whatever the size of the move: that is what they approved). When the figure moved
  since the list was read, nothing is written: the proposal is rewritten with the new figures and the answer says
  `skipped: 'changed'`, so staff read the new figure and approve again. **Keep the current price** deletes the follow row:
  the price is a typed one from now on. A later pass that finds the cost back inside the limit applies the price and closes
  the proposal itself.
- **While a proposal waits** the stored price stays, and every sale is charged `max(stored, floor)` rounded up (fact 4): the
  shop never sells under cost plus the minimum profit.
- **The notice to staff**: the "Price changes" list of the console's Retail pricing tab (every `followed`, `proposed` and
  `detached` row, the waiting ones first, with a count on the tab), an audit row per change (entity `service`, actor
  `system`, the reason, the rule and both costs), and one message with the counts to the ops recipients, at most once an hour
  (staff event `retail.prices_followed`, email and Telegram, default templates by migration).
- **An open checkout session** keeps the amounts it showed until it expires (30 minutes, fact 19); the next session gets the
  new price. Lists and pages read the price on every request, so a change is visible at once. A supplier whose cost rose
  above what an open session charged is the existing `costs_more` case of the dispatch (the order waits for staff): unchanged.

### 3.5 Detection: title, slug, brand, carrier, country

A pure domain module, `storefront/publish/domain/naming/` (no database, no Nest), ported from the measured prototype
(`/home/saifi/gsm-project/.bulk-publish/audit/tmp/prototype.ts`; A3 sections 3-6 are its specification and its numbers are
the acceptance of section 8.2). `NAMING_RULES_VERSION = 1` is stored on every run.

- **Input per service:** `{ name, type, group }` where `group` is the name of the service's category (Quick add names the
  category after the supplier's group; the module decodes entities itself). **Output:** `{ title, slugBase, brand,
  brandKind, carrier, country, flags }`; the final slug is given by `assignSlugs` (below).
- **Types.** The prototype knows `IMEI` and `SERVER` (the only two of the 1157 names). `imei` is named by the IMEI rules;
  `server`, `remote` and `file` by the server rules (hours and days stay in the title, the brand is the tool, no carrier):
  a remote service is a tool session, and a `file` service is blocked anyway.
- **What depends on the row alone.** Brand, carrier and country are functions of one row (`detectFacts(row)`): they are
  read from the title **before the cut** (rules R1-R12) and from the group, with fixed lexicons. The prototype read them
  from the cut title and learned its tool names from the batch it was given (`learnTools`, fact 24); both made a row's
  brand depend on what else was in the run (measured by the review: naming each group alone changed 6 brands). Here the
  145 tool names the prototype holds after reading the whole file are **frozen into `lexicon/tools.ts`**, and nothing is
  learned at run time. On
  the fixture, reading the uncut title changes three brands against the prototype (#60 and #1028 gain Apple, #80 names two
  makers and loses it: 1055 brands instead of 1054; carriers and countries are identical); the review of B2 reads the three.
- **Title:** the ordered rules R1-R14 of A3 section 3: invisible characters, entities (reuse `decodeEntities`), emoji and
  decoration, Arabic script runs (matched with `\u` escapes only, fact 25), punctuation and brackets, the typo list,
  marketing words (never after `not`, `no`, `only`), delivery times (IMEI only: on a server service hours and days are the
  licence), face values (`10$` becomes `$10`) and `Any Qnt`, SHOUTING to Title Case, brand and model casing, tidy, and the
  cut at 80 characters by whole trailing clauses. Meaning words stay (`Clean`, `Premium`, `High/Low Success`, `NOT FMI OFF`,
  `NO REFUND`, `NOT SUPPORTED`). Run the tail rule of R7 once more after the cut, so cleaning a clean title changes nothing
  (the prototype's two exceptions, #1004 and #1005).
- **What depends on the other titles** (`nameAll(rows, { listingTitles })`, the only batch function): the cut (R13) and the
  uniqueness ladder. The cut is applied only where the cut title is not also the cut form of **another title of the batch
  or of a listing already in the table** (`listingTitles`: the public titles of every listing, cut by the same rule), and
  never to a router code list. So a variant published alone next week keeps the words that tell it from its siblings on
  the shop (#476 beside the listed #473-#475). Where two **different** names still make one slug base, both are cleaned
  again without the marketing, delivery and cut rules (flag `marketing_kept`). A title that still equals a listing's title
  or another row's gets the hard flag `title_taken`.
- **Slug:** `slugFor(title)` is `slugOf` of the title after two substitutions that apply to this path only: `$10` becomes
  `10 usd` (else two gift cards collide) and `AT&T` becomes `att` (owner question 7); over 120 characters it is cut at the
  last hyphen. It is the row's `slugBase`. `assignSlugs(named, taken)` then makes the slugs unique in service id order
  against the batch and against `taken` (the slugs of every listing, and the addresses staff typed in the run) with `-2`,
  `-3` through **`nextFreeSlug(base, isTaken)`** (the base is shortened so the slug stays within 120). The same
  `nextFreeSlug` serves the row edit that empties the slug field (section 5.2) and the publisher's "next free suffix"
  (section 6.2): one rule, three callers. `nameAll` needs no slug as input, so the preparer reads the listings' titles
  and slugs once (two columns, at most 10 000 rows, fact 22) and calls the two functions in order.
- **Brand** (three kinds, A3 section 4): an app or store named in the name (the earliest match wins); for a server service
  the tool, from the group text cleaned of its noise words and merged by the alias list, else from the head of the name
  or the frozen tool list; for an IMEI service the device maker from the name, else from the group, and none when several
  makers are named. The traps of A3 section 4 are unit tests (`Nothing Tool` is not the Nothing phone, `Kyocera Phone` is
  not Apple, `Apple ID ... Microsoft Mail` is Apple, `Dhru Fusion - Telegram` is Dhru Fusion, `Knoxwizard` is a tool).
- **Carrier and country** (A3 section 5): IMEI services only for carriers, the first named in the text; none from router
  code lists. A country from a country word in the name, else one country word in the group (flag `country_from_group`),
  else the single country the named carriers share; none for `All Countries`, `Worldwide` or a list of more than three
  (flag `multi_country`). Bare two-letter codes only `US`, `UK`, `JP`. Every trap of A3 section 5.3 is a unit test (`CDMA
  YEMEN`, `China Supported`, `Non-China`, `SamsungTool.us`, `Orange Vegas` in a router list, `ID`, `SE`, `NO`).
- **The lexicons are data files with tests** (`lexicon/brands.ts`, `tools.ts`, `carriers.ts`, `countries.ts`, `typos.ts`),
  seeded from the prototype's tables (`tools.ts` also from what `learnTools` yields on the whole file). A name that matches
  nothing gets no brand, carrier or country: the preview shows the gap, the rules never guess. The country words reuse
  `countryNames` of `search/domain/countries.ts` for the reverse map.
- **Reused:** `decodeEntities`, `cleanDisplay`, `normaliseText` (`search/domain/normalise.ts`), `slugOf`, `isSlug`,
  `SLUG_MAX_LENGTH` (`domain/slug.ts`), `countryNames` (`search/domain/countries.ts`). No new dependency.
- **Category names.** Quick add names a category after the group text verbatim (fact 8), and the public menu shows that
  name. `ServiceImporter` now cleans the group text with `cleanGroupName` (`catalog/domain/category-name.ts`, pure: entities
  decoded, emoji, invisible characters and Arabic script runs removed, spaces collapsed, leading and trailing separators
  dropped; empty gives `Imported`). `categoryFor` looks the category up **by the raw group text first** (today's lookup,
  unchanged: a group whose category an earlier import made under the raw name keeps going there, so its services are never
  split between two categories), **then by the cleaned name**, and only then creates it, under the cleaned name. The
  picker's import uses the same importer and gets the same lookup. The catalog cannot import the storefront's
  `normalise.ts` (fact 17), so `decodeEntities` and the two character patterns move to `src/common/text.ts` and
  `normalise.ts` re-exports them. It changes only categories created from now on; merging 254 groups into a short shop
  menu is a later feature (owner question 11).

## 4. Data model and migrations

Five migrations, generated by `drizzle-kit generate` from the Drizzle definitions unless said (the lead renumbers at the merge
if `main` moved; decision 027: enums are `text` with a CHECK from one `as const` array, money is `numeric(18,4)`, ids `bigint
identity`, every table has `created_at` and `updated_at`). The five new tables are `additionalTables` of their module in
`scripts/module-map.mjs`. No cache key: nothing of this feature is cached (`docs/cache-keys.md` is unchanged).

| File | Slice | Content |
|---|---|---|
| `0040_retail_price_rules.sql` | B1 | `retail_price_rules`, `retail_price_follows` (catalog) |
| `0041_listing_publish_runs.sql` | B3a | `listing_publish_runs`, `listing_publish_items` (storefront) |
| `0042_retail_price_changes.sql` | B5 | `retail_price_changes` (catalog) |
| `0043_retail_follow_templates.sql` | B5 | custom (`drizzle-kit generate --custom`): the two default templates of `retail.prices_followed` (staff, email and Telegram), `ON CONFLICT (event, channel, audience) DO NOTHING` |
| `0044_quick_add_publish.sql` | B6 | `supplier_import_runs.publish_mode`, `service_supplier_links.import_run_id` (suppliers) |

All five are additive: the code of `main` before the merge runs on the new schema (the lead migrates first, section 10).

**Where a list lives (fact 21).** An upper-case `as const` array exported from a schema file must be the value list of a
CHECK. So the CHECK lists below live in the module's `db/schema.ts`; the lists no CHECK holds (`PUBLISH_FLAGS`,
`PUBLISH_RESULT_REASONS`) live in `storefront/publish/domain/publish-item.ts`. Every foreign key column below has an index
that is not partial (the structure test does not count a partial one).

### 4.1 Catalog (`catalog/db/schema.ts`)

**`retail_price_rules`**

| Column | Type and rule |
|---|---|
| `id` | `pk()` |
| `scope` | text, CHECK in `RETAIL_RULE_SCOPES = ['global', 'type', 'category']` |
| `service_type` | text null, CHECK in `SERVICE_TYPES` |
| `category_id` | fk `service_categories.id`, `ON DELETE CASCADE`, null |
| `percent` | `numeric(9,4)` not null, CHECK 0 to 1000 |
| `fixed` | money not null default 0, CHECK 0 to 100000 |
| `rounding` | text, CHECK in `RETAIL_ROUNDINGS = ['cent', 'step_0.05', 'step_0.10', 'ends_99']` |
| `round_from` | money not null default 5, CHECK `>= 0` |
| `auto_follow_percent` | integer not null default 25, CHECK 0 to 1000 |
| `is_active` | boolean not null default true |
| `updated_by` | fk `staff_users.id`, null |
| `changed_at` | `timestampTz()` not null: the clock's time of the create and of every edit (the follow pass names its reason from it, section 3.4; `updated_at` is bookkeeping by the database's clock, decision 027, and is never compared) |
| `deleted_at` | `timestampTz()` null: set by `DELETE /admin/retail-price-rules/:id` (a soft delete; the row stays). CHECK `deleted_at IS NULL OR is_active = false` |

CHECK `retail_price_rules_target_check`: `global` has neither target, `type` has `service_type` only, `category` has
`category_id` only. Unique among the rules that are not deleted (active or not: one rule per target):
`retail_price_rules_global_uq` on `(scope) WHERE scope = 'global' AND deleted_at IS NULL`, `retail_price_rules_type_uq` on
`(service_type) WHERE scope = 'type' AND deleted_at IS NULL`, `retail_price_rules_category_uq` on `(category_id) WHERE scope
= 'category' AND deleted_at IS NULL`. Indexes: `retail_price_rules_updated_by_idx`, **`retail_price_rules_category_idx
(category_id)`** (the three unique indexes are partial, so the foreign key needs its own).

**Why a soft delete.** The three tables below point at a rule. With a hard delete and `ON DELETE SET NULL`, the delete
locks the rule row and then the rows that point at it, while the follow pass and the publisher hold such a row and then
need the rule row for the foreign key check of their own insert (the change row, the follow row): a deadlock (`40P01`) or
a foreign key error, and a `500` on the delete route. A soft delete is an `UPDATE` of a column no foreign key reads; it
takes no lock those checks wait for. The foreign keys keep `ON DELETE SET NULL` for the one hard delete left, the cascade
of a category delete, which the catalog allows only for a category with no service at all (`CATEGORY_IN_USE` otherwise):
no service can be priced by that rule at that moment. Every read of the rules filters `deleted_at IS NULL`; the label of a
deleted rule is still read for history (`rule: { id, label }` of a change or a publish row).

**`retail_price_follows`** (a row means "this service's retail price follows the rules")

| Column | Type and rule |
|---|---|
| `id` | `pk()` |
| `service_id` | fk `services.id`, `ON DELETE CASCADE`, not null, unique `retail_price_follows_service_uq` |
| `rule_id` | fk `retail_price_rules.id`, `ON DELETE SET NULL`, null (the rule that priced it last) |
| `applied_price` | money not null, CHECK `> 0` (the price this feature wrote last) |
| `applied_cost` | money not null, CHECK `>= 0` (the effective cost it was worked out from) |
| `applied_at` | `timestampTz()` not null |

Index `retail_price_follows_rule_idx (rule_id)`.

**`retail_price_changes`** (what the follow pass did or proposes; the console's "Price changes")

| Column | Type and rule |
|---|---|
| `id` | `pk()` |
| `service_id` | fk `services.id`, `ON DELETE CASCADE`, not null |
| `rule_id` | fk `retail_price_rules.id`, `ON DELETE SET NULL`, null |
| `kind` | text, CHECK in `RETAIL_CHANGE_KINDS = ['followed', 'proposed', 'detached']` |
| `reason` | text, CHECK in `RETAIL_CHANGE_REASONS = ['cost_changed', 'rule_changed', 'floor_changed', 'cost_jump', 'no_cost', 'changed_elsewhere']` |
| `old_price` | money not null |
| `new_price` | money null (null for `no_cost` and `detached`) |
| `old_cost`, `new_cost` | money not null |
| `resolution` | text null, CHECK in `RETAIL_CHANGE_RESOLUTIONS = ['applied', 'kept', 'superseded']` |
| `resolved_at` | `timestampTz()` null |
| `resolved_by` | fk `staff_users.id`, null (null when the system closed it) |
| `notified_at` | `timestampTz()` null (set by the hourly message; a rewrite of an open proposal keeps it) |

CHECK `retail_price_changes_resolution_check`: `(resolution IS NULL) = (resolved_at IS NULL)` and a resolution only on
`proposed`. Unique `retail_price_changes_open_uq (service_id) WHERE kind = 'proposed' AND resolved_at IS NULL` (one waiting
proposal per service). Indexes: `(kind, resolved_at)`, `(service_id)`, `(rule_id)`, `(resolved_by)`, `(id) WHERE notified_at
IS NULL`.

### 4.2 Storefront (`storefront/db/schema.ts`, after the search tables)

Both tables, their CHECK lists and their indexes go in the module's one schema file, `src/modules/storefront/db/schema.ts`,
as feature 29's five search tables did. A nested `publish/db/schema.ts` cannot work: the lint rule allows foreign key imports
between schema files, and the barrel's re-export, only for `<module>/db/schema.ts`, and the structure test reads the
storefront's tables from that one file (fact 21). `src/infra/db/schema.ts` is unchanged (it already re-exports the file).

**`listing_publish_runs`**

| Column | Type and rule |
|---|---|
| `id` | `pk()` |
| `status` | text default `'preparing'`, CHECK in `PUBLISH_RUN_STATUSES = ['preparing', 'draft', 'queued', 'running', 'succeeded', 'failed', 'cancelled']` |
| `source` | text, CHECK in `PUBLISH_RUN_SOURCES = ['console', 'quick_add']` |
| `source_run_id` | bigint null: the Quick add run that asked (a plain id, no foreign key: the storefront schema does not import the suppliers'); unique `listing_publish_runs_source_run_uq WHERE source_run_id IS NOT NULL` |
| `scope` | `jsonObject()`: the scope as sent (`{ kind, ... }`, section 5.2) |
| `replaced_by_run_id` | bigint null: the run that "Check again" made from this draft (a plain id, set once with the cancel; no foreign key, so no index is owed) |
| `listed` | boolean not null default true (how the run publishes; the run switch of 6.7 stores its target here too, so a later Continue follows the last choice) |
| `auto` | boolean not null default false (true: applied by the system as soon as it is prepared) |
| `rules_version` | integer not null (`NAMING_RULES_VERSION`) |
| `total` | integer not null default 0, CHECK `>= 0` |
| `published_count`, `skipped_count`, `refused_count` | integer not null default 0, CHECK `>= 0` (written at the close and by a cancel; a live read counts the rows) |
| `error` | text null (at most 500 characters) |
| `requested_by` | fk `staff_users.id`, null |
| `attempt` | integer not null default 0, CHECK `>= 0`: **the claim counter**. Every claim of an apply or of a run switch adds one and returns it; the worker carries the number it got, and every write of that worker requires it (sections 6.2, 6.7). A worker whose number is no longer the row's stops without writing |
| `prepare_claimed_at` | `timestampTz()` null (set by the worker that prepares the draft: the claim of 6.1) |
| `prepared_at`, `started_at`, `finished_at` | `timestampTz()` null (`started_at`, `finished_at`: the apply) |
| `heartbeat_at` | `timestampTz()` not null (the clock's time: at insert, at each claim, by every step) |
| `switch_status` | text null, CHECK in `PUBLISH_SWITCH_STATUSES = ['queued', 'running', 'done', 'failed']` (the run switch of 6.7; null: never asked) |
| `switch_listed` | boolean null (the switch's target); CHECK `(switch_status IS NULL) = (switch_listed IS NULL)` |
| `switched_count`, `switch_skipped_count` | integer not null default 0, CHECK `>= 0` (of the last switch) |
| `switch_error` | text null (at most 500 characters) |

Indexes: `listing_publish_runs_status_idx (status, id)`, `listing_publish_runs_requested_by_idx`.

**`listing_publish_items`** (one row per service of a run: what was detected, what staff changed, what happened)

| Column | Type and rule |
|---|---|
| `id` | `pk()` |
| `run_id` | fk `listing_publish_runs.id`, `ON DELETE CASCADE`, not null |
| `service_id` | fk `services.id`, `ON DELETE CASCADE`, not null; unique `listing_publish_items_run_service_uq (run_id, service_id)` |
| `detected` | `jsonObject()`: `{ title, slug, brand, brandKind, carrier, country }` as the rules found them (for "Reset") |
| `title`, `slug`, `brand`, `carrier`, `country` | text not null default `''` (what will be published; staff may edit) |
| `slug_source` | text default `'auto'`, CHECK in `PUBLISH_SLUG_SOURCES = ['auto', 'staff']` |
| `price_mode` | text default `'rule'`, CHECK in `PUBLISH_PRICE_MODES = ['rule', 'manual', 'keep']` |
| `price_override` | money null; CHECK `(price_mode = 'manual') = (price_override IS NOT NULL)` and `price_override > 0` |
| `replaces_price` | money null: **the typed retail price staff chose to replace with the rule price**. Set only by the row's `PATCH` with `pricing: 'rule'`, to the typed price the service had at that moment; cleared by every other price choice and by a reset; never copied to another run. CHECK `replaces_price IS NULL OR price_mode = 'rule'`. The publisher replaces a typed price only when it still equals this figure (section 6.2) |
| `existing_price` | money null: the retail price the service had at the last evaluation. **For display only**: no write is decided from it |
| `cost`, `floor_price` | money not null default 0 (as evaluated; `cost` is the figure the publish limit compares with, section 6.2) |
| `rule_id` | fk `retail_price_rules.id`, `ON DELETE SET NULL`, null |
| `rule_price` | money null |
| `state` | text default `'blocked'`, CHECK in `PUBLISH_ITEM_STATES = ['ready', 'review', 'blocked']` |
| `blocked_reason` | text null, CHECK in `PUBLISH_BLOCK_REASONS` (the eleven of section 3.2, in that order) |
| `flags` | `textList()` (the flags of section 3.2; the list is `PUBLISH_FLAGS` of the domain file) |
| `included` | boolean not null default false; CHECK `state <> 'blocked' OR included = false` |
| `edited` | boolean not null default false |
| `evaluated_at` | `timestampTz()` null |
| `result` | text null, CHECK in `PUBLISH_ITEM_RESULTS = ['published', 'skipped', 'refused']` |
| `result_reason` | text null (one of `PUBLISH_RESULT_REASONS` of the domain file) |
| `result_detail` | text null (at most 300 characters) |
| `listing_id` | fk `service_listings.id`, `ON DELETE SET NULL`, null |
| `published_price` | money null |
| `finished_at` | `timestampTz()` null |

Indexes: `(run_id, id)`, `(run_id, state)`, `(run_id, result)`, `(service_id)`, `(listing_id)`, `(rule_id)`.

### 4.3 Suppliers (`suppliers/db/schema.ts`)

- `supplier_import_runs.publish_mode`: text not null default `'none'`, CHECK in `QUICK_ADD_PUBLISH_MODES = ['none', 'listed',
  'unlisted']`.
- `service_supplier_links.import_run_id`: fk `supplier_import_runs.id`, `ON DELETE SET NULL`, null, index
  `service_supplier_links_import_run_idx`. Written by `insertFirstLink` when a Quick add creates the service; the exact
  record of "what this run made" (fact 8). `ADDITIONS.service_supplier_links = ['import_run_id']` in
  `test/schema/structure.test.ts`.

## 5. Routes (the wire, exact)

Conventions as everywhere: ids `zId`, money `zMoney` (4 decimals as text), decimals as text, timestamps `zIsoDateTime`, lists
through `listQuery` (`x-total-count`, `422` on an unknown query key), request bodies `z.strictObject`. All routes are
`staff-permission`. No new error code: wrong-state refusals are `409 CONFLICT` with a sentence, a live run is `409
JOB_ALREADY_RUNNING`, field refusals are `422 VALIDATION_FAILED` with a field and a code. Every route also answers
`UNAUTHORIZED`, `FORBIDDEN`, `CSRF_FAILED` (writes), `NOT_FOUND` (an unknown id) and `VALIDATION_FAILED`.

### 5.1 The rows (`scripts/map-additions/31.mjs`, stage 31, in the row shape feature 30 left: an English sentence only)

| Route | Permission | Success | Group / module | Spec | Tables |
|---|---|---|---|---|---|
| `POST /admin/publish-runs` | `storefront:create` | 202 | `storefront` / storefront | B228 | `listing_publish_runs`, `outbox_events`, `audit_logs` |
| `GET /admin/publish-runs` | `storefront:read` | 200 | same | B228 | `listing_publish_runs`, `listing_publish_items`, `staff_users` |
| `GET /admin/publish-runs/:id` | `storefront:read` | 200 | same | B228 | same |
| `GET /admin/publish-runs/:id/items` | `storefront:read` | 200 | same | B228 | `listing_publish_items`, `services`, `service_listings` |
| `PATCH /admin/publish-runs/:id/items/:itemId` | `storefront:create` (a price key also needs `storefront:update`) | 200 | same | B228 | `listing_publish_items` |
| `POST /admin/publish-runs/:id/items/bulk` | `storefront:create` | 200 | same | B228 | `listing_publish_items` |
| `POST /admin/publish-runs/:id/apply` | `storefront:publish` | 202 | same | B228 | `listing_publish_runs`, `listing_publish_items`, `outbox_events`, `audit_logs` |
| `POST /admin/publish-runs/:id/cancel` | `storefront:create` (a run being published also needs `storefront:publish`) | 200 | same | B228 | `listing_publish_runs`, `audit_logs` |
| `POST /admin/publish-runs/:id/listed` | `storefront:publish` | 202 | same | B228 | `listing_publish_runs`, `outbox_events`, `audit_logs` |
| `GET /admin/retail-price-rules` | `pricing:read` | 200 | `catalog` / catalog | B229 | `retail_price_rules`, `retail_price_follows` |
| `POST /admin/retail-price-rules` | `pricing:create` | 201 | same | B229 | `retail_price_rules`, `audit_logs` |
| `PATCH /admin/retail-price-rules/:id` | `pricing:update` | 200 | same | B229 | same |
| `DELETE /admin/retail-price-rules/:id` | `pricing:delete` | 204 | same | B229 | same |
| `POST /admin/retail-price-rules/preview` | `pricing:read` | 200 | same | B229 | `retail_price_rules`, `retail_price_follows`, `services` |
| `GET /admin/retail-price-changes` | `pricing:read` | 200 | same | B230 | `retail_price_changes`, `services` |
| `POST /admin/retail-price-changes/resolve` | `pricing:update` | 200 | same | B230 | `retail_price_changes`, `retail_price_follows`, `service_group_prices`, `audit_logs` |

Sixteen rows. Changed routes (no new row): `GET`/`POST`/`PATCH /admin/service-listings` (B229), `POST
/admin/suppliers/:id/quick-add`, `GET /admin/suppliers/:id/quick-add/:runId` and `GET /admin/suppliers/:id/service-groups`
(B231). `audit: false` with its reason in the description: the two previews-by-nature (`POST /admin/retail-price-rules/preview`: "a calculation, nothing is stored") and
the three draft writes (`POST /admin/publish-runs`, the item `PATCH` and `bulk`: "a draft is not a record of the shop; apply,
cancel and the run switch are audited"). `POST /admin/publish-runs` does write one audit row in one case: "Check again"
cancels the draft it replaces (section 5.2), and that cancel is audited like any other.

**The second permission** (fact 16: the guard checks the route's one permission; the controller checks the other with
`grants(principal.permissions, ...)` and answers `403 FORBIDDEN` naming it). A retail price needs `storefront:update` today
(`PATCH /admin/service-listings/:id`), so the item `PATCH` asks for it whenever the body carries `retailPrice` or
`pricing`: a role that may only prepare previews cannot set shop prices through one. Discarding one's own preview is part
of preparing it, so `cancel` needs `storefront:create`; stopping a run that is `queued` or `running` is a publishing
decision and also needs `storefront:publish`.

### 5.2 Publish runs (storefront; `publish/contracts/publish-runs.contracts.ts`)

```ts
type PublishScope =
  | { kind: 'services'; serviceIds: Id[] }   // 1 to 500, repeats dropped: the rows staff ticked
  | { kind: 'category'; categoryId: Id }
  | { kind: 'supplier'; supplierId: Id }      // live services linked to a service of this supplier
  | { kind: 'quickAddRun'; runId: Id }        // the services that Quick add run created
  | { kind: 'run'; runId: Id }                // an earlier publish run: a draft ("Check again") or the rest of a finished one
  | { kind: 'all' };

type PublishRun = {
  id: Id;
  status: 'preparing' | 'draft' | 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled';
  source: 'console' | 'quick_add'; quickAddRunId: Id | null;
  scope: PublishScope; listed: boolean; auto: boolean;
  total: number;
  counts: { ready: number; review: number; blocked: number; included: number;        // the draft: ready + review + blocked = total
            noRule: number;                                                           // rows that wait for a pricing rule (flag no_rule)
            published: number; skipped: number; refused: number; pending: number };  // the run: the four add up to total
  switch: { status: 'queued' | 'running' | 'done' | 'failed' | null;                 // the run switch (6.7); null: never asked
            listed: boolean | null; switched: number; skipped: number; error: string | null };
  replacedBy: Id | null;                                                             // the run "Check again" made from this one
  error: string | null; requestedBy: Id | null; requestedByName: string | null;      // the name by a join of staff_users
  createdAt: IsoDateTime; preparedAt: IsoDateTime | null; startedAt: IsoDateTime | null; finishedAt: IsoDateTime | null;
};

type PublishItem = {
  id: Id; serviceId: Id;
  service: { id: Id; name: string; code: string; type: 'imei' | 'server' | 'remote' | 'file'; categoryName: string };
  title: string; slug: string; brand: string; carrier: string; country: string;   // what will be published
  detected: { title: string; slug: string; brand: string; brandKind: 'device' | 'tool' | 'app' | null; carrier: string; country: string };
  edited: boolean;
  cost: Money; floorPrice: Money;
  rule: { id: Id; label: string } | null; rulePrice: Money | null;
  priceMode: 'rule' | 'manual' | 'keep'; existingPrice: Money | null;
  replacesPrice: Money | null;            // set when staff chose the rule over this typed price
  retailPrice: Money | null;              // the price apply would store: the typed one, the kept one, or the rule price
  marginPct: Decimal | null;              // marginPercent(retailPrice, cost), the figure of the listings table
  state: 'ready' | 'review' | 'blocked'; blockedReason: BlockReason | null; flags: Flag[]; included: boolean;
  evaluatedAt: IsoDateTime | null;
  result: 'published' | 'skipped' | 'refused' | null; resultReason: string | null; resultDetail: string | null;
  listingId: Id | null; publishedPrice: Money | null;
  listingListed: boolean | null;          // whether that listing is on the shop now (a join; null without a listing)
};
```
`BlockReason` and `Flag` are the closed lists of section 3.2 (exported `as const` arrays; the console's unions must equal them).

**`POST /admin/publish-runs`** `{ scope: PublishScope, listed?: boolean }` (default `true`; for the scope `run`, the old run's
`listed`) answers `202 PublishRun` (`preparing`, `total` = the services counted now). It inserts the run and the outbox event
`storefront.publish_prepare` in one transaction. The rows of a run are the **live services of the scope that have no
listing**; with `kind: 'services'` a ticked service that has a listing is a row too (`blocked: already_listed`), so staff see
why.

**The scope `run`** makes a new draft from an earlier run of any source. The old run must be `draft`, `succeeded`, `failed`
or `cancelled`. The new run is a console run (`source = 'console'`, `auto = false`), whoever made the old one.
- **From a `draft`: "Check again".** Every row is taken. The same transaction locks the old run (`FOR UPDATE`), sets it
  `cancelled`, stores the new run's id in its `replaced_by_run_id` and writes the `cancelled publishing run` audit row
  with `replacedBy`: one live draft, never two over the same rows, and a link from the old one to the new.
- **From a finished run: "Review the rest".** The rows that have no `published` result are taken (left out, refused,
  never reached).
- **What a copied row keeps** (the preparer does the copy, section 6.1): on a row staff edited (`edited`), the title, the
  three facts and a typed address (`slug_source = 'staff'`); the price choice (`price_mode`, `price_override`), never
  `replaces_price`; and the tick, when staff had changed it from the default of the row's state. Detection runs again for
  the rows staff did not edit, and **every** row is evaluated afresh, so a kept price or address that is no longer valid
  shows as `blocked: below_floor` or `slug_taken`, and a row whose obstacle is gone becomes `ready` and ticked.
  A service that was archived or listed meanwhile is not copied.

| When | Answer |
|---|---|
| no service of the scope is left to publish | `422`, field `scope`, code `nothing_to_publish`, "Nothing to publish: every service of this choice is already on the shop." No run is created (and no draft is cancelled) |
| the scope holds more than `MAX_PUBLISH_ITEMS = 5000` | `422`, field `scope`, code `too_many`, "This choice has <n> services. A run takes at most 5000: pick a category or a supplier." |
| an unknown category, supplier or run (`scope.categoryId`, `scope.supplierId`, `scope.runId`) | `422` on that field, code `invalid`. The storefront cannot read the suppliers' tables (fact 17): the existence reads are the catalog's `categoryExists`, `supplierExists` and `importRunExists` (`catalog/application/publish-sources.ts`); a publish run is the storefront's own row |
| scope `run` and the old run is `preparing`, `queued` or `running` | `409 CONFLICT`, "That run is still working." |

**`GET /admin/publish-runs`**: filters `status`, `source`, `quickAddRunId`; sorts `id` (default, descending first in the
console), `createdAt`. **`GET /admin/publish-runs/:id`**: one run. In both, a `preparing`, `queued` or `running` run without a
heartbeat for 5 minutes **reads** `failed` with `error` = `STALLED_ERROR` ("The run stopped before it finished. Start it
again: it continues with what is left.") or, when it stalled while `preparing`, `PREPARE_STALLED_ERROR` ("The preview was
not finished. Start a new one."); a switch that is `queued` or `running` without a heartbeat for 5 minutes reads
`switch.status = 'failed'` with `SWITCH_STALLED_ERROR` ("The switch stopped before it finished. Press it again."). A read
never writes.

**`GET /admin/publish-runs/:id/items`**: filters `state`, `included`, `result` (`pending` selects the rows without one),
`flag` (the row has it), `brandKind`, `afterId` (rows with a greater id: the "Save and next" of 7.2); search `q` over
`title`, `slug`, the service's name and code; sorts `id` (default), `title`, `cost`. Answers `PublishItem[]`.

**`PATCH /admin/publish-runs/:id/items/:itemId`** answers `200 PublishItem` (re-evaluated on the live service).
```ts
{ title?: string;            // 1 to 200, one line
  slug?: string;             // a valid slug, or '' = "make it from the title again"
  brand?: string; carrier?: string;   // at most 80, one line
  country?: string;          // two letters or ''
  retailPrice?: Money;       // a typed price: priceMode 'manual'
  pricing?: 'rule' | 'keep'; // 'rule': the rule price (over the current typed price, when there is one); 'keep': keep the current price
  included?: boolean;
  reset?: true }             // back to what was detected (alone in the body)
```
At least one key. `retailPrice` with `pricing`, or `reset` with anything, is `422` (code `conflict`).

One transaction: the run row `FOR SHARE` and the check that it is a `draft` **under that lock** (apply and cancel take the
row `FOR UPDATE`, so an edit and an apply never interleave), then the item row `FOR UPDATE`, the change, the evaluation of
the row with the facts of now (read without the service lock: a draft decides nothing, apply decides again under the lock),
and **one** `UPDATE`.

- **The price keys** (`normalisePriceMode`, pure, `publish-item.ts`; the same function sets the mode at prepare):
  `retailPrice: P` stores `manual` with `P`. `pricing: 'rule'` stores `rule`; when the service has a **typed** retail price
  at that moment, `replaces_price` is set to it (staff see that price in the dialog and choose the rule over it), else it
  is null. `pricing: 'keep'` stores `keep`. Each of the three, and `reset`, clears what the others set (`price_override`,
  `replaces_price`); `reset` gives the default mode (`keep` when the service has a retail price, else `rule`).
- **Every evaluation normalises the mode against the price the service has now**, so a row never promises to replace a
  price nobody chose to replace: a `rule` row without `replaces_price` whose service has a retail price becomes `keep`
  (flag `price_kept`); a `rule` row whose `replaces_price` is no longer the stored typed price loses it (and then follows
  the line before); a `keep` row whose price is gone becomes `rule`; a `manual` row stays, and is `blocked: below_floor`
  when its price is under the floor of now.
- **The address:** `slug: ''` stores `slug_source = 'auto'` and the slug `nextFreeSlug` gives from the title against the
  listings and the other rows of the run (3.5); a typed slug stores `'staff'`.
- **The flags** that derive from the edited fields are recomputed (`reflag`, 3.2), and `edited` is set (cleared by `reset`).
- **The tick** follows the rule of 3.2: blocked after the change clears it in the same `UPDATE`; leaving `blocked` sets
  the default of the new state unless the body sends `included`.

| When | Answer |
|---|---|
| the run is not a `draft` | `409 CONFLICT`, "This run is no longer a draft." |
| `retailPrice` or `pricing` sent by a role without `storefront:update` | `403 FORBIDDEN` naming `storefront:update` (5.1) |
| `retailPrice` is 0 or less, or under the floor of now | `422`, field `retailPrice`, code `invalid` / `below_floor`, "Below the storefront floor of $X." (the listing route's words) |
| `slug` is not a slug, or an existing listing or another row of the run holds it | `422`, field `slug`, code `invalid` / `duplicate` |
| `included: true` on a row that is `blocked` after the change | `422`, field `included`, code `blocked`, the reason's sentence |
| `pricing: 'keep'` on a row whose service has no retail price | `422`, field `pricing`, code `invalid` |

**`POST /admin/publish-runs/:id/items/bulk`** answers `200 { changed: number, refused: number }`.
```ts
{ select: { itemIds: Id[] }                                       // 1 to 500
        | { filter: { state?: State; flag?: Flag; brandKind?: BrandKind; included?: boolean; q?: string } },  // every matching row
  set: { included?: boolean; brand?: string; carrier?: string; country?: string } }   // at least one key
```
`refused` counts the rows that could not take `included: true` (blocked). One transaction: the run row `FOR UPDATE` and the
`draft` check under it (`409 CONFLICT` otherwise; one bulk at a time per run, and none during an apply). `included` is one
set-based statement checked against the stored state. A fact (`brand`, `carrier`, `country`) is written in pages of 500:
the rows are read, `reflag` recomputes the flags that derive from the three facts (`no_brand`, `title_lacks_brand`,
`carrier_no_country`, `country_from_group`, `multi_country`) and the state that follows from the flags, and one `UPDATE ...
FROM (VALUES ...)` writes the page, so the badges are right after a bulk fix. No price is read and no tick is moved (a
fact never blocks or unblocks a row).

**`POST /admin/publish-runs/:id/apply`** `{ listed?: boolean }` answers `202 PublishRun` (`queued`). One transaction: the run
row `FOR UPDATE`, the guarded move to `queued` (`heartbeat_at` = now, `error` cleared, `listed` stored when sent), on a
resume the rows `refused: failed` set back to no result (here, under the run row lock, where no worker can be inside a
row), the outbox event `storefront.publish_apply`, the audit row. The worker that claims the run gets the next `attempt`
(6.2), which is what stops a worker of the earlier attempt.

| When | Answer |
|---|---|
| `draft` with at least one included row | `202` |
| `failed`, or `queued`/`running` and stalled, and the draft was prepared (`prepared_at` is set) | `202`: **resume**. Rows with a result stay; rows `refused: failed` are tried again; the rest continues |
| `queued` or `running`, not stalled; or a run switch is `queued` or `running`, not stalled | `409 JOB_ALREADY_RUNNING`, "This run is already being published." / "This run is being switched." |
| `preparing`, not stalled | `409 CONFLICT`, "The preview is still being prepared." |
| `failed`, or `preparing` and stalled, and the draft was never prepared (`prepared_at` is null) | `409 CONFLICT`, "The preview was not finished. Start a new one." A half-evaluated draft is never applied (the guarded move to `queued` also asks for `prepared_at IS NOT NULL`); it holds no staff edit, since edits need `draft` |
| `succeeded` or `cancelled` | `409 CONFLICT`, "This run is finished. Start a new one." |
| `draft` with no included row | `422`, field `included`, code `nothing_included`, "No row is included." |

**`POST /admin/publish-runs/:id/cancel`** `{}` answers `200 PublishRun` (`cancelled`). Allowed while `preparing`, `draft`,
`queued` or `running`; anything else is `409 CONFLICT`. A `queued` or `running` run also needs `storefront:publish` (`403`
otherwise, 5.1). One transaction with the run row `FOR UPDATE`: every row transaction of the worker holds that row `FOR
SHARE`, so the cancel waits for the row in flight and the worker stops before the next one; rows already published stay
published and keep their result. The cancel writes the three counters from the rows, `finished_at` and the audit row, and
bumps the catalog price version when a row was published (a run that ends this way wrote prices too).

**`POST /admin/publish-runs/:id/listed`** `{ listed: boolean }` answers `202 PublishRun` (`switch.status = 'queued'`): take
everything this run published off the shop, or put it back (the job of 6.7). One transaction: the run row `FOR UPDATE`,
`switch_status = 'queued'`, `switch_listed` and `listed` = the target, the two switch counters zeroed, `switch_error`
cleared, `heartbeat_at` = now, the outbox event `storefront.publish_set_listed`, the audit row.

| When | Answer |
|---|---|
| `succeeded`, `failed` or `cancelled`, with at least one `published` row | `202` (also again after a switch that is `done`, `failed` or stalled). A `queued` or `running` run that **stalled** is first closed `failed` by this transaction (`STALLED_ERROR`, the three counters from the rows), as Quick add closes a stalled run at a restart; a worker that wakes up later stops at its next row |
| `preparing`, `draft`, or `queued`/`running` and not stalled; or no `published` row | `409 CONFLICT`, "Only a finished run can be switched." / "This run published nothing." |
| a switch is `queued` or `running`, not stalled | `409 JOB_ALREADY_RUNNING`, "This run is being switched." |

### 5.3 Retail price rules (catalog; `contracts/retail-price-rules.contracts.ts`)

```ts
type RetailPriceRule = {
  id: Id; scope: 'global' | 'type' | 'category';
  serviceType: 'imei' | 'server' | 'remote' | 'file' | null;
  categoryId: Id | null; categoryName: string | null;
  percent: Decimal;            // '30.0000'
  fixed: Money; rounding: 'cent' | 'step_0.05' | 'step_0.10' | 'ends_99'; roundFrom: Money;
  autoFollowPercent: number;   // 0 to 1000
  isActive: boolean;
  label: string;               // the server's words: 'Every service +25%, ends in .99', 'IMEI +30%', 'AT&T USA +20% +$0.50'
  following: number;           // services whose price this rule wrote last
  updatedAt: IsoDateTime;
};
```
- **`GET /admin/retail-price-rules`**: filters `scope`, `isActive`; sorts `id`, `scope` (default: `global`, `type`, `category`,
  then `id`).
- **`POST /admin/retail-price-rules`** `{ scope, serviceType?, categoryId?, percent, fixed?, rounding, roundFrom?,
  autoFollowPercent?, isActive? }` answers `201 RetailPriceRule`. `percent` is decimal text with at most 4 decimals. `422`:
  the target fields that do not fit the scope (`serviceType` / `categoryId`, code `invalid`); a second rule for the same
  target (field `scope`, code `duplicate`, "A rule for this already exists. Edit it instead."); a number outside its limits.
- **`PATCH /admin/retail-price-rules/:id`** any of `percent`, `fixed`, `rounding`, `roundFrom`, `autoFollowPercent`,
  `isActive` (the scope and target never change) answers `200`. **`DELETE`** answers `204`: a soft delete (`deleted_at`
  and `is_active = false`, 4.1). A deleted rule is `404` for `PATCH`, `DELETE` and the preview, is absent from the list, and
  leaves its target free for a new rule.
- The three writes: an audit row (entity `retail_price_rule`: `created`, `changed`, `deleted retail price rule`, with the
  fields before and after) and `CatalogPriceVersion.bumpAfterCommit`, which starts the follow pass (section 6.4): following
  prices move within about two minutes.
- **`POST /admin/retail-price-rules/preview`** (what the follow pass would do once this change is saved; nothing is stored)
  ```ts
  { change: { kind: 'create'; rule: <the POST body> } | { kind: 'update'; id: Id; rule: <the PATCH body> } | { kind: 'delete'; id: Id } }
  ->
  { following: number;      // services that follow rules and that this change can reach
    changes: number; raised: number; lowered: number; atFloor: number; noRule: number;
    lines: { serviceId: Id; name: string; code: string; cost: Money; floorPrice: Money;
             currentPrice: Money; newPrice: Money | null; atFloor: boolean }[];   // the 100 largest changes
    truncated: boolean }    // true when more than RULE_PREVIEW_LIMIT = 2000 services were in reach (the figures cover the first 2000 by id)
  ```
  The same `422`s as the write it previews.

### 5.4 Price changes (catalog; `contracts/retail-price-changes.contracts.ts`)

```ts
type RetailPriceChange = {
  id: Id; service: { id: Id; name: string; code: string };
  kind: 'followed' | 'proposed' | 'detached';
  reason: 'cost_changed' | 'rule_changed' | 'floor_changed' | 'cost_jump' | 'no_cost' | 'changed_elsewhere';
  oldPrice: Money; newPrice: Money | null; oldCost: Money; newCost: Money;
  rule: { id: Id; label: string } | null;
  waiting: boolean;                                   // a proposal nobody resolved
  resolution: 'applied' | 'kept' | 'superseded' | null; resolvedAt: IsoDateTime | null; resolvedBy: Id | null;
  createdAt: IsoDateTime;
};
```
- **`GET /admin/retail-price-changes`**: filters `kind`, `waiting`, `serviceId`; sorts `id` (default, newest first in the
  console), `createdAt`. The tab's count is this list with `waiting=true` read from `x-total-count`.
- **`POST /admin/retail-price-changes/resolve`** `{ ids: Id[] (1 to 200), action: 'apply' | 'keep' }` answers
  `200 { applied: number, kept: number, skipped: { id: Id, reason: string }[] }`. One transaction per id (the pattern of the
  bulk reply): lock the service, re-read the proposal; `apply` writes the rule price of now **only when it equals the proposal's
  `newPrice`** (3.4), and is `skipped` with `no_rule`, `no_cost`, `not_waiting`, or `changed` (the figure moved: the proposal
  now shows the new one and staff approve again); `keep` deletes the follow row. Each resolved proposal writes an audit row
  (entity `service`: `approved retail price of` / `kept retail price of`). A request that resolves nothing still writes one
  summary audit row (the bulk reply's rule), so the audit duty of a staff write holds.

### 5.5 Changed routes

- **Listings** (`GET /admin/service-listings`, `GET /:id`, the answers of `POST` and `PATCH`): three new keys, always sent:
  `retailPriceSource: 'rule' | 'manual' | null` (null without a price), `retailPriceRule: { id, label } | null` (the rule a
  following price came from), `retailPriceWaiting: boolean` (a proposal waits). `PATCH` takes `retailPricing?: 'rule'`:
  the rule price of now is written and the price follows from then on; `422` on `retailPricing`: code `conflict` when
  `retailPrice` is sent too, `no_rule` ("No pricing rule covers this service."), `no_cost` ("This service has no cost, so
  a rule cannot price it."); `409 LISTING_LOCKED` as for a price. A typed `retailPrice` turns following off, as before.
- **Quick add** (`POST /admin/suppliers/:id/quick-add`): the body takes `publish?: { listed: boolean }`. `422` on `publish`:
  code `needs_active` with `serviceStatus: 'disabled'` ("Services added switched off cannot go on the shop."), code `no_rule`
  when no retail price rule is active ("Set a retail pricing rule first."). `403 FORBIDDEN` naming `storefront:publish` when
  the staff member lacks it (checked in the controller with `grants`, fact 16: the route's own permission stays
  `catalog:create`). The run (`QuickAddRun`, also inside `service-groups.latestRun`) gains `publish: 'none' | 'listed' |
  'unlisted'`. The console finds the publish run with `GET /admin/publish-runs?quickAddRunId=<id>`.

## 6. The jobs

| Outbox event | Queue | Job | Payload | Written by |
|---|---|---|---|---|
| `storefront.publish_prepare` | `imports` | `publish_prepare` | `runId` (aggregate `listing_publish_runs`) | `POST /admin/publish-runs`; the Quick add hand-over |
| `storefront.publish_apply` | `imports` | `publish_apply` | `runId` | `POST .../apply`; the close of the prepare of an `auto` run |
| `storefront.publish_set_listed` | `imports` | `publish_set_listed` | `runId`, `listed`, `requestedBy` | `POST .../listed` |
| `supplier.quick_add_done` | `imports` | `publish_from_quick_add` | `runId`, `supplierId`, `requestedBy`, `listed` (aggregate `supplier_import_runs`) | the close of a Quick add run that asked to publish |
| (none) | `maintenance` | `retail_price_follow` | `{}` | `RetailFollowScheduler`, the price version listener (delayed 60 s, job id `retail-follow-<minute>`), and the scheduler `retail_price_follow_hourly` |

The four storefront routes are registered by `PublishOutboxRoutes` (`publish/jobs/`, `onModuleInit`, in a module the API
and the worker both load, as `SearchOutboxRoutes`); the suppliers module only writes rows of the type `supplier.quick_add_done`
(it never imports the storefront). `imports` has one attempt and no stalled re-run (fact 9): a job that dies leaves its run
`preparing` or `running`, the 5 minute rule shows it `failed`, and staff start again. Runs are recorded in their own tables,
not in `job_runs`, except the hourly follow pass (a scheduled job: `JobRunsService.run`, overlap `skip`). `docs/queues.md`
gets the five rows and a section per job.

### 6.1 Prepare (`PublishPreparer.run(runId)`, `publish/application/publish-preparer.ts`)

1. **Claim**: `UPDATE ... SET prepare_claimed_at = $now, heartbeat_at = $now WHERE id = $1 AND status = 'preparing' AND
   prepare_claimed_at IS NULL`. No row: return (a second delivery, or the run was cancelled): the job is idempotent.
2. **Work list**: the service ids of the scope, `ORDER BY id`, at most `MAX_PUBLISH_ITEMS` (the Quick add hand-over takes the
   first 5000 and says so in `error`; a console run was refused at the `POST`, which counts with the same walk). The ids come
   from the catalog in keyset pages of 1000 (`catalog/application/publish-sources.ts`, exported: `liveServiceIds`,
   `serviceIdsOfCategory`, `serviceIdsOfSupplier(db, supplierId, afterId, limit)`, `serviceIdsOfImportRun(db, runId, afterId,
   limit)`, and the existence reads of 5.2 `categoryExists`, `supplierExists`, `importRunExists`; the supplier reads join
   `service_supplier_links` and `supplier_services` next to `recomputeEffectiveCost`, which already reads them: fact 17; the
   new file's header carries a DEVIATION note like the one of `catalog/infra/foreign-reads.repository.ts:6`); the storefront
   drops from each page the services that have a listing (its own table). **Scope `run`** reads the old run's rows instead
   (all of a draft, the rows without a `published` result of a finished run), drops the services that are archived or
   listed now, and carries what 5.2 says a copied row keeps.
3. **Rows**: insert `(run_id, service_id)` in batches of 500, `ON CONFLICT DO NOTHING`; a copied row is inserted with the
   fields it keeps.
4. **Detect** (in memory, the whole run at once: the cut and the uniqueness ladder of 3.5 need every title): read the rows
   with their service and category, and the public title and slug of **every** listing (two columns, at most 10 000 rows,
   fact 22). `nameAll(rows, { listingTitles })` gives each row its facts, title, flags and slug base; a copied row that
   staff edited keeps its own title and facts (it still takes part in the uniqueness checks). `assignSlugs(named, taken)`
   then gives the slugs, with `taken` = the listings' slugs and the addresses staff typed in the copied rows.
5. **Evaluate** in pages of 500: `RetailPricing.targets(db, ids)` (cost, floor, existing retail price and whether it is
   typed or following, the rule and its price), `supplyStates(db, ids)` (catalog: `ok`, `no_link`,
   `supplier_unavailable`), the lock facts of `findServiceFacts` read for the page and **with the category's `is_active`**
   (the listing routes do not read it, fact 5); `normalisePriceMode` (the default: `keep` when the service has a retail
   price, else `rule`; a copied row's choice is normalised against the price of now, 5.2), `evaluateItem`; one `UPDATE ...
   FROM (VALUES ...)` per 200 rows writes the detection, the evaluation, the price mode and the tick (`state = 'ready'`,
   or what a copied row keeps when it is not blocked). A heartbeat after every page (guarded on `preparing`: no row means
   cancelled, stop).
6. **Close** (one transaction, guarded on `preparing`): `total`, `prepared_at`, `status = 'draft'`. For an `auto` run with at
   least one included row: `status = 'queued'` and the event `storefront.publish_apply` instead, plus the start audit row of
   6.6 with the actor `system`. An `auto` run with nothing included stays a `draft` for staff.
7. An unexpected error closes the run `failed` with its message (500 characters) and rethrows, as Quick add does.

1157 services: about 3 inserts, one naming pass (well under a second in the prototype) and 3 evaluation pages.

### 6.2 Apply (`PublishRunner.run(runId)`, `publish/application/publish-runner.ts`)

**One worker per attempt.** Quick add never lets two workers share a run: a restart closes the stalled run and makes a new
one (fact 9). A publish run must keep its id across a resume (its rows hold the edits and the results), so the claim counts
instead: `listing_publish_runs.attempt`. A worker that was only slow, and wakes up after staff pressed Continue, finds
that the number it carries is no longer the row's and stops without writing anything.

1. **Claim**: `UPDATE ... SET status = 'running', attempt = attempt + 1, started_at = coalesce(started_at, $now), heartbeat_at
   = $now WHERE id = $1 AND status = 'queued' RETURNING attempt`. No row: return. The returned number is `$mine` below.
   **Every later write of this worker requires `status = 'running' AND attempt = $mine`**; where one finds no row, the worker
   stops quietly (the run was cancelled, or claimed again after a resume).
2. **Left out, in one statement** (guarded by `EXISTS (the run is running with attempt = $mine)`): rows with `result IS NULL
   AND included = false` get `result = 'skipped'`, `result_reason = coalesce(blocked_reason, 'left_out')`. (The rows
   `refused: failed` of an earlier attempt were set back to no result by the resume itself, 5.2.)
3. **Chunks of `PUBLISH_CHUNK = 50`**: read the next 50 ids `WHERE run_id = $1 AND result IS NULL ORDER BY id`; none left:
   close. Each row is **its own transaction** (below). After the chunk the guarded heartbeat (`WHERE id = $1 AND status =
   'running' AND attempt = $mine`; no row: stop quietly).
4. **A row that throws**: a deadlock or serialization failure (`40P01`, `40001`) is tried once more; anything else is
   written as `refused: failed` with `failureReason(error)` (the constraint name, else `unexpected error`; the full error
   goes to the log) by a small transaction of its own that takes the run row `FOR SHARE` with the same check and then
   `UPDATE ... WHERE id = $1 AND result IS NULL`. At `MAX_ITEM_FAILURES = 20` such rows in one attempt the run closes
   `failed` with "Too many rows failed unexpectedly (20). The rest was not tried." (the Quick add rule).
5. **Close** (one transaction, `UPDATE ... WHERE id = $1 AND status = 'running' AND attempt = $mine`; no row: stop quietly,
   nothing else is written): the three counters from the rows, `finished_at`, `status = 'succeeded'`, the audit row of
   6.6, and `CatalogPriceVersion.bumpAfterCommit` when something was published (one bump per run, not per row: A1 hazard
   10). An unexpected error outside the rows, and the 20 failures of step 4, close `failed` by the same guarded statement
   with the same counters and bump; the error is rethrown.
6. `run(runId, hooks?)` takes an optional `afterChunk` hook, a test seam like the limit seam of `too_many`: the tests use
   it to cancel or resume a run between two chunks (8.3). Product code never passes it.

**The row transaction.** The order of the steps is the lock order (**the service, the run, the item, the listings**), and
**no outcome is decided before step 3**: a worker of an old attempt, or a second delivery, writes nothing at all. Steps 1
and 4-12 are `ListingPublisher` (`storefront/application/listing-publisher.ts`: `lock(tx, serviceId)`, then
`publishLocked(tx, service, input)`, which answers the outcome and writes everything but the item row); steps 2, 3 and 13
are the runner's, in the same transaction. Every refusal is decided before the first write.

| # | Step | Outcome when it fails |
|---|---|---|
| 1 | `retail.lockLiveService(tx, serviceId)` (`FOR UPDATE`: the lock every writer of a listing, a price or the service takes first) | (decided at step 4) |
| 2 | the run row `FOR SHARE`: `status = 'running'` and `attempt = $mine` | roll back, write nothing, stop this worker |
| 3 | the item row `FOR UPDATE`, `result IS NULL` | it has a result already: roll back, write nothing, next row |
| 4 | the service of step 1 is gone or archived | `refused: service_gone` |
| 5 | `lockServiceListings(tx, serviceId)`: a listing exists | `skipped: already_listed` |
| 6 | the facts of now (`findServiceFacts` with the category's `is_active`, `supplyStates`) through `evaluateItem` | `refused` with the blocking reason |
| 7 | `quote = retail.quotes(tx, [id])`, the follow row, the rule of now; the price by the table below (`decidePrice`) | `refused: price_missing`, `below_floor` or `cost_moved` |
| 8 | the slug: taken, and `slug_source = 'auto'`: `nextFreeSlug` (3.5); taken, and `'staff'`: | `refused: slug_taken` |
| 9 | insert the listing inside a savepoint; a violation of `service_listings_slug_uq` picks the next suffix (at most 3 tries), of `service_listings_service_uq` is `skipped: already_listed` | |
| 10 | `retail.set(tx, id, price, { origin, quote })` when the table says a price is written | `RetailFloorError` cannot happen after step 7; if it does the row is `refused: failed` |
| 11 | `setListed(tx, listingId, true, clock.now())` when the run is `listed` | |
| 12 | `signals.listingsChanged(tx, [serviceId])`, the audit row `published to the storefront` | |
| 13 | the item: `UPDATE ... SET result, result_reason, result_detail, listing_id, published_price, finished_at WHERE id = $1 AND result IS NULL` (every outcome of steps 4-12 is written here, and only here) | |

Steps 6 to 8 are the blocking list of 3.2 in its order: `evaluateItem` judges the facts, `decidePrice` the price, the
slug check the address. The evaluation of a draft row calls the same three with the facts of that moment (and the row's
own cost as the cost of now, so `cost_moved` cannot arise in a draft).

**The price of a row at apply** (`decidePrice`, pure; the quote and the follow row are read under the service lock; money,
reviewed line by line). "Typed" is a retail row with no follow row; "following" is one with a follow row.

| The row | The service now | What is written |
|---|---|---|
| `manual` (staff typed `P` in the row) | anything | `P >= floor`: `P` with origin `manual` (it replaces whatever is stored: a person typed it for this service, and the last save wins as in the price dialog). `P < floor`: `refused: below_floor`, nothing written (a typed price is never silently raised) |
| `keep` | has a retail price | no price write: the price and its typed or following state stay |
| `keep` | the price is gone | **by the rule** (below) |
| `rule` | no retail price | **by the rule** |
| `rule` | a following price | no price write: it is the rule's price already, or a proposal waits; the follow pass keeps it (3.4) |
| `rule`, and `replaces_price` equals the stored typed price | a typed price | **by the rule**, with origin `rule`: staff chose the rule over exactly this price |
| `rule`, otherwise (`replaces_price` is null, or is not the stored price) | a typed price | **no price write**: a price typed after staff's choice is never overwritten. The row is `published` with that price, and `resultDetail` says "A price typed since the preview was kept." |

**By the rule** means, in this order:
1. no active rule matches, or the effective cost of now is 0: `refused: price_missing`;
2. **the publish limit**: `costMoved(row.cost, cost of now, autoFollowPercent of the matched rule)` (the formula of 3.4;
   `row.cost` is the cost the preview was evaluated with): `refused: cost_moved`, `resultDetail` "The cost moved from $a to
   $b since the preview. Check the preview again.", **nothing is written**. Staff make a new preview from the run (scope
   `run`), see the new figure and publish it or not. Without this a cost the supplier reports wrongly for one sync (10
   instead of 100) would become a first shop price nobody saw, in a Quick add run too, and its later correction would
   itself be a jump that waits (3.4);
3. else the rule price of **now** (never the preview's figure; at or above the floor by construction) with origin `rule`
   and the cost of now. A price that differs from the preview's is said in `resultDetail`.

`existing_price` plays no part: it is the figure the preview showed. What licenses the replacement of a typed price is
`replaces_price`, which only an explicit choice in the row sets (5.2). The scenario that must hold (a test, 8.3): a row
prepared with no price; staff then type $20 on the group price page; staff edit the row's brand; apply. The typed $20
stands, no follow row is made, and the row's detail says so.

`ListingPublisher` does not copy rules: the three steps of today's writer (insert with the conflict mapping, the price with
its floor check, the switch with the disabled and locked checks) move into functions of
`storefront/application/listing-writes.ts` that `ListingAdminService.create`/`update`, `ListingPublisher` and the run switch
(6.7) all call. `ListingAdminService`'s behaviour, answers and audit rows do not change (its tests pass unchanged; in
particular it still does not read the category's `is_active`). The publisher needs no `PublicImages`, so the worker loads
it without the upload path.

**Search**: one `storefront.listing_changed` event per published row, in its transaction (exactly what a staff edit writes).
1157 rows are 1157 small `search_sync` jobs on a queue of concurrency 1: the index catches up in about a minute, and the
shop's lists read Postgres meanwhile (decision 038). The reconcile repairs a lost job.

### 6.3 The Quick add hand-over

- `QuickAddService.start` stores `publish_mode`; `createImportedService` passes the run id to `insertFirstLink`
  (`import_run_id`).
- When a run that asked to publish is closed with `created_count > 0` (by the runner's `close`, succeeded **or** failed, and
  by `start` when it closes a stalled run), the closing transaction also writes `supplier.quick_add_done` (ids and a
  boolean only, fact 14). It is written after every chunk committed, so the consumer sees every created service.
- `publish_from_quick_add` (storefront): `INSERT ... ON CONFLICT (source_run_id) WHERE source_run_id IS NOT NULL DO NOTHING`
  a run (`source = 'quick_add'`, scope `{ kind: 'quickAddRun', runId }`, `auto = true`, `listed`, `requested_by`), then
  `PublishPreparer.run`. The unique index is partial, so the conflict target must repeat its predicate (Drizzle:
  `onConflictDoNothing({ target: runs.sourceRunId, where: isNotNull(runs.sourceRunId) })`); Postgres refuses the statement
  without it. A second delivery finds the run and does nothing.
- So "one step": the ready rows go on the shop without another click; the rows that need a person wait in that run
  (`skipped: left_out`), and "Review the rest" makes a new draft from them (scope `run`). The staff member who started the
  Quick add held `storefront:publish` (section 5.5); the worker acts as `system` and records `requestedBy`.
- An automatic run is published by nobody's eyes, so two things hold it: the hard flags keep every doubtful name out
  until a person ticks it, and the whole run can be taken off the shop with one button (6.7).
- If the consumer job dies, nothing is published and no run exists (or the run failed before its preview was ready): the
  Quick add progress then says so and offers to prepare the preview of that run's services (a console run with the scope
  `quickAddRun`, section 7.4).

### 6.4 The follow pass (`RetailPriceFollow`, `catalog/application/retail-price-follow.ts`)

- **Triggers, and where they live.** `RetailFollowScheduler` (`catalog/application/retail-follow-scheduler.ts`) registers
  with `PriceVersionListeners` and adds the delayed job exactly as `PriceChangeScan.schedule` does (fact 11); it never
  throws into a price change. It is provided by the **global `CatalogPricesModule`**, which the API and the worker both
  load: a rule edit, `retailPricing: 'rule'`, a base price and a B2B rule are written in the API, and a listener that lived
  only in the worker would leave them to the hourly run. The pass itself, its processor and the hourly scheduler live in
  the worker module (`jobs/retail-price-follow.module.ts`), like the scan's processor.
- **`run()`**: a keyset walk over `retail_price_follows` by `service_id`, 200 at a time. Per page one unlocked read
  (`RetailPricing.targets`) finds the candidates (anything but "the rule price equals the stored price and the cost equals
  `applied_cost`"). Each candidate is **its own transaction**: `lockLiveService` (catalog's, `FOR UPDATE`; an archived
  service only loses its follow row), the follow row
  `FOR UPDATE` (gone: skip, a person typed a price meanwhile), the quote and the rules read again inside, then the table of
  3.4. The write is `RetailPrices.set(... origin rule ...)`, the change row and the audit row, together. A candidate whose
  transaction fails with `40P01` or `40001` is skipped and counted; the next pass takes it (the pass never fails for one
  service).
- **It ends** with one `CatalogPriceVersion.bump()` when it changed a price. That bump schedules one more pass, which finds
  nothing, writes nothing and does not bump: the loop closes itself (a test runs the job twice).
- **The message**: at the end of a pass, when rows with `notified_at IS NULL` exist and no row was notified in the last 60
  minutes, one transaction marks them and enqueues `retail.prices_followed` by `enqueueToAddress` to the ops recipients
  (email and Telegram, the variables `changed`, `waiting`, `detached`, `link` =
  `<consoleBaseUrl>/storefront?tab=pricing`; dedupe key `retail-follow:<first unnotified id>`). No recipient configured: the
  notification row records why (the alerts' rule); the console list is the notice either way.
- Idempotent by construction: it compares stored state with computed state and writes differences; two passes in parallel
  serialize on the service row and the second finds nothing.

### 6.5 Concurrency (what runs against what)

**Lock order, everywhere in this feature:** the `services` row, then the `listing_publish_runs` row, then the
`listing_publish_items` row, then the listing rows (in id order), then the price and follow rows. A transaction takes any
subset in this order: the publisher and the run switch start at the service; a draft edit starts at the run; apply, cancel,
the switch route and "Check again" take only the run.

| Against | What holds |
|---|---|
| **The supplier sync** (locks the supplier row, then `recomputeEffectiveCost` updates many `services` rows in one statement) | a publish row and a follow candidate hold **one** service row and never ask for the supplier row or a second service, so no cycle can form. The price is worked out from the cost committed when the row was locked. A cost the sync moved **before** the row is locked is compared with the preview's cost (`cost_moved`, 6.2); a cost that commits a moment **after** bumps the version and the follow pass corrects the price inside the same limit within about two minutes; the sale-time floor covers the gap |
| **A Quick add run** (creates services under the supplier lock, never changes one) | a draft holds the services that existed when it was prepared; the hand-over event is written by the transaction that closes the run, after its last chunk |
| **A staff edit of the service** (disable, archive, base price, category) | serialized by the service row lock. Before the row: the re-check refuses it (`service_disabled`, `service_gone`, `category_inactive`, `b2b_only`). After: the shop's sellable rule hides a disabled service, as today |
| **A staff listing or price for the same service** (`POST`/`PATCH /admin/service-listings`, the group price page) | the same service row lock (`FOR SHARE` of a create blocks our `FOR UPDATE`); the second sees the listing (`already_listed` / `409 LISTING_EXISTS`); `service_listings_service_uq` is the backstop. A price typed on the group price page at any moment before the row is locked is kept, unless it is the exact price staff chose to replace (`replaces_price`, the table of 6.2) |
| **Two publish runs over the same services** | allowed; per service the first transaction wins, the other row ends `skipped: already_listed`; slugs are settled by the pre-check and the unique index inside a savepoint |
| **The same run applied twice, the job delivered twice** | the guarded move to `queued` (one `202`, one `409`), and the claim (`queued` to `running`): one worker gets a row |
| **Two workers on one run** (a slow worker, no heartbeat for 5 minutes, staff press Continue, the worker wakes up) | the claim of the second worker raised `attempt`. The first worker's next row takes the run row `FOR SHARE` after the service lock, reads another number and rolls back before deciding anything; its heartbeat, its `refused: failed` write and its close find no row. A row the first worker had **in flight** holds the run row `FOR SHARE`, so the resume (which takes it `FOR UPDATE`) waits for that row's commit and the second worker never sees it without its result. Every result write is `WHERE result IS NULL` under the item lock: a `published` result is never overwritten |
| **Cancel during a run** | cancel takes the run row `FOR UPDATE`; a row in flight holds it `FOR SHARE`, so cancel waits for that row and the worker stops before the next |
| **A worker that dies** | the row in flight rolls back whole; the run reads `failed` after 5 minutes; apply again continues with the rows that have no result |
| **A staff edit of a draft row during apply** | the edit holds the run row `FOR SHARE` and checks `draft` under it; apply takes the row `FOR UPDATE`. So either the edit commits first and apply publishes the edited row, or apply moves the run first and the edit answers `409`. A bulk edit takes the row `FOR UPDATE` itself (one at a time) |
| **"Check again" against an edit or an apply of the old draft** | it takes the old run `FOR UPDATE` and cancels it in the transaction that creates the new run; an edit after it answers `409`, an apply after it answers `409` (finished). The preparer copies rows that can no longer change |
| **The follow pass against a typed price or a publish row** | the service row lock, then the follow row re-read: a price a person just typed has no follow row and is skipped |
| **A rule edit or delete during a pass or a run** | each row reads the rules inside its transaction; the edit's own bump schedules the next pass. A delete is an `UPDATE` (`deleted_at`): the foreign key checks of the pass and the publisher never wait on it, and a row priced a moment before the delete is re-priced by the next pass (4.1) |
| **The run switch against a staff switch, a price edit or another run's row** | one service row lock per listing, as every writer; the switch re-reads the listing under it and writes only a difference. Against an apply of the same run: the routes refuse one while the other is live (5.2), and both claims raise the same `attempt` |

### 6.6 Audit

| Row | Entity | Actor | `after` |
|---|---|---|---|
| `started publishing to the storefront` | `publish_run` (id, label `Publish run #<id>`) | the staff member (`system` for an `auto` run) | `{ scope, total, included, listed, source, resumed, requestedBy }` |
| `published to the storefront` (one per published service) | `listing` (label = the service's name) | `system` | `{ runId, requestedBy, slug, publicTitle, brand, carrier, country, retailPrice, pricing: 'rule' / 'manual' / 'kept', ruleId, isListed }` |
| `published services to the storefront` (the close) | `publish_run` | `system` | `{ status, total, published, skipped, refused, listed, requestedBy, error? }` |
| `cancelled publishing run` (the cancel route; "Check again" for the draft it replaces) | `publish_run` | the staff member | the counts so far; `replacedBy` for "Check again" |
| `started switching publishing run` | `publish_run` | the staff member | `{ listed, published }` |
| `listed on storefront` / `unlisted from storefront` (one per listing the switch changed; the listing route's own actions) | `listing` | `system` | before `{ isListed }`, after `{ isListed, runId, requestedBy }` |
| `switched publishing run` (the close of the switch) | `publish_run` | `system` | `{ listed, switched, unchanged, skipped: { <reason>: n }, requestedBy, error? }` |
| `created` / `changed` / `deleted retail price rule` | `retail_price_rule` | the staff member | the rule's fields (before and after) |
| `changed retail price of` (the follow pass) | `service` | `system` | before `{ retailPrice, cost }`, after `{ retailPrice, cost, reason, ruleId }` |
| `approved retail price of`, `kept retail price of` | `service` | the staff member | the prices, the costs, the proposal id |

`AUDIT_ENTITY_TYPES` gains `publish_run` and `retail_price_rule` (backend additions; the console gives an unknown type a
generic label). One audit row per published service replaces the three a hand-made listing writes; it holds the same facts.
The audit row of a category delete (`deleted category`) gains `removedRetailRuleId` when the cascade removes the
category's retail rule (4.1), beside the `removedPricingRuleIds` it has.

### 6.7 The run switch (`PublishSwitch.run(runId, listed, requestedBy)`, `publish/application/publish-switch.ts`)

The undo of a run, and the "switch them on" of a run that was created switched off. It touches the switch of each listing
and nothing else: no listing is deleted, no title or price changes, a following price keeps following.

1. **Claim**: `UPDATE ... SET switch_status = 'running', attempt = attempt + 1, heartbeat_at = $now WHERE id = $1 AND
   switch_status = 'queued' AND switch_listed = $listed RETURNING attempt`. No row: return (a second delivery, or a newer
   switch).
2. **Chunks of 50** over the run's rows with `result = 'published' AND listing_id IS NOT NULL`, by id. Each row is its own
   transaction, in the lock order of 6.5, through the switch function of `listing-writes.ts`:
   `retail.lockLiveService` (`FOR UPDATE`), the run row `FOR SHARE` (`switch_status = 'running'` and `attempt = $mine`,
   else roll back and stop), `lockServiceListings`, then:

   | What it finds | What it does |
   |---|---|
   | the service is archived, or the listing is gone | skipped: `service_gone` / `listing_gone` |
   | the listing is already at the target (staff switched it by hand meanwhile) | nothing (counted `unchanged`) |
   | switching **on**: the service is not `active`, or the lock rule of the listing route says no | skipped: `service_disabled` / `b2b_only` (the listing route's checks, the same function) |
   | switching **on**: the service has no retail price any more | skipped: `no_price` (never "on with no price" from this feature, 3.1) |
   | otherwise | `setListed`, the audit row of the listing route (`listed on storefront` / `unlisted from storefront`, actor `system`, with `runId` and `requestedBy`), `signals.listingsChanged(tx, [serviceId])` |

   After each chunk a guarded heartbeat with the two counters. `40P01` and `40001` are tried once more; any other error of
   a row counts as skipped: `failed` (the error in the log), and 20 of them end the switch `failed`.
3. **Close** (guarded on `switch_status = 'running' AND attempt = $mine`): `switch_status = 'done'`, the counters, the
   audit row `switched publishing run` with the count of each skip reason. An unexpected error outside the rows closes
   `failed` with `switch_error` and rethrows.

Idempotent: a second run, a second delivery or a press after a stall finds the listings at the target and changes
nothing. The reasons of the skipped rows are counted in the close's audit row and not stored per row; the result table
shows each row's listing as it is now (`PublishItem.listingListed`), which is the truth staff act on. Switching off never
refuses: taking something off the shop is always allowed, as in the listing route.

## 7. Console (`FA/`; rules of `FA/CLAUDE.md`; every component under about 200 lines; A2 is the file list)

The console computes no price, floor, margin, title or slug (fact 23): every figure and every proposal on these screens is
the server's, and a refusal is shown with the server's words under its field. Two new tabs on the Storefront page
(`storefront/lib/tabs.ts`: eight tabs; `tabs.test.ts` and `StorefrontPage.test.tsx` pin the list and change with it: C1 adds
`pricing` and makes them seven, C2 adds `publish` and makes them eight):
**Publish** (`?tab=publish`, `&run=<id>`; `anyOf: ['storefront:create']`) and **Retail pricing** (`?tab=pricing`; `anyOf:
['pricing:read']`, added to `PAGE_PERMISSIONS`). Both are page-wide tab bodies: no dialog is wide enough for the preview
(A2 section 6.1).

### 7.1 API, types, hooks, mocks (storefront feature)

- `api/publish.ts`: `createPublishRun(body)`, `listPublishRuns(query: ListQuery)`, `getPublishRun(id)`,
  `listPublishItems(id, query: ListQuery)`, `updatePublishItem(id, itemId, body)`, `bulkUpdatePublishItems(id, body)`,
  `applyPublishRun(id, body)`, `cancelPublishRun(id, body)`, `setPublishRunListed(id, body)`. `api/retailPricing.ts`:
  `listRetailPriceRules(query)`, `createRetailPriceRule(body)`, `updateRetailPriceRule(id, body)`, `deleteRetailPriceRule(id)`,
  `previewRetailPriceRule(body)`, `listRetailPriceChanges(query)`, `resolveRetailPriceChanges(body)`. Each has `@route`, a
  `body` or `query` parameter and path ids in order (the extractor's rule), and "backend addition, B228/B229/B230" in its
  JSDoc. Types in `types/publish.ts` and `types/retailPricing.ts` with the `Money`, `Decimal`, `Id`, `IsoDateTime` aliases
  and unions equal to the backend lists (`RetailPriceRule`, never `PricingRule`: that name is the B2B rule's).
- Exports through `storefront/index.ts` for the two other features that start a run: `createPublishRun`, `listPublishRuns`,
  `storefrontPublishPath(runId?)`, the types.
- Hooks: `usePublishRun(runId)` polls every 1.5 s while the run is `preparing`, `queued` or `running`, or its switch is
  `queued` or `running` (the `isLive` + `refetchInterval` style of `useQuickAddRun`); when a run or a switch this page saw
  live finishes it invalidates `service-listings`, the storefront counts and the dashboard keys and shows a toast. `usePublishItems` is a server-paged list (50 a page) with
  `keepPreviousData`. `useRetailPriceRules`, `useRetailPriceChanges`, the mutations.
- Mocks (`storefront/mocks/publishRoutes.ts`, `retailPricingRoutes.ts`, a generator `mocks/publishSeed.ts` that makes 60
  services with the states and flags of section 3.2 from the mock's own service map; never an edit of `demo-state.json`):
  every route of section 5; progress advances **by read count** (the Quick add mock's style, never timers); the mock
  applies the refusals of section 5 so the tests can show them; mock prices are fixed figures in the seed (no arithmetic in
  the mock either: a price edit answers the typed price, a rule preview answers stored lines). Arabic sample text, if any,
  is built from code points (fact 25).
- `docs/MISMATCHES.md`: **M265** (bulk publish and retail pricing are backend additions beyond the map: B228-B230; the
  console shows the server's titles, slugs and prices and computes none) and a line under M10 (**M10c**: Quick add's
  `publish`, B231). `docs/ASSUMED_CONTRACTS.md` and `storefront/HANDOFF.md` get the routes.

### 7.2 The Publish tab

One `Panel flush` split by hairlines. Which part shows depends on the address and the run.

| State | What the tab shows |
|---|---|
| **Start** (no `run` in the address) | "Publish services to the shop". A `RadioGroup` **What to publish**: `Everything not on the shop yet`, `A category` (a search-driven picker: a `SearchInput` over `GET /admin/service-categories?q=`, 20 results, because menus stop at 200, fact 23), `A supplier's services` (a `SelectField` of the suppliers). A line under it: "Prices come from the retail pricing rules." with a link to the Retail pricing tab; **when no rule is active** it is a warn note instead: "No retail pricing rule is active. Services without a price cannot be published until you make a rule or type their prices." (the role has `pricing:read`: `listRetailPriceRules({ filters: { isActive: true } })` is empty; without that permission the plain line stays, since the preview says it anyway). Primary button **Prepare the preview** (`createPublishRun`, then `&run=<id>`). The server's `422` (`nothing_to_publish`, `too_many`) shows in the error slot. Under it **Earlier runs**: a `DataTable` of `listPublishRuns` (When, What, Status `Badge`, Published / Left out / Refused, By = `requestedByName`, "System" for an automatic run, a row link) with a pager; a `draft` row says **Continue** |
| **Preparing** | a spinner line "Preparing the preview of <n> services..."; Cancel |
| **Draft** | the preview (below) |
| **Queued / running** | `Meter` (label "Publish progress") and "<done> of <included> services, <published> on the shop"; the note "It keeps running after you leave this page."; a **Stop** button (`cancelPublishRun`, behind a `ConfirmDialog`; needs `storefront:publish`) |
| **Succeeded / failed / cancelled** | headline: "<published> services are on the shop" for a run applied `listed`, "**<published> services were created switched off**" for a `listed: false` run (never "on the shop"); or the server's `error` in red with "Start it again: it continues with what is left." and a **Continue** button that applies again; a run that failed before its preview was ready (`preparedAt` null) shows the error with **Prepare again**, a new run with the same `scope`, and no Continue; a cancelled draft with `replacedBy` says "This preview was checked again." with a link to the newer run. Then the count lines, **the run switch** (below), the result table (the same table, the Result column first, a column "On the shop" from `listingListed`, filter chips Published / Left out / Refused), **Review the <n> left out** (a new run with scope `run`), a link "See them in Services on sale" |

**The run switch** (result view, when `counts.published > 0`; needs `storefront:publish`, else disabled with the permission
in `title`). One ghost button, by the run's `listed`: **Take these <n> off the shop** or **Put these <n> on the shop**
(`setPublishRunListed`), behind a `ConfirmDialog` ("This switches <n> listings off. Nothing is deleted and no price
changes; you can put them back." / "This puts <n> listings on the shop at their current prices."). While `switch.status`
is `queued` or `running`: the same `Meter` line ("Switching <switched> of <n>"); `done`: "<switched> switched" and, when
`switch.skipped > 0`, a warn note "<skipped> could not be switched (a disabled service, a closed category or no price).
The column On the shop shows which."; `failed`: the server's `switch.error` and the button again. `409
JOB_ALREADY_RUNNING` re-reads the run.

**The preview (draft).**
- A `StatGrid` of neutral cells: Services (`total`), Ready, Needs a look, Cannot publish, Will be published (`included`).
- A warn note when `counts.noRule > 0`: "<n> services have no price because no pricing rule covers them. Make a rule on
  the Retail pricing tab, then press Check again." (the link; the figure is the server's).
- A toolbar: `SearchInput` ("Search title, service, code, slug"), filter chips (All, Ready, Needs a look, Cannot publish,
  Left out, and a `SelectField` "Flag"), the count, "Prices as of <preparedAt>" and the button **Check again**
  (`createPublishRun` with `{ scope: { kind: 'run', runId } }`, then the address moves to the new run; the hint in
  `title`: "Works everything out again with today's rules, costs and services. Your edits are kept."). It is how a fix
  made outside the preview (a new rule, an enabled service, an opened category, a linked supplier) reaches the rows.
- The table (caption "Publish preview", server-paged 50, `selection` with `useRowSelection` kept across pages; the header
  tick box ticks the page, and a line "All <n> rows that match are selected" switches the bulk actions to the server-side
  filter form of `bulk`):

  | Column | Shows |
  |---|---|
  | Service | the clean title; under it, muted and with `dir="auto"`, the supplier's raw name; mono `code` and `/slug` |
  | Brand / Carrier / Country | the three facts; a detected tool or app brand carries a small neutral tag (`Tool`, `App`) |
  | Cost | `cost` |
  | Shop price | `retailPrice` or "–"; under it "Floor $x"; a tag `Rule`, `Typed` or `Kept`; for a row with `replacesPrice`, "replaces $x" |
  | Margin | `marginPct`, amber under 15 (the listings table's rule) |
  | Status | a `Badge` with icon and words: good "Ready"; warn "Needs a look: <flag words>"; crit "Cannot publish: <reason words>"; neutral soft-flag marks with a tooltip |
  | Include | a `Switch`; disabled with the reason in `title` for a blocked row |
  | | **Edit** |

- **Edit** opens `PublishItemDialog` (`FormDialog`, 760 px): the raw name (read only), Title (200), Slug (120, hint "Leave
  empty and the server makes it from the title."), Brand, Carrier, Country, and **Shop price**: a `RadioGroup` "Use the
  pricing rule ($x)" (when the service has a typed price, its hint says "Replaces the current price of $y.") / "Type a
  price" (a mono input; hint "Floor $x") / "Keep the current price ($x)" (only when the service has one). The group is
  disabled, with the permission in `title`, for a role without `storefront:update` (the server answers `403` otherwise).
  A ghost button **Reset to what was detected**; footer Cancel, **Save**, **Save and next**. Field refusals land under
  their fields (`dialogSubmit`).
- **Save and next** asks the server for the next row, never the page in memory: `listPublishItems` with the current
  filters and search, `afterId` = the saved row's id, sorted by id, one row. So it still finds the next row when the saved
  row has left the filter (a "Needs a look" row that became Ready) or the page has ended; with no row it closes the
  dialog and says "That was the last one." The "Needs a look" rows are walked in one sitting, in id order whatever the
  table's sort.
- **Bulk actions** (the `SelectionBar` look, when rows are ticked): Include, Leave out, Set brand..., Set carrier..., Set
  country... (a small `FormDialog` with one field), Clear. After a bulk action the page is read again (the server
  recomputed the flags).
- A sticky action bar (`border-t bg-surface px-4 py-3`): "Discard this preview" (ghost, `cancelPublishRun` behind a confirm;
  `storefront:create` is enough for a draft) and the primary **Publish <included> services**. It opens
  `PublishConfirmDialog`: "This puts <n> services on the shop at the prices shown." / the lines "<m> stay out: they need a
  look or cannot be published.", "Prices are worked out again when each service is published: a price follows its rule
  if the cost changed a little since this preview, and a service whose cost changed a lot is left out for you to check."
  and "You can take them off the shop again with one button."; a `RadioGroup` **On the shop**: "At once" (default) /
  "Create them switched off"; above 500 services the tick box "I checked the preview. Publish <n> services." (the Quick add
  rule, `CONFIRM_ABOVE`). Needs `storefront:publish` (else the button is disabled with the permission in `title`). `409
  JOB_ALREADY_RUNNING` re-reads the run.
- **The words of the lists** (`lib/publishWords.ts`, one map per closed list, checked by a test against the unions): the
  blocking reasons (with `category_inactive` "its category is switched off", `below_floor` "the typed price is under the
  floor", `slug_taken` "the address is taken"), the result reasons (with `cost_moved` "the cost changed a lot since the
  preview") and the flags (with `title_taken` "another listing has this title").

**Entry points** (all end on the tab with a run):
- Storefront, "Services on sale": **Publish services...** beside "Add listing..." in the panel's right slot (primary when
  the shop has no listing; then "Add listing..." is the default button), and as the `cta` of `ListingsEmpty`. The panel's
  sub loses "Only IMEI services are sold to the public."; `ListingsEmpty` says "Add services under Services & pricing or
  Suppliers, then publish them here."
- Services, Services tab: the `SelectionBar` gains **Publish to the shop...** next to "Change their prices..." (the ticked
  services: `{ kind: 'services' }`; needs `storefront:create`).
- Suppliers, the supplier's Services panel: **Publish to the shop...** (scope `supplier`), and Quick add (7.4).

### 7.3 The Retail pricing tab

- **Rules** (a `Panel flush` block, the look of `RulesSection`/`RulesTable`): a `DataTable` "Retail pricing rules":
  Applies to ("Every service", a `TypeTag`, or the category name), Price (`label`), Follows cost changes up to
  (`autoFollowPercent` %), Prices following (`following`), Status (`Badge` On / Off), and the row buttons Edit, Turn off /
  Turn on, Delete (locks by `pricing:update` / `pricing:delete`). Header button **New rule** (primary). Empty state: "No
  retail pricing rule yet. A rule prices the shop from each service's cost." with the same button; the form is then
  prefilled with the owner's example (IMEI, 30, ends in .99).
- **`RetailRuleDialog`** (`FormDialog`, 760 px, the two-step shape of `BulkPriceDialog`): step 1 the form: Applies to
  (`Every service` / `A service type` / `A category`, fixed when editing), the type `SelectField` or the category search
  picker, Margin (%), Plus a fixed amount (USD), Rounding (`Whole cents`, `Up to the next 5 cents`, `Up to the next 10
  cents`, `Ends in .99`), Round prices from (USD; hint "Cheaper prices stay in whole cents, so a $0.20 check is not sold at
  $0.99."), Follow cost changes up to (%; hint "A bigger change waits for your approval. 0 means every change waits.").
  Confirm **Preview**. Step 2: the server's preview: "<changes> of <following> prices change: <raised> up, <lowered> down",
  a warn note when `atFloor > 0` ("<n> prices are held at their floor: the margin is under what the floor allows."), a
  note when `truncated`, the `lines` table (Service, Cost, Now, After, Floor), a ghost "Change the settings", confirm
  **Save the rule**. Deleting and turning off use the same preview inside a `ConfirmDialog`-sized dialog ("<n> services
  will be priced by <the next rule> / keep their current price").
- **Price changes** (a second block): a segmented filter Waiting / All; a `DataTable` "Price changes" with `selection`:
  Service (name, code), What happened (`Badge`: accent "Waiting for approval", good "Followed the cost", neutral "Rule
  changed", "Floor changed", warn "Stopped following"), Cost (old to new), Shop price (old to new, "–" when none), Rule,
  When. For waiting rows the bulk buttons **Apply the new price** and **Keep the current price** (`resolve`; needs
  `pricing:update`; the answer's `skipped` rows are listed in a note). The tab's label carries the waiting count as a
  neutral chip.
- **Listings table and price dialog**: under the storefront price a small tag `Rule` when `retailPriceSource` is `rule`
  (title: `retailPriceRule.label`) and an amber "Waiting" when `retailPriceWaiting`. `PriceDialog` gains a `RadioGroup`:
  "Follow the pricing rule" (sends `retailPricing: 'rule'`; the server's `422` shows under it) / "Type a price" (today's
  field).

### 7.4 Quick add

- Step 1 (`QuickAddGroups.tsx`, under "Add them as"): a `CheckboxField` **Also put them on the shop** with the hint "Each
  gets a clean title and a price from the retail pricing rules. The ones that need a look wait in Storefront, Publish."
  Disabled, with the reason in `title`, when "Switched off" is chosen or the role lacks `storefront:publish`.
  `quickAddBody` adds `publish: { listed: true }`.
- Step 2: the price bullet becomes "Price for merchants: the supplier's cost plus the default minimum profit." and, when
  ticked, a bullet "They are also published to the shop at the retail pricing rules' prices." The server's `422 no_rule`
  shows in the error slot with a link to the Retail pricing tab.
- Step 3, after the run ended with `publish` other than `none`: a line "Publishing to the shop:" and the state of
  `listPublishRuns({ filters: { quickAddRunId } })` (read every 5 s while it is live): "preparing", "<published> on the
  shop, <left out> need a look" with a link to the run (its page holds "Review the rest" and the button that takes the
  run off the shop again); no run 2 minutes after the end, or a run that failed before its
  preview was ready: "The shop preview was not prepared." with the button **Prepare the shop preview**
  (`createPublishRun` with the scope `{ kind: 'quickAddRun', runId }`, then the link to the new run; it needs
  `storefront:create`).

### 7.5 Tests (console)

`storefront/lib/tabs.test.ts`, `StorefrontPage.test.tsx` (eight tabs, the pricing count); new `pages/PublishTab.test.tsx`
(start: each scope's body, the `422`s; preparing; the preview's cells, tags and badges for each state and flag; search,
chips and paging send the right query; a row edit sends only the changed keys and shows a field refusal; Save and next;
bulk by ticked rows and by "all that match"; the confirm dialog's body and the tick box above 500; the missing permission;
progress, result, a failed run and Continue; Review the left out; the history table with the name; **Check again** and
the two no-rule notes; the run switch in both directions, its progress, its skipped note and its permission; the headline
of a run created switched off; the price group locked without `storefront:update`; Save and next reading the next row from
the server when the saved row left the filter; the word maps against the unions), `pages/RetailPricingTab.test.tsx`
(rules table, each dialog step, the preview's notes, delete and turn off, the changes table, resolve with skipped rows,
permissions), `api/publish.test.ts` and `api/retailPricing.test.ts` (method, path, body of all 16 functions),
`ListingsTab.test.tsx` and `PriceDialog` cases (the tags, `retailPricing: 'rule'`), `services/pages` (the `SelectionBar`
entry), `suppliers/pages/SupplierQuickAdd.test.tsx` and `lib/quickAdd.test.ts` (the tick box, its locks, the body, the
review bullets, the publish line of step 3).

## 8. Tests and acceptance

### 8.1 Money (unit; `catalog/domain/retail-rule.spec.ts`, `storefront/publish/domain/publish-item.spec.ts`)

- `evaluateRetailRule`: every worked number of section 3.3 as a case; each rounding style at, just under and just over a
  step; `roundFrom` at the boundary; `fixed` alone; the limits; cost 0.
- **Properties over the real costs**: for each of the 1157 costs of the fixture (8.2) with its default floor
  (`storefrontFloor(suggestedPrice(cost), cost + defaultMinProfit(cost))`), each rounding style and the percents 0, 10, 30,
  100: the price is at or above the floor, at or above `raw`, a whole number of cents, and never lower for a higher cost.
- `pickRetailRule`: category over type over global; an inactive rule is skipped; a deleted rule is skipped; none.
- `costMoved`: exactly the limit is not a move and one unit more is; a fall as a rise; `from` 0; a limit of 0.
- The price table of 6.2 (`decidePrice`): **every row of the table**, each with the floor moved between preview and
  apply, and for the rows priced by the rule: the cost unchanged, moved inside the limit (the rule price of the new cost),
  moved 10 times (`cost_moved`, nothing to write), fallen by more than the limit (`cost_moved`), a limit of 0, no rule,
  cost 0. The typed-price rows one by one: `rule` without `replaces_price` and a typed price now (no write, the detail);
  `replaces_price` equal to the stored price (the rule price); `replaces_price` set and another price stored now (no
  write); a following price now (no write); `keep` with the price gone (by the rule, with the limit).
- `normalisePriceMode`: every line of 5.2 (the default at prepare; `rule` to `keep` when a price appeared; `replaces_price`
  dropped when the stored price is not it; `keep` to `rule` when the price is gone; `manual` kept).
- `evaluateItem`: every blocking reason in its order (with `category_inactive`, `below_floor`, `slug_taken`), every hard and
  soft flag, the tick rule of 3.2. `reflag`: each derived flag set and cleared by its field.
- `RetailPrices.set`: throws `RetailFloorError` one cent under the floor for both origins; `manual` deletes the follow row;
  `rule` upserts it.

### 8.2 Detection (unit and the measured acceptance)

- Fixture `test/fixtures/publish/supplier-names.json`: the 1157 lines of `.bulk-publish/supplier-services.txt` as `{ n, type,
  group, cost, name }`, parsed with the rule of A3 section 1 (the cost is the first purely numeric field after the type: a
  plain split on `|` breaks about 85 lines), written with **every non-ASCII character as a `\u` escape** (fact 25). If the
  guard still trips on a supplier's text (rule R2), the file gets an `allow` entry with the reason "supplier names are data".
- Specs beside each rule file: one case per rule R1-R14 from A3 section 3 (the before and after pairs printed there), every
  trap of A3 sections 4 and 5.3, the meaning words that must stay (the `CHINA NOT SUPPORTED` name #1099 among them),
  idempotence (cleaning a clean title changes nothing); a `remote` and a `file` row are named as `server`; `nextFreeSlug`
  (the suffixes, the shortened base at 120); the cut guard against `listingTitles` (#476 alone, with the titles of
  #473-#475 given as listings, keeps its full title; alone with no listing it is cut); `title_taken`.
- **`test/publish/naming-golden.test.ts`, the acceptance on the real names** (`nameAll` with no listing title, then
  `assignSlugs` with nothing taken, over the fixture; no database):

  | Measure | Required | Prototype |
  |---|---|---|
  | a brand found | at least 1048 | 1054 (91.1 %); 1055 read from the uncut title (3.5) |
  | a carrier found | at least 187 | 188 |
  | a country found | at least 275 | 277 |
  | a title that is not empty and at most 80 characters | at least 1076 | 1082 (93.5 %) |
  | distinct slug bases before any suffix (the empty one counted once) | at least 1149 | 1149 |
  | after `assignSlugs`: every non-empty slug unique, a valid slug, at most 120 characters | all 1156 | 1156 |
  | titles holding emoji, Arabic script, a pipe, an entity, a double space or unpaired brackets | 0 | 0 |
  | names that end `blocked` or `review` by the name alone (`title_missing`, `title_too_long`, `title_long`, `duplicate_name`, `title_taken`, `quantity_text`, `multi_country`) | at most 60 | 53 by this list (measured on the prototype: both rows of each of the 8 pairs wait; no `title_taken`). The study's 59 used its own list (the 6 zero-cost names and unbalanced brackets in, the first row of a pair out) |
  | cleaning every clean title again | no change | 2 exceptions (closed by the second R7 pass) |
  | **naming each supplier group alone** (254 calls of `nameAll`): brand, carrier and country of every row against the whole-file run | identical for all 1157 | the prototype differs in 6 brands (`learnTools`); frozen tools and the uncut title close it |

  and a snapshot `test/fixtures/publish/expected-names.json` (`n`, title, slug, brand, carrier, country, flags for all
  1157) that the test compares exactly: a later rule change shows as a diff a person reads. The slice report lists every
  figure against the prototype and names each row that differs from `prototype.ts --rows` (three brands are expected to:
  #60, #80, #1028).

### 8.3 Integration (real Postgres and Redis, `TestClock`; jobs are run by calling the runner and once through the processor)

**`test/integration/retail-price-rules.test.ts`** (B1): the four CRUD routes, each `422`, the permissions, the audit rows,
the version bump; the preview for create, update and delete (figures and lines, nothing stored); **delete is soft** (the row
stays with `deleted_at`, the list does not show it, `PATCH` and a second `DELETE` are `404`, a new rule for the same target
is accepted, a follow row that points at it keeps its `rule_id`); a category delete removes its rule and names it in the
audit row; `PATCH /admin/service-listings/:id` with `retailPricing: 'rule'` (the price, the follow row, `no_rule`,
`no_cost`, with `retailPrice` together); a typed price deletes the follow row; the group price page: a changed or removed
retail row deletes it, an unchanged one keeps it; the three new keys of a listing row; every existing assertion of
`storefront-listings.test.ts`, `storefront-retail-floor.test.ts` and `catalog-group-prices` passes unchanged.

**`test/integration/listing-publisher.test.ts`** (B3a; the publisher alone: the test opens a transaction, calls `lock` and
`publishLocked` with an input built by `test/support/publish.ts`, and reads the outcome; no run row is needed):
- one service: a listing with the input's title, slug, facts, the rule price, on the shop; `GET /store/v1/services` shows
  it; one `storefront.listing_changed` event; one `published to the storefront` audit row; the follow row.
- `listed: false`: priced, off, not on the shop.
- **the price table of 6.2 against the database**, row by row; a typed price that fell under the floor (`refused:
  below_floor`, no listing).
- **the publish limit**: a sync raises the cost 10 times between the preview's cost and the publish: `refused: cost_moved`
  with both costs in the detail, **no listing and no price row**; a rise of 10 % (limit 25): published at the rule price of
  the new cost, never under the new floor; a fall of 50 %: `cost_moved`.
- **a typed price is never overwritten unasked**: the input of a row prepared with no price (`rule`, no `replaces_price`)
  and a retail price of 20.00 written through `PUT /admin/services/:id/group-prices` first: the listing is published, the
  price is still 20.00, there is no follow row, the detail says a typed price was kept. With `replaces_price` = 20.00: the
  rule price and a follow row. With `replaces_price` = 20.00 and the price changed to 21.00 since: 21.00 stands.
- every refusal of 3.2 (service archived, disabled, a switched-off category, a B2B-only category, file type, supplier
  paused, supplier service no longer listed, no rule, cost 0, empty title), each leaving **no** listing and **no** price
  row.
- slugs: a proposed slug taken meanwhile gets `-2`; a typed slug taken is `refused: slug_taken`; two publishes racing for
  one slug end with two different slugs.
- **Concurrency**: in parallel with `POST /admin/service-listings` for the same service (one listing; the outcome is
  `skipped: already_listed` or the staff call is `409`); in parallel with `PATCH` of the service to `disabled`; in parallel
  with a supplier sync that raises the costs inside the limit (no deadlock; every published price is at or above the floor
  of the cost it committed against).
- `storefront-listings.test.ts` passes unchanged (the three steps moved to `listing-writes.ts`).

**`test/integration/publish-run.test.ts`** (B3b; **the runner and the switch only**: rows are seeded straight into the two
tables by `test/support/publish.ts`, and no route of B4 is called. The helpers do what the routes' transactions do:
`queueRun(runId)` is the guarded move of 5.2 with the reset of the rows `refused: failed`; `cancelRun(runId)` sets
`cancelled` with the counters; both can be called from the runner's `afterChunk` hook):
- 250 rows publish in 5 chunks; the close writes the counters, one audit row and one version bump; rows not included end
  `skipped` with `left_out` or their blocking reason.
- **Idempotency**: `run` twice does nothing the second time; two `run` calls in parallel publish each service once (one
  claim wins); the job delivered through the processor twice.
- **Resume after a death**: a run seeded `running` with N rows done and a heartbeat 6 minutes old; `queueRun`, then `run`:
  it continues and ends with exactly one listing and one retail row per service; a row seeded `refused: failed` is tried
  again.
- **Two workers on one run**: worker A's `afterChunk` hook, after its first chunk, calls `queueRun` and runs worker B to
  the end, then returns; A's next row reads another `attempt` and A stops without a write. One listing per service, no
  `published` result overwritten, `listing_id` and `published_price` of A's rows intact, the counters of the close equal
  the rows, one close audit row. The same with A stopped inside a row (a held service row lock): the resume waits for it.
- **Cancel**: the hook calls `cancelRun` between two chunks: the worker stops before the next row, the rows done keep
  their result, the rest have none, the status is `cancelled`.
- 20 unexpected failures (a row made to violate a constraint) end the run `failed` with the rest untouched.
- **The switch** (`PublishSwitch`): off, then on: every listing of the run follows, with one audit row and one search
  event each; **twice** changes nothing the second time; a listing staff switched by hand meanwhile is `unchanged`; a
  service disabled meanwhile is skipped on switch-on and stays off, and the close's audit row counts it; a listing whose
  price was removed is skipped on switch-on; prices and follow rows are untouched; a second switch claimed while the
  first is alive stops the first (`attempt`).

**`test/integration/publish-routes.test.ts`** (B4a the first paragraph, B4b the second):
`POST` for each scope (the rows are the unlisted live services; `nothing_to_publish`; `too_many` with the limit lowered
through a test seam; `invalid` for an unknown category, supplier, Quick add run and publish run); the outbox event; prepare
(detection, evaluation, the default ticks, the slugs free against listings and inside the run, `keep` for a service with a
price, `category_inactive`); **a preview changes nothing** (row counts of `services`, `service_listings`,
`service_group_prices`, `outbox_events` of type `storefront.listing_changed` and `audit_logs` before and after `POST`,
`PATCH` and `bulk`; "Check again" adds exactly one audit row, the cancel of the old draft, and nothing else); the list
filters (with `afterId`), sorts and search with `x-total-count`; `requestedByName`;
**Check again** (scope `run` from a draft: the old draft is `cancelled` with its audit row and reads `replacedBy`; a row blocked
`price_missing` becomes `ready` and ticked after a rule is made; an edited title, a typed price, a typed address and a tick
staff changed are kept; `replaces_price` is not; a typed price now under the floor reads `blocked: below_floor`; a typed
address a listing took reads `blocked: slug_taken`; a service listed meanwhile is not copied); scope `run` from a finished
run (the rows without `published`) and from a live one (`409`); the stalled reads with their messages.

Every `PATCH` key and every `422`/`409`/`403` of 5.2 (a price key without `storefront:update`); the price keys:
`pricing: 'rule'` on a service with a typed price stores `replaces_price`, on one without stores none; **the scenario of
6.2 through the routes** (a row prepared with no price; a price typed on the group price page; a `PATCH` of the brand: the
row reads `keep` with `price_kept`; apply: the price is unchanged and there is no follow row); a `PATCH` whose
re-evaluation blocks the row (the service was disabled since) answers `200` with `included: false`, never `500`; one that
unblocks it ticks it; `bulk` by ids and by filter, with the flags recomputed (`no_brand` gone after a brand is set,
`multi_country` gone after a country is set) and no price touched; an edit racing an apply (one of the two orders of
6.5, never a row published with half an edit); apply, cancel and the run switch in every status of their tables (a run
that failed or stalled while preparing is `409` and publishes nothing; **the resume through the routes**: the clock moves
6 minutes, `GET` reads `failed`, apply answers `202`, and again `409` while it runs; cancel during a run; the switch
route on a stalled run closes it first); the permissions (`storefront:create` cannot apply, can cancel a draft, cannot
stop a running run).

**`test/integration/retail-price-follow.test.ts`** (B5): a cost rise inside the limit (the price follows, a `followed`
row, an audit row, `applied_cost`); **a sync that lowers the supplier's price** (the effective cost falls to
`services.cost` at the lowest, and the following price falls with it inside the limit); a jump over the limit, up and
down (a proposal, the price unchanged, **the shop charges the floor**: `GET /store/v1/services/:slug` is at or above the
new floor); apply; **apply after the cost moved again** (`skipped: 'changed'`, the proposal shows the new figures, nothing
written; a second apply writes); a pass over an unchanged open proposal rewrites nothing and keeps `notified_at` (the next
hourly message does not count it again); keep (later passes leave the price alone); cost 0; a typed price is never touched
whatever the cost does; a rule edit moves every follower at once whatever the size; a rule switched off or deleted falls
back by precedence, and with no rule the prices stay; **a rule deleted while a pass prices by it** (no error, no deadlock;
the next pass re-prices); a base price edit that moves the floor; the reason of each `followed` row (`cost_changed`,
`rule_changed`, `floor_changed`); a cost move of exactly the limit follows and one unit more waits; an archived service
loses its follow row; the retail row changed by SQL is `detached`; **the pass twice** (the second writes nothing and does
not bump); two passes in parallel (one change row per service); a pass against a parallel typed `PATCH` (the typed price
stands and no follow row is left); a publish run in parallel with a sync, then the pass (every price equals the rule price
of the new cost); **a rule `PATCH` through the API app enqueues `retail-follow-<minute>`** (the scheduler lives where the
API loads it); an open checkout session keeps its amounts through a reprice and pays them; the message: one notification
per hour with the counts, none when nothing changed, the no-recipient path; `job_runs` for the scheduled run; the list and
the resolve route with each `skipped` reason.

**`test/integration/quick-add-publish.test.ts`** (B6): the body's `422`s and the `403`; `import_run_id` on the links; the
event at the close (succeeded, failed with some created, a stalled run closed by a new start; none when nothing was
created or `publish` was not asked); the consumer twice makes one run (the conflict target with its predicate); end to
end: Quick add of 30 services with a rule in force, the hand-over, prepare, the automatic apply: the ready ones are on the
shop at the rule prices and the flagged ones are `skipped: left_out`; the run switch takes them off again.
`supplier-quick-add.test.ts` passes unchanged. Category names: a group with `&amp;`, an emoji and a direction mark becomes
one clean category, found again by the next import; **a group whose category an earlier import made under the raw text
keeps going there** (no second category, the services are not split); the picker's import finds the same category.

**`test/scenarios/bulk-publish.e2e.test.ts`** (B6): the owner's story in one test: a supplier with real names from the
fixture, a general rule, Quick add with publish, the shop list and the search rule (`SearchableIds`) hold the published
services, a sync raises a cost, the price follows, the "Price changes" list and the audit log show it.

Contract suite: route, access and permission parity with the 16 rows; OpenAPI examples validate (each contract has a request
and a response example); the console's functions and fixtures after the paired step (section 10). Schema: `structure.test.ts`
(`ADDITIONS`, the two storefront tables in the module's own schema file, an index behind every foreign key),
`db-schema.test.ts`. `bun run lint` (`gsm/module-boundaries`: no schema file outside `<module>/db/schema.ts`).
`test/unit/module-load.test.ts` (no new cycle). `docs/queues.md` and the queue definition spec.

### 8.4 Done

Backend: `bun run check` green on the branch (against the console's `main`) and again in the paired step. Console: `npm run
typecheck && npm run lint && VITE_API_MOCKS=false npm run build && npm test`. The lead's walk (L5).

## 9. Slices (12: 5 Opus, 7 Sonnet; one agent session each)

**Worktrees** (the lead creates them after feature 30 is merged and makes them runnable): `../backend-31` (`feat/backend-31`;
`bun install`; `.env.test` with its own `gsm_31_test` database and a free Redis DB number) and `../frontend-admin-31`
(`feat/console-31`; `npm ci`, which the backend's `contract:extract` and `contract:harvest` need too). Every implementer reads
sections 1-3 and its own sections, opens the audit sections named, and reports files by folder, the migration name, the test
counts and anything the code forced to differ from this brief. Slices of one repository run one after the other, with one
exception: **B2 creates only new files in its own folders and may overlap B1** (it runs only the path-limited commands of its
row, never `bun run format` or `bun run check`, which would read B1's half-written files).

**Backend acceptance** (B1, B3a-B6): `bun run format`, then `bun run check` green (heavy runs through `bash
scripts/with-slot.sh ...`). **A slice's tests call only what that slice or an earlier one built** (B3a tests the publisher,
B3b the runner through helpers, B4a and B4b the routes): no acceptance waits for a later slice. The new routes and the new
keys of old routes do not break the parity with the console's `main` (a key the console does not declare is only reported).
A new file is not read by `english:check` until it is tracked (fact 25): every implementer also greps its new files for
Arabic script and for a quoted lower-case `ar`, and the lead runs the guard after staging.

| Slice | Who | Scope and files | Tests, migration |
|---|---|---|---|
| **B1** retail price rules, the one price writer | **Opus** (money) | Catalog: `db/schema.ts` (the two tables of 4.1 with `deleted_at` and `retail_price_rules_category_idx`, the enums), `domain/retail-rule.ts` (+ spec: `evaluateRetailRule`, `pickRetailRule`, `ruleLabel`, the rounding, `costMoved`), `application/retail-pricing.ts` (`RetailPricing`: `targets(db, ids, at?)`, `anyActiveRule(db)`), `application/retail-prices.ts` (`set` with `{ origin, quote }`, `RetailFloorError`, `sources(db, ids)`), `infra/retail-price-rule.repository.ts` (every read filters `deleted_at IS NULL`), `application/retail-price-rule-admin.service.ts` (CRUD with the soft delete, preview), `contracts/retail-price-rules.contracts.ts`, `controllers/retail-price-rules.controller.ts`, `application/group-price-admin.service.ts` (the follow row after a replace), `application/category-admin.service.ts` (`removedRetailRuleId` in the delete's audit row), `index.ts`, the modules, `README.md`. Storefront: `application/listing-admin.service.ts` and `contracts/listings.contracts.ts` (`retailPricing`, the three keys; `retailPriceWaiting` is `false` until B5), `README.md`. `platform/audit/audit-entity-types.ts` (`retail_price_rule`), `scripts/module-map.mjs`, `scripts/map-additions/31.mjs` (the five rule rows), `test/schema/structure.test.ts` if needed, the generated documents | `0040`; `retail-rule.spec.ts`, `retail-price-rules.test.ts` (8.1, 8.3); the listing, floor and group price suites unchanged |
| **B2** detection | **Opus** (intricate rules; may overlap B1) | Create only: `src/modules/storefront/publish/domain/naming/{title-rules,name-batch,facts,brand,carrier-country,slug-for,index}.ts` (`detectFacts`, `nameAll`, `assignSlugs`, `nextFreeSlug`, `slugFor`), `naming/lexicon/{brands,tools,carriers,countries,typos}.ts` (`tools.ts` frozen from the prototype's learned set), their specs, `test/fixtures/publish/supplier-names.json` and `expected-names.json`, `test/publish/naming-golden.test.ts`. Port `prototype.ts` rule by rule (A3 sections 3-6) with the three differences of 3.5 (nothing learned at run time, facts from the uncut title, the cut guard and `title_taken` against the listings' titles); no file of another slice is edited | no migration; `bunx prettier --write` and `bunx eslint` on its paths, `bun test src/modules/storefront/publish/domain test/publish`; the table of 8.2 in the report. The whole `typecheck` is run by the lead (or by B2 once B1 reported) |
| **B3a** the publisher: one service, one transaction | **Opus** (money at apply) | Storefront: `db/schema.ts` (4.2: the two tables, their CHECK lists and indexes, after the search tables; `src/infra/db/schema.ts` is not touched), `publish/domain/publish-item.ts` (+ spec: `evaluateItem`, `decidePrice`, `normalisePriceMode`, `reflag`, `PUBLISH_FLAGS`, `PUBLISH_RESULT_REASONS`, the constants, `isStalled`, `runView`, `failureReason`), `application/listing-writes.ts` (the three steps moved out of `ListingAdminService`, which now calls them), `application/listing-publisher.ts` (`lock`, `publishLocked`), `infra/foreign-reads.repository.ts` (the facts with the category's `is_active`, for one service and for a page); catalog: `application/publish-sources.ts` (`supplyStates`; exported); `scripts/module-map.mjs` (`additionalTables`), the generated documents, `test/support/publish.ts` (the input builder) | `0041`; `publish-item.spec.ts`, `listing-publisher.test.ts` (8.1, 8.3); `storefront-listings.test.ts` unchanged |
| **B3b** the run: the worker, the claim counter, the switch | **Opus** (concurrency) | Storefront: `publish/infra/publish.repository.ts` (the claims and every guarded statement of 6.2 and 6.7), `publish/application/publish-runner.ts`, `publish/application/publish-switch.ts`, `publish/jobs/{publish-outbox-routes,publish.processors}.ts` (apply and switch), `publish/publish-engine.module.ts` (API and worker) and `publish-worker.module.ts`, `src/worker.module.ts`, `src/app.module.ts`; `platform/audit/audit-entity-types.ts` (`publish_run`), `docs/queues.md` (apply, switch), `test/support/publish.ts` (`seedRun`, `queueRun`, `cancelRun`) | `publish-run.test.ts` (8.3) |
| **B4a** the draft: prepare and read | Sonnet | Storefront: `publish/application/publish-preparer.ts` (the scopes, the copy of scope `run`, detection, evaluation), `publish/application/publish-run-admin.service.ts` (create with "Check again", list, show, items), `publish/contracts/publish-runs.contracts.ts` (the four contracts of create, list, show and items, and the shared types), `publish/controllers/publish-runs.controller.ts`, `publish/publish-http.module.ts`, `storefront.module.ts`, the prepare processor and its outbox route; catalog `application/publish-sources.ts` (the scope reads and the three existence reads); `scripts/map-additions/31.mjs` (those four rows), `docs/queues.md` (prepare), `publish/README.md`, the generated documents | `publish-routes.test.ts`, first paragraph (8.3) |
| **B4b** the draft: edit, apply, cancel, switch | Sonnet (reviewed by Opus with B3b and B4a) | Storefront: `publish/application/publish-item-edit.service.ts` (the item `PATCH` and `bulk`, with the locks of 5.2 and the pure functions of B3a), `publish-run-admin.service.ts` (apply with the resume, cancel, the `listed` route), the five contracts and handlers of the item `PATCH`, `bulk`, apply, cancel and `listed` with the controller's second permission checks, `scripts/map-additions/31.mjs` (those five rows), `storefront/README.md`, the generated documents | `publish-routes.test.ts`, second paragraph (8.3) |
| **B5** the follow pass, proposals, the notice | **Opus** (money) | Catalog: `db/schema.ts` (`retail_price_changes`), `application/retail-follow-scheduler.ts` (the listener; provided by `catalog-prices.module.ts`), `application/retail-price-follow.ts`, `application/retail-price-changes.service.ts` (list, resolve), `infra/retail-price-change.repository.ts`, `contracts/retail-price-changes.contracts.ts`, the controller, `jobs/retail-price-follow.{module,processor}.ts` (worker only: the processor and the scheduler `retail_price_follow_hourly`), `application/retail-prices.ts` (`sources` gains `waiting`), `index.ts`, `README.md`; storefront `listing-admin.service.ts` (`retailPriceWaiting`); platform: `notifications/notification-events.ts` (the staff event `retail.prices_followed`), `default-templates.ts` and its spec; `src/worker.module.ts`; `scripts/map-additions/31.mjs` (two rows); `docs/queues.md`; `docs/OPERATIONS.md` (the message needs `ALERTS_EMAIL_TO`) | `0042`, `0043`; `retail-price-follow.test.ts` (8.3) |
| **B6** Quick add, category names, the story | Sonnet | Suppliers: `db/schema.ts` (4.3), `contracts/quick-add.contracts.ts`, `controllers/quick-add.controller.ts` (the `grants` check), `application/quick-add.service.ts`, `quick-add-runner.ts`, `quick-add-outbox.ts` (`done`), `imported-service.ts`, `infra/supplier-catalogue.repository.ts` (`insertFirstLink`), `domain/quick-add.ts`, `README.md`; storefront: `publish/jobs/` (the `publish_from_quick_add` processor and its route, the conflict target with its predicate); `src/common/text.ts` (`decodeEntities` and the invisible and emoji patterns move here; `search/domain/normalise.ts` re-exports them, so nothing else changes) and catalog `domain/category-name.ts` (`cleanGroupName`, + spec), `application/service-importer.ts` (`categoryFor`: the raw text, then the cleaned name, then create), `catalog/README.md`; `test/schema/structure.test.ts`; `docs/queues.md`; `STOREFRONT` note text for the lead (section 10) | `0044`; `quick-add-publish.test.ts`, `bulk-publish.e2e.test.ts` (8.3); `supplier-quick-add.test.ts` and `suppliers-admin.test.ts` unchanged |
| **C1** console: Retail pricing | Sonnet | 7.1 (the pricing half), 7.3: `storefront/{api,types,hooks,mocks,components/pricing/*}`, **the `pricing` tab** in `lib/tabs.ts` with `tabs.test.ts` and `StorefrontPage.test.tsx` (seven tabs) and `PAGE_PERMISSIONS`, `lib/paths.ts`, the listings table tag and `PriceDialog`, their tests | the four console commands |
| **C2** console: Publish, the frame | Sonnet | 7.1 (the publish half, the mocks and their generator), 7.2 without the preview: **the `publish` tab** in `lib/tabs.ts` with the same two tests (eight tabs), start with the no-rule note, the category picker, preparing, progress, result with the run switch and the "On the shop" column, history, the three entry points, the copy changes of "Services on sale", `lib/publishWords.ts` | the same |
| **C3** console: Publish, the preview | Sonnet | 7.2 "The preview": the stat grid, the no-rule note, toolbar with **Check again**, table, `PublishItemDialog` with the permission lock and the server-side **Save and next**, bulk actions and the server-side "all that match", the confirm dialog | the same |
| **C4** console: Quick add, the records | Sonnet | 7.4; the Services `SelectionBar` entry if C2 left it; `docs/MISMATCHES.md` (M265, M10c), `docs/ASSUMED_CONTRACTS.md`, `storefront/HANDOFF.md`, `PROGRESS.md` | the same |

**Reviews (Opus, at most two rounds each).**
1. After **B1**: the money review, line by line (`retail-rule.ts`, `RetailPrices.set`, every caller, the group price change,
   the preview's arithmetic against section 3.3, the soft delete in every read).
2. After **B2**: the snapshot (every row with a hard flag, the eight duplicate pairs, the six Arabic names, the traps, the
   three brands that differ from the prototype, and one row in ten of the rest) and the figures of 8.2, the per-group row
   among them.
3. After **B3a**: the money review of the publisher, line by line: `decidePrice` against the table of 6.2 (the typed price,
   `replaces_price`, the publish limit), `normalisePriceMode`, the order of `publishLocked`'s steps, "every refusal before
   the first write". B3b starts on a reviewed publisher.
4. After **B4b**, with B3b and B4a: the claim counter and every guarded statement against 6.2, 6.5 and 6.7 (two workers,
   resume, cancel, the switch), the locks of the draft edits, "Check again", the second permissions, "a preview changes
   nothing".
5. After **B5**: the money review, line by line (the table of 3.4, the proposal life cycle and the approve-what-was-seen
   rule, the self-ending bump, the scheduler's module, the message).
6. After **B6**: the whole branch.
7. Console: after **C3** (the Publish tab against section 5 and the M92 rule) and after **C4** (the whole branch).

A reviewer also checks every decision an implementer reported as forced.

The slice count is above the default of `CLAUDE.md` (6 calls a feature); it follows the owner's rule for this job (Fable
plans, Opus writes the hard parts and reviews, at most 4 agents at once), as features 29 and 30 did. The first plan had
one slice for the run core and one for the draft; the review found each larger than a session, so each is two.

## 10. Order, and the lead's steps

**L0 Before the worktrees (lead, on `main`, after feature 30's L8).**
1. Confirm feature 30 is merged in the three repositories and `bun run check` is green; re-read on the merged tree the
   symbols this brief names (`ListingAdminService.create`/`update`, `listingConflict`, `slugTaken`, `lockServiceListings`,
   `findServiceFacts`, `lockOf`, `ServiceImporter.categoryFor`, `CategoryAdminService.remove`, the two listing constraints,
   the row shape of `scripts/map-additions/30.mjs`, the template columns that `0043` inserts) and correct this brief where
   a name differs.
2. The rulings first, in `docs/contract/lead-decisions.json` `extra` (indexes 123-126 after feature 30, status `decided`), so
   `31.mjs` can name them from the first slice: **B228** (storefront: bulk publish; the nine routes; what publish means;
   the states, flags and results; one audit row per service; the run switch), **B229** (catalog and storefront: retail
   price rules; the five routes; precedence, formula, rounding and floor; typed against following; the three keys and
   `retailPricing` of the listing routes), **B230** (catalog: following the cost; the two routes; the limit, proposals,
   the notice; the price of an open checkout session), **B231** (suppliers: Quick add's `publish`; the run's `publish`;
   the hand-over; cleaned category names). Then `bun run contract:docs && bun run check`.
3. Create the two worktrees (section 9). Run nothing against `gsm` or `gsm_storefront`.

**Order.** Backend, one after the other in `../backend-31`: **B1** (with **B2** beside it), their two reviews, **B3a**, its
money review, **B3b**, **B4a**, **B4b**, the review of the three, **B5**, its money review, **B6**, the branch review.
Console, one after the other in `../frontend-admin-31`: **C1**, **C2**, **C3**, its review, **C4**, the branch review. The
console builds on the wire of section 5 and its own mocks, so it never waits for a backend slice.

**Rounds (never more than 4 agents, reviewers included).**

| Round | Backend (`../backend-31`) | Console (`../frontend-admin-31`) |
|---|---|---|
| 1 | B1 and B2 (B2 in its own folders) | C1 |
| 2 | the money review of B1, the review of B2, their fix rounds; the lead runs the whole `typecheck` and the guard | C2 |
| 3 | B3a, then its money review | (C2 ends) |
| 4 | B3b | C3 |
| 5 | B4a, then B4b, then the review of B3b + B4a + B4b | (C3 ends), the review of C3 |
| 6 | B5, then its money review | C4, then the console branch review |
| 7 | B6, then the branch review | |

**The lead's steps after the rounds.**
- **L1 Paired check.** In `../backend-31` with `FRONTEND_DIR=../frontend-admin-31`: `bun run contract:extract && bun run
  contract:harvest && bun run routes:build && bun run contract:docs && bun run docs:openapi && bun run coverage:build && bun
  run format && bun run check` (a new console GET with no mock goes to `known-gaps.json` only with a reason). Console: its
  four commands. Stage both branches and run `english:check` in each (fact 25). Nothing of the paired run is committed in
  the backend branch except what is true against the console's `main` too (the regenerated documents of the backend's own
  routes); the console-dependent files are regenerated again in L4. **Who fixes what the paired check finds:** this brief's
  section 5 is the referee. A difference of a name, a key or a union in one file is fixed by the lead on the side that
  left section 5. Anything larger goes to **one Sonnet fix call per repository** (two calls budgeted for this step), whose
  brief is the failing parity output and the paragraph of section 5; a difference where section 5 itself is wrong is a
  line in `docs/contract/MISMATCHES.md` and the lead's decision, never a silent pick.
- **L2 Migrate first (additive).** Migrate `gsm`, then `gsm_storefront`, with the code of `../backend-31` (`DATABASE_URL` set
  by hand). The owner's API and worker watch `main` and keep running: the old code works on the new schema.
- **L3 Merge the backend** (one squash commit, `feat(storefront)`: body = routes, jobs and queues, tables and migrations,
  "no cache key"). Restart nothing by hand: the watchers load the new code. `bun run check` on `main`.
- **L4 Merge the console** (one squash commit), then on backend `main`: `bun run contract:extract && bun run
  contract:harvest && bun run contract:docs && bun run docs:openapi && bun run coverage:build && bun run check` and commit
  the contract step; console `npm run mocks:live` and commit.
- **L5 The walk** (the lead, through the console against the isolated API and its demo database, never `gsm`): a first
  preview with no rule (every row waits for a price, the note says why); a general rule and a type rule with their
  previews; **Check again** (the rows become ready); an edit, a bulk action, a typed price; apply, the run, the shop page
  and the search of one published service; **take the run off the shop and put it back**; Quick add of a small group with
  "Also put them on the shop"; a cost raised by hand and a sync, the price that follows, a jump that waits, approve and
  keep; a preview whose cost jumped before apply (the row is left out with `cost_moved`); the hourly message in the
  notification log. **Nothing is published on the owner's data by the lead**: the first rule and the first run on `gsm`
  are the owner's clicks (prices are the owner's decision, owner question 3); `PROGRESS.md` gets the three steps to do it
  (make the rules, Quick add with the tick or Storefront, Publish, read the preview).
- **L6 Records.** `docs/decisions/040-retail-price-rules.md`, the `CLAUDE.md` clause, `PROGRESS.md` of both repositories,
  `STOREFRONT-BACKEND-HANDOFF.md` (one section "Bulk publish and retail rules (feature 31)": no route, key or code of
  `/store/v1` changes; server and remote services now appear, with their order fields; more categories in the menu;
  prices can change between two page loads and an open checkout keeps its price) and one line in the status table. Remove
  the two worktrees and the test database.
- **Production**: nothing special. The five migrations are additive; deploy as usual (`migrate`, then the new images). The
  worker must run for a preview to be prepared and for prices to follow; `ALERTS_EMAIL_TO` (or the Telegram chat) must be
  set for the hourly message.

## 11. Risks and their mitigations

| # | Risk | Mitigation |
|---|---|---|
| 1 | A price under the floor is stored by a new writer | `RetailPrices.set` refuses it itself and needs the quote the caller read under the lock; every rule price is `max(raw, floor)` rounded up; the properties of 8.1 run over the 1157 real costs; the sale-time floor stays as the last line |
| 2 | A supplier's mistake becomes a shop price | **a following price**: the per-rule limit on the **cost** move (default 25 %, up or down) turns it into a proposal, and approving writes only the figure staff saw. **A first price at a publish**: the same limit against the preview's cost refuses the row (`cost_moved`). Cost 0 is never priced by a rule. Every change is listed, audited and announced. **Not covered:** a wrong cost that is already there when the preview is made (a Quick add publish has no earlier cost to compare with): the preview shows the figure, the floor keeps the sale above it, and the run can be taken off the shop |
| 3 | A typed price is overwritten | two licences and no third: the follow row (the pass re-reads it under the service lock and checks `applied_price` against the stored price; the group price page and the price dialog delete it), and `replaces_price` on a publish row, which only an explicit choice in the row sets and which must equal the stored price under the lock. `existing_price` decides nothing. Tests: a typed `PATCH` racing the pass; the group-page price typed between the preview and apply (6.2) |
| 4 | Hundreds of raw or wrong titles go public | the preview; the hard flags wait for a person; the rules are measured on the real names with a snapshot; nothing is guessed (no match, no value); a Quick add publish needs a tick, the permission, and (above 500) the existing confirmation; **and a mistaken run is taken off the shop with one button** (6.7) |
| 5 | A run publishes twice, half a row, or loses a result | one transaction per service that holds everything; one listing per service and one price row per service and group by unique keys; the claim counter (`attempt`) makes a second worker on the same run stop before it decides anything; every result write is `WHERE result IS NULL` under the item lock; resume works from the rows |
| 6 | Deadlock with the sync, or with a rule delete | one service row per transaction, the same first lock as every other writer, one lock order (6.5), one retry of `40P01`; a rule delete is an `UPDATE` no foreign key check waits for (4.1); the concurrency tests run a sync against a publish and a rule delete against a pass |
| 7 | Unsellable cards (no supplier, a file service, a disabled service, a switched-off category) | blocked in the preview and re-checked at apply. **Not covered:** a supplier that drops a service after it was published (the sellable rule does not look at the supplier, fact 5); that is the later "supplier sync with a review queue" |
| 8 | Slugs are public and permanent; 114 names carry a version or a year | deterministic rules with a version on the run; a slug is written once and no rule change rewrites it; staff can edit the slug in the preview. A redirect after a later rename does not exist (`legacy_slugs` is written by feature 30's migration only) |
| 9 | 254 supplier groups become public categories | names are cleaned at import from now on, and a group already imported keeps its one category; the menu still grows (the route caps at 500). A short shop menu is a later feature (owner question 11) |
| 10 | Tool and app names fill the brand filter | the preview shows the brand's kind and can clear brands in bulk by kind; the facet shows the most used spelling (owner question 12) |
| 11 | The search index lags after a big run or a run switch | one small job per service on a queue of its own; the shop lists read Postgres; the reconcile repairs; a run is capped at 5000 |
| 12 | The shop list stops at 10 000 priced services (fact 22) | far from today's 1157; written here so the next catalogue size is not a surprise. The preparer's read of every listing's title and slug has the same bound |
| 13 | The follow pass walks every following price after each price change | deduped to one pass a minute; 200 a page with one batched read; a pass that changes nothing writes nothing. At 10 000 following prices a pass is about 50 read batches |
| 14 | The hand-over job dies (one attempt) | nothing is published; the Quick add screen says so and points to the manual path (7.4) |
| 15 | Drafts and rows pile up ("Check again" leaves a cancelled draft each time) | small rows (about 1 KB); no purge in this feature (a later housekeeping job; a cancelled draft is history) |
| 16 | The lexicons age (a new supplier, a renamed tool) | data files with tests; no match shows as an empty field in the preview, never as a guess; staff edit per row and in bulk. Nothing is learned from a run, so a result never depends on what else was selected |
| 17 | `english:check` reads new files only once tracked | the grep of section 9 in every slice and the lead's run after staging (L1) |
| 18 | The console and the backend drift on the lists (`Flag`, `BlockReason`, the result reasons, statuses) | the backend exports them `as const`; the paired step's shape parity fails on an `enum` difference; the console's word maps are tested against its unions |
| 19 | The first preview of a shop with no rule shows nothing to publish | the Start note and the preview's note say why, with the link; "Check again" after the rule is made (7.2); the lead's walk starts with exactly this (L5) |
| 20 | A schema file in a nested folder passes on the implementer's machine until lint and the structure test run | the tables live in `storefront/db/schema.ts` (4.2); `bun run lint` and `structure.test.ts` are in B3a's acceptance |

## 12. Out of scope, and the room left for it

Not built: bulk edit in the listings table; CSV or Excel import and export; automatic supplier sync with a review queue; AI
title clean-up; default pictures per brand; a shop menu that merges categories; lowering `services.cost` (the imported
cost) on a supplier price drop; deleting the listings of a run (the run switch takes them off the shop and keeps them); a
staff-editable lexicon; a purge of old runs; a bell item for staff.

The room: a draft row is a flat record (`detected` beside the edited fields), so a CSV export and import are a read and a
`PATCH` loop over `listing_publish_items`, and an AI clean-up or a later rules version is another writer of `title` that the
same preview shows. A system-made draft already exists (`source`, `auto`): the supplier sync's review queue is a run with
`source: 'sync'`. `bulk` with a server-side filter is the pattern of a bulk edit of listings, and `retailPricing: 'rule'` is
its "follow the rule" action. `brandKind` is detected and kept in `detected` for the day pictures or a second facet need it.
`retail_price_changes` is the place a lower imported cost would be proposed. The run switch (one job over a set of
listings, through `listing-writes.ts`) is the engine a bulk on and off in the listings table would reuse.

## 13. Owner questions (the default is applied; none blocks the work)

1. What does "publish" do? Default: **the services appear on the shop at once**; the ones that need a look wait until staff
   tick them. A run can instead create everything switched off. **A finished run can be taken off the shop again, and put
   back, with one button.**
2. Which kinds of services go on the shop? Default: **IMEI, server and remote**; file services cannot be ordered online and
   stay out. (The console said "only IMEI"; the website already sells the others.)
3. The starting rules? Default: **none is created for you**; the form opens with your example (IMEI +30 %, server +20 %,
   prices ending in .99). Until a rule exists nothing is priced automatically: a first preview says "no price" for every
   service, and "Check again" fills the prices once the rule is made.
4. A service that costs 0 at the supplier (6 today)? Default: **left out**; it goes on the shop only with a price typed by
   hand.
5. Two services with the same name (8 pairs)? Default: **both wait**; staff publish one or both (the second gets `-2` in
   its address).
6. Arabic words inside a supplier's name? Default: **left out of the shop title**; the service keeps its name. The one
   name with no English waits for a typed title.
7. `AT&T` in an address? Default: **`att`** (`/services/att-usa-...`) for addresses made by this feature; hand-made ones are
   untouched.
8. When the supplier lowers a price? Default: **the shop price follows it down as it follows it up**, inside the limit of
   question 9, but never below what the cost was when the service was imported: that cost falls only when staff refresh
   it (lowering it automatically would also lower every merchant's floor, which is a separate decision).
9. How big a cost change is followed without asking? Default: **up to 25 %** per rule; a bigger one waits for approval,
   and meanwhile the shop never sells under the floor. The same limit holds back a service whose cost changed that much
   between the preview and the publish.
10. Who is told about automatic price changes? Default: **the console's "Price changes" list**, and one message an hour to
    the alerts mailbox and Telegram chat when they are configured.
11. The shop menu? Default: **one menu entry per category as today**, with names cleaned of codes and emoji for new
    imports; a short hand-made menu (about 11 entries for the 254 groups) is a later feature.
12. Tool and app names as "brand" (Chimera, Octoplus, iTunes)? Default: **yes**, next to the phone makers; staff can clear
    them in the preview by kind.
13. Who may do what? Default: **prepare, edit and discard a preview with `storefront:create`** (typing a price in it also
    needs `storefront:update`, as a price does today); **publish, stop a run and switch a run off or on with
    `storefront:publish`**; rules and approvals with `pricing:*`.
14. Quick add with "Also put them on the shop"? Default: **the services that need no look go on the shop without another
    click; the rest wait in a preview.** The tick is off unless staff set it.
15. Prices ending in .99 for cheap services? Default: **only from $5**; cheaper prices stay in whole cents.
16. Position and "featured" of the new listings? Default: **position 0, not featured, no picture**.
17. A service that already has a shop price typed by hand? Default: **the price stays**. A rule replaces it only when staff
    choose "Use the pricing rule" for that service in the preview, and only if the price is still the one they saw.
18. A service in a category that is switched off? Default: **left out** until the category is switched on (it would be
    "on" and invisible).

## 14. Review against the code

Checked in the code (main checkouts, 2026-11-16): the listing writer and its lock order, refusals and audit rows; the listing
schema and its unique keys; `RetailPrices` (`lockLiveService`, `quotes`, `set`) and its three callers; the floor
(`floorFor`, `storefrontFloor`, `defaultMinProfit`, `suggestedPrice`) and the sale-time rule (`retailNet`, `pricedSellable`);
`applyRounding`; `recomputeEffectiveCost` and its six callers; `CatalogPriceVersion`, `PriceVersionListeners` and
`PriceChangeScan`; the Quick add service, runner, outbox, schema and contracts; the queue table (`imports`, `maintenance`);
the outbox payload limits; `AuditService` (the actor) and `AUDIT_ENTITY_TYPES`; the permission guard and `grants`; the module
import directions (the cycle a storefront import of suppliers would close); `pickLink`; the checkout session (the 30 minutes,
the `file` refusal, the locked amounts); the staff event path and the alert templates migration; `consoleBaseUrl`; the
structure test; `route-parity.test.ts` (a spec is an existing B-entry or `B-TBD`); `lead-decisions.json` (`extra` has 119
entries, 123 after feature 30); the test runner's roots; the website's order form for services that are not IMEI; the
prototype's rules, tables and figures.
Second pass of the planner (same day, on the same commits): read again `RetailPrices` whole, `GroupPriceAdminService.replace`
(it writes the retail row itself with its own floor check: decision 040 and section 3.3 now say two writers), the floor
functions and `retailNet`, the outbox value rules (a flag is allowed at the top level), the `imports` and `maintenance`
queues, the Quick add start and runner, the listener and scan pattern, the listing writer, the guard's rules in brief 30
section 9.4, the console's six tabs, `CONFIRM_ABOVE` and the last mismatch id; every worked number of section 3.3 was
recomputed by hand. Added by that pass: a draft that was never prepared cannot be applied (section 5.2), the exact limit
comparison and the reason of a followed price with `retail_price_rules.changed_at` (sections 3.4, 4.1), the follow row of
an archived service, and the "Prepare the shop preview" button of Quick add (section 7.4).
Taken from the audits and not re-read line by line: the console's file list and limits (A2), the counts of the names study
(A3), `ServiceImporter`'s creation fields beyond the category lookup.
Not verified (the first slice that touches it proves it, and reports): the names and signatures feature 30 leaves in
`listing-admin.service.ts`, `listing.repository.ts` and the template tables (L0 re-reads them); the exact Nest module wiring
that lets the worker load `ListingPublisher` and `RetailPricing` without the HTTP modules (B3b follows `SearchWorkerModule`);
whether `english:check` has a mode that reads untracked files; how long 1157 item transactions take on the owner's machine
(the estimate, under a minute, is from the statement count); whether the owner's database has `ALERTS_EMAIL_TO` set and any
retail price beyond its one listing.

Third pass of the planner (same day, after the two adversarial reviews; every must-fix was checked in the code before the
plan changed): `GroupPriceAdminService.replace` and `replaceGroupPriceRows` (a retail price can be typed for a service with
no listing); `recomputeEffectiveCost` (`greatest(services.cost, credit x rate)`: the effective cost falls with the
supplier's price, down to `services.cost`) and the sync's upsert (`credit = excluded.credit`); `QuickAddService.start` and
the runner's guarded progress (a restart closes the stalled run and makes a new one; a publish run keeps its id, hence the
claim counter); `scripts/eslint/module-boundaries.mjs` (`SCHEMA_FILE` is tested on the path inside the module) and
`test/schema/structure.test.ts` (the module's one schema file, partial indexes not counted, upper-case arrays must be CHECK
lists); `listings.contracts.ts` (a price and the switch need `storefront:update`); `ServiceImporter.categoryFor` (the lookup
by the raw text); `visibleTo`, `lockOf` and `findServiceFacts` (the category's `is_active` is in the sellable rule and not
in the lock rule); `CategoryAdminService.remove` (only a category with no service is deleted); `CatalogPricesModule` and
`worker.module.ts` (where the scan's listener and processor live); the audit interceptor (`audit: false` exempts, it does
not forbid a row). Measured on the prototype, read only: 145 tool names after `learnTools`; brand, carrier and country
read from the uncut title differ from the prototype in three brands and nothing else; 63 titles are cut; 53 names end
`blocked` or `review` by the list of 8.2.

## 15. Review notes (two adversarial reviews, 2026-11-16)

**Must-fix findings: all seven were confirmed in the code and are applied.**

| # | Finding | Where the plan changed |
|---|---|---|
| 1 | A typed price could be overwritten unasked: "staff chose the rule" was read from `existing_price`, which every re-evaluation rewrites | `listing_publish_items.replaces_price` (4.2); the price keys and `normalisePriceMode` (5.2); the table of 6.2; `existing_price` is display only; decision 040; tests 8.1 and 8.3 with the reviewer's scenario |
| 2 | Apply skipped the limit that exists for supplier mistakes | the publish limit `cost_moved` in "by the rule" (6.2), `costMoved` shared with the follow pass (3.4), the result reason and the console's words (3.2, 7.2), tests (8.1, 8.3) |
| 3 | Two workers could work on one run and overwrite a result | `listing_publish_runs.attempt` (4.2); every guarded statement and the new step order of the row transaction (6.2); the lock order and the two-workers row (6.5); the test with two workers (8.3) |
| 4 | The publish tables were planned in `storefront/publish/db/schema.ts`, which lint and the structure test refuse | both tables in `storefront/db/schema.ts`; the barrel untouched; the lists without a CHECK in the domain file (4, 4.2, slice B3a) |
| 5 | B3's acceptance needed routes that only B4 builds | the runner is tested through helpers and a hook (B3b); the route-level cases moved to `publish-routes.test.ts` (8.3); the rule "a slice's tests call only what exists" (9) |
| 6 | A draft could never be re-checked after a fix made outside it, and a re-evaluation that blocks a ticked row broke a CHECK | "Check again" (scope `run` from a draft; 3.1, 5.2, 6.1, 7.2), the no-rule notes (7.2, `counts.noRule`), the tick rule (3.2, 5.2) |
| 7 | A finished run had no undo | the run switch: the route (5.2), the job (6.7), the columns (4.2), the console's buttons and headline (7.2), tests (8.3) |

**Applied with another mechanism than the reviewer proposed** (the finding is accepted; the reason for the difference):
- *Must-fix 3, the reset of the rows `refused: failed`.* The reviewer guards it in the worker. It is done by the resume's
  own transaction instead, under the run row `FOR UPDATE` (5.2): at that moment no worker can be inside a row, so the
  reset needs no guard and cannot race a claim.
- *Must-fix 7, "a refused row's reason is recorded".* The reasons are counted in the close's audit row and in
  `switch.skipped`, not stored per row; each row shows its listing's live state (`listingListed`). A second result set on
  every item for an action that changes one boolean was not worth five columns. Two additions of the planner: the switch
  refuses to put a listing on with no price, and it stores its target in `runs.listed` so a later Continue follows it.
- *Should-fix, copied typed prices and addresses (scope `run`).* The reviewer sends a price under the floor back to
  `rule` and a taken address back to `auto`, with a flag. The plan keeps what staff typed and **blocks the row**
  (`below_floor`, `slug_taken`): a price or an address a person chose is never replaced silently, and one function
  (`evaluateItem`) then decides the same way at prepare, at an edit and at apply.
- *Should-fix, deleting a rule.* Of the two remedies offered, the soft delete (4.1), not the retry of `40P01`: it removes
  the deadlock and the foreign key error together, and keeps the rule's name in the history.
- *Should-fix, the category lookup.* The two reviewers gave opposite orders. The plan takes "the raw text first, then the
  cleaned name": it is today's lookup unchanged, so no existing group can be redirected.
- *Should-fix, the cut guard.* Both remedies offered are applied (the listings' titles feed the guard, and the hard flag
  `title_taken`), over every listing and not only those of the same categories: one read of at most 10 000 short rows.
  In addition brand, carrier and country are now read from the **uncut** title, since the cut is the one batch rule left
  and the prototype read the facts after it (three brands differ on the fixture, 8.2).

**Should-fix notes applied as written:** falling costs (fact 10, decision 040, 3.4, owner question 8, a test with a sync
that lowers the cost); approving a proposal writes only the figure staff saw, and a proposal is rewritten only when its
figures differ (3.4, 5.4); the second permission on a price key (5.1, 5.2); the draft locks (the run row `FOR SHARE` for an
edit; `FOR UPDATE` for a bulk, so two bulks never interleave); the conflict target with its predicate and the catalog's
existence reads (6.3, 5.2, 6.1); `category_inactive` (3.2); the follow scheduler in the global module (6.4); the index
behind `retail_price_rules.category_id` (4.1); `nameAll` and `assignSlugs` as two functions with one `nextFreeSlug` (3.5);
the frozen tools and the per-group acceptance row (3.5, 8.2); the slice split and the owners of the tabs and of the paired
step's fixes (9, 10); `requestedByName`, the flags recomputed by `bulk`, `remote` named as `server`, the server-side "Save
and next" (5.2, 3.5, 7.2).

**Changes that follow from the fixes and were asked by nobody:** `cancel` needs `storefront:create` (a role that may
prepare a preview may discard it, and "Check again" already cancels a draft with that permission), and stopping a live
run needs `storefront:publish` as well; the draft slice is two (B4a, B4b) for the same reason B3 is two; a `rule` row whose
service already has a **following** price writes no price (the follow pass owns it); a category delete names the retail
rule its cascade removes; owner questions 17 and 18; the "Prototype" column of the names-that-wait row in 8.2 now carries
the figure for the plan's own list (53).

**Rejected findings:** none. No should-fix note was left out.

**Still open after this review** (none blocks; each is the first slice's to prove, as section 14 says): the names feature
30 leaves in the listing files (L0); whether the switch function of `listing-writes.ts` can serve the staff route and the
job with one signature (B3a decides and B3b reports); the time of 1157 item transactions on the owner's machine.

Approved by Fable 5.2 (planner), 2026-11-16, after two adversarial reviews
