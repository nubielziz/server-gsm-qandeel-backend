# 068: Shop content trimmed: landing pages, the TAC admin and the search tools are retired

Status: accepted, 2026-11-24. Builds on decisions 035 (routes beyond the map), 038 (search on Typesense), 061 and 062 (the retired-route list
and how a feature is retired) and 067 (the most recent retirement).

**Context.** The owner runs the shop alone and found three parts of the console's Shop content page to be work with no return. Landing pages were
text-only marketing pages nobody wrote. The TAC catalogue was a table of IMEI prefixes that only fills by hand, one entry at a time: the one free
list (Osmocom, 22,527 entries, read on 2026-11-24) has no phone newer than 2019 in any number that matters (iPhone 11, 12, 14, 15: none; Galaxy S21
to S24: none), and the complete lists are sold. The search tools (synonyms, pinned results, a report, hidden popular terms, a test box) were five
screens for a search that already answers well with the synonyms it ships with. The owner asked on 2026-11-24 to remove the first two and to keep
only the index section of the third.

**Decision.**

- **Landing pages are retired.** A content page is a static page or a blog post: `CONTENT_PAGE_KINDS` is `static` and `blog`, and the five landing
  kinds (`country`, `model`, `brand`, `carrier`, `tool`) leave the check of `content_pages.kind`, the contracts, the filters and the seeds. A
  creation or a change that names another kind is `422`. The generator `POST /admin/content-pages/generate` is retired with its use case and its
  read of the TAC catalogue. Migration 0069 deletes the rows of the five kinds and narrows the check, so the public page routes and the sitemap
  list can no longer answer one.
- **The TAC catalogue has no admin routes.** `GET /admin/tac-catalog`, `GET /admin/tac-catalog/:id`, `POST /admin/tac-catalog` and
  `PATCH /admin/tac-catalog/:id` are retired with their controller, use case, repository and tests.
- **The search tools are retired; the index stays.** Gone: the four synonym routes, the four pin routes, the three hidden-term routes,
  `GET /admin/search/report` and `GET /admin/search/preview` (additions of feature 29: their rows are deleted from `scripts/map-additions/29.mjs`),
  the event `search.settings_changed` and its `search_settings` job, pins in the engine (the curation set, its link in the services schema, the
  `pinned` mark of a match) and the hidden terms of the popular searches. The services schema version moves by one: at the worker's start the
  reconcile finds no alias of the new version and rebuilds the index by itself, the API answers from the database fallback until it is done, and
  the rebuild deletes the old curation set.

**Kept.**

- **Synonyms, as shipped data.** The rows of `search_synonyms` (migration 0033's five starting synonyms and whatever staff added before) stay,
  read only: the rebuild pushes the synonym set, the terms build and "did you mean" read them, and the ranking is unchanged. A visitor's search
  answers exactly as before. A new synonym now comes with a migration.
- `GET /admin/search/index` and `POST /admin/search/index/rebuild`; the public `GET /store/v1/search` and `GET /store/v1/search/suggest`; the search
  statistics (`SearchTermsCounter`, `search_terms_flush`, `search_terms_purge`, `search_terms_daily`), which the popular searches read.
- Static pages, blog posts, legal documents and the help centre, with every route they had.
- The table `tac_catalog`, its seed rows, the foreign key from `imei_checks` and the risk queue's read of a held order's device name. With no way
  to add an entry the device name stays empty in production until a list is loaded by a migration or a script.
- The tables `search_pins` and `search_hidden_terms`, emptied by migration 0069 and unread: dropping them waits for a later migration, so an API of
  the previous release never meets a missing table during a deploy.

**Consequences.** The console's Shop content page keeps Content and legal, Help centre and Search (the index panel). No staff member can change what
a search returns except by rebuilding the index; a term in the popular searches can no longer be hidden. Migration 0069 runs under the automatic
deploy: it deletes rows nobody can reach any more, narrows one check and empties two retired tables.

**The deploy window.** For the moment an API of the previous release still runs after migration 0069: a call of the generator answers `500` (the
narrowed check refuses its rows) instead of `422`, and a synonym, pin or hidden-term edit made in that moment writes a `search.settings_changed` row
that no route takes any more (the relay retries it with a warning until it is marked as handled by hand). Both need a staff member acting in those
seconds on a console of the previous release; they are accepted.

**Retired routes.** `POST /admin/content-pages/generate`, `GET /admin/tac-catalog`, `GET /admin/tac-catalog/:id`, `POST /admin/tac-catalog`,
`PATCH /admin/tac-catalog/:id` (rows of the map, listed in `test/contract/retired.ts`); `GET /admin/search/synonyms`, `POST /admin/search/synonyms`,
`PATCH /admin/search/synonyms/:id`, `DELETE /admin/search/synonyms/:id`, `GET /admin/search/pins`, `POST /admin/search/pins`,
`PATCH /admin/search/pins/:id`, `DELETE /admin/search/pins/:id`, `GET /admin/search/hidden-terms`, `POST /admin/search/hidden-terms`,
`DELETE /admin/search/hidden-terms/:id`, `GET /admin/search/report`, `GET /admin/search/preview` (additions, deleted).
