# Feature 30: English only (Arabic removed as a language of the system: backend, console, website)

Written by Fable 5.2 (planner), 2026-11-16, against backend `main` @ `aa7074e`, console `main` @ `939ae2b`, website `main` @
`68eb019`. Owner decision (2026-11-16): remove the Arabic language from the whole system and keep English only; a plan first, then
implementation by Opus (hard parts) and Sonnet (standard parts). Inputs: `/home/saifi/gsm-project/.english-only/OWNER-DECISIONS.md`
and the six audit files in `/home/saifi/gsm-project/.english-only/audit/`, cited below as **A1** (website routing and i18n), **A2**
(website content and tests), **A3** (backend data), **A4** (backend behaviour and contract), **A5** (console) and **A6** (the critic;
its G1-G11 win where they contradict A1-A5). The audits are the file lists: this brief cites their sections instead of repeating them,
and an implementer opens the cited section before editing. Read first: `backend/CLAUDE.md`, `docs/briefs/_common.md`; console slices
also `frontend-admin/CLAUDE.md`; website slices `storefront/CLAUDE.md`, `AGENTS.md` and the guides in `node_modules/next/dist/docs/`.
Paths are backend-relative; `FA/` = the console worktree, `SF/` = the website worktree. No agent commits, runs git that changes
state, spawns agents, or touches the databases `gsm` and `gsm_storefront` (only the lead does, §11). Two adversarial reviewers
read this brief on 2026-11-16; every finding was checked in the code, and what changed is listed in §16.

Three groups, as in the audits: **A** = Arabic as a language of the system (goes); **B** = machinery that exists only for two
languages (goes); **C** = Arabic *text* that people or suppliers supply as data (stays, and gets tests that protect it).

## 1. What exists (verified in the code on 2026-11-16; the design rests on these)

| # | Fact | Evidence |
|---|---|---|
| 1 | **70** operations of the contract carry a language field (50 `/admin`, 4 `/client`, 16 `/store/v1`); 19 take a `locale` query parameter; 12 of those are strict list routes that answer `422` to an unknown query key. Request bodies and plain-object queries strip unknown keys | counted by script over `docs/contract/openapi.json` (the list is §5); `src/common/contract/list-query.ts:400-410`; A4 §2.4, A6 G2 |
| 2 | `bun run check` ties the backend to the console in both directions: `contract:check` re-extracts the console's types from `FRONTEND_DIR` (default `../frontend-admin`) and fails when `docs/contract/frontend-endpoints.json` is stale; `shape-parity.test.ts` fails on `missing-field`, `required` and `enum`; a field the backend sends and the console does not declare (`extra-field`) is only reported. The seed and the fixture harvest read the same `FRONTEND_DIR` | `package.json` (`check`, `contract:*`), `test/contract/README.md` (rule table), `scripts/lib/manifest.mjs:20`, `scripts/contract-harvest.mjs:11`, `scripts/seed/demo-state.ts:30` |
| 3 | The website's `npm run check` starts with `gen:api:check`: `lib/api/schema.gen.ts` must equal what `backend/docs/contract/openapi.json` generates (19 `"en" \| "ar"` unions today). `GSM_OPENAPI` overrides the file; `BACKEND_DIR` overrides the checkout the isolated API on `:3100` runs from | `SF/package.json`, `SF/scripts/gen-api-types.mjs:11`, `SF/scripts/dev-backend.sh:7`, A1 §1.10 |
| 4 | Every public and merchant read answers English when no `locale` is sent (the customer inbox: the saved language). A website that sends no language therefore works against today's API | `storefront/infra/listing.repository.ts:33,57`, `storefront/contracts/public-content.contracts.ts:101,122,164`, `platform/notifications/inbox/inbox.service.ts:68-71` |
| 5 | Nine language columns: two backend additions (`clients.locale` with the only language CHECK, `service_categories.name_ar`) and seven map columns (`customers`, `content_pages`, `help_articles`, `legal_documents`, `notification_templates`, `reply_templates`, `service_listings`). Six unique keys contain `locale`. The structure test expects each map table to have exactly id + the map's columns (from `docs/slices/<module>.json`) + timestamps + `ADDITIONS` | A3 §1, §3; A6 §2.1; `test/schema/structure.test.ts:68-156,193-201` |
| 6 | The migrator runs **all pending migrations in one transaction**, decides "applied" by the journal `when` only (last: `0033_search`, 1794780844122) and never hash-checks. `created_at` is `timestamp(3) DEFAULT now()` and `now()` is the transaction start, so a row inserted by an earlier migration of the same run has `created_at >= date_trunc('milliseconds', transaction_timestamp())` | `src/infra/db/migrate.ts:27-46`, `node_modules/drizzle-orm/pg-core/dialect.js:44-66`, `drizzle/0000_init.sql:589` |
| 7 | 42 Arabic default templates are inserted by applied migrations (0023: 5, 0025: 6, 0027: 31; 0032 updates two). A fresh database therefore holds 42 Arabic rows at the moment any new migration starts. Tests never rely on them (`resetDb` truncates every table); a test database's name ends in `_test` | A3 §0.5; `test/support/db.ts:25-28,102-109` |
| 8 | `consent_records.legal_document_id` references `legal_documents` with `ON DELETE RESTRICT`. The demo has Terms 3.2 in English and in Arabic, both in force, with the same version text, so `(type, version)` is not unique without `locale`; seeded consents point at the Arabic row. Evidence packs and the data export print the type and the version only | `drizzle/0000_init.sql:1217`; `FA/src/mocks/seed/demo-state.json` (`state.legal` lg1, lg2); `scripts/seed/b2c.ts:163-169`; `money/infra/b2c-reads.repository.ts:176-177`, `customers/infra/foreign-reads.repository.ts:218-219` |
| 9 | A stored campaign audience is re-parsed with a strict schema: `zCustomerSegment` is a `z.strictObject` and `parseStoredAudience` stops the fan-out when the value no longer parses. Statuses: draft, scheduled, queued, sending, sent, cancelled, failed; a draft cannot be cancelled. Cancelling writes `status`, `cancelled_at`, `cancelled_by`, `fanout_cursor = null` and `updated_at`, and rings an inbox recount after its commit. A segment that is present with no filter means all of it, and the console offers Duplicate on a campaign of **every** status and copies its stored audience into the new draft. `audit_logs` accepts the actor `system` with an empty name | `platform/notifications/campaigns/audience-spec.ts:46-52,63-66,136-137`, `campaign-rules.ts:25-29`, `campaign-send.service.ts:160-170`, `platform/db/schema.ts:86,150-166,506-538`; `FA/src/features/notifications/components/CampaignHeader.tsx:48`, `FA/src/features/notifications/lib/spec.ts:249` |
| 10 | Checkout accepts a service listed in **any** language, search indexes English only: a service listed only in Arabic is buyable today and invisible to English lists. The listing is read when a checkout session is created, not when it is paid | `storefront/infra/listing.repository.ts:139`, `storefront/search/application/searchable-ids.ts:57`, `customers/application/checkout-session.service.ts:125`, `checkout-pay.service.ts` (no listing read), A3 §2.8 |
| 11 | English fallbacks already exist for templates, legal documents, campaign text, category names and inbox texts. Mail links carry no language segment (`<STORE_BASE_URL>/sign-in?token=…`), so no sent mail holds an `/ar` link the backend wrote | A3 §0.8; `customers/application/mail/customer-mail-jobs.ts:23-40`, A1 §1.2 |
| 12 | Data to remove (the lead's read-only counts): `gsm` has 42 Arabic templates and 1 Arabic listing; `gsm_storefront` has 42 templates, 5 listings, 6 content pages, 1 legal document, 41 merchants and 37 customers with the saved language `ar`. The 5 Arabic listings and the pages of `gsm_storefront` are hand-made, not seeded | `OWNER-DECISIONS.md`; A6 G3 |
| 13 | Website: 68 files under `app/[lang]`; `proxy.ts:40-44` sends a path whose first segment is not a language to `/<preferred>/…` (307; preferred = cookie `gsm_locale`, then `Accept-Language`, then `en`); 14 message files each with an `ar` block (2,766 lines); 184 non-test files carry a `locale` identifier (app 63, components 83, lib 37, proxy 1); `tsc` also compiles the unit tests and `e2e/`; `resolveService` already has a `redirect` result | `SF/proxy.ts`, `SF/lib/i18n/config.ts:4`, A2 §0-§1.1, grep of 2026-11-16, `SF/components/store/resolve-service.ts:9-16` |
| 14 | Next 16.4: `redirects()` of `next.config.ts` run before `proxy.ts` and before the filesystem, `permanent: true` answers 308, and the query string is passed on. A layout with no layout above it is a root layout, also inside a plain folder | `SF/node_modules/next/dist/docs/01-app/03-api-reference/05-config/01-next-config-js/redirects.md:30,39,43`; `…/03-file-conventions/proxy.md` ("Execution order"); `…/layout.md:142-146` |
| 15 | The console's own interface is English only. Language exists there only as fields of the content it manages: 14 form controls, 4 table columns, about 9 text places, 10 files with right-to-left code, 15 wire rows. `src/lib/api/schema.gen.ts` is generated from the read-only map and has `locale` on 7 row types. The console's and the website's stream parsers **drop** a live event unless `item.locale` is `en` or `ar` | A5 headline, §2, §4; `FA/src/lib/realtime/events.ts:112`, `SF/lib/realtime/events.ts:50,68` |
| 16 | Group C today. Backend: PDF shaping and bidi (feature 24E: `src/modules/platform/pdf/*`, two TTF files, `bidi-js`, `@pdf-lib/fontkit`), upload and attachment names, plain-text mails, CSV exports, and supplier service names that contain Arabic script (6 of the owner's 1142). Website: `dir="auto"` (39 lines), `<bdi>` (38), Arabic-digit parsing, the IME guard. Console: nothing | A3 §10, A4 §9, A6 G4-G6; A1 App. H; A5 §6 |
| 17 | A route row beyond the map must carry an Arabic sentence (`f`), and a public or session row uses the map's Arabic auth words. The generated documents copy the map's Arabic (`docs/route-manifest.json` 671 lines, `docs/slices/*.json` 1,195, `docs/contract/endpoints/*.md` 479) | `scripts/lib/map-additions.mjs:89`, `scripts/lib/map.mjs:36-54`, A4 §10 |
| 18 | `docs/OPERATIONS.md` §3 promises additive migrations (the old code works on the new schema). Drizzle names every column in a select, so the old code fails the moment a column is dropped | `docs/OPERATIONS.md:100-118`, A3 §5.4 |
| 19 | Next numbers: migrations from **0034**, decision **039**, spec entries from **B224** (`lead-decisions.json` `extra` has 119 entries, last B223), `scripts/map-additions/30.mjs`, console mismatch M264 | `drizzle/meta/_journal.json`, `docs/contract/lead-decisions.json`, A5 §9 |
| 20 | Two main checkouts hold uncommitted work that this feature's files touch or sit next to: backend `src/modules/platform/notifications/mail-driver.ts` (+ spec), website `docs/IMAGE-PROMPTS.md` | `git status` of 2026-11-16 |
| 21 | The production image carries the scripts it runs **by name**: `db-migrate`, `setup`, `first-run`, `search-keys` and four `scripts/lib` files. `.dockerignore` shuts out the rest of `scripts/`, the verify stage imports the tools by name, `test/unit/deploy-files.test.ts` pins the list, and the image runs as `USER bun`. The `migrate` service is the same image with the command `bun scripts/db-migrate.ts` | `Dockerfile:22-23,29,42`, `.dockerignore:20-31`, `test/unit/deploy-files.test.ts:232-236`, `deploy/compose.prod.yaml:108-117` |
| 22 | `docs/contract/MISMATCHES.md`, `ANSWERS.md`, `RULES.md`, `OPEN-QUESTIONS.md`, `error-codes.md` and `endpoints/*.md` are **generated** by `scripts/build-contract-docs.mjs` from the hand-written `docs/contract/extraction/*.json` (summaries, business rules, endpoint texts, proposed answers), `lead-decisions.json` (`conflicts`, `answers`, `extra`), the manifest and `frontend-endpoints.json`; `contract:check` fails on a hand edit. The B-number of an `extra` entry is the count of `mapConflict` entries of the extraction plus its index. `route-parity.test.ts` refuses a map addition whose `spec` is not an existing B-entry | `scripts/build-contract-docs.mjs:1-22,66-78,115-160,276-277`, `test/contract/route-parity.test.ts:98-106`, `package.json` (`contract:check`) |
| 23 | Next 16.4: a `permanentRedirect` thrown after streaming began cannot set the status: it reaches the browser as a meta tag inside a 200 answer. The service, content page, help and checkout pages read `params` inside `<Suspense>` (Cache Components), so whatever they decide comes after the shell | `SF/node_modules/next/dist/docs/01-app/03-api-reference/04-functions/permanentRedirect.md:11`; `SF/app/[lang]/(store)/services/[slug]/page.tsx:75-87`, `pages/[slug]/page.tsx:41-52`, `checkout/page.tsx:43,78-81` |
| 24 | Group C code compares the direction of a text run (`=== 'rtl'`, the type `'ltr' \| 'rtl'`) and never writes a `dir` attribute. Pictures and fonts hold bytes that decode to Arabic code points: 96 of the 97 files under `SF/public` (png, jpg) and the two TTF files. `test/support/pdf.ts` holds no Arabic and no `ar` | `src/modules/platform/pdf/pdf-fonts.ts:44,72,82,86`, `text-runs.ts:9,82,113,181`, `pdf-renderer.ts:169`; `git ls-files` of 2026-11-16 |

## 2. Decision 039 (text for `docs/decisions/039-english-only.md`; the lead writes the file)

**Decision.**
- **English is the only language of the system.** No visitor, customer, merchant or staff member can see, choose or receive
  Arabic as a language: no translation, template, seeded content, language selector, language filter, language column in a table,
  `locale` field on the wire or right-to-left layout code remains in the product code of the backend, the console and the website.
  New work is English only.
- **Arabic text is still data.** What a person or a supplier types (a name on an invoice, a ticket message, a supplier's service
  name, a file name, digits typed on an Arabic keyboard) is stored, shown and printed as typed. The PDF shaping and fonts of
  feature 24E (decision 030), `dir="auto"` and `<bdi>` on user text, Arabic-digit parsing, UTF-8 CSV and plain-text mails stay,
  and tests protect them (group C).
- **Stored Arabic content is deleted for good, after a backup file.** A script exports, per database, every row and value the
  migration removes; the deleting migration refuses to run on a database that holds such content and has no fresh export.
- **One exception: legal evidence.** A legal document version in another language that a consent record references is the proof
  of what a person accepted. It is not deleted: it is taken out of force (`is_current = false`) and kept as history. For that reason
  `legal_documents.locale` stays as an archive tag (`en` on every version that can be created or published; another value only on
  retired history), and a CHECK forbids a non-English version in force.
- **Columns.** `clients.locale`, `service_categories.name_ar` (backend additions) and the map columns `customers.locale`,
  `content_pages.locale`, `help_articles.locale`, `notification_templates.locale`, `reply_templates.locale` and
  `service_listings.locale` are dropped; the unique keys lose the language (one listing per service, one slug, one template per
  event, channel and audience, one version in force per document type). Dropping six map columns is a recorded deviation from the
  map (B224): `test/schema/structure.test.ts` gets a `REMOVED` list next to `ADDITIONS`.
- **The wire.** The language leaves all 70 operations that carried it; only the four staff routes of legal documents keep a
  read-only `locale` in the row (the archive tag). Unknown query keys stay a `422`: the three repositories change in one lock step.
- **URLs.** The website keeps `/en/…`. Every `/ar/…` URL answers a permanent redirect (308) to the same path under `/en`, with
  its query. An Arabic service, page or help address that no longer exists is remembered in `legacy_slugs`: the English page that
  receives it sends the reader on to the English page of the same service, else to the English list (a page: the home page; a
  help article: the help centre). That second step is written into the page, which is `noindex`: these pages stream, so their
  status line is already sent (§7.1). No `hreflang`, no Arabic sitemap entry.
- **People.** A saved language no longer exists; every merchant and customer reads English.
- **Campaigns.** A campaign of **any** status whose customer audience named only other languages loses its customer audience
  (staff choose one again; a copy of a finished one must not reach every customer), and a scheduled or running one is also
  cancelled. Every other campaign only loses the language filter. Each campaign that lost its audience gets a system audit row.
  Campaign text becomes one title and one body.
- **History is not edited.** Applied migrations (0023, 0025, 0027 and 0032 hold Arabic template text) stay as they are
  (decision 027): a fresh database inserts those rows and the new migration deletes them in the same run. Old briefs, decision
  records and `RESOLUTIONS` stay. `audit_logs` rows keep the language values they recorded.
- **The map stays the owner's Arabic specification** (`reference/gsm-map`, read-only). The tooling no longer demands an Arabic
  sentence for a new route row; the generated documents keep the map's own text.
- **A guard** (`english:check`, part of `bun run check`; the website's and the console's `lint`) fails when Arabic script, the
  `ar` locale or right-to-left layout code reappears outside a short allowlist, and when a protected group C file loses what it
  protects.

**Why drop the columns and not pin them to `en` with a CHECK.** A pinned column keeps every insert, seed, fixture, unique key and
wire field carrying a value that can never differ, and keeps the "one row per language" shape alive for the next reader. The cost
of dropping is one recorded deviation and one list in a test; the values are exported first. `legal_documents` is the one table
where the column carries information (which text a person accepted), so it stays.
**Why not also drop `/en`.** The owner decided to keep it (decision 1 of 2026-11-16): indexed and bookmarked `/en` URLs stay valid.

**Consequences.** One release changes the three repositories together and is **not** additive: the old code cannot run on the new
schema, so the deploy stops the API and the worker, exports, migrates and starts the new images (§11). The export file is the
only copy of the deleted content besides the regular database backups. The export script ships in the backend image, because the
runbook runs it there. `docs/slices/*.json` and the console's map-generated row
types still list the six dropped columns (they mirror the map); the `REMOVED` list and the console generator's omit list are where
that difference is written down.

**CLAUDE.md clause (the lead adds it under Architecture).** "English only (decision 039): no language field, parameter, column,
translation or right-to-left layout code. Arabic text that people or suppliers type is data and must keep working (PDF shaping,
plain-text mails, CSV). `bun run english:check` guards both."

## 3. Target state

**Backend.** No `locale`, `locales`, `nameAr`, `byLocale`, `alternates` or `content.ar` in any contract; no language constant
(`STOREFRONT_LOCALES`, `CLIENT_LOCALES`, `CUSTOMER_LOCALES`, `TEMPLATE_LOCALES`, `CAMPAIGN_LOCALES`, `DEFAULT_LOCALE`,
`FALLBACK_LOCALE`, `GENERATED_LOCALE`, the inline unions of A3 §6); no Arabic template, inbox text, footer, example or seed row; no
`dir="rtl"` mail wrapper; one listing per service; one template per event, channel and audience; campaign content
`{ title, body }`; the only `locale` left is the column `legal_documents.locale` and the read-only field of its four staff routes.
A new table `legacy_slugs` and one public route answer old addresses. Group C code is untouched.
**Console.** No language control, column, label or tab; no `nameAr`; no `rtl` code; types and mocks without language; the legal
page shows a retired non-English version only in its "Earlier versions kept for the record" line. A ticket message renders with
`dir="auto"`.
**Website.** One language: `/en/…` pages, `<html lang="en" dir="ltr">`, one font (Inter), no switcher, no language select, no
`ar` messages, no `rtl:` variants, no `hreflang`; `/ar/…` redirects for good; no `locale` sent to the API. After the cleanup wave
(§7.8) no `locale` argument, `getLocale()`, `[lang]` segment or language-keyed message object remains either.

## 4. Data: the export, the migrations, what stays

### 4.1 What happens to each stored thing

`non-en` means `locale <> 'en'` (not only `ar`: template languages were free text such as `en-GB`, A3 §0.2).

| Stored thing | Rows | The migration | In the export file |
|---|---|---|---|
| `notification_templates` | non-en | deleted | whole rows |
| `service_listings` | non-en | remembered in `legacy_slugs`, then deleted | whole rows |
| `content_pages` | non-en | live ones remembered in `legacy_slugs`, then deleted | whole rows |
| `help_articles` | non-en | published ones remembered in `legacy_slugs`, then deleted | whole rows |
| `reply_templates` | non-en | deleted | whole rows |
| `legal_documents` | non-en, no consent references it | deleted | whole rows, `fate: "deleted"` |
| `legal_documents` | non-en, referenced by a consent | **kept**, `is_current = false` (§4.4) | whole rows, `fate: "retired"`, the number of consents |
| `customers.locale`, `clients.locale` | non-en | column dropped (everybody reads English) | `id`, `locale` |
| `service_categories.name_ar` | filled | column dropped | `id`, `name`, `name_ar` |
| `notification_campaigns` | `content` has `ar`, or the audience has `customers.locales` | `content` becomes `{ title, body }` (the English text); the language filter goes; a campaign that was for other languages only loses its customer audience and, when scheduled or running, is cancelled (§4.6) | `id`, `name`, `status`, `audience`, `content`, `fate` |
| `content_pages.canonical_url` | an English page whose canonical address starts with `/ar` | set to `NULL` (the page's own address is then canonical) | `id`, `slug`, `canonical_url` |
| `audit_logs`, `notifications.payload.locale`, consent records | all | untouched (append-only history) | not exported |
| Search settings in Arabic script (`search_synonyms`, `search_pins.query`, `search_hidden_terms.term`, A6 G7) | any | untouched (staff remove them in the console; a visitor may still type Arabic) | listed in the report only |
| Typesense | | untouched: it holds English documents only (decision 038) | |

### 4.2 The export script (`scripts/english-only-export.ts`, slice B0)

`bun scripts/english-only-export.ts --out <dir> [--check]`. The script imports **only `pg` and Node built-ins** (no `src/**`, no
`scripts/lib/**`): it reads the connection string itself, `DATABASE_URL`, or `DATABASE_URL_TEST` under `NODE_ENV=test` (the rule
of `databaseUrlFor`, decision 014), so it runs in the lead's shell with one variable set and in the image without the whole
production configuration. Its work is an exported `main()` behind `if (import.meta.main)`, as in `scripts/search-keys.ts`, so
the image's verify stage can import the file without running it (fact 21).
0. **Before anything is read.** `--out` is **required in every environment** (no default: the lead's shell has no `NODE_ENV`,
   and nothing may be written inside a container by accident); it is resolved against the current directory. The script
   writes and removes a probe file there and exits 1 with one clear sentence when the folder is missing or cannot be written:
   no snapshot, no marker. Then the level: the newest `created_at` of `drizzle.__drizzle_migrations` is the `when` of a tag in
   `drizzle/meta/_journal.json` (fact 6), and that tag must be `0033_search` or `0034_legacy_slugs`. Older: exit 3, "upgrade this database to the
   previous release first" (the SQL below needs the columns of 0020 and 0024, and a run that starts lower would insert the
   template rows of 0023/0025/0027 after the marker). At or past `0035_english_only_data`: exit 3, "already migrated". No
   migrations table at all: exit 0, "nothing to export".
1. One `REPEATABLE READ, READ ONLY` transaction (one snapshot). It reads the rows of §4.1 with raw SQL (the schema of 0033: it
   never imports the Drizzle tables, which lose these columns later) and `counts` with **one
   `SELECT jsonb_build_object(…)` whose text is the guard's expression of §4.3**: node-postgres returns that as an object with
   numbers, while a bare `count(*)` comes back as a string and would never equal the guard's value. Every other count in the
   script is cast `::int`. Then the **report**: counts per table and language; services whose only listing is not English, with
   their orders and open checkout sessions (A3 §9 query 4); **rows with no English row for the same key**: templates by event,
   channel and audience (after the deletion that event sends nothing on that channel), and every live content page and
   published help article in another language (none has a stored English twin; listed by title); legal document types that
   have a non-English version in force and no English one; templates staff edited (`updated_at > created_at`); campaigns by
   fate (below); search settings that contain Arabic script.
2. `--check` prints the report and stops (no file, no marker); it still does the probe and the level check of point 0, so the
   runbook can prove the image, the folder and the database before anything is stopped. Without it the script writes **one
   file per database**: `<out>/english-only-<database>-<UTC yyyymmddThhmmssZ>.json`, mode 0600, UTF-8, pretty-printed, keys in
   a fixed order:
   `{ format: 1, feature: "30-english-only", database, exportedAt, migrations, counts, deleted: { <table>: [rows…] },
   changed: { "customers.locale": […], "clients.locale": […], "service_categories.name_ar": […], notification_campaigns: […],
   "content_pages.canonical_url": […], legal_documents_retired: […] }, report, howToRestore }`. A row is an object keyed by
   column name with every column (`jsonb` as JSON, timestamps ISO, numerics as strings). `counts` has exactly the eleven keys
   of the guard in §4.3, as JSON integers. A campaign row carries its `fate`: `cancelled` (scheduled, queued or sending, no
   English in its language list), `audience_removed` (a draft of that kind), `audience_removed_finished` (sent, failed or
   cancelled of that kind), `filter_removed` (its list contained `en`) or `text_only` (only `content.ar`). `howToRestore` says
   in plain words which table each section came from and that, after migration 0036, a row is restored by typing it again in
   the console or by SQL into a copy restored from the dump of the same day (the language columns no longer exist).
3. It reads the file back, parses it and compares the counts and a SHA-256 of the bytes with what it wrote; only then, in a
   second short transaction, it writes the **marker**: one `job_runs` row (`job = 'english_only_export'`, `trigger = 'manual'`,
   `status = 'succeeded'`, `started_at` = the snapshot time, `processed` = rows written, `result = { file, sha256, counts }`).
   The System health page lists jobs by a fixed set of names, so this row is not shown there.
4. The file is never committed. It holds content and ids, no secret and no address.
5. Exit codes: 0 written and verified; 0 with "nothing to export" on a database with no such rows (no marker needed); 3 on a
   wrong level (point 0); 1 on any error (nothing half-written is left: the file is written to `*.tmp` and renamed).

The lead runs it on `gsm` and on `gsm_storefront` (§11). Implementers run it only against their worktree's test database.

### 4.3 The migrations (six files; all pending files run in one transaction, fact 6)

| File | Kind | Slice | Content |
|---|---|---|---|
| `0034_legacy_slugs.sql` | generated | B0 | the table `legacy_slugs` (§4.5) |
| `0035_english_only_data.sql` | custom (`drizzle-kit generate --custom`) | B0 | the guard, then every data change of §4.1 |
| `0036_english_only_listings.sql` | generated | B1 | `service_listings`, `service_categories` |
| `0037_english_only_content.sql` | generated | B2 | `content_pages`, `help_articles`, `legal_documents` |
| `0038_english_only_templates.sql` | generated | B3 | `notification_templates` |
| `0039_english_only_accounts.sql` | generated | B5 | `clients`, `customers`, `reply_templates` |

One data file before every schema file: the rows go first, the columns after. A slice owns the schema of its tables (Drizzle
definition, generated migration, constraint names in the code, tests), so every slice ends with `bun run db:check` green.

**`0034_legacy_slugs.sql`** (generated from the Drizzle definition of §4.5; shown without the identity clause):

```sql
CREATE TABLE "legacy_slugs" (
  "id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
  "kind" text NOT NULL,
  "slug" text NOT NULL,
  "service_id" bigint,
  "created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "legacy_slugs_kind_slug_uq" UNIQUE("kind","slug"),
  CONSTRAINT "legacy_slugs_kind_check" CHECK ("legacy_slugs"."kind" in ('service', 'page', 'help')),
  CONSTRAINT "legacy_slugs_service_check" CHECK ("legacy_slugs"."service_id" is null or "legacy_slugs"."kind" = 'service')
);
ALTER TABLE "legacy_slugs" ADD CONSTRAINT "legacy_slugs_service_id_services_id_fk" FOREIGN KEY ("service_id")
  REFERENCES "public"."services"("id") ON DELETE cascade ON UPDATE no action;
CREATE INDEX "legacy_slugs_service_id_idx" ON "legacy_slugs" USING btree ("service_id");
```

**`0035_english_only_data.sql`, exact shape** (statements separated by `--> statement-breakpoint`; the `DO` block is one statement):

```sql
-- English only (decision 039). 1. The guard: never delete content that existed before this run without an export of it.
DO $$
DECLARE
  live jsonb;
  marker record;
  missing text;
BEGIN
  -- A test database holds nothing to keep (test/support/db.ts truncates it). A test forces the guard with
  -- ALTER DATABASE <name> SET gsm.english_only_guard = 'on'.
  IF current_database() ~ '_test$' AND coalesce(current_setting('gsm.english_only_guard', true), '') <> 'on' THEN RETURN; END IF;

  -- Retiring the only version in force of a document would leave checkout with nothing to agree to.
  SELECT string_agg(DISTINCT d.type, ', ') INTO missing FROM legal_documents d
   WHERE d.is_current AND d.locale <> 'en'
     AND NOT EXISTS (SELECT 1 FROM legal_documents e WHERE e.type = d.type AND e.locale = 'en' AND e.is_current);
  IF missing IS NOT NULL THEN
    RAISE EXCEPTION 'English only (0035): publish an English version of these documents first: %', missing;
  END IF;

  live := jsonb_build_object(
    -- rows that migrations 0023/0025/0027 inserted earlier in this same run are not content (a fresh database)
    'notification_templates', (SELECT count(*) FROM notification_templates WHERE locale <> 'en'
                                 AND created_at < date_trunc('milliseconds', transaction_timestamp())),
    'service_listings',       (SELECT count(*) FROM service_listings   WHERE locale <> 'en'),
    'content_pages',          (SELECT count(*) FROM content_pages      WHERE locale <> 'en'),
    'help_articles',          (SELECT count(*) FROM help_articles      WHERE locale <> 'en'),
    'reply_templates',        (SELECT count(*) FROM reply_templates    WHERE locale <> 'en'),
    'legal_documents',        (SELECT count(*) FROM legal_documents    WHERE locale <> 'en'),
    'customers',              (SELECT count(*) FROM customers          WHERE locale <> 'en'),
    'clients',                (SELECT count(*) FROM clients            WHERE locale <> 'en'),
    'service_categories',     (SELECT count(*) FROM service_categories WHERE name_ar <> ''),
    'notification_campaigns', (SELECT count(*) FROM notification_campaigns
                                WHERE content ? 'ar' OR audience #> '{customers,locales}' IS NOT NULL),
    'canonical_urls',         (SELECT count(*) FROM content_pages
                                WHERE locale = 'en' AND canonical_url ~ '^(https?://[^/]+)?/ar(/|$|\?|#)'));
  IF NOT EXISTS (SELECT 1 FROM jsonb_each_text(live) WHERE value::bigint > 0) THEN RETURN; END IF;

  SELECT result, started_at INTO marker FROM job_runs
   WHERE job = 'english_only_export' AND status = 'succeeded' ORDER BY id DESC LIMIT 1;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'English only (0035): this database holds content the migration deletes (%). Run "bun scripts/english-only-export.ts" first (docs/OPERATIONS.md, release 30).', live;
  END IF;
  IF marker.result -> 'counts' IS DISTINCT FROM live THEN
    RAISE EXCEPTION 'English only (0035): the export is out of date (exported %, now %). Run it again.', marker.result -> 'counts', live;
  END IF;
  -- content edited after the export (same count, other text): the five content tables, legal documents and campaigns
  IF EXISTS (SELECT 1 FROM notification_templates WHERE locale <> 'en' AND updated_at > marker.started_at
                AND created_at < date_trunc('milliseconds', transaction_timestamp()))   -- the rows the count reads
     /* … the same test for service_listings, content_pages, help_articles, reply_templates, legal_documents,
        and notification_campaigns with the predicate above … */ THEN
    RAISE EXCEPTION 'English only (0035): content changed after the export. Run it again.';
  END IF;
END $$;
--> statement-breakpoint
-- 2. Old addresses (§4.5): only slugs that no English row of the same kind uses.
INSERT INTO legacy_slugs (kind, slug, service_id)
SELECT 'service', l.slug, l.service_id FROM service_listings l
 WHERE l.locale <> 'en' AND NOT EXISTS (SELECT 1 FROM service_listings e WHERE e.locale = 'en' AND e.slug = l.slug)
ON CONFLICT (kind, slug) DO NOTHING;
--> statement-breakpoint
INSERT INTO legacy_slugs (kind, slug)
SELECT 'page', p.slug FROM content_pages p
 WHERE p.locale <> 'en' AND p.status IN ('published', 'noindex')
   AND NOT EXISTS (SELECT 1 FROM content_pages e WHERE e.locale = 'en' AND e.slug = p.slug)
ON CONFLICT (kind, slug) DO NOTHING;
--> statement-breakpoint
INSERT INTO legacy_slugs (kind, slug)   -- a help address starts with the article id (domain/help-slug.ts)
SELECT 'help', h.id::text FROM help_articles h WHERE h.locale <> 'en' AND h.is_published
ON CONFLICT (kind, slug) DO NOTHING;
--> statement-breakpoint
-- 3. Campaigns (§4.6): EVERY campaign, whatever its status, whose customer audience named no English reader. The audit rows
--    and the change read the same snapshot. A finished one is included: left with only its filter removed it would read
--    "all customers", and the console copies a stored audience into a new draft.
WITH hit AS (
  SELECT id, status IN ('scheduled', 'queued', 'sending') AS running FROM notification_campaigns
   WHERE jsonb_typeof(audience #> '{customers,locales}') = 'array'
     AND NOT (audience #> '{customers,locales}') ? 'en'
), noted AS (
  INSERT INTO audit_logs (actor_type, actor_name, action, entity_type, entity_id, entity_label, before, after)
  SELECT 'system', '',
         CASE WHEN hit.running THEN 'cancelled campaign (English only)' ELSE 'removed the customer audience (English only)' END,
         'notification_campaign', c.id, c.name,
         jsonb_build_object('status', c.status, 'audience', c.audience),
         jsonb_build_object('status', CASE WHEN hit.running THEN 'cancelled' ELSE c.status END, 'audience', c.audience - 'customers')
    FROM notification_campaigns c JOIN hit USING (id)
)
UPDATE notification_campaigns c
   SET status        = CASE WHEN hit.running THEN 'cancelled' ELSE c.status END,
       cancelled_at  = CASE WHEN hit.running THEN now() ELSE c.cancelled_at END,
       fanout_cursor = CASE WHEN hit.running THEN NULL ELSE c.fanout_cursor END,  -- as cancel() writes; cancelled_by stays NULL (the system)
       audience      = c.audience - 'customers',
       updated_at    = now()
  FROM hit WHERE c.id = hit.id;
--> statement-breakpoint
-- What still has the key listed 'en': those campaigns keep their customers and lose only the filter.
UPDATE notification_campaigns SET audience = audience #- '{customers,locales}' WHERE audience #> '{customers,locales}' IS NOT NULL;
--> statement-breakpoint
UPDATE notification_campaigns SET content = content -> 'en' WHERE content ? 'en';   -- { en: {title, body}, ar? } -> { title, body }
--> statement-breakpoint
-- 4. Legal documents (§4.4): one audit row per version that stays as history, then retire, then delete what nobody accepted.
INSERT INTO audit_logs (actor_type, actor_name, action, entity_type, entity_id, entity_label, before, after)
SELECT 'system', '', 'retired legal document (English only)', 'legal', d.id, d.type || ' ' || d.version,
       jsonb_build_object('isCurrent', d.is_current, 'locale', d.locale), jsonb_build_object('isCurrent', false, 'locale', d.locale)
  FROM legal_documents d
 WHERE d.locale <> 'en' AND EXISTS (SELECT 1 FROM consent_records c WHERE c.legal_document_id = d.id);
--> statement-breakpoint
UPDATE legal_documents SET is_current = false, updated_at = now() WHERE locale <> 'en' AND is_current;
--> statement-breakpoint
DELETE FROM legal_documents d
 WHERE d.locale <> 'en' AND NOT EXISTS (SELECT 1 FROM consent_records c WHERE c.legal_document_id = d.id);
--> statement-breakpoint
-- 5. Content in other languages (no table references these rows: A3 §0.7).
DELETE FROM service_listings       WHERE locale <> 'en';
--> statement-breakpoint
DELETE FROM content_pages          WHERE locale <> 'en';
--> statement-breakpoint
DELETE FROM help_articles          WHERE locale <> 'en';
--> statement-breakpoint
DELETE FROM reply_templates        WHERE locale <> 'en';
--> statement-breakpoint
DELETE FROM notification_templates WHERE locale <> 'en';
--> statement-breakpoint
UPDATE content_pages SET canonical_url = NULL WHERE canonical_url ~ '^(https?://[^/]+)?/ar(/|$|\?|#)';
```

No `UPDATE … SET locale = 'en'` on `customers` or `clients`: their column is dropped by 0039 and `updated_at` of people is not
touched. The guard compares jsonb values: `live` holds numbers, so the marker's `counts` must hold JSON integers (§4.2, point 1).
The migration writes no outbox event and invalidates no cache: no cache key holds a language (A3 §7.1), Typesense holds
English documents only, and the deploy restarts the API, the worker and the site. It rings no inbox recount either (`cancel()`
does, after its commit): the items of a cancelled campaign hide at the next read, and the restart reconnects every open bell,
which then reads its count again.

**Generated files 0036-0039** (the implementer reads what `bun run db:generate` wrote; a same-name constraint that changes its
columns must come out as drop, then add; fix the order by hand before the file is ever applied, and keep `db:check` green):

```sql
-- 0036 (B1)
ALTER TABLE "service_listings" DROP CONSTRAINT "service_listings_service_locale_uq";
ALTER TABLE "service_listings" DROP CONSTRAINT "service_listings_slug_uq";
ALTER TABLE "service_listings" DROP COLUMN "locale";
ALTER TABLE "service_listings" ADD CONSTRAINT "service_listings_service_uq" UNIQUE("service_id");
ALTER TABLE "service_listings" ADD CONSTRAINT "service_listings_slug_uq" UNIQUE("slug");
ALTER TABLE "service_categories" DROP COLUMN "name_ar";
-- 0037 (B2)
ALTER TABLE "content_pages" DROP CONSTRAINT "content_pages_slug_uq";
ALTER TABLE "content_pages" DROP COLUMN "locale";
ALTER TABLE "content_pages" ADD CONSTRAINT "content_pages_slug_uq" UNIQUE("slug");
ALTER TABLE "help_articles" DROP COLUMN "locale";
DROP INDEX "legal_documents_current_uq";
CREATE UNIQUE INDEX "legal_documents_current_uq" ON "legal_documents" USING btree ("type") WHERE "legal_documents"."is_current";
ALTER TABLE "legal_documents" ADD CONSTRAINT "legal_documents_locale_check" CHECK ("legal_documents"."locale" = 'en' or not "legal_documents"."is_current");
-- 0038 (B3)
ALTER TABLE "notification_templates" DROP CONSTRAINT "notification_templates_event_uq";
ALTER TABLE "notification_templates" DROP COLUMN "locale";
ALTER TABLE "notification_templates" ADD CONSTRAINT "notification_templates_event_uq" UNIQUE("event","channel","audience");
-- 0039 (B5)
ALTER TABLE "clients" DROP CONSTRAINT "clients_locale_check";
ALTER TABLE "clients" DROP COLUMN "locale";
ALTER TABLE "customers" DROP COLUMN "locale";
ALTER TABLE "reply_templates" DROP COLUMN "locale";
```

### 4.4 Legal documents: the one exception (critic G11)

A non-English version that a consent references is evidence and stays. Exactly:
- **Column values of a retired version:** `locale` unchanged (its language code), `is_current = false`, `updated_at` = the
  migration time; `type`, `version`, `body_md`, `effective_from`, `requires_reacceptance`, `created_by`, `created_at` unchanged.
  Its `consent_records` rows are not touched. A non-English version with no consent (a draft, or one nobody accepted) is deleted.
- **Rules from now on:** the CHECK `legal_documents_locale_check` (`locale = 'en' OR NOT is_current`); the partial unique index is
  one version in force per `type`; `legal_documents_version_uq (type, locale, version)` stays (an English and a retired version
  share the text `3.2`, fact 8). `POST /admin/legal-documents` takes no language and writes `en`. Publishing works on a draft
  only, so a retired version answers `409 NOT_A_DRAFT` as any replaced version does. `findCurrent(type)`, `retireCurrent(type)`
  and the publish lock (`pg_advisory_xact_lock` on the type) no longer take a language.
- **Where staff still see it:** `GET /admin/legal-documents` (it is one of the "earlier" rows: not current, `effectiveFrom` set;
  the row's read-only `locale` is not `en`; `acceptedCount` is its consents) and `GET /admin/legal-documents/:id` (its text). The
  console prints it only in the line under the Legal table: "Earlier versions kept for the record: … Terms of service v3.2
  (retired AR text), accepted 14 times". The label is the code in capitals; no select, filter, column or tab names a language.
- **Where nobody sees it:** `/store/v1/config`, `/store/v1/pages/<type>` and the checkout consents read versions in force, which
  are English by the CHECK. Evidence packs and the customer data export print type and version as before (fact 8).
- **Data today:** `gsm` has no legal row; in `gsm_storefront` the Arabic Terms 3.2 (the seeded consent proofs point at it) is
  retired, and English Terms 3.2 stays in force.

### 4.5 Old addresses: `legacy_slugs` and one public route

`src/modules/storefront/db/schema.ts` (module `storefront`, `additionalTables` in `scripts/module-map.mjs`):
`legacy_slugs (id, kind text CHECK in ('service','page','help') [LEGACY_SLUG_KINDS], slug text, service_id bigint NULL
REFERENCES services ON DELETE CASCADE, created_at, updated_at)`, `UNIQUE (kind, slug)` `legacy_slugs_kind_slug_uq`, CHECK
`legacy_slugs_service_check` (`service_id IS NULL OR kind = 'service'`), index `legacy_slugs_service_id_idx`. `fk(…, 'cascade')`:
an old address must never keep a service from being deleted. Nothing writes the table after the migration. The demo seed adds
two rows so the website's e2e can follow an old address: `('service', 'legacy-demo-service', <the service of a seeded listing>)`
and `('service', 'legacy-demo-gone', NULL)`. B1 keeps both as constants of `scripts/seed/storefront.ts` and names the seeded
listing's slug in its report, because the lead inserts the same two rows by SQL in L4.

`GET /store/v1/legacy-slugs/:kind/:slug` (public, the `ip` limiter, the cache headers of `GET /store/v1/pages/:slug`; row in
`scripts/map-additions/30.mjs`: surface `store`, group `content`, stage 30, tables `legacy_slugs`, `service_listings`, module
`storefront`, spec B224, success 200). `kind` is one of the three; `slug` 1-200 characters (for `help` only the leading id counts,
as on `GET /store/v1/help/:slug`). `200 { path, slug }`: for a service whose listing is on sale now (the rule that serves
`GET /store/v1/services/:slug`), `slug` is that listing's slug and `path` is `/services/<slug>`; for a service with no such listing
`slug` is null and `path` is `/services`; a page: `/`; a help article: `/help`. `404 NOT_FOUND` for an address that was never
retired. Paths carry no language prefix, like notification links. The website asks only after its own lookup found nothing (§7.1).

### 4.6 Campaigns (owner decision 4 makes everybody an English reader)

- A campaign of **any status** whose customer segment listed languages **without** `en` loses its `customers` segment: its
  readers were chosen by a language the system no longer has. Removing only the `locales` key is not enough: a segment with no
  filter means all of it (fact 9), so "Arabic readers" would read "every customer", and the console's Duplicate copies the
  stored audience of a sent campaign into a new draft. By status:
  - `scheduled`, `queued`, `sending`: also **cancelled** (`status = 'cancelled'`, `cancelled_at`, `fanout_cursor = NULL` as
    `cancel()` writes them; no `cancelled_by`: the system did it).
  - `draft`: stays a draft; it can reach no customer until staff choose a customer audience again (an audience left empty is
    refused at send by `audienceProblems`, code `empty`).
  - `sent`, `failed`, `cancelled`: the status stays. Who received it stays in its counters and in the `notifications` rows; the
    stored audience no longer names the customers, and a copy of it targets no customer until staff choose.
- Each of these gets one `audit_logs` row from the system with the audience before and after; the export file holds the whole
  row and its fate; the report names them, and the lead tells the owner which campaigns were changed, the finished ones too.
- A campaign whose list contained `en` only loses the `locales` key (required, fact 9: a stored key the schema no longer knows
  stops the fan-out). It now also reaches the people whose saved language was Arabic.
- Every campaign's `content` becomes `{ title, body }` (its English text). Arabic text survives only in the export file and in the
  audit rows that recorded it. An inbox item of a sent campaign renders from `content` at read time, so it shows the English text.

### 4.7 Constraints and indexes after the release

| Table | Before | After |
|---|---|---|
| `service_listings` | `service_listings_service_locale_uq (service_id, locale)`, `service_listings_slug_uq (locale, slug)` | `service_listings_service_uq (service_id)` (still the index behind the foreign key), `service_listings_slug_uq (slug)` |
| `content_pages` | `content_pages_slug_uq (locale, slug)` | `content_pages_slug_uq (slug)` |
| `notification_templates` | `notification_templates_event_uq (event, channel, audience, locale)` | `notification_templates_event_uq (event, channel, audience)` |
| `legal_documents` | `legal_documents_version_uq (type, locale, version)`; `legal_documents_current_uq (type, locale) WHERE is_current` | `legal_documents_version_uq` unchanged; `legal_documents_current_uq (type) WHERE is_current`; new CHECK `legal_documents_locale_check` |
| `clients` | CHECK `clients_locale_check` | gone with the column (and `CLIENT_LOCALES`) |
| `legacy_slugs` | | `legacy_slugs_kind_slug_uq`, `legacy_slugs_kind_check`, `legacy_slugs_service_check`, `legacy_slugs_service_id_idx` |

Code that names a constraint or a conflict target changes in the slice that owns the table: `listing-admin.service.ts:256,257,377`
and `listing.repository.ts:205,276` (B1); `content-page-admin.service.ts:184,228`, `content-page.repository.ts:149`
(`onConflictDoNothing` target `[slug]`), `legal-document-admin.service.ts:154` (B2); `TEMPLATE_UNIQUE` in
`notification-template.repository.ts:17-18` and the `ON CONFLICT` text of the SQL builders (B3; A3 §3).

### 4.8 The map's columns and `test/schema/structure.test.ts`

The map defines `locale` on seven tables. Six are dropped as a recorded deviation; `legal_documents.locale` stays as the map has
it. In the test: remove `'locale'` from `ADDITIONS.clients` (B5) and the entry `service_categories: ['name_ar']` (B1); add
`const REMOVED: Record<string, string[]>` ("map columns the backend dropped by decision 039, B224") with `service_listings`,
`content_pages`, `help_articles`, `notification_templates`, `reply_templates`, `customers` → `['locale']`, each entry added by the
slice that drops the column; the expected set subtracts `REMOVED[table]`; one new case asserts that every `REMOVED` column is a
column of the map for that table (so the list cannot rot) and that `legal_documents` still has `locale`. `docs/slices/*.json` are
built from the map and keep listing the six columns: that is the map, not the schema. The console generator gets the same six
names as an omit list (§8).

## 5. The wire, operation by operation (all 70; plus one new route)

Ruling for every row: **removed**, not kept as a constant. A constant `locale: 'en'` would be dead machinery on 70 operations and
in two frontends; the cost of removing is the lock step of §11, which the contract tests force for any console change anyway.
The one field kept is the read-only `locale` of a legal document row (§4.4). "First" says who must change first so nothing answers
`422` or drops data: **S** = the website stops sending before the backend refuses it (a strict list route); **C** = the same for
the console; **=** = console and backend change together (the parity tests fail otherwise); **B** = either order (the backend
strips unknown body and plain-query keys; the reader only loses a field). The lock step merges the website and the console
before the backend, so every row is safe.

| # | Operations | What is removed | First |
|---|---|---|---|
| 1 | `GET /admin/clients`, `POST /admin/clients`, `GET /admin/clients/{id}`, `PATCH /admin/clients/{id}` | response `locale`; PATCH body `locale` | = |
| 2 | `GET /admin/customers`, `POST /admin/customers`, `GET /admin/customers/{id}`, `PATCH /admin/customers/{id}` | response `locale`; POST body `locale` (required today), PATCH body `locale` | = |
| 3 | `GET /admin/content-pages`, `POST /admin/content-pages`, `GET /admin/content-pages/{id}`, `PATCH /admin/content-pages/{id}`, `POST /admin/content-pages/{id}/publish`, `POST /admin/content-pages/generate` | query filters `locale`, `locale_ne`; body `locale`; response `locale` (`created[].locale` on generate); the slug is unique for the site, `SLUG_TAKEN` text loses "in the locale" | = |
| 4 | `GET /admin/help-articles`, `POST /admin/help-articles`, `GET /admin/help-articles/{id}`, `PATCH /admin/help-articles/{id}` | query filters `locale`, `locale_ne`; body `locale`; response `locale` | = |
| 5 | `GET /admin/legal-documents`, `POST /admin/legal-documents`, `GET /admin/legal-documents/{id}`, `POST /admin/legal-documents/{id}/publish` | query filters `locale`, `locale_ne`, the sort `locale`; POST body `locale`. **Kept:** response `locale`, read-only (`en`, or the code of a retired version) | = |
| 6 | `GET /admin/service-listings`, `POST /admin/service-listings`, `GET /admin/service-listings/{id}`, `PATCH /admin/service-listings/{id}`, `POST /admin/service-listings/{id}/image` | query filters `locale`, `locale_ne`; POST body `locale`; response `locale`; `LISTING_EXISTS` = the service already has a listing, or the slug is taken | C (the pin picker sends `locale=en`: `FA/src/features/storefront/hooks/useSearchAdmin.ts:67`), then = |
| 7 | `GET /admin/service-categories`, `POST /admin/service-categories`, `GET /admin/service-categories/{id}`, `PATCH /admin/service-categories/{id}` | body and response `nameAr` | = |
| 8 | `GET /admin/notification-templates`, `POST /admin/notification-templates`, `GET /admin/notification-templates/{id}`, `PATCH /admin/notification-templates/{id}` | query filter `locale`; body `locale`; response `locale`; a second template for the same event, channel and audience is the `409` | = |
| 9 | `GET /admin/reply-templates`, `POST /admin/reply-templates`, `GET /admin/reply-templates/{id}`, `PATCH /admin/reply-templates/{id}` | query filter `locale`; body `locale`; response `locale` | = |
| 10 | `POST /admin/notification-campaigns`, `PATCH /admin/notification-campaigns/{id}`, `GET /admin/notification-campaigns/{id}`, `POST …/{id}/cancel`, `POST …/{id}/schedule`, `POST …/{id}/send` | `content` is `{ title, body }` (was `{ en, ar? }`) in body and response; `audience.customers.locales` | = |
| 11 | `POST /admin/notification-campaigns/audience-preview` | body `audience.customers.locales`; response `byLocale` | = |
| 12 | `POST /admin/notification-campaigns/{id}/preview`, `POST /admin/notification-campaigns/{id}/test` | body `locale` (required on preview); the fallback `note` text about Arabic | = |
| 13 | `GET /admin/inbox` | query `locale`; response `locale` | = |
| 14 | `GET /admin/stream` | query `locale`; `item.locale` in the `notification.created` frame | C (its parser must stop requiring `item.locale`, fact 15) |
| 15 | `GET /client/auth/me`, `PATCH /client/profile`, `GET /client/notifications`, `GET /client/stream` | response `locale`; profile body `locale`; notifications query `locale` and response `locale`; stream query and frame `locale` | S for the notifications query (`SF/components/notifications/notification-list.tsx:63`, critic G1) and the frame; B for the rest |
| 16 | `POST /store/v1/auth/verify`, `GET /store/v1/me`, `PATCH /store/v1/me` | response `locale`; PATCH body `locale` | B |
| 17 | `GET /store/v1/categories`, `GET /store/v1/services`, `GET /store/v1/services/{slug}`, `GET /store/v1/search` | query `locale` (a strict filter on the list); response `locale`; `alternates` on the service page; `category.name` is the one name | S for `GET /store/v1/services`; B for the others |
| 18 | `GET /store/v1/pages`, `GET /store/v1/pages/{slug}`, `GET /store/v1/help`, `GET /store/v1/help/{slug}`, `GET /store/v1/config` | query `locale`; response `locale`; `legalDocuments[].locale` in the config | S for the two lists; B for the others |
| 19 | `POST /store/v1/checkout-sessions/{token}/consents` | body `locale`; response `records[].document.locale` (the document is the version in force) | B |
| 20 | `GET /store/v1/me/notifications`, `GET /store/v1/me/stream`, `GET /store/v1/tickets/{token}/stream` | query `locale`; response and frame `locale` | S for the list query and the frames |
| new | `GET /store/v1/legacy-slugs/{kind}/{slug}` | (added, §4.5) | backend, then the website |

Rows 1-14 are 50 operations, row 15 is 4, rows 16-20 are 16. Also changed, outside the OpenAPI operations: the live frames
(`docs/contract/realtime-events.md`: no `locale` in an inbox item), the customer data export (`EXPORT_FORMAT` 2, no
`profile.locale`), and the fixed text of `SLUG_TAKEN` and `LISTING_EXISTS`. Other senders of a `locale` query today, to change with
the rows above: `SF/e2e/admin.ts:390`, `test/load/search.ts:99`, `test/load/realtime-connections.ts:270`,
`test/contract/harvest/plan.mjs:167-181`. Machine surfaces (Dhru, REST `/v1`, webhooks, events, supplier calls) carry no language
and do not change (`docs/contract/openapi.public.json`: 0 hits; A4 §1).

## 6. Backend, by area (file lists: the audit sections named; each slice of §10 owns one area)

**6.1 Listings, public catalog, categories, search gates (B1; A3 §2.8-2.9, A4 §3.7-3.8, §3.10).** One listing per service:
`siblingFacts`, `lockServiceListings` over several rows, `findSiblingSlugs`, `alternates`, `appliedToLocales`, the `locale`
parameter of `listedServiceIdsIn`, `publicWhere`'s default language and both copies of `STOREFRONT_LOCALES`/`DEFAULT_LOCALE`
disappear; the facts (brand, carrier, country, featured, sort, picture) simply live on the row. `listedServiceIds` now means "has
a listing that is on". `englishOnly()` and the `locale=ar` ILIKE branch of `storefront-catalog.service.ts:238,269,373,505-508` go:
with `q` the engine answers, and the Postgres path is only the fallback of decision 038. Category cards and the menu use `name`;
`categoryNameAr`/`nameAr` leave `catalog` (5 files) and `scripts/seed/catalog.ts:50-60`. The legacy route of §4.5 is new:
`contracts/legacy-slugs.contracts.ts`, a method on the public catalog service, `infra/legacy-slug.repository.ts`, the controller
route, the seed rows. Comments that name the Arabic exception in `search/**` are rewritten (A3 §11).
**6.2 Pages, help, legal, consent (B2; A3 §2.3-2.5, A4 §3.7).** Slug uniqueness for the site; the page generator no longer
names a language; `findLivePage(slug)`, `listArticles` and `findServiceFaqs` without a language; legal as §4.4 (`FALLBACK_LOCALE`,
`currentWithBody(type)`, `legalLabel` without `(EN)`); `consent.service.ts` takes the version in force of the type;
`contracts/shared.ts` `LocaleField` and `domain/locales.ts` are deleted here (their last users). Seeds: `scripts/seed/storefront.ts`
writes no language and **skips a demo legal row whose `lang` is present and not `EN`** (right with the console's demo file before
and after C3 edits it); `scripts/seed/b2c.ts:163-169` then finds one version in force per type.
**6.3 Templates, delivery, recovery (B3; A4 §3.1-3.2, A3 §2.6, §7.3).** Delete `arabic-templates.ts` and its spec, the exports in
`platform/index.ts:168-174` and `ARABIC_TEMPLATES_MIGRATION`. `findTemplateFor(event, channel, audience)` reads one row;
`activeTemplateLocales`/`writableLanguages` become "is the template on"; `dueRecoveryIds` loses its language list
(`customers/infra/recovery.repository.ts:188-208`, `recovery-queue.ts:78-106`, `recovery-sweep.ts:50-66`). `rtlHtml` is deleted
(an event mail is plain text). `checkLocale`, the `LOCALE` pattern and `locale` in `FIXED_FIELDS` go. Default rows: `identity-templates.ts` keeps 8,
`customer-wallet-notifications.ts` 5, `support-templates.ts` loses `CONVERSATION_LINK_LINES.ar` (`supportReplyLinkSql` prints 2
updates); `SECURITY_NOTICE_PHRASES` is one sentence per kind. **The specs that pinned code to the text of applied migrations** (`identity-templates.spec.ts:107-115`,
`customer-wallet-notifications.spec.ts:51-53`, `support-templates.spec.ts:111-117`, `default-templates.spec.ts`) cannot stay
equalities (the files keep their Arabic rows and their `"locale"` column): each becomes "every default row of the code is found,
by event, channel, audience, subject and body, in the applied file that shipped it". The SQL builders print the new shape (no
`locale`, conflict target `(event, channel, audience)`) for the seed and the test support.
**Three seams B3 leaves exactly as they are, for B4** (their last users are files of B4, so changing them here would break
B3's `typecheck`): (1) `Recipient.locale` and its reads (`notification-foreign-reads.ts:22-23,71,84,105,118,133`); (2) the
`locale` of an inline send (`enqueueInline`, `notification.service.ts:165-184`, and `sendInline`,
`notification-delivery.ts:297-315`); (3) the second parameter and the Arabic branch of `emailHtml`
(`template-rules.ts:249-264`, its spec `:165-175`). B3 only stops *using* a language in its own code: the template lookup, the
recovery selection and the event delivery.
**6.4 Inbox, live streams, campaigns, audiences (B4; A4 §3.3-3.5).** Built-in inbox texts and campaign content are
`{ title, body }`; no `locale` in an inbox view, list query or frame; the four stream routes take no `locale`
(`infra/realtime/realtime.types.ts:25-26`, `identity/realtime/*`, `support/contracts/ticket-live.contracts.ts:64`). Campaigns:
`CAMPAIGN_LOCALES`, the `locales` segment, the `arabic` flag of the three audience sources, `byLocale`, the preview and test
`locale`, the Arabic footers of `campaign-render.ts:111,117` and the Arabic example of `campaign.contracts.ts:122-123` go.
**B4 removes the three seams B3 left (§6.3), each with its last users:** `Recipient.locale` with `inbox/inbox.service.ts:71` and
`inbox/inbox-realtime.source.ts:258,274`; the inline `locale` with `campaigns/campaign-send.service.ts:223` (a new row's payload
holds `variables` only; old rows keep what they recorded, §4.1); the second parameter of `emailHtml` with
`campaigns/campaign-render.ts:88,124`. After B4 `emailHtml(text)` has one parameter and only its `dir="ltr" lang="en"` wrapper
(campaign and inline mails, critic G6), and no file of `platform/notifications` reads a language. B4 runs before B5, so the
directory stops reading `clients.locale` and `customers.locale` before those columns are dropped.
**6.5 Accounts and reply templates (B5; A3 §2.1-2.2, §2.7, A4 §3.6, §3.9).** `clients.locale`/`CLIENT_LOCALES` and
`customers.locale`/`CUSTOMER_LOCALES`/`LocaleField` leave contracts, views, the detail editors and their audit diffs;
`customer-export.ts` drops `profile.locale` and sets `EXPORT_FORMAT = 2`; reply templates lose `TEMPLATE_LOCALES` and the field.
Seeds `customers.ts` and `support.ts` write no language.
**6.6 Tooling for routes beyond the map (B0; ruling: the smallest change that stops requiring Arabic).** In
`scripts/lib/map-additions.mjs` the Arabic sentence `f` becomes optional: a row without it gets `f = en`, so every consumer of
`descriptionAr` keeps working; `scripts/build-contract-docs.mjs:254` prints the bracket only when the two sentences differ. In
`scripts/lib/map.mjs` `ACCESS` also accepts English auth words for new rows (the access names themselves: `public`,
`public + Turnstile`, `staff-session`, `merchant-session`, `customer-session`, `checkout-token`, `tracking-token`, `link-token`,
`ticket-token`). `scripts/map-additions/README.md` says so; `test/unit/map-additions.test.ts` gets the two cases. **Existing
generated documents:** nothing is rewritten. `docs/route-manifest.json`, `docs/slices/*.json` and `docs/contract/endpoints/*.md`
keep the map's Arabic for the map's 382 endpoints and for the 97 rows already added (they regenerate byte for byte); the row of
feature 30 and every later row are English only. The generated documents are not among the guard's roots, and `scripts/map-additions/{20..29}.mjs` are on its allowlist (§9.4).
**6.7 Docs that describe the product (B6).** Module READMEs (`platform`, `storefront`, `storefront/search`, `identity`,
`customers`, `catalog`, `support`, `money`, `infra/db`, `infra/realtime`), `docs/queues.md:174,228,516`,
`docs/contract/realtime-events.md`, `docs/ROADMAP.md:42,70`, `docs/OPERATIONS.md` (§11), `scripts/table-descriptions.en.mjs`,
`deploy/Caddyfile:35` (comment), the map quote in the comment at `test/scenarios/manual.e2e.test.ts:75`, and the TSDoc lines that
quote the map's Arabic in `money/domain/money-events.ts`, `suppliers/contracts/supplier-calls.contracts.ts` and
`storefront/domain/page-generator.ts:140` (English wording instead).
**The generated contract documents are never edited by hand** (fact 22): `RULES.md`, `ANSWERS.md`, `MISMATCHES.md`,
`error-codes.md` and `endpoints/*.md` change only through their sources; a note typed into one of them fails `contract:check` and
is overwritten by the next `contract:docs`. The rulings are the lead's and are in before round 1 (L0: B224-B227 and six
answers). B6 edits the hand-written extraction, `docs/contract/extraction/b2c-storefront-support.json`, `ops-risk-refunds.json` and
`auth-access.json`: every `summary`, `businessRules`, `query`, `request`, `response` and `errors[].when` text that states a
language rule is rewritten to the English-only rule. The rendered lines are in A4 §10: `RULES.md` 364, 371, 374, 383-384, 393,
464, 502; the `SLUG_TAKEN` meaning (`auth-access.json:2306`, rendered at `error-codes.md:105`); the `locale (en|ar)`, `nameAr` and
`{ en, ar }` mentions of the operations of §5. Rule 10 of the storefront feature becomes "English only (decision 039, B224): no
language field; `locale` is an unknown key". Not touched there: any `mapConflict` (none added, removed or moved: the B-numbers
count them), any `questions[]` entry (the lead's overrides answer them) and the console's `mismatches` notes (its history).
Then `bun run contract:docs`; `bun scripts/build-contract-docs.mjs --check` is green.

## 7. Website (`SF/`; Next 16.4: read the guide in `node_modules/next/dist/docs/` before touching routing, caching or `proxy.ts`)

### 7.1 Old links keep working

One rule in `next.config.ts`: `redirects()` returns `{ source: "/ar/:path*", destination: "/en/:path*", permanent: true }`
(308; it also matches `/ar` alone; the query is passed on; it runs before `proxy.ts`, fact 14). Nothing else knows `/ar`, except the
two validators below.

| Old address | What it does after the release |
|---|---|
| `/ar`, `/ar/<any static path>` (services, help, track, imei-check, support, checkout, account…, merchant…, sign-in, sign-up…) with any query | 308 to the same path and query under `/en` |
| Token and code links under `/ar`: `/ar/track/<token>`, `/ar/support/tickets/<token>`, `/ar/checkout/<token>`, `/ar/checkout/resume?token=`, `/ar/unsubscribe?token=`, `/ar/set-password?token=`, `/ar/verify-email?token=`, `/ar/merchant/set-password?token=`, `/ar/merchant/register?ref=` | 308 with the token or code intact; the English page behaves as today |
| Links the backend writes (no language segment): `/sign-in?token=`, `/set-password?token=`, `/verify-email?token=`, `/checkout/resume?token=`, `/unsubscribe?token=`, `/support/tickets/<token>`, `/merchant/support/<id>`, `/account/wallet?topUp=`, the referral link `/merchant/register?ref=` | `proxy.ts` sends them to `/en…` (307, query kept) as today, now without reading a cookie or `Accept-Language` |
| `/ar/services/<slug>` whose slug is also an English slug | 308, the English page |
| `/ar/services/<arabic slug>` | 308 to `/en/services/<slug>`; the page finds no listing and asks `GET /store/v1/legacy-slugs/service/<slug>`: it sends the reader on (inside the page, see "Statuses" below) to `/en/services/<english slug>` of the same service, or to `/en/services` when that service has no page on sale; an address that was never one: the not-found page |
| `/ar/checkout?service=<arabic slug>` | 308; the checkout's existing `redirect` branch (`checkout/page.tsx:78-81`) follows the same answer to `/en/checkout?service=<english slug>`; with no English page: its "service not found" state |
| `/ar/pages/<slug>` | a legal type (`terms`, `privacy`, `refund`, `cookies`) or a slug that exists in English: the English page; an Arabic-only page: `legacy-slugs/page/<slug>` → sent on to `/en` (an Arabic page has no known English twin and the site has no page index); otherwise the not-found page |
| `/ar/help/<id>-<words>` | an English article with that id: shown; a deleted Arabic article: `legacy-slugs/help/<slug>` → sent on to `/en/help`; otherwise the not-found page |
| `?next=/ar/account/…` on a sign-in address (bookmarks, old proxy redirects) | `safeNext` (`components/auth/safe-next.ts:6-9`) rewrites a leading `/ar` to `/en`, then applies its usual checks |
| A stored notification `link` that starts with `/ar` | `notificationHref` (`lib/notifications/link.ts:46,56-73`) maps it to `/en` |

The lookup lives in one place: `resolveService(slug, currency)` returns `found`, `redirect` (with the slug or the path the API
gave) or `missing`; `services/[slug]`, quick view and checkout use it; `pages/[slug]` and `help/[slug]` call a small
`legacyPath(kind, slug)` (`lib/api/public.ts`, `'use cache'`, `cacheLife('content')`) before `notFound()`. Redirects out of a legacy
answer use `permanentRedirect`. The cookie `gsm_locale` is no longer read or written; a browser that still has it loses nothing.

**Statuses, exactly.** Only the first hop is an HTTP redirect: `/ar/…` to `/en/…` is a 308 from `next.config.ts`, for every
Arabic URL. What a slug page decides next comes after its shell is sent (fact 23), so `permanentRedirect` there reaches the
browser as an instant redirect written into a 200 answer (Next's meta tag; a client-side navigation when the page is opened from
a link), and `notFound()` as the not-found content, as on these pages today. `generateMetadata` already answers
`robots: { index: false }` whenever the slug is not found (`services/[slug]/page.tsx:43`, `pages/[slug]/page.tsx:26`,
`help/[slug]/page.tsx:34`; S4 keeps the three lines and a test pins them), so the in-between answer is never indexed; a search
engine reads an instant meta refresh as a permanent redirect. **Considered and not built:** a real 308 for the second hop, either from a list loaded into `redirects()`
at build time (stale as soon as staff rename an English slug or switch a listing off, and it needs a list route) or from a
lookup in `proxy.ts` (an API read, or a cache to keep fresh, on every page request). No production database exists, so outside
the two development databases `legacy_slugs` is empty; the hop that every Arabic URL takes is the real 308.

### 7.2 Language core (slice S3; the `[lang]` folder itself moves in §7.8)

`lib/i18n/config.ts`: `Locale` is `"en"`; `LOCALES`, `DEFAULT_LOCALE`, `LOCALE_COOKIE`, `isLocale`, `dirOf` and `switchLocalePath`
are deleted; `intlLocaleOf` answers `"en-US"`; `localePath` stays for now; `CURRENCY_COOKIE` moves to `lib/currency.ts` (4
importers, A1 §1.3). `lib/i18n/server.ts`: `getLocale()` returns the constant without `next/root-params`. `lib/i18n/define.ts`:
`defineMessages({ en })`; `plural` keeps `one`/`other` (and `zero`, which English strings use). `app/[lang]/layout.tsx`:
`generateStaticParams` returns `[{ lang: "en" }]`, any other value is `notFound()`, static English `metadata`.
`proxy.ts`: a first segment other than `en` goes to `/en<path>` (307, query kept); the private-area fast path is unchanged.
Once `Locale` is one literal, `tsc` reports every typed leftover (`locale === "ar"`, `errors.ar`, `otherLocale()`); A2 §1.1 lists
what `tsc` cannot see (two path patterns, the metadata literals, comparisons with API strings, CSS, computed direction).
Removed with their callers: the language switcher (`components/layout/language-switcher.tsx` + test; render sites
`store-header.tsx:158,171`, `checkout-header.tsx:35`, `auth-shell.tsx:73`), the customer "Language" select
(`components/account/preferences-form.tsx:80-90`, `account/settings/page.tsx:120`, the row at `account/page.tsx:143`), the merchant
"Language of our emails" select (`components/merchant-settings/profile-form.tsx:196-205`, `merchant/settings/page.tsx:53,57`), the
"not listed in this language" cards (`checkout/page.tsx:95-110`, `checkout/resume/page.tsx:98-104`), the Arabic empty states
(`services/page.tsx:71-83`, `help/page.tsx:107-111`), the Arabic branches of A2 §2 A4 (`bell.tsx:60-61`,
`merchant-settings/format.ts:9-11`, `lib/quantity.ts:126-129`, `unreadTextInline`'s isolate), Turnstile `lang` (always `en`).
**What `tsc` reports is S3's.** S3 ends with `npm run typecheck` green, so it also makes the smallest edit in five places that
only the wire slice would otherwise touch, because they call the deleted helpers or hand an API language to `Locale`:
`help/[slug]/page.tsx:19,69,80` (no `lang`/`dir` on the article: the page's direction), `notification-list.tsx:15,154` (the
same), `components/ui/toast.tsx:4,9,23-24,28,46,48,94` (a toast has no `lang` field) with `notification-stream.tsx:59` (none
passed), and `lib/realtime/browser.ts:9,49-54,82` (`pageLocale()` goes and line 82 falls back to `() => undefined`: the three
streams send no `?locale=`, which today's API answers in the saved language, fact 4; the option itself and the member of
`StreamEnv` stay for S4, so nothing else has to change here). Any other line `tsc` reports in a file of S4 is handled the
same way and named in S3's report. S4 then removes what still compiles but talks about a language (§7.7).

### 7.3 Messages (S3)

Delete the `ar` block of the 14 files of `lib/i18n/messages/` and of the `kit` namespace in `(store)/ui-kit/page.tsx` (line
ranges: A2 §1 table), and the language keys left in the `en` blocks (A2 §1 last column; A1 App. I): `languageNames`, `language`,
`otherLanguage*`, `arEmpty*`, `service.otherLanguage`, `help.noneAction`, `profile.emailLanguage*`, the "in this language"
wording of `help.noneTitle/noneText`, the stray `two/few/many` forms. No English sentence changes meaning.

### 7.4 Layout, fonts, CSS (S3)

`<html lang="en" dir="ltr">`. `IBM_Plex_Sans_Arabic` and `--font-plex-arabic` go (`layout.tsx:5,22-31,76`, `globals.css:70`); so
do the `Inter Latin Fallback` face (`globals.css:293-307`) and the `html:lang(ar)` block (`:309-332`). `global-not-found.tsx` loses
its Arabic sentence and the `/ar` link (`:17,23-24`). One Google font remains (`docs/DEPLOY.md:64`).

### 7.5 Right-to-left code (S5)

All 37 `rtl:` variants (29 files, A1 App. E), `:root[dir="rtl"]` and the `--inline-dir` variable (`globals.css:264-281` and its
16 uses, `home-parts.tsx:43`: the constant 1), the mirrored banner art (`components/store/banner.tsx:47-68`), and the three
places that read the page's computed direction (`components/ui/segmented-control.tsx:57-60`, `components/ui/menu.tsx:41-43`,
`components/search/ghost-text.tsx:16-18`). Logical utilities (`ms-`, `pe-`, `start-`…) stay: they are plain Tailwind. **Not
touched:** every `dir="auto"`, `<bdi>`, `dir="ltr"` on codes and numbers, `ltr()` isolates (group C, §9.5).

### 7.6 Metadata, sitemap, robots, canonical (S3)

No `alternates.languages` anywhere (root layout `:51`, the five page literals and the loop in `services/[slug]/page.tsx:44-58`;
A1 §1.7); `openGraph.locale` is `en_US`. Every indexable page keeps naming its own `/en/…` address as canonical (a staff-entered
`canonicalUrl` of a content page still wins; the migration cleared the ones that pointed under `/ar`). `app/sitemap.ts`: English
addresses only, no `alternates`, one `allListedServices()` read. `app/robots.ts` is unchanged, and `/ar` is **not** disallowed:
a crawler must be able to fetch an old Arabic address to see its 308.

### 7.7 The wire (S4)

No `locale` in any request: the reads of `lib/api/public.ts:58,72,82,96,114` and `lib/api/store-query.ts:80`, the live re-read
of `checkout-form.tsx:169`, the consents body of `session-view.tsx:243`, `notification-list.tsx:63` (critic G1), and what is left
of the stream option (`lib/realtime/browser.ts:45-46,82`, the `locale` member of `StreamEnv` and `stream-client.ts:463-464`; S3
already removed `pageLocale()`, §7.2).
No read of `me.locale`, `alternates`, `article.locale`, `item.locale`, `doc.locale`: `lib/realtime/events.ts:50,68` must accept a
frame without `locale` (today it drops it); the three places that showed a text in its own language
(`notification-list.tsx:154`, `toast.tsx:94`, `help/[slug]/page.tsx:69,80`) already follow the page since S3. The search gates
are always true (`store-header.tsx:50`, `lib/catalog.ts:146-152`, `lib/catalog-facets.ts:229-232`); `searchStoreServices`
(`lib/api/visitor.ts:14-19`) goes when nothing calls it. `lib/api/schema.gen.ts` is only ever regenerated: S4 runs
`npm run gen:api` with `GSM_OPENAPI=/home/saifi/gsm-project/.english-only/openapi-after-B2.json`, the copy the lead takes when B2
is done (the file inside `../backend-30` is being rewritten by B3 at that time). That copy still has `locale` on the routes B4
and B5 change (rows 15, 16 and 20 of §5), so S4 removes those reads by the list of §5, not by what `tsc` reports; the lead
regenerates from the final file at L2, where a type error is a missed read. `e2e/admin.ts:390,722,749` follow the new staff
contract.

### 7.8 The cleanup wave (S6-S9, after the lock step is merged; no URL, text or behaviour changes)

What is left after §7.2 is a constant passed around: 184 files with a `locale` identifier. It is removed in four steps, each
ending green:
1. **S6, library functions.** Every exported function of `lib/**` loses its `locale` parameter and every call site loses that
   argument (`formatMoney(amount, currency, decimals?)`, `formatDate(iso, options?)`, `plural(count, forms)`, `countryName(code)`…);
   `localePath(locale, path)` becomes `sitePath(path)` (`lib/site-path.ts`, the one place that knows `/en`); `intlLocaleOf` becomes a
   constant. A signature and its call sites change together, so this step cannot be split by folder; it is done with a throwaway
   script over the TypeScript syntax tree (the `typescript` package is already installed; the script stays in the agent's scratch
   folder) and finished with `tsc`. About 20 definition files and well over 100 files with one deleted argument.
2. **S7, shared components** (`components/{ui,layout,notifications,store,search,forms}`, `turnstile.tsx`): the `locale` prop goes
   from each component and from every JSX that passed it.
3. **S8, feature components** (`components/{merchant,merchant-settings,wallet,support,auth,account,checkout}`): the same.
4. **S9, pages and the folder.** `getLocale()` and `getMessages()` go (a message namespace is a plain object:
   `export const store = { … }`; `defineMessages`, `Namespace`, `Locale` and `lib/i18n/server.ts` are deleted; the 11
   `(typeof x)["en"]` types become `typeof x`). `app/[lang]` is renamed to **`app/en`** (a plain folder; its `layout.tsx` stays
   the root layout, which Next allows, fact 14; no `params`, no `generateStaticParams`); the 45 typed route strings (A1 App. D)
   and the three folder-walking tests follow. `app/global-not-found.tsx` and its flag stay as they are: the 404 path does not
   change. The lead runs `next build` and the full e2e.

### 7.9 Group C in the website (kept; §9.5 protects it)

`dir="auto"` on text people type (39 lines, 24 files, A1 App. H1), `<bdi>` around values of the API (38 lines), `dir="ltr"` on
codes and numbers, `normalizeImei`, `parseQuantityInput`, `parseAmountInput` and the order-input parser (Arabic-Indic and Persian
digits typed on an Arabic keyboard), the IME guard of `ticket-reply-form.tsx:178`, avatar initials for a name in any script, the
`cleanText` pass-through of an Arabic search query. S5 rewrites the two literal digit classes (`lib/quantity.ts:96-97`,
`lib/merchant/money-math.ts:88-90`) as escapes of the code points U+0660 to U+0669 and U+06F0 to U+06F9, as
`lib/format/index.ts:110` already does, and the four comments that show Arabic script as an example
(`lib/format/index.ts:104`, `components/ui/avatar.tsx:17`, `lib/countries.ts:39`, `lib/store/delivery.ts:36`) in words or code
points, so no product file contains Arabic script.

## 8. Console (`FA/`)

The interface is already English; the work is to remove language fields from the content it manages. **Controls removed (14):**
the "Language" select of the help article, content page, new legal version and add-listing dialogs
(`storefront/components/{HelpDialog,ContentPageDialog,LegalVersionDialog,ListingCreateDialog}.tsx`, fed by `LOCALE_OPTIONS`,
`lib/kinds.ts:47-51`); "Language" in add and edit customer (`customers/components/{Add,Edit}CustomerDialog.tsx`), edit merchant
(`merchants/components/EditMerchantDialog.tsx:114-119`), the notification template dialog
(`settings/components/TemplateDialog.tsx:96-101`), the reply template dialog (`support/components/TemplateDialog.tsx:84-89`) and
the test-send dialog (`notifications/components/TestSendDialog.tsx:46-55`); "Arabic name (storefront)"
(`services/components/CategoryDialog.tsx:98-106`); the English/Arabic tabs of the composer and of the campaign preview
(`MessageFields.tsx:43-84`, `CampaignContent.tsx:52-94`: one title, one text); "Language they read"
(`CustomerSegment.tsx:49-63`). **Columns removed (4):** "Language" in the listings, landing pages, static pages and reply
templates tables (`ListingTable.tsx:128-133`, `LandingTable.tsx:85-89`, `PagesPanel.tsx:48-52`, `TemplatesTable.tsx:43`).
**Text places:** the language line and the "(English)" in the accessible names of the legal table and its dialogs
(`LegalTable.tsx:40,82`, `PublishLegalDialog.tsx:19`, `LegalVersionDialog.tsx:64`), the merchant profile row (`ProfileTab.tsx:65`),
the audience count row and sentence (`AudienceCount.tsx:47`, `lib/audienceText.ts:61,70-71,132-134`), the template caption
(`settings/lib/templates.ts:64-68`), the macro picker suffix (`MacroPicker.tsx:23`), the edit-listing sub-title, the "every
language of this service" hints (A5 §3.2), and "listed English service" in the Search tab (it becomes "listed service";
`useSearchAdmin.ts:67` sends no `locale`).
**Legal page (the exception of §4.4):** `LegalDocument` keeps `locale` read-only; `legalLanguage` is deleted; the footnote of
`LegalPanel.tsx:59-70` prints `Terms of service v3.2 (retired AR text), accepted 14 times` for a row whose `locale` is not `en`
(the code in capitals, no language name in the source); `versionInForce` matches the type only.
**Right-to-left code (10 files):** `dir="rtl"` in `CategoryDialog`, `MessageFields`, `CampaignContent`, `InboxItemRow`,
`ListingEditDialog` and its two field groups; the `rtl` argument of `components/ui/Tabs.tsx:23-29,54-56`; `rtl:` in
`app/layout/Sidebar.tsx:42` and `suppliers/components/SupplierCharts.tsx:20`; `styles/index.css:735-737` (A5 §3, §5).
**Types, API functions, mocks:** the 15 wire rows of A5 §2 follow §5 of this brief (the campaign `content` is `{ title, body }`);
`mocks/http.ts` `LOCALES` and the per-language rules of the mock routes go (A5 §3.2-3.7); the stream parser accepts an item
without `locale` and `browserEnv.ts:18-23,40` sends none. **Generated row types:** `scripts/gen-entity-types.mjs` gets an omit
list ("map columns the backend dropped, decision 039": the six of §4.8; `legal_documents.locale` stays) and
`src/lib/api/schema.gen.ts` is regenerated; `scripts/table-descriptions.en.mjs:73,74,92` lose "per language".
**Demo data:** `src/mocks/seed/demo-state.json` is edited by a small script, never by `seed:extract` (the read-only demo would
bring the values back): `customers[].locale`, `legal[].lang`, `listings/landing/pages[].langs` are removed and the Arabic legal row
lg2 is deleted; `scripts/extract-demo-seed.mjs` applies the same normalisation so a later extract cannot undo it;
`notifications/mocks/seed.ts` loses its Arabic campaign texts and inbox item; `customers/mocks/store.ts:48,193` and
`refunds/mocks/{demoTypes,evidence}.ts` stop testing `lang` (A5 §7).
**Group C, added:** `support/components/MessageBubble.tsx` renders the message body with `dir="auto"`, so a customer's Arabic
message reads correctly (the console had no handling at all, A5 §6); one test.
**Docs:** the three feature HANDOFF files, `docs/ASSUMED_CONTRACTS.md`, `docs/briefs/customers.md`, `PROGRESS.md:10` get a dated
note; `docs/MISMATCHES.md` gets **M264** ("English only: language fields removed; the map still lists `locale` on six tables; the
legal row keeps it read-only"). `docs/route-manifest.json` keeps the map's Arabic (the map is the owner's specification).

## 9. Tests

### 9.1 The rule for every Arabic test

An Arabic test is deleted only when the slice report names the English test that covers the same behaviour; otherwise it is
**ported** (the same steps on English data) before it is deleted. A test that mixes both keeps its English half. A test that uses
Arabic text as *data* (group C) is never deleted, trimmed or "neutralised". The report of a slice lists: deleted (with the twin),
ported, kept as group C.

### 9.2 Backend

- **Deleted whole:** `platform/notifications/arabic-templates.spec.ts`, `support/application/support-templates-ar.spec.ts`,
  `test/integration/listing-locale-filter.test.ts` (the filter no longer exists; its one English case moves into
  `storefront-listings.test.ts`).
- **Ported, because the Arabic case was the only cover of a rule:** recipient status of a mail whose template is off or missing
  (`notification-recipient-status.test.ts:126-167`) and delivery by template (`notification-delivery.test.ts:163-191`) on English
  templates; the recovery sweep's "no active template, no mail" (`growth-recovery-jobs.test.ts:233-253,419-431`,
  `growth-abandoned.test.ts:407-425`); the merchant security notice and lifecycle mails (`merchant-lifecycle-mails.test.ts:89-111,
  201,236`); "the facts of a service are written once" and the picture (`storefront-listings.test.ts:897-951`,
  `storefront-images.test.ts:80,219,265`: one row now); a second listing for a service and a taken slug are `409 LISTING_EXISTS`;
  a taken page slug is `409 SLUG_TAKEN`; one template per event, channel and audience is the `409` of
  `notification-templates.test.ts`.
- **Trimmed** (the lists: A3 §8.3, A4 §8.1-8.2): the storefront, notification, account, campaign and realtime tests and specs of
  each slice, the helpers `test/support/{storefront,growth,store,campaigns,stream,notifications,support,identity-mail,
  customer-wallet}.ts`, the seed tests (`storefront-seed.test.ts`: 6 versions, 4 in force; `notification-seed.test.ts`,
  `customers-seed.test.ts`), `test/scenarios/b2c-account.e2e.test.ts:68`. The 13 scenarios do not depend on a language.
- **New:**
  - `test/integration/english-only-migration.test.ts` (B0): a scratch database (a name that ends in `_test`, created and dropped
    by the test as `test/integration/db-reset.test.ts` does with `recreateDatabase`, the guard forced on with
    `ALTER DATABASE … SET gsm.english_only_guard = 'on'`). (a) A fresh database migrated from zero to the newest file in one run
    passes the guard with no marker and ends with no non-English template. (b) Migrated to 0034 from a temporary copy of
    `drizzle/`, filled with raw SQL (non-English rows in each table of §4.1; a legal version with a consent and one without; an
    English and another-language version both in force; a campaign of each fate of §4.2, among them a **sent**, a failed and a
    cancelled one for `['ar']`; a listing whose service has no English listing; a page with an `/ar` canonical), then migrated
    on: without a marker it fails with the "Run … english-only-export" message and changes nothing; after the export it passes,
    and every line of §4.1, §4.4, §4.5 and §4.6 is asserted, including the audit rows, that a finished campaign for `['ar']`
    keeps its status and has no `customers` key, that a cancelled running one has `fanout_cursor` null, and that the people
    rows kept their `updated_at`. (c) A row added, and a row edited, after the export: "out of date" and "changed after the
    export". (d) A document type whose only version in force is not English: the "publish an English version" refusal.
    **After the migration every assertion goes by id** (the ids of the deleted rows are gone, the ids of the kept rows are
    there), never by a language column: the file has to stay valid while 0036-0039 drop those columns. It always fills at 0034
    and migrates to the newest file, and B1, B2, B3 and B5 run it (§10).
  - `test/integration/english-only-export.test.ts` (B0): the file holds every column of every row of (b); `counts` are JSON
    integers and equal the guard's `live` on the same data (the test runs the guard's expression); `--check` writes nothing; a
    second run writes a second file and a second marker; a database with nothing to export writes no marker; `--out` left out,
    a folder that does not exist and one that cannot be written: exit 1, nothing read, no file, no marker; a database below
    0033 and one past 0035: exit 3. The database it exports is always the scratch one at 0034.
  - `test/integration/storefront-legacy-slugs.test.ts` (B1): each kind; a service with a listing on sale, with a listing switched
    off, deleted (the row is gone: 404); a row with no service (`/services`); `422` on an unknown kind; no query key accepted.
  - Legal (B2), in `storefront-legal-documents.test.ts`: a retired non-English version is listed among the earlier rows with its
    `locale` and `acceptedCount`, `GET :id` shows its text, publish is `409 NOT_A_DRAFT`, the CHECK refuses to make it current,
    `POST` writes `en`, `/store/v1/config` and `/store/v1/pages/terms` never show it, a consent on a new checkout references
    the English version.
  - Campaigns (B4), in `notification-campaigns.test.ts`: the detail of a finished campaign whose stored audience has no segment
    left answers 200, and a copy of it is refused at send until staff choose an audience (`empty`).
  - Contract (B6), `test/contract/english-only.test.ts`: no operation of `docs/contract/openapi.json` has a parameter or property
    named `locale`, `locales`, `nameAr`, `byLocale`, `ar` or `alternates`, except `locale` in the responses of the four legal
    routes (the script of fact 1 as code).
  - **Language codes in new tests.** A "not English" row is written with the code `tr` (legal, listings, pages, templates, the
    console's footnote test): the rule is "not English", and such a file needs no allowlist entry. `ar` appears only where the
    stored value is literally that (the campaign key `content.ar`, a `locales` list, an `/ar` address), in the files §9.4
    allowlists for it.

### 9.3 Website and console

- **Website unit tests (S1; A2 §5.1 table, file by file):** delete `language-switcher.test.ts` with its component (S3); delete or
  trim the Arabic cases of the 30 files listed there; keep every group C case (`format.test.ts:39`, `quantity.test.ts:102`,
  `money-math.test.ts:53`, `order-input.test.ts:122`, `terms.test.ts:68`, `catalog-facets.test.ts:335`, `whatsapp.test.ts:65`).
- **Website e2e (S2; A2 §5.2 table):** about 48 Arabic-only tests deleted, about 21 trimmed. **Ported first:** the "No" vote of a
  help article (`content.spec.ts:122`, its only cover) and the codes list of `stock-delivery.spec.ts` step 7 move to `/en`; for
  `balance-payment.spec.ts:429`, `top-ups.spec.ts:472` and `wallet.spec.ts:207` the implementer checks the English twin and ports
  what it lacks (A2 §7.5). `merchant.spec.ts:271` (a typed Arabic digit) stays. The Arabic specs already fail after any
  `dev-backend.sh reset` (critic G3), so nothing reproducible is lost.
- **New website tests:** `routing.spec.ts` rewritten (S3): `/ar` and `/ar/services?brand=x` answer 308 to `/en…` with the query;
  `/sign-in?token=t` and `/merchant/register?ref=r` reach `/en/…` with the query whatever cookie or `Accept-Language` is sent; no
  page has an `hreflang` link; `sitemap.xml` has no `/ar` and no alternate. S4: `resolve-service.test.ts` (found, legacy redirect
  to a slug, legacy redirect to the list, missing), `safe-next.test.ts` and `link.test.ts` (an `/ar` value maps to `/en`),
  `events.test.ts` (a frame without `locale` is accepted), a unit test that no helper of `lib/api` puts `locale` in a query, and
  two cases in `e2e/routing.spec.ts` for the seeded old addresses: the browser opens `/ar/services/legacy-demo-service` and ends
  on the English page of that service, opens `/ar/services/legacy-demo-gone` and ends on `/en/services`. The first hop is
  asserted as a 308; the second by the final address and by the `noindex` robots meta in the full answer of the in-between
  page (it is not an HTTP status, §7.1).
- **Console (A5 §8 table, 42 files):** the four "Arabic name" tests of `Categories.test.tsx:145-226` and the Arabic tab, preview,
  test-send, audience and bell cases are deleted; fixtures lose the field; accessible names lose "(English)"
  (`ContentTab.test.tsx`, `StorefrontPage.test.tsx`, `SearchPins.test.tsx`). New: the legal footnote with a retired row (its
  `locale` is `tr`, printed `TR`); the stream parser accepts an item without `locale`; `MessageBubble` with an Arabic body has
  `dir="auto"`; the guard's own test (`scripts/check-english-only.test.mjs`, §9.4).

### 9.4 The guard (`scripts/check-english-only.mjs`: one script, the same file in the three repositories)

**One implementation.** C3 writes the script and its test (`scripts/check-english-only.test.mjs`; the console wires the guard
first, in round 3): about 150 lines of plain ESM with Node built-ins only, so it runs under `node` and under `bun`. S5 and B6
copy the file byte for byte (`cmp` against `../frontend-admin-30/scripts/check-english-only.mjs` is part of their acceptance) and
write only their own `english-only.config.json`. A fault found later is fixed in the three branches by the lead before L1.

Wired in: backend `"english:check": "bun scripts/check-english-only.mjs"`, added to `check` after `format:check`; website
`"lint": "eslint && node scripts/check-english-only.mjs"`; console `"lint": "eslint . --max-warnings 0 && prettier --check . &&
node scripts/check-english-only.mjs"`. Configuration in `english-only.config.json` next to it: `roots`, `frontend` (true in the
two frontends), `notScanned` (`{ path, why }`), `allow` (`{ path, why }`) and `keep` (`{ path, has?, why }`); a `path` is a file
or a glob.

**What is read.** Only files git tracks under `roots` (`git ls-files`; without git, a walk that skips `node_modules` and build
output) whose extension is one of `ts tsx js jsx mjs cjs json sql css md html yml yaml sh svg txt`, and the root files a config
names (`compose.yaml`, `.env.example`). Every other file is skipped without being decoded: pictures and fonts hold bytes that
look like Arabic code points (fact 24); the fonts are protected by R5 instead. The script never reads itself, its config or a
file named `check-english-only.test.*`.

| Rule | Fails when |
|---|---|
| R1 Arabic script | a read file has a character of U+0600-06FF, 0750-077F, 08A0-08FF, FB50-FDFF or FE70-FEFF and is not in `allow` |
| R2 the `ar` locale | a quoted `ar` literal (case-sensitive: the country code `AR` is fine), a tag such as `ar-JO` or `ar_JO`, `lang="ar"`, `:lang(ar)`, `hreflang`, `locale=ar`, or an `/ar` path literal, outside `allow` |
| R3 right-to-left layout | a `dir` attribute with the value `rtl` (`dir="rtl"`, `dir='rtl'`, also escaped inside a string), in every repository; where `frontend` is true also `[dir=rtl]`, `[dir="rtl"]`, `:dir(rtl)`, a Tailwind `rtl:` variant in a class string, and a read of the computed direction (`getComputedStyle(…).direction`); outside `allow`. **Nothing else is right-to-left "layout":** comparing the direction of a text run (`=== 'rtl'`) and the type `'ltr' \| 'rtl'` are the PDF shaping of group C (fact 24) and match no rule |
| R4 the lists are alive | an `allow` or `notScanned` entry matches no tracked file, or a file matched by an `allow` entry no longer triggers R1 or R2: a "cleanup" that strips a group C test fails here |
| R5 group C code is there | a `keep` file is missing, or no longer contains `has` |

`--skip <path>` (repeatable) leaves a path out of one run. It exists for the two slices that finish before the lock step while
their repository still holds a generated file of the old wire: B6 passes `--skip test/contract/fixtures/frontend` (harvested
again in L1) and S5 `--skip lib/api/schema.gen.ts` (generated again in L2). Nothing is committed for it and no `package.json`
script passes it (the script's test asserts that), so there is no exclusion to remember to remove.

**Roots.** Backend `src`, `test`, `scripts`, `deploy`, `drizzle`, `compose.yaml`, `.env.example`; website `app`, `components`,
`lib`, `e2e`, `scripts`, `public` (its pictures are skipped by the extension rule), `proxy.ts`, `next.config.ts`; console `src`,
`scripts`, `index.html`. `docs/` (history and documents generated from the map), `reference/` and build output are not roots.
**`notScanned`** (backend): `drizzle/0000*` to `drizzle/0039*` (applied migrations are never edited, decision 027; 0035 has to
name the stored campaign key `ar` and the old `/ar` addresses) and `drizzle/meta` (generated), so the first migration the guard
reads is 0040; `test/unit/english-only.test.ts` (it names the patterns). The word "Arabic" in a comment is not a finding (group
C comments need it).

**The allowlist is derived, then compared with this list.** B6 (C3 and S5 likewise) first runs the scanner with an empty
`allow`. Every finding is then removed (a leftover of group A or B: it belongs to an earlier slice and goes into the report),
rewritten in English (a comment that quotes the map), or entered in `allow` with its reason. The entries expected, each with
its reason in the config:
- **Backend, group C specs and tests** (Arabic text as data): `src/modules/platform/pdf/*.spec.ts`;
  `src/infra/cache/cache-entry.spec.ts`, `src/infra/crypto/{encryption.service,password-hasher}.spec.ts`,
  `src/infra/storage/storage-names.spec.ts`, `src/modules/platform/application/file-upload.service.spec.ts`,
  `src/modules/identity/domain/{password-policy,client-rules}.spec.ts` (a password, and a username made from a name in Arabic),
  `src/modules/risk/domain/imei-check.spec.ts`,
  `src/modules/storefront/domain/{slug,category-slug,help-slug,page-generator}.spec.ts` (a title, category, question, model or
  network in Arabic gives a Latin slug or is reported as unusable, critic G4);
  `test/integration/{invoices-admin,client-statement,b2c-pay,b2c-disputes,storage,http,storefront-page-generator}.test.ts`,
  `test/search/golden.test.ts`, the new `test/integration/user-text-stays.test.ts`.
- **Backend, files of this feature that must name the stored key or the old address:** `scripts/english-only-export.ts` (the
  campaign key `ar`, the `/ar` canonical pattern), `test/integration/english-only-migration.test.ts` and
  `test/integration/english-only-export.test.ts` (rows that carry them), `test/contract/english-only.test.ts` (it names `ar` as
  a forbidden property).
- **Backend, the map's language in the tooling:** `scripts/lib/map.mjs`,
  `scripts/map-additions/{20,21,22,23,24a,26,27,28,28b,29}.mjs` and its README, `test/unit/map-additions.test.ts` and
  `test/unit/fixtures/map-additions/sample.mjs`.
- **Backend, rewritten instead of allowlisted:** the sample value at `test/integration/settings-admin.test.ts:93`
  (`keyboardLayout: 'ar'` gets another value: it is not about text handling), the comment at
  `test/scenarios/manual.e2e.test.ts:75` and the TSDoc lines of §6.7. `test/support/pdf.ts` gets no entry: it holds no Arabic
  (fact 24).
- **Website:** the group C tests of §9.3, `e2e/merchant.spec.ts`, the new `components/user-text.test.tsx`, and the old-address
  handling (`next.config.ts`, `components/auth/safe-next.ts`, `lib/notifications/link.ts`, their tests, `e2e/routing.spec.ts`).
- **Console:** `scripts/build-route-manifest.mjs`, `scripts/gen-entity-types.mjs` and its test (the map's words and the check
  that refuses an Arabic description), the `MessageBubble` test.

An entry of another kind needs a line in the slice report and the reviewer's yes.
**`keep`:** backend `src/modules/platform/pdf/pdf-fonts.ts` (has `scriptDirection`), `src/modules/platform/pdf/text-runs.ts`
(has `paragraphDirection`), the two files `src/modules/platform/pdf/fonts/IBMPlexSansArabic-{Regular,Bold}.ttf` (present),
`package.json` (has `"bidi-js"` and `"@pdf-lib/fontkit"`); website: the entries of §9.5; console
`src/features/support/components/MessageBubble.tsx` (has `dir="auto"`).
**Tests of the script.** `scripts/check-english-only.test.mjs` (console, C3) and `test/unit/english-only.test.ts` (backend, B6)
run it with `--root` and `--config` on a small tree they write to a temporary folder (the Arabic samples come from code
points): each rule; a `.png` with Arabic-looking bytes is skipped; a line `run.direction === 'rtl'` is no finding; an `allow`
entry that no longer triggers fails; a missing `keep` fails; `--skip` leaves a path out; no `package.json` script contains
`--skip`.

### 9.5 Group C protection (what must keep working, and the test that says so)

| What | Kept code | Protected by |
|---|---|---|
| An Arabic name, company, service title or note on an invoice, receipt, statement or evidence PDF | `src/modules/platform/pdf/*`, the two TTF files, `bidi-js`, `@pdf-lib/fontkit` | existing `text-runs.spec.ts`, `pdf-renderer.spec.ts` (with the golden hash), `pdf-fonts.spec.ts`, `invoices-admin`, `client-statement`, `b2c-pay`, `b2c-disputes`; `keep`: the font files, both dependencies in `package.json`, `scriptDirection` in `pdf-fonts.ts` and `paragraphDirection` in `text-runs.ts` |
| Upload and attachment names, UTF-8 bodies, passwords and usernames in any script, Latin-only slugs, Arabic-Indic digits refused in an IMEI | `file-upload.service.ts`, `infra/storage/storage-names.ts`, `password-policy.ts`, `client-rules.ts`, `storefront/domain/slug.ts`, `risk/domain/imei-check.ts` | their existing specs, `storage.test.ts`, `http.test.ts` |
| CSV exports carry text as typed (critic G5) | `orders.controller.ts:56`, `client-orders.controller.ts:118`, `wallet.controller.ts:149-150` | **new** `test/integration/user-text-stays.test.ts` (B6): an order and a wallet line with an Arabic customer name and note come back byte for byte, `charset=utf-8` |
| Plain-text mails and Telegram carry typed values unchanged (critic G6) | `renderText`, the plain-text delivery | **new**, same file: an event mail whose `{customerName}` and `{message}` are Arabic has no HTML part and the exact text |
| A supplier's service name with Arabic script (critic G4) | no code strips it | **new**, same file: such a service reads back unchanged from the Dhru service list, `GET /v1/services`, the console list and, copied into a listing title with a staff-given slug, `GET /store/v1/services/:slug` |
| A ticket message in Arabic | free text | **new**, same file: it round-trips through the store and staff routes; console `MessageBubble` test; website `ticket-conversation.test.tsx` |
| A search typed in Arabic answers 200 with no hits | `search/domain/normalise.ts` | existing `test/search/golden.test.ts` case 42 |
| Website: direction of typed text, isolated API values, typed Arabic digits, IME, initials | §7.9 | existing tests of §9.3; **new** `components/user-text.test.tsx` (S5): a ticket message and a file name render with `dir="auto"`/`<bdi>`, an Arabic name gives an initial, Enter during composition does not send; `keep` entries for `ticket-messages.tsx`, `file-upload.tsx`, `bdi-text.tsx`, `lib/format/index.ts`, `lib/quantity.ts`, `lib/merchant/money-math.ts` |

## 10. Slices (19: 6 Opus, 13 Sonnet; one agent session each; sequential inside a repository, parallel across repositories)

**Worktrees.** The lead creates them and makes them runnable: a new worktree has no `node_modules` and none of the git-ignored
env files.
- `../backend-30` (`feat/backend-30`): `bun install`; `.env.test` with its own `gsm_30_test` database and a free Redis DB number.
- `../frontend-admin-30` (`feat/console-30`): `npm ci`. The backend needs this install too: `contract:extract` loads the
  console's `typescript` (`scripts/extract-frontend-contract.mjs:14`) and `contract:harvest` runs the console's `vitest`
  (`scripts/contract-harvest.mjs:13-17`).
- `../storefront-30` (`feat/storefront-30`): `npm ci`; a copy of `.env.development.local` and `.env.production.local` from the
  main checkout (or `GSM_API_ORIGIN=http://localhost:3100` in the shell): `playwright.config.ts` refuses to start without the
  isolated API's origin.

Every implementer reads §1-§2 and its own sections, opens the audit sections named, and reports per §9.1. The slices of a
repository run one after the other, so a file is never edited by two agents at once; a slice that drops a column also fixes
every seed, helper and test that named it (the shared files are `test/schema/structure.test.ts`, `test/support/storefront.ts`,
`storefront/db/schema.ts`, `scripts/seed/storefront.ts` and `scripts/seed/platform.ts`).

**Backend acceptance.**
- **B0** changes nothing on the wire: the full `bun run check` stays green against the console's `main` (the rulings of L0 are
  already in), and `routes:check` and `contract:check` prove that the tooling change altered no generated file.
- **B1-B5** (in `../backend-30`): `bun run format`, then `bun run typecheck && bun run lint && bun run db:check &&
  bun run routes:build && bun run contract:docs && bun run docs:openapi && bun test ./src` and the integration files the slice
  names. **A slice that drops a column (B1, B2, B3, B5) also runs the four files that read the schema:**
  `test/schema/structure.test.ts`, `test/integration/db-schema.test.ts`, `test/integration/english-only-migration.test.ts` and
  `test/integration/english-only-export.test.ts`. Red from B1 until the lead's paired run (L1), by construction and not to be
  "fixed" by an allowlist entry: the console extract (`extract-frontend-contract.mjs --check`, the first half of
  `contract:check`), `test/contract/shape-parity.test.ts` and `test/contract/fixtures.test.ts`.
- **B6** cannot run the whole `bun run check`: the console extract and the harvested fixtures are renewed only in L1. Its
  acceptance is everything else: `bun run format`, then `bun run typecheck && bun run lint && bun run format:check &&
  bun run routes:check && bun scripts/build-contract-docs.mjs --check && bun run docs:openapi:check && bun run coverage:check &&
  bun run db:check && bun scripts/check-english-only.mjs --skip test/contract/fixtures/frontend`; the tests outside
  `test/contract`: `bash scripts/with-slot.sh bash scripts/test-batches.sh ./src ./test/dhru ./test/integration ./test/lint
  ./test/scenarios ./test/schema ./test/search ./test/unit`; and in `test/contract` the four files that do not read the
  console: `bun test test/contract/route-parity.test.ts test/contract/error-parity.test.ts
  test/contract/openapi-examples.test.ts test/contract/english-only.test.ts` (a failure there that names a harvested fixture or
  the console's extract is L1's; anything else is B6's). **The first point where the whole `bun run check` is green is L1.**

| Slice | Who | Scope (files: the sections named) | Its tests and migration |
|---|---|---|---|
| **B0** export, migration guard, data, old-address table, tooling, image | **Opus** (hard: irreversible data, the guard of 0035) | Create `scripts/english-only-export.ts` (§4.2), `drizzle/0034_legacy_slugs.sql` and `0035_english_only_data.sql` with journal and snapshots (§4.3), `legacySlugs` + `LEGACY_SLUG_KINDS` in `storefront/db/schema.ts`, `scripts/module-map.mjs`; **the image** (fact 21): `scripts/english-only-export.ts` in the `COPY` of `Dockerfile:22`, `'english-only-export'` in the import list of the verify stage (`Dockerfile:29`), `!scripts/english-only-export.ts` in `.dockerignore`, and a case in `test/unit/deploy-files.test.ts` like the one of `search-keys`; the tooling of §6.6 (`scripts/lib/map-additions.mjs`, `scripts/lib/map.mjs`, `scripts/build-contract-docs.mjs`, `scripts/map-additions/README.md`, `test/unit/map-additions.test.ts`); `docs/OPERATIONS.md` (the release-30 runbook of §11 and the "not additive" note in §3), `src/infra/db/README.md`. The cancelling `UPDATE` of 0035 mirrors `cancel()` (`campaign-send.service.ts:160-170`, fact 9) | `english-only-migration.test.ts`, `english-only-export.test.ts` (§9.2), `test/schema/structure.test.ts`, `test/integration/db-schema.test.ts`, `test/unit/map-additions.test.ts`, `test/unit/deploy-files.test.ts` |
| **B1** listings, catalog, categories, search gates, old-address route | **Opus** (hard: one listing per service, what is buyable, a new public route) | §6.1; A3 §2.8-2.9, A4 §3.7 (listing and public-catalog rows), §3.8, §3.10; `scripts/map-additions/30.mjs` (spec B224; then `bun run coverage:build` too); `scripts/seed/catalog.ts`, `scripts/seed-search-demo.ts`, `scripts/seed/storefront.ts` (the listing rows and the two demo rows of `legacy_slugs`, §4.5); `test/support/storefront.ts` (listing helpers); `test/load/search.ts`; `catalog/README.md`, `storefront/search/README.md`; structure test (`ADDITIONS.service_categories` out, `REMOVED.service_listings`) | `0036`; `storefront-listings`, `storefront-catalog`, `storefront-images`, `storefront-popularity`, `checkout-sessions`, `search-api`, `search-sync`, `catalog-categories`, new `storefront-legacy-slugs`, `test/search/golden.test.ts`; `listing-locale-filter.test.ts` deleted; the four schema files |
| **B2** pages, help, legal, consent | Sonnet (the legal part of §4.4 and `consent.service.ts` are reviewed line by line by Opus) | §6.2, §4.4; A3 §2.3-2.5; `contracts/shared.ts`, `domain/locales.ts` deleted; `scripts/seed/storefront.ts` (pages, help, legal), `scripts/seed/b2c.ts`; `test/support/storefront.ts` (page, help and legal helpers); `storefront/README.md`; structure test (`REMOVED.content_pages`, `.help_articles`) | `0037`; `storefront-content-pages`, `storefront-public-content`, `storefront-page-generator`, `storefront-help-articles`, `storefront-legal-directory`, `storefront-legal-documents`, `storefront-seed`, the consent cases; the four schema files |
| **B3** templates, delivery, recovery | **Opus** (hard: who gets which mail, the recovery selection, specs tied to applied migrations) | §6.3; A4 §3.1-3.2, A3 §2.6, §7.3; `scripts/seed/platform.ts` (template rows); `test/support/{notifications,support,identity-mail,customer-wallet,growth}.ts`; structure test (`REMOVED.notification_templates`). **Leaves the three seams of §6.3 untouched** (`Recipient.locale`, the inline `locale`, `emailHtml`'s second parameter): B4 removes them | `0038`; `notification-templates`, `notification-recipient-status`, `notification-delivery`, `merchant-lifecycle-mails`, `growth-recovery-jobs`, `growth-abandoned`, `customer-mail`, `b2c-mails`; the four schema files |
| **B4** inbox, streams, campaigns, audiences | Sonnet | §6.4; A4 §3.3-3.5; **the three seams B3 left, with their last users** (`notification-foreign-reads.ts`, `notification.service.ts:165-184`, `notification-delivery.ts:297-315`, `template-rules.ts:249-264` and its spec, `inbox/inbox.service.ts:71`, `inbox/inbox-realtime.source.ts:258,274`, `campaigns/campaign-render.ts:88,124`, `campaigns/campaign-send.service.ts:223`); `scripts/seed/platform.ts` (campaign rows); `test/support/{campaigns,stream}.ts`; `test/load/realtime-connections.ts`; `docs/contract/realtime-events.md` | `notification-inbox`, `notification-campaigns` (with the emptied-audience case of §9.2), `notification-campaign-audience`, `-delivery`, `-fanout`, `notification-center-flow`, `notification-seed`, `realtime-inbox`, `realtime-stream` |
| **B5** accounts, reply templates | Sonnet | §6.5; A3 §2.1-2.2, §2.7; A4 §3.6, §3.9; `scripts/seed/{customers,support}.ts`; `test/support/store.ts`; structure test (`ADDITIONS.clients` without `locale`, `REMOVED.customers`, `.reply_templates`) | `0039`; `store-account`, `customers-admin`, `clients-admin`, `merchant-sign-in`, `kyc`, `api-keys-admin`, `support-templates`, `customers-seed`, `customers-privacy`, `client-security-admin`, `support-seed`, `test/scenarios/b2c-account.e2e.test.ts`; the four schema files |
| **B6** guard, group C tests, docs | Sonnet | §9.4: the script copied byte for byte from `../frontend-admin-30/scripts/check-english-only.mjs`, the backend's `english-only.config.json` (allowlist derived as §9.4 says), `english:check` in `package.json`; §9.5 (`test/integration/user-text-stays.test.ts`); `test/contract/english-only.test.ts` (§9.2); §6.7 (the docs, and the extraction files as the source of the generated documents: never `RULES.md`, `ANSWERS.md`, `MISMATCHES.md` or `error-codes.md` themselves); `test/contract/harvest/plan.mjs:167-181`; `test/integration/settings-admin.test.ts:93` | `test/unit/english-only.test.ts`; the B6 acceptance above (not the whole `bun run check`: that is L1) |
| **C1** console: storefront and categories | Sonnet | A5 §3.1, §3.2 (dialogs, tables, legal page as §8, Search tab wording, mocks, tests); the omit list in `scripts/gen-entity-types.mjs` for `service_listings`, `content_pages`, `help_articles`, regenerated `schema.gen.ts`, `scripts/table-descriptions.en.mjs`; the mock seed ignores a demo legal row that is not `EN` | `npm run typecheck && npm run lint && VITE_API_MOCKS=false npm run build && npm test` |
| **C2** console: notifications and the live stream | Sonnet | A5 §3.3, §4 (composer, preview, test send, audience, bell, types, mocks, `src/lib/realtime/*`) | the same four commands |
| **C3** console: accounts, templates, the rest, **the guard script** | Sonnet | A5 §3.4-3.7, §5 (right-to-left code), §7 (demo data script, `extract-demo-seed.mjs`, the two refunds mocks), §9 (docs, M264); omit list for `customers`, `notification_templates`, `reply_templates`; `MessageBubble` `dir="auto"`; §9.4: **writes** `scripts/check-english-only.mjs` and `scripts/check-english-only.test.mjs` (the one implementation the two other repositories copy), the console's config, `lint` | the same four commands (the guard runs inside `lint`) |
| **S1** website: unit tests | Sonnet | A2 §5.1 table (30 files): delete, trim and port per §9.1; product code untouched | `npm run typecheck && npm run lint && npm run test` |
| **S2** website: e2e specs | Sonnet | A2 §5.2 table (29 specs and `e2e/admin.ts` callers): delete, trim, port (§9.3); product code untouched | `npm run typecheck && npm run lint`; the lead runs `npm run e2e` on the still bilingual site: the English tests pass |
| **S3** website: language core, pages, SEO | **Opus** (hard: routing, redirects, what every old link does) | §7.1 (the redirect rule and `proxy.ts`), §7.2-§7.4, §7.6; A1 §4.1 set K; **and every line `tsc` reports after the core change, also in a wire file**: the five call sites of §7.2 (`help/[slug]/page.tsx`, `notification-list.tsx:154`, `toast.tsx`, `notification-stream.tsx:59`, `lib/realtime/browser.ts`); the 14 message files and `ui-kit/page.tsx`; `resolve-service.ts` reduced to found or missing (S4 adds the old-address answer); `i18n.test.ts`, `error-page.test.tsx`, `profile-form.test.ts`, `e2e/routing.spec.ts` | `npm run typecheck && npm run lint && npm run test`; the lead runs `npm run build` and `e2e/routing.spec.ts`, `head-preload`, `prefetch-content` |
| **S4** website: the wire, old addresses, live stream | **Opus** (hard: strict API, what a missing page does with an old address, the stream parser) | §7.1 (the lookups, `safeNext`, `notificationHref`), §7.7 (what S3 left: request parameters, field reads, the stream parser; not the five call sites of §7.2); A2 §3 B3-B5, A6 G1; `e2e/admin.ts`; tests of §9.3; starts after B2 and after the lead's copy of its OpenAPI (it needs the new route and the public reads) | `GSM_OPENAPI=/home/saifi/gsm-project/.english-only/openapi-after-B2.json npm run gen:api`, then `npm run typecheck && npm run lint && npm run test` |
| **S5** website: right-to-left code, guard, group C tests, docs | Sonnet | §7.5, §7.9 (with the four Arabic-script comments), §9.4 (the script copied byte for byte from `../frontend-admin-30/scripts/check-english-only.mjs`, the website's config, `lint`), §9.5; comments that still describe Arabic pages (A6 G9, A1 §4.2: grep `Arabic\|RTL\|both languages`); `CLAUDE.md` (routes, language and UI rules), `README.md`, a dated entry in `PROGRESS.md`, a header note and the checklist line 1409 of `IMPLEMENTATION-PLAN.md`, `docs/DEPLOY.md:64`, `docs/BACKEND-NEEDS.md`, `docs/IMAGE-PROMPTS.md` (merge with the owner's edit, fact 20) | `npm run typecheck && npx eslint && node scripts/check-english-only.mjs --skip lib/api/schema.gen.ts && npm run test`. `npm run lint` as a whole stays red on `lib/api/schema.gen.ts` (the `"en" \| "ar"` unions of the routes B4 and B5 change) until the lead regenerates it in L2 |
| **S6** cleanup: library functions | **Opus** (a scripted change over more than 100 files, §7.8 step 1) | `lib/**` definitions and every call site; `lib/site-path.ts` | `npm run typecheck && npm run lint && npm run test` |
| **S7** cleanup: shared components | Sonnet | §7.8 step 2 (about 41 component files and the JSX that passes the prop) | the same |
| **S8** cleanup: feature components | Sonnet | §7.8 step 3 (about 42 files and their callers) | the same |
| **S9** cleanup: pages and the folder | Sonnet | §7.8 step 4 (`app/[lang]` → `app/en`, 68 files; 81 `getMessages` call sites; 14 message files; A1 App. A, D); `CLAUDE.md` route line | the same, then the lead: `npm run check` and the full e2e |

Reviews (Opus, at most two rounds each): backend after B1 (with B0: every SQL statement against §4), after B3, and the whole
branch after B6; console after C3 (the guard script is read line by line against §9.4: two more repositories copy it); website
after S4 (with S3: every row of §7.1 tried by hand on the build) and after S5; the cleanup after S9. A reviewer also checks the
twin list of every deleted test (§9.1) and that no group C line was removed.

## 11. Order, the lock step, the lead's merge and migration steps

**Before the worktrees (lead).** Commit or shelve the uncommitted files of fact 20. From here until L7 nothing else is merged
into the three `main` branches (if something must be, the lead rebases the three branches and repeats L1-L3). Create the
worktrees and install them (§10). Run nothing against `gsm` or `gsm_storefront` yet.

**L0 The rulings first (lead, in `../backend-30`, before round 1).** In `docs/contract/lead-decisions.json`:
- four `extra` entries (indexes 119-122, status `decided`): **B224** (shop content: language removed from listings, pages,
  help, categories and the public catalog; six map columns dropped; the old-address route), **B225** (legal documents: `locale`
  is an archive tag; retired history; consents without a language), **B226** (notifications: one template per event, channel
  and audience; inbox and streams without a language; campaign content `{ title, body }`, no language audience), **B227**
  (accounts: no saved language for merchants and customers; reply templates; data export format 2);
- six `answers` overrides (status `changed`) for the answers that state a language rule, each the same answer with that part
  replaced: `storefront Q1` (the retail price belongs to the service's one listing), `storefront Q4` (a generated page has no
  language), `storefront Q8` (a page's `url` is the site address, `/en` and the slug path), `storefront Q9` (a slug is unique
  for the site), `support Q5` and `settings Q5` (reply templates and notification templates have no language).

Then `bun run contract:docs` (it writes `MISMATCHES.md` and `ANSWERS.md`) and `bun run check`: green against the console's
`main`. From here on `scripts/map-additions/30.mjs` can name B224 (`route-parity.test.ts` refuses a spec that is not a B-entry,
fact 22), and no later step types into a generated document.

**Rounds (never more than 4 agents, reviewers included).**

| Round | Backend | Console | Website |
|---|---|---|---|
| 1 | B0 | C1 | S1 |
| 2 | B1 (then the Opus review of B0+B1) | C2 | S2 |
| 3 | B2 | C3 (then its review) | S3 |
| 4 | B3 (then its review) | | S4 |
| 5 | B4 | | S5 (then the review of S3-S5) |
| 6 | B5, then B6, then the branch review | | |

Between rounds the lead does two things besides the reviews. **After B2 (round 3):** copy
`../backend-30/docs/contract/openapi.json` to `/home/saifi/gsm-project/.english-only/openapi-after-B2.json`; S4 generates its
types from that fixed copy, not from the file B3 is rewriting. **After the review of C3:** the guard script of the console branch
is the one S5 and B6 copy; a change to it after that point is made in every branch that already has it.

**The lock step (lead; one sitting).** The wire is strict, so the three branches are proven together first and merged together.

- **L1 Backend, paired.** In `../backend-30` with `FRONTEND_DIR=../frontend-admin-30`:
  `bun run contract:extract && bun run contract:harvest && bun run routes:build && bun run contract:docs && bun run docs:openapi
  && bun run coverage:build && bun run format && bun run check`. Nothing is typed into a generated document: the rulings are in
  since L0 and the extraction since B6; here they are only regenerated. **First green point, and the first time the whole
  `bun run check` passes on this branch**: from B1 on the console extract, the harvested fixtures, `shape-parity`,
  `fixtures.test.ts` and (since B6) the guard over the old fixtures were red by construction. Then, once,
  `docker build --target verify .`: the image still builds and the export tool imports (fact 21). Compare the three copies of
  the guard script (`cmp`).
- **L2 Website, paired.** In `../storefront-30`: `GSM_OPENAPI=../backend-30/docs/contract/openapi.json npm run gen:api`, then
  `npm run check` with the same variable. This is the first run in which the website's `lint` is green with the guard over
  every file: until now `lib/api/schema.gen.ts` held the `"en" | "ar"` unions of the routes B4 and B5 changed. A type error
  here is a read of a removed field that S4 missed: fix it in the worktree. **Second green point.** The console branch's four
  commands are green since C3; run them once more.
- **L3 Export.** From `../backend-30`, for each database (`DATABASE_URL` set by hand to `gsm`, then to `gsm_storefront`; no
  other variable is needed, §4.2): `bun scripts/english-only-export.ts --check --out /home/saifi/gsm-project/.english-only/backup`,
  read the report (services listed only in Arabic and their open checkout sessions; templates, pages and help articles with no
  English twin; campaigns by fate, the finished ones too; a document type with no English version in force), then the same
  command without `--check`. Both files stay in that folder.
- **L4 Rehearsal on the demo database.** Stop the isolated API; migrate `gsm_storefront` with the code of `../backend-30`
  (`DATABASE_URL` set by hand). This is the data path on real rows: read back the `legacy_slugs` rows of the five Arabic
  listings, the retired Terms version, the audit rows and the counts. **No reset:** `dev-backend.sh reset` would also wipe every
  hand-made English row of that database (27 pages against 20 seeded), and no export holds those. The two demo addresses the
  e2e follows are inserted by SQL instead, the same rows the seed writes (§4.5; the listing slug is in B1's report):
  `INSERT INTO legacy_slugs (kind, slug, service_id) SELECT 'service', 'legacy-demo-service', service_id FROM service_listings
  WHERE slug = '<that slug>' ON CONFLICT (kind, slug) DO NOTHING;` and `INSERT INTO legacy_slugs (kind, slug) VALUES
  ('service', 'legacy-demo-gone') ON CONFLICT (kind, slug) DO NOTHING;`. Start the isolated API from `../backend-30`
  (`BACKEND_DIR`), open one old Arabic address by hand, and in `../storefront-30` run `npm run build` and the full
  `npm run e2e`. **Third green point.** If that database is ever seeded afresh from this branch, `FRONTEND_DIR=../frontend-admin-30`
  must be set (the seed reads the console's demo file, fact 2), and the owner is asked first.
- **L5 Merge the website, then the console**, one squash commit each. Both work against the old API (fact 4; only the console's
  create dialogs and the campaign composer would be refused for these minutes); the old website does not work against the new
  API, which is why the backend is last. Between this step and L6 the website's `gen:api:check` and the backend's
  `contract:check` are red on `main` by construction.
- **L6 Migrate `gsm`, then merge the backend: in that order, one right after the other.** The owner's API and worker watch
  `main`. If they can be stopped (ask the owner), stop them now. Migrate `gsm` with the code of `../backend-30` (`DATABASE_URL`
  set by hand; the guard finds the marker of L3; "out of date" or "changed after the export" means something changed since:
  export again, migrate again). Then the backend squash merge; the watchers load the new code onto the new schema (or are
  started). Restart the isolated API from `main`. **Never the other order:** the new code on the old schema can pick the Arabic
  row where it now expects one template (a real mail in Arabic), fails every template upsert (`ON CONFLICT (event, channel,
  audience)` has no constraint to match yet) and fails a due scheduled campaign whose stored audience it can no longer parse.
  The old code on the new schema only answers errors, for the seconds until the merge.
- **L7 All green on the three `main` branches.** Backend `bun run check` (default `FRONTEND_DIR`); console: its four commands and
  `npm run mocks:live`; website: `npm run check` and `npm run e2e`. Reload open console and website tabs.
- **L8 Records.** `docs/decisions/039-english-only.md`, the `CLAUDE.md` clause, `PROGRESS.md` of the three repositories (with one
  line for later: take the export script out of the image once every environment is migrated),
  `STOREFRONT-BACKEND-HANDOFF.md` (a new section "English only (feature 30)": no `locale` anywhere, `/ar` redirects, the old-address
  route, the campaign shape; the older sections stay as history under a banner) and the banner of `STOREFRONT-HANDOFF.md`.
  Tell the owner: the legal exception (§4.4); which campaigns changed, the finished ones too; which services lost their page,
  and that a checkout session already open for one of them can still be paid; which templates, pages and help articles had no
  English twin; where the export files are.
- **L9 The cleanup wave.** Reset `feat/storefront-30` to `main`; S6, S7, S8, S9 in order; review; `npm run check` and the full e2e;
  one squash commit (`refactor`). Then remove the three worktrees, the test database and the OpenAPI copy.

**Production runbook (B0 writes it into `docs/OPERATIONS.md`; no production database exists yet, the order is the same for any
environment).** This release is not additive: never run the old API on the migrated database. The database must be at the
previous release (migration 0033) before it starts: the export refuses an older one.
1. `gsmc run --rm -T backup pg-backup.sh` and wait.
2. Build the three new images. **While everything still runs**, prove that the export can run where the migration runs: make a
   host folder the image's user can write (`install -d -m 700 -o 1000 -g 1000 <host folder>`; the image runs as `bun`, uid 1000
   in `oven/bun`: `gsmc run --rm migrate id -u` says so), then
   `gsmc run --rm -v <host folder>:/out migrate bun scripts/english-only-export.ts --check --out /out` and read the report. It
   writes nothing; it fails here, with the shop up, when the script is not in the image, the folder cannot be written or the
   database is at the wrong level.
3. `gsmc stop api worker` (no campaign is then mid-send, nothing is written).
4. Export: `gsmc run --rm -v <host folder>:/out migrate bun scripts/english-only-export.ts --out /out`; copy the file to the
   backup storage.
5. `gsmc run --rm migrate` (it refuses without step 4).
6. `gsmc up -d api worker console site`.
7. `/health?strict=1`, one `/ar/…` address, reload open tabs.

**If step 4 or 5 fails,** the database is unchanged (the migration is one transaction): set the previous image tag, `gsmc up -d
api worker`, and find the cause with the shop up. **Rollback after step 5:** restore the dump of step 1 into a new database and
start the previous images; there is no down-migration.

## 12. Risks and their mitigations

| # | Risk | Mitigation |
|---|---|---|
| 1 | The wire is strict in three repositories: any half-merged state answers `422` or fails a check | Paired green before any merge (L1, L2, L4); merge order website, console, backend; nothing else merged meanwhile; the lead does it in one sitting |
| 2 | The old code cannot run on the new schema (fact 18), and the new code must not run on the old one (it could send an Arabic template) | Development: `gsm` is migrated from the branch right before the backend merge, the owner's API and worker stopped if possible (L6). Production: stop, export, migrate, start (runbook); `docs/OPERATIONS.md` §3 says this release is the exception |
| 3 | Content is deleted without a copy | The guard of 0035 (marker, same counts, nothing edited since), the export's read-back and hash, the runbook's order, the regular dump; the export file is copied off the server |
| 4 | The guard blocks a fresh database, CI or the tests (42 Arabic rows arrive from applied migrations) | Rows of the same run are exempt (fact 6), `_test` databases are exempt, case (a) of the migration test proves a fresh run |
| 5 | A service listed only in Arabic loses its page and no new checkout can start for it; a session that is already open stays payable and is fulfilled (the listing is read when a session is created, fact 10) | The `--check` report names such services with their orders and open sessions before anything is deleted, and the lead tells the owner; default: accept (staff add an English listing; the old address leads to the list). `gsm` has one Arabic listing to look at |
| 6 | A document type whose only version in force is not English | The guard refuses with the type names; staff publish the English version first |
| 7 | A campaign reaches people it was not meant for, at once or later through a copy of a finished one | §4.6 (the customer audience is removed from every campaign that was for other languages only, whatever its status; running ones are cancelled), audit rows, the report; in production the worker is stopped while migrating; in development the lead checks that the report shows no campaign in `queued` or `sending` |
| 8 | A browser tab opened before the release runs old code: its stream parser drops live items without `locale`, the console's pin picker sends `locale=en` | Reload after the release (L7, runbook step 7). No production exists yet; a compatibility constant on the wire for stale tabs was judged not worth keeping |
| 9 | A 308 is cached by browsers and search engines for good | Intended ("for good" is the owner's decision); written in the decision so nobody plans to reuse `/ar` |
| 10 | Search engines hold Arabic addresses | Every one answers 308 to its `/en` address; an old Arabic slug is then sent on from inside a `noindex` page (not an HTTP status, §7.1); `/ar` is not blocked in `robots.txt`; the sitemap lists only `/en`; the owner resubmits the sitemap when the site is public |
| 11 | drizzle-kit's SQL for a constraint that keeps its name and changes its columns, or its snapshot, is wrong | The implementer reads the generated file against §4.3 and fixes the order by hand before it is ever applied; `db:check`; the migration test runs the real files |
| 12 | Specs compare template code with the text of applied migrations | They become containment checks (§6.3); the applied files are not edited |
| 13 | An Arabic test was the only cover of a behaviour | §9.1 (twin or port, listed in the report), the ported cases of §9.2-9.3, the reviewer checks the list |
| 14 | Group C is stripped, now or by a later cleanup | §9.5 tests; guard rules R4 and R5; reviewers reject any removed `dir="auto"`, `<bdi>`, digit parser or PDF line |
| 15 | The console's demo file is extracted again and Arabic values return | `extract-demo-seed.mjs` normalises; the backend seed and the console mocks ignore a demo legal row that is not `EN` |
| 16 | A user-typed Arabic value inside an English mail has no direction mark | Accepted (critic G6): the mail is plain text and mail readers handle mixed text |
| 17 | The cleanup wave touches about 180 files | It runs after the lock step, changes no URL, text or request, is one separate commit, and is checked by `tsc`, the unit tests, `next build` and the full e2e. Dropping it leaves the owner's target met |
| 18 | The agent limits of `backend/CLAUDE.md` (at most 2 implementer calls per feature) do not fit 19 slices | The lead counts a slice as the unit, as in the job of 2026-11-10; at most 4 agents at once; no slice is spawned twice |
| 19 | The export cannot run where the migration runs (the image carries its scripts by name), and that shows only when the shop is already stopped | B0 puts the script into the image, the verify stage and the deploy test (fact 21); L1 builds the verify stage once; the runbook runs `--check --out` in the new image **before** it stops anything; a failed export or migration leaves the database unchanged, so the previous images start again |
| 20 | A check is made green before the lock step by an exclusion that stays, or a generated document is edited by hand | B6 and S5 pass `--skip` on the command line only (nothing is committed); §6.7 names the sources of the generated documents; L1 and L2 are the named first green points, and what is red before them is listed in §10 |
| 21 | The guard is three copies of one script and they drift | One author (C3), byte-identical copies (`cmp` in S5, B6 and L1), the backend's unit test runs the same file |
| 22 | A slice cannot pass its own typecheck because the next slice owns the last users of what it deletes | S3 owns every line `tsc` reports (§7.2); B3 leaves three named seams for B4 (§6.3, §6.4); schema slices run the four schema tests (§10) |

## 13. Out of scope

- The read-only map (`backend/reference/gsm-map`, `frontend-admin/reference/**`): the owner's original Arabic specification.
- History: applied migrations 0000-0033 (four hold Arabic template text; once applied, 0034-0039 are history too), old briefs, decision records, `RESOLUTIONS.md` and
  `resolutions.json`, the mismatch rows before B224 and M264, `IMPLEMENTATION-PLAN.md` beyond a header note, `audit_logs` rows.
- Documents generated from the map (`docs/route-manifest.json`, `docs/slices/*.json`, the "Map:" lines of
  `docs/contract/endpoints/*.md`, the console's `docs/route-manifest.json`) and the ten existing files of `scripts/map-additions`:
  they keep the map's Arabic (§6.6).
- Working folders outside the repositories (`.perf-audit/`, `.typesense-step0/`, `.english-only/`) and the second website
  worktree `storefront-lab` (it follows when its HEAD is moved).
- The referral code on staff-created merchants (owner: not now).
- The sentence "talk to the user in short Jordanian Arabic" in the three `CLAUDE.md` files: it is how the assistant speaks with
  the owner, not a language of the system.
- Evidence packs and the data export keep printing a legal document as type and version; naming the language of a retired
  version there would be a new B-entry.
- A real HTTP status for the second step of an old Arabic slug (a list in `redirects()` at build time, or a lookup in
  `proxy.ts`): considered and not built (§7.1).
- Taking the export script out of the image again once every environment is migrated: a line in `PROGRESS.md` (L8).

## 14. Owner questions (the default is applied; none blocks the work)

1. **Legal history (the one exception to "delete for good").** An Arabic legal version that a customer accepted is proof of what
   they agreed to. Default: **it is kept, taken out of force, and shown to staff only in the "Earlier versions" line as a retired
   text**; an Arabic version nobody accepted is deleted. Today this is one row in the demo database and none in yours.
2. **A service that is listed only in Arabic.** Default: **it loses its public page (staff can add an English one); its old
   address leads to the English list.** Nobody can start a new checkout for it; a checkout that is already open can still be
   paid and is fulfilled. The lead shows you the names and the open checkouts before the migration runs.
3. **Campaigns that were for Arabic readers only.** Default: **each loses its customer audience, whatever its status; a
   scheduled or running one is also cancelled; a draft waits for staff.** A finished one keeps its results but no longer shows a
   customer audience: otherwise it would read "all customers", and a copy of it would go to everybody. **Every other campaign
   only drops the language filter**, so people who had chosen Arabic now receive what English readers receive. Each change is in
   the audit log, and the lead gives you the list.
4. **Old Arabic links.** Default: **permanent redirects with no end date**; an old Arabic service page goes to the same service
   in English, an old Arabic content page to the home page, an old Arabic help article to the help centre. Every `/ar` address
   is a true permanent redirect to `/en`; only that last step for an Arabic-only address happens inside the page (instant for a
   visitor, never indexed).
5. **The backup files.** Default: **one JSON file per database in `.english-only/backup/`, never committed, kept until you
   delete it**; on a server it is copied to the backup storage with the nightly dumps.
6. **Search settings typed in Arabic** (synonyms, pinned queries, hidden terms). Default: **left as they are and listed in the
   report**; staff can remove them in the console. A visitor may still type Arabic into the search box and gets no results.
7. **The map and its generated documents stay Arabic.** Default: **untouched** (your specification); new rows are English only.
8. **Notes outside the repositories** (`.perf-audit/`, `.typesense-step0/` hold Arabic test runs). Default: **left**; delete
   them whenever you like.

## 15. Review against the code

Checked in the code on 2026-11-16: the 70 operations (a script over `docs/contract/openapi.json`; the same list as A4 §2 and
A6 G2); the strict list query and the stripped bodies; `FRONTEND_DIR` in the extract, harvest, manifest and seed scripts and the
parity rules of `test/contract/README.md`; `GSM_OPENAPI` and `BACKEND_DIR` in the website's scripts; the defaults when no
`locale` is sent; the migrator (one transaction, journal order) and `timestamp(3) DEFAULT now()`; `resetDb` and
`assertTestDatabase`; `db:check`; the structure test's column rule; `legal_documents`, `consent_records`, the consent service and
the two evidence reads; the demo's legal rows and Arabic customers; `notification_campaigns`, the strict audience schema,
`parseStoredAudience`, the campaign statuses and the cancellable set; `audit_logs` (actor `system`, the entity words
`notification_campaign` and `legal`); `job_runs` and how the System health page reads it (by job name); `fk()` (restrict or
cascade only); the map-additions helper, the auth vocabulary and the three generators that carry the map's text; the store groups
of the manifest; `docs/OPERATIONS.md` §3-§4 and the `migrate` service; `proxy.ts`, `lib/i18n/config.ts`, `resolve-service.ts`,
`next.config.ts`, `robots.ts`, the three slug pages and the checkout page, `notification-list.tsx` (a server component), the
digit parsers and the three direction readers; the console's legal footnote and helpers, its scripts and `lint`; the Next 16.4
documents for redirects, the execution order, root layouts and `global-not-found`. Counts of files per folder and per module were
taken with grep on the same day.
**Checked again for the two reviews (facts 9, 10, 21-24):** the `Dockerfile`, `.dockerignore`, the deploy test and the `migrate`
service; `build-contract-docs.mjs` and what each generated document is made from; `route-parity.test.ts`; `test-batches.sh`
(the folders a run can be limited to); every call site of `isLocale`, `dirOf` and the toast's `lang` in the website; the users
of `Recipient.locale`, `enqueueInline`, `emailHtml`, `findTemplateFor` and `writableLanguages` in the backend; `cancel()`; the
audience schema's "all of it" rule and the console's Duplicate; the `rtl` comparisons of the PDF code; the file types under the
guard's roots and every tracked backend file that holds Arabic script (79 outside the harvested fixtures: the allowlist of §9.4
was read against that list); `permanentRedirect` in a streaming context and the three `generateMetadata` functions;
`playwright.config.ts`, `dev-backend.sh` and the two contract scripts that need the console's install.
**Not verified (the slice proves it):** what drizzle-kit emits for the same-name constraints and for the partial index; that a
setting made with `ALTER DATABASE … SET` reaches the migrator's connection in the test;
whether a listing that is on but not sellable should redirect or lead to the list (§4.5 says: the rule of the page route);
`/ar` alone matching `/ar/:path*` (the routing test asserts it); the English twin of each deleted e2e test (A2 §8); Next's typed
routes after `app/[lang]` becomes `app/en` (S9, with `next typegen` and a build); the uid of the image's `bun` user (the runbook
asks the image); that `test/contract/openapi-examples.test.ts` reads no harvested fixture (if it does, it joins the files that
are L1's); the exact wording of the six answers of L0 (the lead writes them from `ANSWERS.md`).
**Where the code decided against the first idea:** `legal_documents.locale` cannot be dropped or pinned (two languages share a
version text and consents hold the rows); the guard cannot simply refuse when Arabic rows exist (a fresh database has 42 from
applied migrations); a stored campaign audience must lose `locales` in every row, sent ones too (the strict schema), and a
campaign for other languages only must lose its whole customer segment, sent ones too (an unfiltered segment means everybody);
the schema changes are four generated files, one per slice, instead of one (one worktree per repository makes the slices
sequential, and each must end with its own tables consistent); the website's tests are ported before its code (its `tsc`
compiles the tests); an old Arabic content page has no English twin and no list to fall back to, so it goes to the home page;
the second step of an old Arabic slug cannot be an HTTP status on pages that stream.

## 16. Review notes (two adversarial reviews, 2026-11-16)

Every finding was verified in the code before the plan changed. R1 and R2 are the two reviewers; "MF" is a must-fix.

**Must-fix: all twelve (ten distinct: two were raised by both reviewers) are confirmed and fixed.**

| Finding | Verified in | What changed |
|---|---|---|
| R1 MF1: S3 deletes `isLocale`/`dirOf` and narrows `Locale`, five call sites in S4's files then fail `tsc` | grep of the website: `help/[slug]/page.tsx:19,69,80`, `notification-list.tsx:15,154`, `toast.tsx:9,24,94`, `notification-stream.tsx:59`, `lib/realtime/browser.ts:9,53` | The five call sites move into S3, with the rule "what `tsc` reports is S3's" (§7.2, §7.7, §10) |
| R1 MF2: B3 removes three things that B4's files still use | `inbox.service.ts:71`, `inbox-realtime.source.ts:258,274`, `campaign-render.ts:88,124`, `campaign-send.service.ts:223` | B3 leaves the three seams untouched and B4 removes them with their last users (§6.3, §6.4, §10). Chosen over "fix `Recipient.locale` to `en` in B3": an untouched seam needs no edit in B3 and no dead value for one slice |
| R1 MF3: B6 cannot pass the whole `bun run check` before L1 | `package.json` (`check`, `contract:check`), `route-parity.test.ts:98-106`, the harvested fixtures (4 hold Arabic script, about 40 a language field) | L0 puts B224-B227 in before round 1; B6's acceptance is the part that does not need the console pairing; L1 is named as the first whole green (§10, §11) |
| R1 MF4: `RULES.md` and `ANSWERS.md` are generated | `build-contract-docs.mjs:3,23,115-160`, line 3 of each document | §6.7 names the sources: the extraction files (B6) and `lead-decisions.json` (L0); L1 only regenerates (fact 22) |
| R1 MF5 and R2 MF1: the export script is not in the production image | `Dockerfile:22-23,29,42`, `.dockerignore:20-31`, `deploy-files.test.ts:232-236`, `compose.prod.yaml:108-117` | B0 adds it to the copy, the ignore exceptions, the verify stage and the deploy test; the script imports only `pg` and built-ins behind `import.meta.main`; the runbook runs it through `migrate`, prepares a writable folder and rehearses with `--check --out` before it stops anything; `--out` is probed before the snapshot; L1 builds the verify stage (§4.2, §10, §11, risk 19) |
| R1 MF6: rule R3 would fail on the PDF shaping | `pdf-fonts.ts:72,86`, `text-runs.ts:82,113,181` | R3 is the `dir` attribute and, in the frontends, CSS, Tailwind and computed direction only; `keep` entries for `scriptDirection` and `paragraphDirection` (§9.4, §9.5) |
| R1 MF7: rule R1 would decode pictures and fonts | 97 png/jpg under `SF/public`, 2 TTF under `src` | Only tracked text files, chosen by extension (§9.4) |
| R1 MF8 and R2 MF3: the plan's own files trip the guard, and one `allow` entry is dead | grep of the planned predicates; `test/support/pdf.ts` has 0 matches | `drizzle/0000`-`0039` are `notScanned` history; the export script, its two tests and the contract test are allowlisted with reasons; the scanner skips itself and its test; `test/support/pdf.ts` is out; new "not English" rows use `tr` (§9.2, §9.4) |
| R1 MF9: the website's `lint` cannot be green in S5 | `lib/api/schema.gen.ts`: 19 `"ar"` unions, regenerated only in L2 | S5 runs the guard with `--skip lib/api/schema.gen.ts`; `npm run lint` is red on that one file until L2, the named first green (§9.4, §10, §11) |
| R2 MF2: a finished campaign for Arabic readers would read "all customers", and Duplicate would send its copy to everybody | `audience-spec.ts:63-66`, `CampaignHeader.tsx:48`, `lib/spec.ts:249` | Every campaign for other languages only loses its customer segment, whatever its status; running ones are cancelled; audit rows, export fates, report and the owner's list name the finished ones (§2, §4.2, §4.3, §4.6, §9.2, §14) |

**Should-fix: applied.** The legacy hop is not a 308 (said so in §2, §7.1, §9.3, risk 10 and owner question 4); worktree
installs and the e2e environment (§10); the four schema tests in every schema slice (§10) and assertions by id in the
migration test (§9.2); a fixed OpenAPI copy for S4 (§7.7, §11); `gsm` is migrated before the backend merge, never after (L6,
risk 2); the unlisted Arabic lines (group C specs in §9.4, the comment of `manual.e2e.test.ts` in §6.7, the four website
comments in §7.9, `tr` in the console's footnote test); no reset of `gsm_storefront` in L4; `fanout_cursor = NULL` and the
missing inbox recount (§4.3, §4.6); `counts` as JSON integers from the guard's own expression (§4.2); `cancel()` cited where it
lives and taken out of "not verified"; the export refuses a database that is not at 0033 or 0034 (§4.2, runbook); an open
checkout session stays payable (fact 10, risk 5, owner question 2); the report lists rows with no English twin (§4.2, L3, L8);
`--out` is required everywhere and L3 passes it (§4.2, §11).

**Applied in another form than the reviewer proposed, and why.**
- *Legacy hop (both reviewers offered "say so" or "build a real 308").* Said so, not built: a list in `redirects()` goes stale
  when staff rename a slug and needs a second route, a lookup in `proxy.ts` costs every page request, and `legacy_slugs` is
  empty outside the two development databases (no production data exists). The 308 every Arabic URL takes is real (§7.1).
- *R1 MF8, "allowlist `0035`".* The migration range 0000-0039 is `notScanned` instead: once applied these files can never be
  edited, so a rule over them could only ever be satisfied by an exception.
- *R1 MF8, "write the scanner's fixtures as escapes".* Not needed: the scanner skips its own test, and that test writes its
  samples to a temporary folder.
- *R2 MF1, "copy every `scripts/lib` file it imports".* The script imports none, by design (§4.2), so the image gains one name.
- *R1 MF3 and MF9, "a temporary exclusion".* A `--skip` option on the command line of the two slices instead: nothing is
  committed that someone has to remember to remove (risk 20).
- *R1 should-fix on L4, "tell the owner, or insert by SQL".* Inserted by SQL: the owner's hand-made rows stay.

**Rejected.** None: no finding was wrong in fact.

**Added while fixing, asked by no reviewer.** The guard is one script written once (C3) and copied, not three (§9.4, risk 21);
`bun run contract:docs` joins the commands of B1-B5 so the generated endpoint documents never lag behind the manifest; B4 tests
the detail of a campaign whose audience was emptied (§9.2); the runbook says what to do when the export or the migration fails
with the shop stopped (§11).

Approved by Fable 5.2 (planner), 2026-11-16, after two adversarial reviews
