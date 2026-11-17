# 039: English only

Status: accepted, 2026-11-17 (feature 30, planned by Fable 5.2 after an audit by six agents and two adversarial reviews, built in
19 slices by Opus 5.5 and Sonnet 5.5 with six Opus reviews, merged by the lead; plan `docs/briefs/30-english-only.md`). Builds on
decisions 014 (test database), 027 (migrations), 030 (Arabic in PDFs) and 035 (routes beyond the map). Spec entries B224-B227.

**Context.** The system was built in two languages (English and Arabic): 70 operations of the contract carried a language field,
nine columns held a language, and the website served `/en` and `/ar`. On 2026-11-16 the owner decided to remove Arabic from the
whole system (website, backend, console) and keep English only, with four rulings: the URLs keep `/en`; stored Arabic content is
deleted for good after a backup file; Arabic text that people type stays readable; people whose saved language was Arabic become
English readers.

**Decision.**
- **English is the only language of the system.** No visitor, customer, merchant or staff member can see, choose or receive
  Arabic as a language: no translation, template, seeded content, language selector, language filter, language column in a table,
  `locale` field on the wire or right-to-left layout code remains in the product code of the backend, the console and the website.
  New work is English only.
- **Arabic text is still data.** What a person or a supplier types (a name on an invoice, a ticket message, a supplier's service
  name, a file name, digits typed on an Arabic keyboard) is stored, shown and printed as typed. The PDF shaping and fonts of
  feature 24E (decision 030), `dir="auto"` and `<bdi>` on user text, Arabic-digit parsing, UTF-8 CSV and plain-text mails stay,
  and tests protect them (group C).
- **Stored Arabic content is deleted for good, after a backup file.** A script (`scripts/english-only-export.ts`) exports, per
  database, every row and value the migration removes; the deleting migration (`0035_english_only_data`) refuses to run on a
  database that holds such content and has no fresh export.
- **One exception: legal evidence.** A legal document version in another language that a consent record references is the proof
  of what a person accepted. It is not deleted: it is taken out of force (`is_current = false`) and kept as history. For that reason
  `legal_documents.locale` stays as an archive tag (`en` on every version that can be created or published; another value only on
  retired history), and a CHECK forbids a non-English version in force.
- **Columns.** `clients.locale`, `service_categories.name_ar` (backend additions) and the map columns `customers.locale`,
  `content_pages.locale`, `help_articles.locale`, `notification_templates.locale`, `reply_templates.locale` and
  `service_listings.locale` are dropped; the unique keys lose the language (one listing per service, one slug, one template per
  event, channel and audience, one version in force per document type). Dropping six map columns is a recorded deviation from the
  map (B224): `test/schema/structure.test.ts` has a `REMOVED` list next to `ADDITIONS`.
- **The wire.** The language left all 70 operations that carried it; only the four staff routes of legal documents keep a
  read-only `locale` in the row (the archive tag). Unknown query keys stay a `422`: the three repositories changed in one lock step.
- **URLs.** The website keeps `/en/…`. Every `/ar/…` URL answers a permanent redirect (308) to the same path under `/en`, with
  its query. An Arabic service, page or help address that no longer exists is remembered in `legacy_slugs` and answered by
  `GET /store/v1/legacy-slugs/:kind/:slug`: the English page that receives it sends the reader on to the English page of the same
  service, else to the English list (a page: the home page; a help article: the help centre). That second step is written into
  the page, which is `noindex`: these pages stream, so their status line is already sent. No `hreflang`, no Arabic sitemap entry.
- **People.** A saved language no longer exists; every merchant and customer reads English.
- **Campaigns.** A campaign of **any** status whose customer audience named only other languages loses its customer audience
  (staff choose one again; a copy of a finished one must not reach every customer), and a scheduled or running one is also
  cancelled. Every other campaign only loses the language filter. Each campaign that lost its audience gets a system audit row.
  Campaign text is one title and one body.
- **History is not edited.** Applied migrations (0023, 0025, 0027 and 0032 hold Arabic template text) stay as they are
  (decision 027): a fresh database inserts those rows and migration 0035 deletes them in the same run. Old briefs, decision
  records and `RESOLUTIONS` stay. `audit_logs` rows keep the language values they recorded.
- **The map stays the owner's Arabic specification** (`reference/gsm-map`, read-only). The tooling no longer demands an Arabic
  sentence for a new route row; the generated documents keep the map's own text.
- **A guard** (`english:check`, part of `bun run check`; the website's and the console's `lint`) fails when Arabic script, the
  `ar` locale or right-to-left layout code reappears outside a short allowlist, and when a protected group C file loses what it
  protects. The script is one file, byte-identical in the three repositories.

**Why drop the columns and not pin them to `en` with a CHECK.** A pinned column keeps every insert, seed, fixture, unique key and
wire field carrying a value that can never differ, and keeps the "one row per language" shape alive for the next reader. The cost
of dropping is one recorded deviation and one list in a test; the values are exported first. `legal_documents` is the one table
where the column carries information (which text a person accepted), so it stays.

**Why not also drop `/en`.** The owner decided to keep it (2026-11-16): indexed and bookmarked `/en` URLs stay valid.

**Consequences.** One release changed the three repositories together and is **not** additive: the old code cannot run on the new
schema, so a deploy stops the API and the worker, exports, migrates and starts the new images (`docs/OPERATIONS.md`, release 30).
The export file is the only copy of the deleted content besides the regular database backups. The export script ships in the
backend image, because the runbook runs it there; it can leave the image once every environment is migrated. `docs/slices/*.json`
and the console's map-generated row types still list the six dropped columns (they mirror the map); the `REMOVED` list and the
console generator's omit list are where that difference is written down. A 308 is cached by browsers and search engines for
good: `/ar` must not be reused for anything else.
