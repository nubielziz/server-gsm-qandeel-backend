# Progress

Single source of truth for status. The lead updates it after every step. Read it first.

## Resume here

**Sign-up collects the full details, with a password (2026-11-28, decision 079): merged and pushed on the owner's order ("push it fast, let CI/CD
check, do not check locally").** The owner's ruling: email, password, first name, last name, country and phone, all required.
`POST /store/v1/auth/sign-up` keeps the details beside the mailed link (table `account_signups`, migration `0074_account_signups`, the password
as an argon2id hash); the account is created when the link is opened (`POST /store/v1/auth/verify`): in the browser that asked, with the details
and the password; in any other browser with nothing applied, and the answer carries `pendingDetails` so the person confirms them and types a
password in `POST /store/v1/auth/sign-up/finish` (a session at most 60 minutes old, an account without a password; the mail
`customer.password_set` tells the owner). Why: a stranger must not be able to put a password or their details on someone else's mailbox. An
emailed sign-in link no longer creates an account (`customer.no_account` note, addressed by email, no row made). The country rule: with no tax
window in force (production has none) any ISO country is accepted (`src/common/countries.ts`), at sign-up, the staff create and edit, the
checkout and `PATCH /store/v1/me`. A `sign_up_purge` job every 15 minutes removes waiting details whose link ended. Built by an Opus
implementer, reviewed twice by an Opus reviewer (3 blockers and 10 fixes applied, then 0 blockers), final review by the lead (Fable 5.2).
**Checks:** typecheck, lint, format, English, routes, contract, OpenAPI, coverage, `db:check` (75 migrations) on the merged main; the agents ran
the sign-up, sign-in, checkout and account files in their worktree; the whole suite was NOT run locally on the merged main (the owner's order):
GitHub runs it. **Release:** the deployer was held so the backend and the shop go live together.

**One call reorders groups; API keys are named by the server and fully editable (2026-11-27, decision 078): merged and pushed on the owner's order.**
`POST /admin/service-categories/order` (all or none, one audit row, the price version moved once; the console drags groups, its decision 038) and
`PATCH /admin/api-keys/:id` with `name` and `expiresAt`, `POST /admin/clients/:id/api-keys` without a name (`API key <n>`). The owner's ruling: a
key's "permissions" are its allowed IP addresses and the period it is valid; only an Owner may widen them. The group delete now locks the
categories it changes in id order. Built by a Sonnet implementer, reviewed by an Opus reviewer (no blockers), final review by the lead.
**Checks:** typecheck, lint, format, English, routes, contract, OpenAPI, coverage, `db:check`; the contract tests and the changed files (1,454
pass). The map-additions spec of the new route is still `B-TBD group-order`. **Still being built:** sign-up with the full details (decision 079).

**The server makes a payment method's code and an alert rule's key (2026-11-27, decision 077): merged and pushed on the owner's order ("when you
finish push and check the website goes live").** Part of the owner's "fewer inputs in the console" list (the console's decisions 035 and 036): `code`
is optional on `POST /admin/payment-gateways` and `key` on `POST /admin/alert-rules`; left out, the server makes it from the preset's key or the
name (`src/common/identifier.ts`: lower case, accents dropped, runs of other characters into one underscore; `_2`, `_3` when taken; `rule_` in
front of an alert key that would start with a digit or be too short). A clash with a create at the same moment is settled by
`INSERT ... ON CONFLICT DO NOTHING` and the next number. A typed value is judged as before; PATCH unchanged; no migration. Built by a Sonnet
implementer, reviewed by an Opus reviewer with the console's side, final review by the lead (Fable 5.2). **Checks:** typecheck, lint, format,
English, routes, contract, OpenAPI, coverage, `db:check`; the contract tests and the money and health files (1,546 pass). **Release order:**
console, backend (the backend's check reads the console's main; the backend usually deploys first, which is the safe order here).
**Next (the owner's second request of 2026-11-27, being built):** one call to reorder groups and API key edits (decision 078), sign-up with the
full details and a password (decision 079), with the console's Orders columns, drag-and-drop groups and key dialogs and the shop's sign-up form.

**The owner's notes of 2026-11-27 (decisions 074, 075, 076): merged and pushed on the owner's order ("go ahead ... when you finish push the work and
confirm live").** Three features, one squash commit each, built in parallel worktrees (Sonnet and Opus implementers, two Opus reviewers, final review by
the lead, Fable 5.2). **074:** `POST /admin/services` makes the code when none is sent (`IMEI-`, `SRV-`, `RMT-`, `FILE-` and the service's own
id; `-2`, `-3` when taken; no existing code changes), and `PATCH /admin/service-listings/:id` with the stored `isListed` writes no audit row
(`AuditService.nothingChanged`). **075:** a website order (`source = 'portal'`) of a service with `allow_cancel` waits 2 minutes before the dispatch
claims it (`cancelWindowEnd`, the job moves itself to `delayed`; Dhru, shop, manual and held orders and services without the switch are sent at
once; a staff send inside the window waits too), and the merchant's order gains `cancelUntil`, `cancelBlocked`, `verifyUntil`, `verifyBlocked`
(a replay of an answer stored before the release has them filled in). **076:** ten more custom field types (`imei_bulk`, `imeisv`, `serial`,
`iccid`, `eid`, `meid`, `ecid`, `mac_address`, `mi_lock_code`, `box_sn`), one rule table (`FIELD_TYPE_RULES`) on every surface; `imei_bulk` is
one order at one price (up to 30 IMEIs, each checked; the blocklist, the payment step and the account block read every line); migration
`0073_more_field_types` (the check only, no data step). The console (its decisions 033, 034) and the shop (009, 010) carry their sides.
**Why it was asked:** the owner's test on production (service 199): the shop switch of Retail Purchase kept "Yes" (a console bug, their 033), the
Cancel button never showed (an automatic order is sent in the second it is placed) and the Verify button was only on the order's page.
**Checks:** typecheck, lint, format, English, routes, contract, OpenAPI, coverage, `db:check` (74 migrations), and the tests locally on the
merged main: contract, Dhru, e2e and every integration folder up to suppliers in one run, then orders, suppliers, customers, infra, storefront,
tooling and unit in a second (552 files, 6,886 pass, 0 fail). One failure in all: a timing test of `english-only-migration.test.ts` under two
parallel runs; it passes alone (18 of 18). **Release order:** console, backend, shop. **Open:** the local database `gsm` needs
`bun run db:migrate` (0073) when the dev stack is started again; the `withActionFacts` fill-in can go 7 days after the release.

**IMEI is a field type; the service type forces nothing (2026-11-26, decision 073): merged, not pushed (waiting for the owner's word).** The owner's
order: "do not make the server force an IMEI in services of type imei; make the IMEI input the default and give the user the freedom". A custom field
has a fifth type `imei` (digits, 15, Luhn; `invalid_imei` on `inputs.<key>`), judged on any service. An IMEI service is placed like a server service:
its fields decide; a sent `imei` (older pages, Dhru's `IMEI`, bulk items) is the value of its main-input field (`bridgedImeiOf`) and is judged by that
field; `orders.imei` is that field's value, else the sent `imei` (a service without a main-input field also falls back on the server rule). The checkout's
blocklist match and the account block read the main input and every `imei`-type field. The default field (the import, and now `POST /admin/services`
of type imei) is of type `imei`; the field-save audit row shows type and pattern. Migration `0072_imei_field_type`: the check takes `imei` and the
text main-input fields named IMEI of IMEI services become of that type; rehearsed on a scratch copy of production (277 changed, every other field
unchanged, a second run changes nothing; copy and dump removed). The owner's own test service (an optional textarea main input) accepts anything after
the release. Built by an Opus implementer, reviewed by an Opus reviewer (five findings, fixed), final review by the lead (Fable 5.2). **Checks:**
typecheck, lint, format, English, routes, contract, OpenAPI, coverage, `db:check` (73 migrations); the contract tests (463) and the order, checkout,
migration and field tests (351). The whole suite was not run locally. **Release order:** console (decision 031), backend, shop (decision 008).

**The option lists route is retired (2026-11-26, decision 072): merged and pushed on the owner's word.** The console's Options section of a service
(Models, Networks, MEP) is deleted (its decision 030), so `PUT /admin/services/:id/options` is retired (`test/contract/retired.ts`, 404). The table
`service_options`, every read of options (`GET /admin/services/:id`, `GET /client/services/:id`, the search labels) and the seed rows stay; no
migration (production holds no option rows). The outbox reason `options` left with its only writer. Custom field patterns are untouched: the console
only hides the column and sends the saved pattern back. Also **decision 071 is LIVE since 2026-11-26 13:31 UTC** (backend `9ae9a452`; migration 0071 ran:
278 IMEI services, none without a main input). Built by a Sonnet implementer, reviewed by an Opus reviewer (one finding, fixed by the lead: the console
mock keeps `options: []` so the harvested fixture matches the schema). **Checks:** typecheck, lint, format, English, routes, contract, OpenAPI,
coverage; the contract tests (463 pass), the retired-routes test and the touched catalog files. The whole suite was not run locally.
**Release order:** console, then backend.

**A plain IMEI service gets an IMEI field (2026-11-26, decision 071): merged, not pushed (waiting for the owner's word).** A Dhru supplier names
its main box only when it is not an IMEI, so after decision 070 production's 277 IMEI services without a main-input field could not be ordered in
the shop. `importShape` now gives a service that stays `imei` a first field (Name and label `IMEI`, required text, `isMainInput`); the sync's
adoption (decision 042) still works when a field is flagged: that field becomes the supplier's box in full (text, no options, same key). Migration
`0071_imei_main_input_field` (data only, additive, idempotent): flags a field named IMEI, else inserts the field first; rehearsed on a scratch
copy of production on 2026-11-26 (277 inserted, 0 services left without a main input, none with two, the fields of other types unchanged, a second
run changes nothing; the copy and its dump are removed). Built by an Opus implementer, reviewed by an Opus reviewer (one fix round), final review
by the lead (Fable 5.2). **Checks:** typecheck, lint, format, English, routes, contract, OpenAPI, coverage, `db:check` (72 migrations); the touched
test files (253 pass); search and object-store tests cannot run locally. The whole suite was not run locally. **Release:** backend only.

**Order forms draw only the custom fields (2026-11-26, decision 070): merged and pushed on the owner's word.** The owner had the shop's built-in
IMEI box and bulk IMEI list removed. `GET /store/v1/services/:slug` and `GET /client/services/:id` list every field with `isMainInput` (an IMEI
service's main-input field is no longer left out); the checkout and `POST /client/orders` take the IMEI from `imei` when sent, else from the value
under the main-input field's key (`typedImeiOf`; same normalisation and Luhn check, problems on `inputs.<key>`). `imeis`, the Dhru actions and
`imeiservicelist` are unchanged. No migration by the owner's ruling: **production's 276 active IMEI services have no main-input field and cannot be
ordered in the shop until staff add one to each** (Dhru orders keep working); the demo seed gives its IMEI services the field. Built by an Opus
implementer, reviewed by an Opus reviewer (no blocker), final review by the lead (Fable 5.2). **Checks:** typecheck, lint, format, English, routes,
contract, OpenAPI, coverage; the touched test files and the 16 seed files (2 seed cases and 3 Dhru file cases need the object store, not running
locally). The whole suite was not run locally. **Release order:** backend, then the shop (its decision 007); console decision 029 any time.

**Code-stock services and a service's own cost (2026-11-25, decision 069): merged, not released.** The owner sells gift-card codes
they buy themselves. `services.stock_delivery` ("Delivered from code stock", migration `0070_code_stock`, backfilled true for services that
hold any code that is not void): only such a service accepts a code import and only its orders take codes at placement (every path goes through
`InventoryStock.claim`); before, every service could hold codes and every order tried the stock first. A stock service with an available code
counts as supplied (shop publish, `supplyStates`, the `no_supplier` attention); with none and no usable supplier the publish reason is the new
`out_of_stock`, and an automatic order waits for staff ("No codes in stock and no supplier: deliver it by hand."). A service's own cost
(`services.cost`) is editable as `ownCost` on create and PATCH (`pricing:update`, cap 1e9, a create under the new floor refused like PATCH) with
every consequence of a supplier cost change; `recomputeEffectiveCost` now locks its rows in id order first (a race with an ownCost PATCH is
tested on two connections). Rows carry `stockDelivery`, `stockAvailable`, `ownCost`; `GET /admin/services` filters `stockDelivery`.
Built by an Opus implementer (backend) beside a Sonnet one (console, its decision 027), each reviewed by an Opus reviewer, one fix round
each; contract re-extracted against the console's main, fixtures harvested. **Checks:** typecheck, lint, format, English, routes, contract,
OpenAPI, coverage; the whole suite run locally (its only failures were files run against the same test database at once, rerun alone: green).
**Release order:** console, then backend.

**Shop content trimmed (2026-11-25, decision 068): merged, not released.** On the owner's order the landing pages, the TAC catalogue's admin
routes and the search tools of the console are retired; the search index status and "Rebuild index" stay. A content page is a static page or a
blog post (`POST /admin/content-pages/generate` and the five landing kinds are gone); the four `/admin/tac-catalog` routes are gone (the table,
its seed rows and the risk queue's device name stay); the thirteen synonym, pin, hidden-term, report and preview routes are gone with
`search.settings_changed` and the `search_settings` job. **Synonyms stay in the engine as shipped data, read only**, so a visitor's search
answers as before; pins and hidden terms are out of the engine (services schema version 2: the worker's first reconcile rebuilds the index by
itself, the API answers from the database fallback meanwhile). Migration `0069_shop_content_trimmed`: deletes landing rows, narrows
`content_pages_kind_check`, empties `search_pins` and `search_hidden_terms`, marks unsent `search.settings_changed` rows as handled; safe under
the automatic deploy. Built by a Sonnet and an Opus implementer in parallel worktrees, integrated by the lead (Fable 5.2), reviewed by an Opus
reviewer with no blocker (plan: `/home/saifi/gsm-project/.shop-content-trim/PLAN.md`). **Checks:** typecheck, lint, format, English, routes,
contract, OpenAPI, coverage and `db:check` (70 migrations); the contract, tooling, storefront, risk, infra and platform suites pass (3,926 tests
in the wide run, 2,494 in the last one); the whole suite was not run locally. **Release order:** console, backend, shop.

**API keys are made by staff (2026-11-24, decision 067): merged, released with the shop's read-only page.** The owner decided merchants no
longer create, change or revoke their API keys: `POST /client/api-keys`, `PATCH /client/api-keys/:id` and `DELETE /client/api-keys/:id` are
retired (listed in `test/contract/retired.ts`, a merchant session gets 404); `GET /client/api-keys` stays, read only. Staff routes are
unchanged (an Owner creates, staff change limits and revoke). `MachineCredentialHold` and the portal key notice's sender are gone; the
columns `password_set_by_staff`/`email_set_by_staff` stay, written but unread; old merchant-made keys keep working. No migration.
**Checks:** typecheck, lint, format, English, routes, contract, OpenAPI, coverage and `db:check`; the 16 touched test files (473 pass) and the
identity mail and notification-event unit specs. The whole suite was not run locally. The shop's side is its decision 005; push the backend first.

**One Name per custom field (2026-11-24, decision 065): built, all tests pass, generated documents rebuilt; not released.** A custom
field of a service has one Name (`service_fields.supplier_key`, `name` on the admin wire: never empty, unique in its service ignoring letter
case, exactly what a supplier receives in `CUSTOMFIELD`), a hidden key the server makes from the Name and never changes (order answers stay
stored under it), and the new flag `service_fields.is_main_input` in place of "supplier key `IMEI` means the main box"; the dispatch decides
the main input by the flag only (on an IMEI service with no flagged field, the import and the fields route flag the field named IMEI).
`PUT /admin/services/:id/fields` recognises a saved field by its key and refuses an unknown key, a repeated Name and a second main input; the
supplier import writes the supplier's own spelling as the Name; our Dhru list publishes the Name as `fieldname` and an incoming
`CUSTOMFIELD` is matched by exact Name, then by key, then by Name ignoring letter case; the order details carry `answers` (label and
value); the portal and the shop no longer draw a second IMEI box, and the problems of that field are reported on the IMEI. `orders.imei`
takes the flagged field's value first, as the dispatch sends it. Spec entries B276 to B279. **Checks:** typecheck, lint, format, the English check, `db:check` (69 migrations), the route, coverage and
contract-document checks, and every test passes; the OpenAPI documents, the console contract extraction, the harvested fixtures and the
contract pages are rebuilt. **Release:** by hand, by the "Release" section of decision 065: one migration, `0068_field_names` (data steps,
then a not-empty check and two unique indexes), alone, with the deployer on hold and the worker and the API stopped (stop both, deploy,
start); a failed start is repaired forward or by restoring the dump, never by putting the old image back on the migrated data. The backend
and the console go out together (the fields body needs `name`); merchants who synchronise our Dhru service list are told first
(`fieldname` becomes the Name). **Open:** the field map of a supplier link, for a second supplier that spells a field name differently.

**One account type (2026-11-24, decision 064): merged, not released.** Merchants and customers are one account type, told apart by a
rank (a client group; only the merchant kind is a merchant): one accounts table, one stored type word and one buyer column, one sign-in and
one session with a default-deny rank gate, one live wallet per account, and one Owner-only route that changes a rank. Migrations 0066
(expand, with a read-only preflight) and 0067 (permissions); the old customer routes answer 410 until the contract release. **Before it on
main, each its own commit and its own release:** the gate that closes the public hosts to all but the operator (deploy files only), then the
retired features of the merchant side (decisions 061 and 062, migrations 0064 and 0065). **Checks:** typecheck, lint, format, the English
check and every generator check against the console's `main`, the verify stage of the production image, and the whole suite locally
(10,866 tests pass, 1 skipped, none failed). The migration was rehearsed on a copy of a development database and compared row by row (accounts,
ledger, references). **Release:** by hand with the deployer on hold, by the runbook of `docs/OPERATIONS.md` (search for "decision 064"),
never by `resume`, `retry` or `force`: it needs a checked backup with a restore drill and a rehearsal on a production copy first, and
`PORTAL_BASE_URL` becomes the account area of the shop. **Open:** the contract release (it drops the frozen customer tables and the 410
routes) follows after the expand release has run for some days.

**The Product / Services page of the console, backend part (2026-11-24, decision 063): merged.** The owner replaced the console's
one-page Catalog with a page in the layout their staff know (console decision 022). The reads of decision 060 stay and are used by it. Three
additive parts were added for it. `GET /admin/services/price-grid` (feature 47) answers a page of services with the price every merchant
group pays today, taken from the price resolver the orders use, and the margins over cost. `services.sort` (migration 0063) stores the
order of services inside a category; `POST /admin/services/order` sets it, and the lists merchants and Dhru clients read follow it (groups
by category position, then the stored order, then name). `POST /admin/suppliers/:id/import` and its preview take an optional `status` and
`categoryId`; without them nothing changes on the wire. **Checks:** typecheck, lint, format and every generator check on the merged tree,
the generated documents rebuilt against the console's new `main` (343 console routes); the API boots. The tests were written and are run by
the checks on GitHub, not locally. **Release:** the console and this repository are pushed together with the server's deploys on hold, and
the hold is lifted when both runs are green (the contract check here reads the console's `main`). **Open:** `ServiceRow.sort` is always
sent and still optional in the contract; it becomes required when the console's service type reads it. **First run on GitHub (2026-11-23):** types, lint, the
generated documents and the production image passed; four tests failed and were corrected: the list of columns added to the map's tables
did not name `services.sort`; and three tests of the import options were wrong about the test, not the code (the two modules each hold
an importer, so its calls are watched on the class; Bun's `toMatchObject` leaves its matcher in the place of a text it matched; and two
fixtures put the price floor of a linked service under the supplier's new price, a state the sync never leaves for a first supplier).
**Known defect, older than this feature, not fixed here:** an import that raises the cost of a linked service above its price floor (the
supplier is not the service's first one, so the sync did not lift the floor) is refused by the check `services_effective_cost_check` and
answers 500. The cost and the floor must move together, through the bookkeeping the sync uses (`cost_was`, the price version).

**One-page Catalog, the reads of the backend (2026-11-23, decision 060): merged in two steps.** Owner request: adding and pricing a service
took three console pages (Services and pricing, Suppliers, Storefront); the console gets one Catalog page. This step only adds. A service
row carries its attention reasons (`no_supplier`, `below_floor`, `price_proposal`, `publish_failed`), its shop price and where that price
comes from, and with the right permission its listing, its shop state, the reason it cannot go on the shop, and its price rule; the detail
carries the last refused publish. The list takes the filters `needsAttention`, `hasSupplier`, `supplierId`, `isListed`, `notOnShop` and the
sort `retailPrice`. New route `GET /admin/services/:id/supplier-links` (feature 46, `scripts/map-additions/46.mjs`). The import of supplier
services answers with the services it created. Every new field is optional on the wire, so the present console keeps working. **Checks:**
typecheck, lint, format and every generator check on the merged tree; the tests ran on the branch (a first run on a loaded machine had
failures that passed when run again); two reviews. **Steps 2 and 3 (the same day):** the console's Catalog page is on its `main`; this repository then rebuilt the contract documents against
it (341 console routes), made `attention`, `retailPrice`, `retailPriceSource` and `createdServiceIds` required on the wire, and moved the link
of the retail-follow mail to `/catalog?view=settings&tab=shop-prices`. The push of step 1 met the new console on GitHub before step 3
existed, so its checks failed and nothing was deployed; the server's deploys were put on hold until this step is green. Seen and left as it was: an import of a changed item is refused with a server error
when the supplier's price moved without a sync (`services_effective_cost_check`).

**Checks on GitHub and automatic deploys (2026-11-23): DONE, running.** Owner request: a CI/CD pipeline for the three repositories. **Decision
057:** a workflow in each repository (`.github/workflows/ci.yml`; backend: the steps of `bun run check` in one job, the tests in six shards
through `GSM_TEST_SHARD` of `scripts/test-batches.sh` with one more run for a batch that failed, and a build of the production image; console:
types, lint, tests, build; website: types, lint, unit tests, and a job that only says when its generated API types are behind). No workflow
reads a secret. The production server deploys a commit of `main` by itself once its runs succeeded: `deploy/cd/auto-deploy.sh` on a timer
(build, a dump before a migration, migrate, replace, health check, the previous image back when that fails; `hold`, `retry`, `force`); nothing
is pushed to the server and GitHub holds no key of it. **Decision 058**, found on the same day while the production server was put behind a
CDN: there the visitor's address comes from the CDN's own header and `TRUST_PROXY` never holds a CDN's ranges; `deploy/cd/edge-cdn.py` writes
the server's Caddyfile from the repository's, and `deploy/cd/origin-firewall.sh` lets only the CDN reach the web ports. The first real run of
the runbook also corrected two of its lines: a MinIO user's password is at most 40 characters, and many hosts close the usual outgoing mail
ports. Documents: `docs/OPERATIONS.md` sections 1, 2, 3, 7 and the new section 8; README "CI". **Checks:** the whole check on the branch
(typecheck, lint, format and the generator checks; 727 test files, 9683 pass, 1 skip; one test of the first batch kept its 15-second limit
only when the batch ran alone: 522 pass); the console's and the website's workflows run by hand in a clean clone (console: 5825 tests and the
build; website: 986 tests); two review rounds. **Production** runs since 2026-11-23 (first deploy by section 2 of the runbook, every check of
its step 5 passed); the deployer is installed there, its steps were run once by hand for each part, and it waits for the first commit whose
runs succeed. **First runs on GitHub (2026-11-23):** all three workflows passed on their first real run (backend: the static job 2.6 minutes,
the six test shards 4 to 8 minutes each, the image under a minute; console 20 minutes; website 1 minute), after one start that GitHub refused
for the whole account. The server then deployed by itself: the website with its generated API types brought up to the contract (the comparison
is a required check there since), and the backend (build, no migration, containers replaced, healthy in under ten seconds). One correction
from that first day: a commit whose checks failed is asked about again after ten minutes, not thirty, so runs started again on GitHub are
noticed.

**Backups on Cloudflare R2, driven by the server (2026-11-23, decision 059): built, reviewed twice, first night proven by hand.** The
container scripts of decisions 036 and 055 stay as they were; new are the host side (`deploy/backup/gsm-backup.sh` with `run`, `check`,
`status` and `drill`, two systemd timers, alerts by mail through the application's SMTP account, an optional heartbeat), the encrypted copy of
the server's own configuration (`config-copy.sh`), `offsite-status.sh`, and `deploy/backup/r2-bucket-rules.sh` (lifecycle and lock rules: on
R2 the lock rules stand in for versioning and a key that cannot delete). Found on the first real run and fixed: R2 hands out a version id and
refuses requests that name it, so rclone's read-back after an upload is left out for `BACKUP_S3_PROVIDER=Cloudflare`. On the production server
the first dump went to the bucket and the restore drill passed with it (ledger sums to zero, 63 migrations). **Still to do on the server after
this release is deployed:** install the script and the timers, the first `gsm-backup run` (it adds the configuration copy), and the bucket's
rules once the owner's API token may edit R2.

**Second pass over money and access (2026-11-23): DONE, merged.** The branch `security/deep-financial-auth-fixes` (35 commits: 33 changes, the
list of tooling tests and the documents) was fast-forwarded into `main` on the owner's instruction after the final checks. The rules are in
`docs/decisions/056-second-pass-money-and-access.md`; B234 to B239 of `docs/contract/MISMATCHES.md` still wait for the owner's confirmation.
Every change was built with a test that fails without it and was reviewed before its commit. **Final checks (2026-11-23).** Backend, the whole
check on the merged commit `dd759053`: typecheck, lint, format and the generator checks; 725 test files, 9653 tests pass, 1 skip, 0 fail.
Console `main` (`f1bb3dc`): typecheck, lint, 5825 of 5825 tests and the build (`VITE_API_MOCKS=false`) pass; a walk of 19 pages and their tabs
on this code made 304 real calls, and the only answers that were not a success were the monitoring charts (the walk's API had no
`PROMETHEUS_URL`). Website `main` (`94a6d59`): typecheck, lint, 986 unit tests and the build pass. Its browser tests ran on this code from a
copy of its test folder outside the repositories, with the page's `Origin` added to the two `/store/v1` sign-in calls (the change its helpers
need since decision 045): 625 passed, 47 skipped, 37 failed. 32 of the 37 fail the same way on the code before this branch: they assume what
decisions 049, 052 and 053 changed (a ticket opened with a typed address, two-step sign-in before the address is confirmed, one receipt file
for two top-ups) or meet two manual methods in the demo data. Five come from this branch, where a rule meets what a test assumes:
`e2e/harness.spec.ts:127` (a merchant who confirms an address without a session chooses a new password), `e2e/merchant-account.spec.ts:54` on
both screen sizes (the confirmation of a signed-in merchant needs the `X-CSRF-Token` header; the page sends it, the test's direct call does
not), `e2e/support-live.spec.ts:218` and `:246` (the demo order was opened as a guest with the address of an account, so its ticket is
unconfirmed and the answer has no token). Three extra browser checks of the merchant pages on this code pass: confirming the address while
signed in keeps the password; confirming without a session mails a password link and the new password signs in; after staff set a temporary
password a new API key waits for a password from a mailed link. The website's generated API types are stale (`npm run gen:api`), as they were
before this branch. Migrations `0056` to `0062` are on the dev database `gsm` (a dump was taken first, and they were rehearsed on a copy).
**Not touched:** the demo database of the website's isolated API (`gsm_storefront`) is at migration 0046; run `scripts/dev-backend.sh reset`
in the website before its tests run from the repository again, then set the two demo merchants' passwords as the website's PROGRESS says. The
console and the website were not changed; what each needs, and the points left for the owner to decide, are in the report outside the
repositories: `/home/saifi/gsm-project/.security-audit/deep-financial-auth-fixes.md`.

**In progress (2026-11-22): the security fixes after the audit of 2026-11-20.** Status and next step: the section "Security fixes after the
audit" below; the live state, briefs and reviews are outside the repositories (`/home/saifi/gsm-project/.security-audit/fix/`, read `STATE.md` first).

**Job of 2026-11-10/11: DONE (2026-11-11, 13:00).** The owner's prompt (finish the roadmap, merchant management, a customer
wallet, the storefront's backend needs and a notification center; backend and console only; the storefront read-only) is built,
reviewed and merged. Flow per feature: Opus discovery (`.lead/w1/D1`…`D6`) → **Fable 5.2 plan, approved before any code**
(`docs/briefs/W0`, `20`-`24E`) → Sonnet or, for the hard parts, Opus implementation in `../backend-<id>` / `../frontend-admin-<id>`
worktrees → Opus review of the code **and of every implementer decision** (+ an independent Fable money review for 21 and 24C) →
the lead's merge (migrations renumbered, full check). Binding rules: `.lead/w1/LEAD-DECISIONS.md`; agent reports and reviews:
`.lead/w1/results/`. At most 5 agents at once (the owner's limit); one Fable agent wrote the last six plans (the owner's cost rule).

| Feature | Backend commit | Console commit | Migrations | Reviews |
|---|---|---|---|---|
| W0 routes beyond the map (decision 035) | `ed5416f` | | | Opus |
| 22 storefront catalog | `430cf59` | `de1b819` | 0020, 0021 | Opus (backend, console) |
| 21 customer wallet | `796eeab` | `faed3fb` | 0022, 0023 | Opus + Fable money (backend), Opus (console) |
| 20 merchant management | `1087d98` | `5e844ab` | 0024, 0025 | Opus (backend, console) |
| 23 notification center | `620eea7` | `1011fd7` | 0026, 0027 | Opus (backend, console) |
| 24B site API gaps | `8a501b0` | | 0028 | Opus |
| 24C payment fixes | `d4c7ce5` | `dbb33fb` | | Opus + Fable money (backend), Opus (console) |
| 24A smart sign-in | `dc747c0` | | | Opus |
| 24D production readiness | `e28683b` | | | Opus |
| 24E Arabic in PDFs | `4c20d45` | | | Opus |

Then: the console contract and fixtures re-harvested, B-entries **B183-B211** (`58dd931`), console `mocks:live` (298 routes,
`6048fd9`). Coverage: **438 of 438** endpoints (382 map + 56 additions). Dev DB `gsm` migrated to 0028 (the owner's data intact).
Handoff for the site: `/home/saifi/gsm-project/STOREFRONT-BACKEND-HANDOFF.md` (every section from merged code). ROADMAP has a status
table. **Final full check on `main` (`7b54cc6`, 13:40): typecheck, lint, format, routes, contract, OpenAPI, coverage and db checks green; tests 6429 pass, 9 skip, 0 fail** (the 9 skips are expected in the main checkout: 8 Redis-flush cases of `db-reset.test.ts` run only with a worktree's own Redis DBs, 1 needs `GSM_TEST_DOCKER=1`). Console `main` (`6048fd9`): typecheck, lint, build (`VITE_API_MOCKS=false`) green; 4704 of 4705 tests, the one failure a load flake that passes alone.

**After the job (2026-11-11 evening).** The storefront handoff was checked against `main` by a workflow (8 agents, every patch verified): 172 corrections in `STOREFRONT-BACKEND-HANDOFF.md` and the older `STOREFRONT-HANDOFF.md` (the file the site's `PROGRESS.md` reads; it now opens with a banner pointing at the new file and marks 110 changed spots). The check found three bugs, fixed in `3c096b5` (merchant campaign links and the "Manage notifications" link under `/merchant` once, joined to `STORE_BASE_URL`; a merchant link must be a `/merchant` page; the Announcements row saves without a linked Telegram; compose gives the site `GSM_API_ORIGIN`); `bun run check` green, 6432 pass, 9 skip, 0 fail. Console: `f42cd21` (a dialog opened inside a drawer no longer closes the drawer: the campaign composer's Add/Exclude people) and `ce3c152` (merchant link placeholder `/merchant/orders`). Follow-up: some console tests are timing-sensitive under load (different ones fail each full run, all pass alone); a longer `asyncUtilTimeout` in the console's test setup would steady them.

**Feature 25, service quantities (2026-11-11 evening): DONE.** Owner request: staff set a service's quantity. Plan `docs/briefs/25-service-quantities.md` (Fable 5.2); slices by Sonnet in `../backend-25` and `../frontend-admin-25` (removed), reviewed by Opus (both pass; small nits fixed by the lead). Backend `b10f03b` (POST/PATCH /admin/services take `minQty`, `maxQty`, `qtyOptions`; a service sells a range or packs, packs derive min/max; 422 codes below_min, above_max, invalid_pack, duplicate_pack, packs_set; migration `0029_service_quantity_limits` adds `services_qty_limits_check`; the service audit rows carry the values; a Dhru import copies the supplier's QNT/MINQNT/MAXQNT/QNTOPTIONS from `supplier_services.raw` at creation only; the import preview shows the rule and `quantityDiffers`), contract step `dd13563` (keys required; B212, B213). Console `272f0a3` (Quantity section in New/Edit service; `Qty …` hint in the table; Quantity column in the import preview). Dev DB `gsm` migrated to 0029. `bun run check` green on main (6483 pass, 9 skip, 0 fail). Both storefront handoff files carry the note (`STOREFRONT-BACKEND-HANDOFF.md` §13). Follow-ups: the receipt PDF prints no quantity or unit price; store cards show a one-unit price (the site should label it per unit).

**Feature 26, supplier Quick add (2026-11-12): DONE.** Owner request: add a supplier's services by whole group or all of them. Plan `docs/briefs/26-supplier-quick-add.md` (Fable 5.2); slices by Sonnet in `../backend-26` and `../frontend-admin-26` (removed), reviewed by Opus (both pass; nits fixed by the lead: the import SLA constants moved to `application/imported-service.ts` so the worker no longer loads the admin service, README, an unused export; console: the picker's query key, a doubled hint, headers). Backend `6764ffb`: `GET /admin/suppliers/:id/service-groups`, `POST /admin/suppliers/:id/quick-add` (202, a scope: all or 1 to 500 groups; serviceStatus active by default or disabled; 409 SUPPLIER_DISABLED, 409 JOB_ALREADY_RUNNING, 422 nothing_to_add), `GET /admin/suppliers/:id/quick-add/:runId`; list filters remoteGroup, type, isAvailable; creates only (not imported, available, importable type); queue `imports`, job `supplier_quick_add` from the outbox event `supplier.quick_add`, chunks of 100 under the supplier lock, item retry, 20 failures stop, 5-minute stall rule, start again = resume; table `supplier_import_runs` (migration 0030, one live run per supplier). Contract step `a1c6490` (B214, B215; harvested fixtures: the console mock seeds a finished run for supplier 6, plan override). Console `e5672a9` (Quick add dialog, Group filter in the picker) and `3575160` (mocks:live 301 routes, the seeded run). Dev DB `gsm` migrated to 0030. The dev containers had stopped with the machine at 19:02 on 2026-11-11 (clean exits); the lead restarted them with `docker compose up -d` on 2026-11-12. Follow-up: `test/integration/catalog-inventory.test.ts` "defaults to newest first" failed once under a full run (rows created moments apart came back as [2, 1, 3]); it passes alone; a tie-breaker on `id` in that sort (or the test) would steady it. Console: `system-health/tabs/queues/QueuesTab.test.tsx` ("a platform in trouble") failed twice on a cold run and then passed 11 runs in a row; its `/\d+m \d+s/` age check depends on the clock (the code was not touched by features 25 and 26). Console main after feature 26: lint and build green, 4786 of 4787 tests (that one).

**Features 27 and 28, live notifications and the support live chat (2026-11-15): DONE.** Owner request: notifications that appear at once, and support as a conversation. Plans `docs/briefs/27-realtime-notifications.md` and `28-support-live-chat.md` (Fable 5.2, `498c3e1`); decision 037 (SSE + POST, a Redis doorbell with ids only). Backend `ff4b053` (feature 27: `/admin/stream`, `/client/stream`, `/store/v1/me/stream`, replay by Last-Event-ID, caps 3 per session, 30 per address, 5000 per process; no migration) and `e679a61` (feature 28: live messages, typing, seen marks, attachments, My tickets, merchant support; migrations 0031, 0032; B217-B219), `5adb089` (B220, owner decision: a resolved ticket is closed for its requester, 409 TICKET_RESOLVED), `824f81a` (support contract parity: staff keys required, a multipart file part in the comparator). Console `db00207`, `97c985c`, `a8e6921` (live bell, motion, chime), `c8cd50f` (live support thread), `df46680` (contract bodies). Website `d14587a`, `2922d99` and the motion commits after them. Load test of the streams in `src/infra/realtime/README.md` (2000 streams: 94.5 KB per stream against a 50 KB target, idle CPU 2.65 %, p95 393 ms, 0 drops). Follow-up: per-stream memory.

**Feature 29, public storefront search on Typesense (2026-11-16): DONE.** Owner request: the search box completes words and phrases from the catalog and suggests the nearest services, English only. Plan `docs/briefs/29-search-typesense.md` (Opus 5.5, two adversarial reviews, `b9e4ab2`); step 0 by the lead (`bddfb90`: the dev container, engine checks, sizing; the typo-safety rule: `enable_typos_for_alpha_numerical_tokens` has no effect in 30.2, so the title is searched with no typos and a digit-free `title_words` copy carries the typos). Slices in `../backend-29` (B1 index, sync and infra by Opus; B2 search API, console routes and docs by Sonnet), `../frontend-admin-29` (C by Sonnet), `../storefront-29` (S by Opus), each reviewed by Opus with one fix round; the last must-fix (no engine slow-request log: it records the typed query) applied by the lead. Backend `84d7eb2` (decision 038, B221-B223, migration 0033_search, queue `search-index`, maintenance jobs `search_rebuild`, `search_reconcile`, `search_terms_build`, `search_terms_flush`, `search_terms_purge`). Console `91c6c8d`, `0113199` (Search tab: synonyms, pins, hidden terms, report, preview, index status, Rebuild). Website `2ab819e` (header combobox, results page; first-load JS under +1 KB per route, the lazy chunk about 10 KB; full e2e on the production build 745 passed, 0 failed; the lead fixed one combobox bug found by the e2e: text typed before the chunk mounted did not reach its state). Handoff `STOREFRONT-BACKEND-HANDOFF.md` §17. Full `bun run check` on `main` after the merge: 7008 pass, 9 skip (expected in the main checkout), 0 fail. Dev DBs `gsm` and `gsm_storefront` migrated to 0033; the owner's DB has no English listing yet, so its index is empty until English listings exist. Load (10k services, 100 suggest/s from 20 addresses): suggest p95 10.4 ms, results p95 60.6 ms, price-sorted p95 95.9 ms, 0 errors; full rebuild of 100k services 9.8 s (table in `src/modules/storefront/search/README.md`). Follow-ups: 12 Postgres queries per warm suggest (plan target 4; `RetailPrices.quotes` runs 6); short codes like "O2" or "5G" in brand or carrier match only through the title; `SearchCircuit.released()` for a rejected half-open probe; `CacheService.peek` for the popular-searches read; the facet labels read inside `engine.run`; a submit before the lazy combobox loads searches without a recent entry.

**Merchant application on WhatsApp (2026-11-16, website only): DONE.** Owner request: "Apply as a merchant" no longer sends a form; the page tells the visitor to message the team's WhatsApp number (+20 12 10230575) and staff open the account in the console. Website `68eb019` (Sonnet, two Opus reviews, the lead's integration; full e2e 748 passed, 1 unrelated flake). No backend or console change: `POST /client/auth/register` stays (the site no longer calls it). **Open, waiting for the owner:** `POST /admin/clients` takes no referral code and no staff route sets `referred_by_id`, so a merchant who applies through a referral link (the code arrives in the WhatsApp message) cannot be linked to the referrer; proposal: an optional `referralCode` on `POST /admin/clients` (422 `unknown_code`) and the field in the console's New merchant dialog.

**Feature 30, English only (2026-11-16/17): DONE.** Owner decision (2026-11-16): Arabic leaves the whole system (backend, console, website); `/en` URLs stay; stored Arabic content is deleted for good after a backup file; Arabic text that people type stays readable; people whose saved language was Arabic read English. Plan `docs/briefs/30-english-only.md` (Fable 5.2 after an audit by six agents and two adversarial reviews, `121e83e`), decision 039, spec B224-B227. 19 slices in `../backend-30` (B0-B6), `../frontend-admin-30` (C1-C3) and `../storefront-30` (S1-S5), the hard ones by Opus 5.5, the rest by Sonnet 5.5, six Opus reviews; the lock step by the lead (Fable 5.2) on 2026-11-17. Backend `f354855`: the language left 70 operations (the `locale` filters, body fields and response fields, `nameAr`, `alternates`, `byLocale`; campaign content `{ title, body }`; a strict route answers 422 to `locale`); one new public route `GET /store/v1/legacy-slugs/:kind/:slug` (where an old Arabic address leads now); migrations `0034_legacy_slugs`, `0035_english_only_data` (refuses without a fresh export; deletes the content in other languages, retires the legal versions people accepted, remembers the old addresses, rewrites the campaigns with system audit rows) and `0036`-`0039` (drop `service_listings.locale`, `content_pages.locale`, `help_articles.locale`, `notification_templates.locale`, `clients.locale`, `customers.locale`, `reply_templates.locale`, `service_categories.name_ar`; one listing per service, one slug, one template per event, channel and audience); `legal_documents.locale` stays as an archive tag; the guard `english:check` is part of `bun run check`. No queue, job or cache key changed. Console `b24098b`, website `73534db`. **The release is not additive** (`docs/OPERATIONS.md`, release 30: stop, export, migrate, start). Group C is kept and tested: PDF Arabic shaping, plain-text mails, CSV, `test/integration/user-text-stays.test.ts`.

The lock step, in order (2026-11-17): the one red test of the paired check was an order dependence, fixed (`test/integration/search-api.test.ts` clears the identity caches after its reset: the file before it left role 1 in the cache Redis); paired check 7101 pass, 1 skip, 0 fail; `docker build --target verify .` green; a `pg_dump` of both databases and the export files in `/home/saifi/gsm-project/.english-only/backup/` (never committed); `gsm_storefront` migrated first as the rehearsal (website check, build and the full e2e against it); website, then console merged; `gsm` migrated, then the backend merged; the isolated API restarted from `main`. What the migration did to the owner's `gsm`: 42 Arabic templates deleted; the one Arabic listing deleted (service #20 "3 Hutchison & CPW & Flex Policy UK - iPhone All Models", listed only in Arabic, 0 orders, 1 open checkout session: it has no shop page until staff add an English listing; its old address leads to the service list); 3 sent campaigns lost their language filter; nobody lost an audience; no legal document was touched. In `gsm_storefront`: 42 templates, 5 listings (their addresses are remembered), 6 draft pages, 82 sent e2e campaigns became text only, and Terms 3.2 in Arabic (118 consents) is kept as history, out of force.

Also on 2026-11-17: the console's Add listing dialog searches the services on the server (`b9d8ded`, owner's request: the select showed only the first 200 names). **For later:** take `scripts/english-only-export.ts` out of the image (`Dockerfile`, `.dockerignore`, `test/unit/deploy-files.test.ts`) once every environment is migrated; the website's cleanup wave (S6-S9, no URL or behaviour change) is its own commit.

Checks on the three `main` branches after the merge (2026-11-17): backend `bun run check` 7096 pass, 9 skip (the main checkout's expected skips), 0 fail (the generated `docs/contract/frontend-endpoints.json` had to be extracted again on `main`: it names the console folder it was read from); console typecheck, lint, build and 5264 of 5264 tests, `mocks:live` up to date (321 routes); website `npm run check` green and the full e2e in dev mode against the isolated API 650 passed, 59 skipped, 1 failed under load (`[mobile] merchant.spec.ts:144`, 3 of 3 alone). The e2e found two races of the tests themselves, fixed in the website (`hydrated(page)` in `e2e/helpers.ts`: `go()` waits only for the first form control, which is the header's search box since feature 29; a form lower on the page hydrates a moment later). Records: decision 039, the `CLAUDE.md` clause, `STOREFRONT-BACKEND-HANDOFF.md` section 18 with a banner over the older sections. **`STOREFRONT-HANDOFF.md` was found empty** (saved empty on 2026-11-15 03:05): the lead restored the last copy that could be found (the text of 2026-11-09 23:19, from the editor history of an earlier session) under a banner; the marks of 2026-11-11 are lost; a raw copy is in `.english-only/backup/`.

**Feature 31, publish services to the shop in bulk (resumed 2026-11-18, merged 2026-11-19): DONE.** Owner request (2026-11-16): stop adding shop services one by one; postponed on 2026-11-17, resumed on 2026-11-18. Plan `docs/briefs/31-bulk-publish.md` (Fable 5.2, two adversarial reviews; 16 lead corrections at its top after `main` moved), decision 040, rulings B228-B231, mismatches M265 and M10c. Backend `8a41c3d` (one squash commit: routes, jobs, tables, migrations 0041-0046 in its body) and `3067991` (contract harvested on main, five stale allowlist entries removed); console `185045c` and `f1bb3dc` (live routes, 340). Built in 12 slices (B1-B6 with B3 and B4 split, C1-C4) by Opus 5.5 and Sonnet 5.5; Opus reviewed every money and concurrency slice line by line (B1, B3a, B3b+B4a+B4b, B5), then the whole branch twice: a conformance review and an adversarial attack (six findings fixed: buyers see the published title at checkout, tracking, account orders and receipts; a stale group price form no longer undoes a following price, `retailPriceSeen`; a reset needs `storefront:update` when it drops a chosen price; the `Imported` group gives no brand; the scope-cut note survives; existing category names cleaned once). **Owner decisions of 2026-11-19:** clean the existing category names once (migration 0046 queues `category_names_clean`: 18 of the owner's 302 names change when the owner's worker starts; a name written only in Arabic script, category 258, keeps its name), and migrate and merge without asking again. **Checks:** paired check against the console branch 8056 pass, 1 skip, 0 fail; console whole suite 5825 green; the whole check on main after the merge (`3067991`) 8049 pass, 9 skip (the known skips of main's `.env.test`), 0 fail. **Databases:** `gsm_storefront` and `gsm` migrated to 0046 after dumps (`.english-only/backup/*-before-0041-20261119-1123.dump`). **Walk (L5)** through the API of the isolated stack (scripts in `/home/saifi/gsm-project/.bulk-publish/walk/`): a first preview with no rule, two rules, Check again, edits, apply, the shop and the search, the run off the shop and back, Quick add publishing, a price that follows, a jump that waits and is approved at the figure seen, a cost that jumps before apply (`cost_moved`), the hourly message rows: all as the plan says. Small notes left (none blocks): `counts.noRule` also counts `file` rows (the owner has none); a group named `Licenses` or `Remote` becomes a server brand (demo data only); a rule preview's `following` counts every follower in reach. **For the owner to do:** start the API and the worker (the category clean-up runs then), make the retail pricing rules (Storefront, Retail pricing), then publish (Storefront, Publish, or Quick add with "Also put them on the shop") and read the preview before Publish; set `ALERTS_EMAIL_TO` (or the Telegram chat) for the hourly price message. Briefs, notes and reviews: `/home/saifi/gsm-project/.bulk-publish/`.

**Feature 32, ready-made payment methods with logos (2026-11-17): DONE.** Owner request: have bank transfer, crypto transfer, Vodafone Cash, Fawry, InstaPay, Binance Pay, NOWPayments and Binance Pay (automatic) ready to switch on, each with its logo, in the shop, the console and the backend; anyone with a method of their own still adds it. The owner's rulings: the six manual transfers now, the two automatic ones listed as "Coming soon" until their drivers are built; a manual method tops up a balance only, as before; logos from official sources, each source written down, and a custom method gets a logo staff upload. Plan `docs/briefs/32-payment-method-presets.md` (Fable 5.2), **decision 041**, spec B232, console M266. Three slices by Sonnet in `../backend-32`, `../frontend-admin-32`, `../storefront-32` (removed), two Opus reviews with one fix round each (backend: a `PATCH` could turn a preset-made method into another kind, so the preset's kind and driver are now kept on `PATCH` too, and the file cleanup learned the logo reference; frontends: two mock templates differed from the catalog and the dialog let staff change the two kept fields). The lead: the five logo files (Simple Icons drawings, CC0, for Binance, Vodafone and Fawry; NOWPayments' and InstaPay's own pictures; sources in both `docs/LOGOS.md`), the paired step (contract re-extracted and re-harvested, 324 console routes), and a hand walk on the isolated API (add Vodafone Cash from the catalog, a custom method with an uploaded logo, top up a store balance with it, approve it: credited, method `bank`; both forms show the logos), which found that a logo was held to the 200 pixels of a service picture: **a logo needs 64 pixels on each side**. Backend `8aa6a18` (routes `GET /admin/payment-gateway-presets`, `POST` / `DELETE /admin/payment-gateways/:id/logo`; `preset` on create with four `422`s; `preset` and `logoUrl` on the gateway row, both top-up method lists, the config's and a checkout session's `paymentMethods`; migration **0040** additive), console `d3d7f59`, website: see its PROGRESS. Databases: `gsm_storefront` then `gsm` migrated to 0040 after a `pg_dump` (`.english-only/backup/gsm-before-0040-20261117.dump`). **Nothing was added to the owner's `gsm`: the owner adds each method in the console (Settings, Payment methods) with their own account details.** Whole check in the worktree before the merge: 7154 pass, 1 skip, 2 fail, both fixed and rerun green (the multipart logo body needed an allowlist entry in the contract comparison; `support-tickets.test.ts` searched `T-90`, which broke when one more ticket was made earlier in its batch: it searches `T-9` now). Known and unchanged (decision 041): `GET /client/payment-methods` lists an automatic method whose driver has no code, and a top-up through it answers `GATEWAY_ERROR`; only a custom row typed by staff can be one. Not ordered yet: the NOWPayments and Binance Pay drivers; PayTabs, PayPal and FawryPay (discussed 2026-11-17). **Checks on the three `main` branches after the merges (2026-11-17, evening):** backend `bun run check` 7151 pass, 9 skip (the main checkout's expected skips), 0 fail; console typecheck, lint, build (`VITE_API_MOCKS=false`) and `npm test` 5339 of 5339; website `npm run check` green (types up to date, 984 tests, build) and its e2e on a production build of the branch against the isolated API: 661 passed, 47 skipped, 2 failed, both tests and not the site, fixed and rerun green (the website's PROGRESS has the account). The isolated API (:3100) runs from `main` again; the demo database keeps one switched-off Vodafone Cash method from the hand walk.

**Brand: IMEI-HUB (2026-11-17): DONE.** Owner request: the logo `IH Orbit IMEI-HUB Logo.png` is the logo of the shop and the console, and the name is **IMEI-HUB everywhere** (the website said "GSM Store", the console "GSM Supply"). Backend `ecb0772`: the authenticator issuer (a new enrolment is labelled IMEI-HUB; enrolled codes keep working), the footers of invoice, statement and evidence PDFs, the titles of the two API references, the queue board, the sender name of the development default (`MAIL_FROM`), with the contract examples, tests and harvested fixtures. Console `8231e58` (the mark in the sidebar and on the sign-in screens in both themes, the tab icon, every title and mock). Website: see its PROGRESS. The kit (the owner's picture, the cutting script, every file, the payment logos with their sources) is in `/home/saifi/gsm-project/.brand/`, outside the repositories. Not renamed, on purpose: the PDF producer and creator fields (the golden test keeps Latin documents byte-identical), the webhook `User-Agent` (`GSM-Webhooks/1`), referral codes (`GSM` + six characters), cache keys, package and repository names, the demo sign-in addresses (`@gsm-supply.example`). The owner's own `MAIL_FROM` in `backend/.env` still says "GSM": theirs to change.

**Feature 33, real Dhru Fusion suppliers (2026-11-17, evening): DONE.** The owner's first real order (paid from the store balance) was refused by its supplier twice with `Parameter 'ID' Required`, although the call carried `ID`; the owner asked for the cause, then for the fix. Three gaps of one family, each proved in the supplier's own answers: (1) **the wire form**: a supplier that runs Dhru Fusion itself reads `parameters` only as the plain XML string of the classic Dhru client, and we sent base64 of JSON (the standards v6.1 form decision 026 fixed for our own Dhru server); the column `suppliers.param_format` said `dhru_xml` and nothing read it. A read-only probe (`getimeiorder` for an order that does not exist) settled it: plain XML answered `NoResultFound`, base64 of XML and base64 of JSON answered `Parameter 'ID' Required`. (2) **the main box**: the classic service list describes the main box of an IMEI service as `CUSTOM` (an ECID, a serial number, a lock code instead of an IMEI; its value travels as `IMEI`); the import read only `Requires.Custom`, so 359 of that supplier's 1158 services were IMEI services that demand a real IMEI. (3) **required fields**: a Dhru Fusion site marks a required field with `required: "on"`, which the import read as optional (635 of 637 fields). Plan `docs/briefs/33-dhru-fusion-suppliers.md`, **decision 042**, spec B233, console M267. Backend `a3090c7`: parameters in the supplier row's format (`dhru_xml` the classic XML, `json` base64 of JSON; the stored call says which); such a service is a `server` service whose first required field is the box (supplier key `IMEI`, one rule in `src/common/dhru/main-input-key.ts`; the dispatcher sends it as `IMEI`); the import reads `on`, takes `radio` as a list and leaves `adminonly` out; **the supplier's sync brings the services made before in line** (an unarchived service with exactly one active link at that supplier: the type and the box, required fields raised, never lowered; one audit row per change; `adopted` in the sync's answer); a supplier's own patterns are never used (untrusted); a shop checkout opened before an adoption keeps the buyer's value. Order and money rules unchanged; no schema change. Console `5ed70c8` + `46b2bde` (the sync toast says how many services now ask for what the supplier requires). Built by Opus in `../backend-33` (removed), reviewed by Opus (FIX: untrusted supplier patterns, the checkout across an adoption; fixed; re-review PASS); the required-fields round was found from the owner's question and reviewed by the lead. **Checks, said plainly:** the whole check ran on the first slice (7190 pass, 1 skip, 1 fail: the sync fixture, fixed by the paired step); after the two fix rounds the owner asked to skip what is not needed, so typecheck, lint, format, the document checks and the tests of the changed code ran (950 pass in 45 files on the branch, 655 in 27 on `main`), not the whole check at merge time. **The whole `bun run check` then ran on `main` (`d051f4a`) the same evening, in the background: 7208 pass, 9 skip (the main checkout's expected skips), 0 fail.** The new driver was tried against the owner's supplier with the same read: `dhru_xml` answered `NoResultFound`. **For the owner:** start the API and the worker again, press Sync on the supplier (the toast says how many services changed), refund order 1 (it holds a test IMEI where the supplier wants an ECID) and place a new order. Not done, written in the plan: a console control for the format; our own Dhru server still reads only base64 of JSON from a merchant's client (check with the first classic Dhru site that connects).

**Test layout (2026-11-19): DONE.** Owner request: reorganise the backend's files and keep the tests apart from the code; the
owner chose the first of three proposed layouts. **Decision 043**; one commit on `main` (`438dd6c`), built by the lead (Opus 5.5) in
`../backend-test-layout` (removed) with a move script and `git mv` (601 files). No test file is left under `src/` (the image no
longer carries 296 specs); `test/unit/` mirrors `src/`; `test/integration/<module>/` (12 modules and `infra/`); `test/e2e/` (was
`test/scenarios/`); `test/tooling/` (scripts, deploy files, lint rules, schema structure, module loading); tests import code as
`@src/...` (tsconfig `paths`), `src/` keeps relative imports (a lint rule refuses `@src` there); the env, wall-clock and console
lint rules now also cover `test/unit/`; `test/tooling/test-layout.test.ts` guards the layout. Found on the way: `bun run test` never
ran `test/lint/lint-rules.test.mjs` (the batches looked for `.ts` only; 58 tests now run), and `health-seed` read a dashboard payload
another file had cached seconds before once both sat in one batch (it drops the dashboard cache after seeding). **Checks:**
`bun run check` green in the worktree, 8117 pass, 1 skip, 0 fail; registered tests counted per file in both trees before the merge:
equal for every moved file; on `main` after the merge: typecheck, `test:unit` (2803 pass) and the layout and lint-rule tests (61 pass).
Not done, offered to the owner: tidying `src/modules/platform` (sub-features beside the layer folders) and `scripts/` (30 files flat).

**Security fixes after the audit (started 2026-11-20, in progress).** Owner's order: close every finding of the security audit of 2026-11-20
(3 high, 23 medium), then name the places that deserve another review. Backend only; the console and the website are read-only and their needs
are collected for a handoff. Flow per feature: a plan by Opus 5.5 at max effort with the lead's rulings appended, an implementer in
`../backend-<id>`, an adversarial review with one fix round and a re-review, then the lead (Fable 5.2) reads the diff, proves the fix (the new
tests fail on the old code), runs the whole check and squash-merges. Briefs and reviews stay outside the repositories on purpose; decision files
state each rule and its reason.

| Feature | Commit | Decision | Migrations | What it guarantees |
|---|---|---|---|---|
| 34 dispatch state | `69b524a` | 044 | 0047 | An order being sent to a supplier waits for the answer: cancel, reject, reply, change of supplier and refund approval wait while the call is in flight; a sweep on the maintenance queue finds sends that were lost |
| 35 origins per surface | `b043de5` | 045 | none | Browser origins are a property of the surface: `CONSOLE_ORIGINS` for the staff surface, `SHOP_ORIGINS` for the merchant and storefront surfaces, none for the machine surfaces |
| 36 privilege ceiling | `8065e0c` | 046 | none | Staff act only inside the permissions they hold; stronger actions ask for a second permission or an Owner; a change of the IP rules by a non-Owner cannot refuse an address an active Owner uses, now or when a rule runs out |
| 42 sign-in and mail limits | `745c9ce` | 052 | none | Per-email sign-in limits count per email and network; ten failed passwords lock an email for 15 minutes for every network its account has not signed in from; the sign-in link and forgot-password mails are capped per recipient; temporary passwords expire after 72 hours; two-step sign-in needs a confirmed address |
| 41 suppliers | `50b8517` | 051 | 0048 | A saved supplier key stays with the address it was saved for; what a supplier answers is cleaned and bounded; a field pattern is checked against a supported form before it ever runs; only an Owner allows supplier calls over plain http |
| 44 logs and secrets | `20a4355` | 054 | 0049, 0050 | A failed database statement leaves no values in logs, error reports, job records or queue pages; the proxy's access log writes no link token; the shop's link tokens are stored as a keyed hash; one key (`LOOKUP_HASH_KEY`) for the hashes kept for later matching |
| 39 manual money and exchange rates | `ddea7c4` | 049 | 0051 | A transfer receipt backs one payment (by file and by content); a staff member's manual credits are capped over 24 hours; a manual invoice is not approved by its issuer; money on the wire is bounded and signed only where it can be; a refreshed exchange rate that moves beyond a bound is held, and an old rate is not offered |
| 45a infrastructure, inside the application | `e02e478` | 055 (part A) | none | Cache entries are sealed and checked before they are trusted; database statements, lock waits and idle transactions end at a limit and answer 503; work whose queue job was lost is asked for again (`lost_work_reconcile`); handed-over outbox rows are purged after 45 days |
| 38 payments integrity | `9a3aa04` | 048 | 0052 | A payment confirmation counts only when the gateway's own record says paid, for the quoted amount and currency, for this payment; what cannot be captured as quoted is held, sent back where the gateway can, and closed by staff; a late payment is refunded; a card top-up is credited only against the gateway's record; a refund of a disputed payment is not sent, and an unsent one is reversed at a chargeback |
| 40 risk inputs | `8abc73e` | 050 | 0053 | The card's issuing country and funding and the visitor's country are read and used; a rule without an input source does not apply and is named at boot; while a tax window is in force a country without one is refused and a payment whose card or visitor country differs from the declared one is held; a guest checkout is judged as a first order; a block from a guest order can be limited to guest checkouts; order counts see checkouts still being paid; a top-up without a risk screening goes to staff |
| 45b infrastructure, the production stack | `6ba0a4d` | 055 (part B) | none | Five networks with fixed proxy addresses; the application's own database role, checked at a production start; passwords on both Redis instances; application and backup users for the file store and a files host for signed reads only; a production start refuses template, development and weak values; encrypted, append-only backups |
| 37 staff data access | `3d277cf` | 047 | 0054 | An email change of a merchant or a customer needs the security permission of that account, ends its sessions and tells the address before the change; the mails that carry a sign-in link or protect an account keep the link and the notice visible, hold no other address, and cannot be switched off; a stored file opens only with the read permission of every record that uses it, and identity documents and payment proofs are audited; a customer's address is masked outside the Customers pages; the order export and the digits of an IMEI check need their own permissions |
| 43 limits of the public surfaces | `7c394a5` | 053 | 0055 | Request text with U+0000 or an unpaired surrogate is refused; a ticket opened by a typed address is unconfirmed until its link is used and its receipt holds nothing a visitor typed; a marketing answer counts once the address is confirmed; uploads are bounded by bytes read, by a live session and by quotas, and a janitor removes unused files; lookups of unknown sessions and keys are counted per address; merchant webhooks have a test budget and switch off after twenty failed deliveries; the health probe, incoming webhooks and bulk calls are bounded; the server bounds the time of a request |

Checks: the whole `bun run check` on the tree of `8065e0c` (main with 34, 35, 36): 8290 pass, 1 skip, 0 fail; on the tree of `745c9ce`
(with 42): 8393 pass, 1 skip, 0 fail; on the tree of `50b8517` (with 41): 8456 pass, 1 skip, 2 fail, both Redis command timeouts under load in
files the change does not touch, each green alone; on the tree of `20a4355` (with 44): 8565 pass, 1 skip, 2 fail, both naming one migration as
pending in a test database migrated before the renumbering, green on a fresh one. From here the whole check runs its test batches in four
parallel shards (same batches, isolated databases; a failed batch is run again alone): the tree of `ddea7c4` (with 39): typecheck, lint and
generators pass, 8631 pass, 1 skip, 1 fail (the 15-second limit of one openapi-generator test under load; its batch alone 179 pass); the tree
of `e02e478` (with 45a): 8706 pass, 1 skip, the same single limit, its batch alone 317 pass; the tree of `9a3aa04` (with 38, after the
generator tests got a time limit that fits, `c4f647a`): 8808 pass, 1 skip, 0 fail; the tree of `8abc73e` (with 40, after the test helper
learned to clear the cached IP rules, `bab76b7`): 8863 pass, 1 skip, 0 fail; the tree of `6ba0a4d` (with 45b): 8978 pass, 1 skip, 0 fail; the tree of
`3d277cf` (with 37): 9079 pass, 1 skip, 0 fail; the tree of `7c394a5` (with 43, the last one): 9270 pass, 1 skip, 0 fail. Dev DB `gsm`
migrated to 0055 after a dump before each step (the worker's one-off review of stored field
patterns clears nothing there: all 458 are in the import's length form). **For the owner:** production now needs `CONSOLE_BASE_URL`, `STORE_BASE_URL` and `PORTAL_BASE_URL` as https addresses and refuses
`CORS_ORIGINS`; outside production `CORS_ORIGINS` still fills both lists, with a warning at boot (`docs/OPERATIONS.md` section 1). The website's e2e
helpers must send the page's `Origin` on the two `/store/v1` sign-in calls.

All findings of the audit of 2026-11-20 are closed on main (3 high, 23 medium; features 34 to 45, decisions 044 to 055). What the console
and the shop must change, and the places that deserve another review, are written down outside the repositories for the owner.

Next (2026-11-22, night): a second, deeper review of the money logic and of sign-in, permissions and tenant scoping, with fixes on the branch
`security/deep-financial-auth-fixes` (not merged: the owner reviews it first).

**For the owner after decision 053:** a ticket opened from the contact form with a typed address joins the customer's account only after the
link in its receipt is used. A merchant webhook endpoint whose last 20 deliveries failed is switched off and the merchant is told by email.
The upload janitor removes files that nothing has used for 7 days.

**For the owner after decision 047:** a staff role that changes merchant emails needs `clients:security`, one that changes customer emails
or creates customers with a temporary password needs `customers:password`, the order export needs `reports:read`. A stored mail template
of an account link or a security notice that breaks the new rules is not sent: the shipped text goes out instead, with a warning in the
worker's log, until the template is saved again in a form the rules accept.

**For the owner after decision 050:** create a tax window for every country the shop sells to before the first window goes live (0 % with
the type "no tax" where none is due): from then on a country without one is refused at checkout. `GEOIP_COUNTRY_HEADER` stays unset
until a CDN in front of the edge writes the visitor's country.

**For the owner after decision 055 (part B):** nothing changes for development. The first production release with it recreates every
container: follow "Release with decision 055" in docs/OPERATIONS.md in its order.

**For the owner after decision 054:** production needs `LOOKUP_HASH_KEY` (an
installation with data sets it to its `TOKEN_PEPPER`); a Telegram bot's webhook needs a new secret and a new registration
(`scripts/telegram-webhook.ts`); the worker converts the stored link tokens once when it starts. **After decision 049:** a currency whose rate
was not saved or refreshed for 48 hours is not offered until its rate is saved again; production needs `FX_API_KEY` or `FX_PROVIDER=manual`.
**After decision 055 part A:** every cache entry is read as a miss once after the release.

**Follow-ups (not blocking):** a test of a top-up dispute through `/webhooks/payments`; a same-instant refund.failed/complete race in
`refund-settlement.ts`; `closeForErasure` should also refuse while a balance-paid order is not final (B191); no per-email lock on the
old `POST /client/auth/login` (B208); remove `TURNSTILE_MERCHANT_AUTH` one release after production runs with it on; harvest
overrides for `PATCH /admin/clients/:id` and `PATCH /admin/service-listings/:id` (their fixtures fell out of the re-harvest); the
merchant inbox list defaults to English when no `locale` is sent (the site always sends it); `test/integration/db-reset.test.ts` times
out (240-340 s) only while several full suites run at once (passes alone); the console's `npm run build` refuses the owner's local
`VITE_API_MOCKS=true` (build with `VITE_API_MOCKS=false`). **Owner decisions:** payment provider, JOD display decimals (2), the wallet's
legal sign-off before `wallet.customer.enabled`, mail domain, Sentry account, backup storage and key holders, JoFotara, customer email
self-change, data-export delivery, orderable model/network/MEP options. Lesson recorded: merge a console part only after its backend
is on `main` and no backend branch that lacks it is still in flight. The queue Redis AOF was repaired once after a power loss (backup
in `~/gsm-redis-aof-backup-2026-11-10/`); `db:migrate` now says how many migrations it applied (`ca7af73`).

**Next work is planned, not built: `docs/ROADMAP.md` (2026-11-09).** The owner chose one public site for merchants and regular
customers (two account types, one smart sign-in, the whole merchant portal inside it, Arabic and English). Phase 0 (staff cannot
yet reset a merchant's password, resend an invitation or edit a merchant's details) was **deferred by the owner ("later")**: the
website comes first, in a new session, from `/home/saifi/gsm-project/STOREFRONT-HANDOFF.md`; its app is
`/home/saifi/gsm-project/storefront` (the owner's Next.js scaffold and designs in `screenshots/`). A merchant cannot set a
password or create an API key until that site (or phase 0) exists. **Customers get a wallet too** (decided 2026-11-09):
ROADMAP **phase 2W** (per-customer ledger accounts and a migration, top-up and balance-pay money events, `/store/v1/me/wallet*`,
pay method `balance`, a console Wallet tab, legal and payment checks), backend first, before phase 2 goes live. Mail in development goes through Resend (`backend/.env`, git-ignored, `smtps`
on 465 because this network blocks plain SMTP on 587).

**First run on a fresh server: P4b merged (2026-11-09, `1f18322`, B181).** Found after the final state: only the dev seed (which
refuses production) made the base currency, the 12 system ledger accounts, the Owner role and someone who can sign in, so a fresh
production database had no way in. Now:
- **`bun run setup`** (production-safe, idempotent; brief `docs/briefs/P4b-first-run.md`): applies the pending migrations, creates
  USD, the 12 system ledger accounts (one definition shared with the seed) and the Owner role, then, in a terminal with no admin yet,
  asks for the first admin (email, full name, hidden password twice; the user chose this flow). The first sign-in goes to the TOTP
  enrollment. Deploy scripts: `--email --name` (temporary password printed once, forced change) or `--password-stdin`.
- **`bun run db:reset`** (development only, local servers only): drop and recreate the dev database, migrate, empty both Redis
  databases and the files bucket, then nothing, `--seed` (the demo) or `--setup` (the same questions).
- Review: four Opus lenses (security, correctness, CLI, tests); the two blocking claims were refuted by an adversarial check and kept
  as hardening; merge fixes reviewed. Full `bun run check` 5554 pass, 1 skip, 0 fail. The lead's walk
  (`.lead/walk/first-run-walk.py`: a real pseudo-terminal on scratch databases, then each kind of first admin signs in and enrolls
  TOTP through the API): 34 of 34.
- Also fixed: the dashboard test failed between 21:00 and 23:00 and before 05:00 UTC (clock now pinned to 12:00 UTC);
  `suppliers-admin` read the last audit row without an order; `security-seed` left cached IP rules behind. The test runner's
  per-process memory guard (`GSM_TEST_MAX_RSS_MB`) defaults to 6000 MB (the user's approval).

**Final state (2026-11-08, 22:20): the project is complete.** Every feature is built, reviewed (Opus), checked and squash-merged
on `main`: through 9 and 14a as below, then **12a** (`4af39e9`, B170), **15** (`a9301be`, B171), **14b** (`f3a8341`, B172),
**11** (`93bab9b`, B173), **12b** (`320404c`, B174), **17** (`3e5e775`, B175), **19** (`9df68a8`, B176), **16** (`8085f59`,
B177), **18** (`35dfcde`, B178), **6b** supplier call contracts (`d2ed171`, B179), **P4a** follow-ups (`6afa404`, B180) and,
the next day, **P4b** first run (`1f18322`, B181, above).
`docs/COVERAGE.md`: **382 of 382** manifest entries built (routes, Dhru actions, supplier calls, events; `test/contract/pending.ts`
is empty), the console's **269 of 269**, **13 of 13** scenario e2e tests. Last full `bun run check` (P4a, on the tree that became
`6afa404`): 5383 pass, 1 skip, 0 fail, every step green; `contract:check`, `routes:check` and `coverage:check` rerun on `main`
after the merge. **Final walk** (Playwright, real sign-in with TOTP, the console with `VITE_API_MOCKS=false`, Prometheus and
Mailpit running, dev database migrated and seeded): every console page and tab, 76 steps, **290 real API calls, none mocked, no
failure, no page or console error** (`.lead/walk/walk-final.cjs`, screenshots `.lead/walk/out-final3`). The console needed two
changes found by the walks (frontend M259 customers header, M260 idle supplier badge); its checks are green (405 test files,
4261 tests). Dev services are back to Postgres, the two Redis servers and MinIO; the API, worker, Vite, Prometheus and Mailpit
start only for a walk (`docker compose up -d prometheus mailpit`, `PROMETHEUS_URL=http://localhost:9090`).

**Known gaps, decided and recorded (not built):** gateway health checks (no definition of a gateway's health, B168); the invoice
PDF still renders inside the request; a mismatched payment adjusted by hand never passes through `gateway_clearing`; webhook
deliveries lost with the queue Redis are not re-queued and failing endpoints are not auto-disabled (7b); the paid supplier IMEI
check (no supplier call in the manifest) and mails when a data request completes (B178); blocklist entries from chargebacks
(M115); an approved held order of a stocked service goes to a supplier or the manual queue, not to stock (B178); money's
`foreign-directory.repository.ts` and a few list joins read other modules' tables (documented decision 016 deviations); stock codes
carry no purchase cost. The `origin` remote still points at `nestjs/typescript-starter` (nothing was pushed).

**State on 2026-11-07, late night.** Phase 3 waves 1 to 3 are merged on `main`, plus: **3** money (`c332201`), **2b**
merchant portal (`446fd46`), **2a** staff access (`ed74e0b`), **4a** catalog structure (`7c012d2`), **4b** catalog pricing
(`3838d27`), the 4 tax rate routes of 14b built early by the lead (`23dc5d5`), **7b** merchant API keys and webhooks
(`e9322de`), **5** orders engine (`e6de28a`), the lead's B2B stock delivery (`5b291ad`), **6** suppliers (`bbf84f4`), **7a**
Dhru and REST v1 (`13cdb12`), **8** billing (`8f8f4b0`), **9** dashboard and System health (`6826959`) and **14a** storefront
catalog, IMEI check, guest checkout and tracking (`ae1dc07`, spec decisions B169). **236 of 382** map endpoints are built;
the console calls 269, of which **154** are built (14a's routes are storefront routes the console never calls). `bun run
check` is green on the merged 14a tree (3646 pass, 1 skip, 0 fail). Scenario e2e tests: 6 of 13.

**Phase 4 (frontend integration) is running alongside.** The console has a partial mock mode (`VITE_API_MOCKS=unbuilt`,
frontend decision 018): built routes go to this API through the Vite dev proxy, the rest stays mocked; `npm run mocks:live`
in the frontend regenerates the list after each merge (106 routes, committed). Runtime walks with Playwright and a real
sign-in (password + TOTP) after each merge: access, merchants, wallets, ledger, trial balance, currencies, tax rates, audit,
settings, services, categories, inventory, client groups, the price resolver, rules and a merchant's pricing tab, all
answered by the real API with no error; real writes through the UI (reconciliation, merchant approval, wallet adjustment,
service disable/enable); a Support member sees the forbidden pages hidden and the API refuses them (403). With no mocks at
all the unbuilt pages show their error state with the server's 404 detail. 7b walk: a merchant's API access tab (keys
listed, the Staging key revoked: 204) and Settings > Webhook deliveries (list, a failed delivery in the drawer, Retry: 200,
a second retry within the minute: the server's 429 shown in the drawer). 5 walk: the seven Orders tabs with their counts
(70 real answers), Complete, Reopen and Reject on one order and Accept on a manual one (all 204), the drawer's timeline and
money, and the ledger's settle, reversal and release journals. Fixes found at runtime: audit phrases (money, catalog), the
role member count (2a), a default merchant group on a fresh database (4a migration 0005), the seeded webhook payloads (7b),
and in the console the mid-session sign-out keeps the page (`?to=`).

**Running now (six agents at once, the user's request of 2026-11-07 night):** one workflow per feature, each in
`../backend-<feature>` on `feat/backend-<feature>` with its own test database `gsm_<feature>_test` and Redis DB.
`gsm-backend-continue` (finishing interrupted work, args in `.lead/continue-args.json`): **12a** notifications
(`wf_4cd665ad-733`, Redis 9), **14b** customer accounts (`wf_4b060a2c-6a7`, 4), **15** storefront content (`wf_c039bfd4-270`,
5), **11** commissions and reports (`wf_a50bf7cb-24e`, 7). `gsm-backend-feature` (new worktree from `main`, args in
`.lead/feature-args.json`): **12b** alerts and integrity (`wf_31478c9a-770`, from `664f11c`, Redis 6), **16** B2C payments,
refunds and disputes (`wf_73269427-02a`, from `ae1dc07`, Redis 10). Each run: Sonnet implementer, Opus read-only review,
Sonnet fix of blocking findings, Opus re-review. Scripts: `workflows/scripts/gsm-backend-{feature,continue}-*.js` in the
lead's session directory; a resumed run needs the same args. Lead tools in `.lead/` (ignored through `.git/info/exclude`):
`merge-prep.sh start|finish <feature>`, `recreate-db.ts`, walk scripts, check logs. Only Postgres, the two Redis servers and
MinIO run; the API, worker and Vite start only for a walk and stop after it.

**Merge notes (the lead does these at each merge):**
- **14b:** set `turnstile: true` on its three store auth routes (decision 034); link a signed-in customer in checkout (14a
  opens guest sessions only); then let a signed-in account holder record `marketing` (14a's `ConsentService` skips it for any
  `has_account` customer because a guest checkout must never change it); its link-token tests need 14a's
  `createTestApp({ withoutModules })`; merge 14b's `findCustomerById` with 14a's `findCustomer` (customers infra).
- **12a:** add the `notifications` routes of 8's `invoice.paid` and the deposit approval; then 12b's alert notifications and
  16's refund decline email (both record where they must notify).
- **11:** add `GET /admin/reports/client-statement/:clientId` (it waited for `PdfRenderer`, merged with 8).
- **16:** 11 and 16 both touch `order-placement.ts` / `order-transitions.ts`; B169's open point (round the retail net up to
  whole cents).
- **Open from earlier merges:** gateway:<id> health checks (9), idempotency_keys expiry (7a), orphan files on refused file
  orders, the FILEDATA 1 MiB form limit, invoice PDF inline rendering, mismatched payments not reconciling through
  gateway_clearing, idle suppliers shown as degraded.

**Standing authorization (the user, 2026-11-08 12:40, before leaving the house):** continue without asking until the project
is complete (every remaining feature built, reviewed, merged and walked; the console integrated), at most **5 agents at once**;
if the usage limit is reached, wait for the reset and continue from this file. The machine restarted at 12:36: Docker was
started again, and the interrupted runs were relaunched: 16 (`wf_bc19eab4-9c0`, resumed at its fix step), 12b merge fixes
(`wf_73c324f5-a7e`, resumed), 17 (`wf_9bbe47ba-2ea`) and 19 (`wf_1c12d204-b6b`) through `gsm-backend-continue`; 14b's full
check rerun. **Order from here:** merge 14b (B172 written) then 11 (re-merge main for 14b's migration 0012, renumber 11's to
0013, B-entry), then 12b, 16, 17, 19 as their runs end (each: re-merge main, renumber migrations, B-entry, full check, squash);
launch 18 when 16 and 14b are on main; walk the console pages of the merged features; frontend `npm run mocks:live` after each
merge; final PROGRESS in both repos.
**Memory limit (found 2026-11-08 12:55):** the two restarts at 12:34 and 12:50 were the Linux out-of-memory killer (WSL has 15 GB;
one full `bun test` process peaked at 5 GB; 4 to 6 full suites at once took 14.7 GB plus swap and the init scope was killed).
Since then: `bunfig.toml` sets `[test] smol = true` (main `69d4220` and every worktree), at most **3 agent runs** at once
plus the lead's one full check, and a low-memory monitor (below 2 GB available) is armed while agents run. Relaunched at
12:58: 16 (`wf_bc19eab4-9c0`), 12b merge fixes (`wf_73c324f5-a7e`), 17 (`wf_9bbe47ba-2ea`), all resumed; 19
(`wf_1c12d204-b6b`, continue) waits for a slot.

**Third restart (13:16) and the fix (13:25):** a single full `bun test` process grew past 11 GB even with `smol`, so the suite
now runs in batches (`scripts/test-batches.sh`: 25 files per fresh process, totals summed) and at most two heavy runs (a
full suite or the typed lint) run at once on the machine (`scripts/with-slot.sh`, lock files in /tmp; main `cf47afb`, every
worktree has it). The lead's watchdog `.lead/mem-watch.sh` (run as a Monitor) warns below 1.5 GB available and, below 700 MB
with under 1 GB swap left, stops the single largest test, lint or typecheck process. The user's instruction (13:20): full
permission to finish the project, **at most 4 agents**, avoid crashes. Running: 16, 12b merge fixes, 17, 19 (all resumed).

**20:20 state:** **6b merged** (`d2ed171`, B179; its check: 5344 pass, 1 skip, 0 fail): **every one of the 382 manifest keys has a
contract** (`test/contract/pending.ts` is empty; console routes 269 of 269 built). P4a follow-ups still building
(`wf_99d70d35-0b2`); then its full check and merge, and the final walk with no mocks at all.

**19:55 state:** **18 merged** (`35dfcde`, B178; its check: 5302 pass, 1 skip, 0 fail; console live routes 268, frontend
`3e7586b`: every route the console calls is built, the 269th being the Bull Board page `GET /admin/queues` it only links
to). 18's merge-fix run passed after one refix; the lead added at the merge: a storefront settings PATCH that changes nothing
writes one audit row (16's route answered 500 under the audit enforcement), a stricter Risk seed test. **6b** passed its
review on the first round; the lead applied its minors (the service list archive keeps the supplier's own entry, docs, three
tests), merged main (`3f61017`: **382 of 382 endpoints built**, `pending.ts` empty), wrote B179 (`c50b530`); full check
running (`.lead/check-6b.log`). **P4a** follow-ups (`wf_99d70d35-0b2`, worktree `../backend-p4a` from `35dfcde`, Redis 12,
brief `.lead/P4a-polish.md`): idempotency keys expire after 7 days (B166), no file left by a refused file order, the Dhru
form limit for `FILEDATA`, an idle supplier never shown degraded (B168), the portal origin in the dev CORS default. First walk
of the whole console on main before 18 (16, 17, 19 in): 76 steps, 279 real calls, only 18's routes mocked, failures only
System health's metrics and errors (503: Prometheus is not running; start `docker compose up -d prometheus mailpit` and
`PROMETHEUS_URL` for the final walk).

**18:55 state:** **16 merged** (`8085f59`, B177; its check: 5081 pass, 1 skip, 3 fail: the b2c seed test counted 19's checkouts
and guests, and the notification-template test's "placeholder the event does not offer" used `support.reply`, which 17 gave
`{{link}}`; all three fixed, the two batches reran 207 and 224 pass, 0 fail; console live routes 251, frontend `6dc2673`).
**18** passed its review after the lead fixed the re-review's lint finding (the top-up screen spec), took main twice (17 and
19, then 16: `bad748d`, 378 of 382 endpoints) and its merge-fix run `wf_69e48409-ea6` (items in `.lead/18-merge-items.md`,
args `.lead/18-merge-args.json`) wires the capture screening, the risk refund through 16's refund, anonymize into 17's ticket
tokens, the blocklist at checkout, one `require3ds`, the Risk page seed and the review minors. **6b** (new, `wf_4b8e42cb-926`,
worktree `../backend-6b` from `8085f59`, Redis 14, brief `docs/briefs/6b-supplier-calls.md` in the worktree): contracts for the
four outgoing supplier calls (`defineSupplierCall`), the last four manifest keys (382 of 382). The workflow prompts now say to
run checks in the foreground (18's fix agent replied while its check still ran).

**18:15 state:** **19 merged** (`9df68a8`, B176; its check: 4877 pass, 1 skip, 2 fail in 14b's `customers-seed.test.ts`, which
expected exactly the demo's 30 customers while 19's seed adds a guest per left checkout from id 900 000: the test now counts
the demo's ids, and the failing batch reran 196 pass, 0 fail; console live routes 239, frontend `b45581d`). **16** took main
twice (17, then 19: `d6a36d8`; migrations renumbered `0017_b2c_payments` and `0018_refund_declined_template`, test database
recreated), B177 written (`e6dccc7`), full check running (`.lead/check-16.log`). Order changed: 16 lands before 18, and
18's merge-fix run wires `RiskScreening.assess` into 16's capture (hold places the order `held`, block refunds), its risk
refund into 16's `b2c_refund`, anonymize into 17's ticket tokens (`CustomerErasureHooks`), billing's auto-credit into
`reviewTopUp`, and decides the `Blocklist.match` calls in checkout and registration. 18 (`wf_13a23d14-575`): built (19
routes, no migration; its implementer's check 4580 pass, 1 skip, 1 fail, an `api-keys` ordering tie that passes alone), Opus
review running. The final walk script `.lead/walk/walk-final.cjs` visits every console page and clicks every tab.

**18:00 state:** 16's merge-fix passed after its refix (refund double-pay guard with the send attempt, default templates of the four
customer mails); 16 merged main (`f079f1f`: migrations now `0016_b2c_payments` and `0017_refund_declined_template`, to renumber
once more after 17's `0016_support_tickets`); it waits for 18 (the risk screening is wired into its capture at the merge), then
its B-entry and full check. 17's second merge-fix run `wf_8f8afa92-f08` adds `support_tickets.survey_sent_at` (one survey per
ticket without matching message text). 19's merge fixes passed (claim released on a skipped mail, English fallback for every
message, generator skips); its follow-up `wf_1190055c-492` fixes the template contract text, one transaction for abandon and
release, unusable carriers and the 20 000 sentinel. 18 still building (`wf_13a23d14-575`).

**17:10 state:** **12b merged** (`320404c`, B174; console live routes 225, frontend `7e37ac8`). 19 passed review, merged main
(`b581211`) and its merge-fix run `wf_de932880-b27` handles the recovery mark on a skipped mail, the English template fallback,
the page generator's skips and the funnel edge. 17 merged main (`5e8e38d`, migration now `0016_support_tickets`) and its
merge-fix run `wf_15137898-566` moves the guest insert behind a customers service, fixes the audit phrase, limits tickets per
email, sends one survey per ticket and searches the requester's email. Still running: 16 fixes (`wf_27c5b76d-222`) and 18
(`wf_13a23d14-575`).

**16:35 state:** 12b merged main (`8839974`: migrations `0014_alerts` and `0015_alert_templates`, B174) and its full check runs;
17 passed after fix (`wf_9bbe47ba-2ea`: the ticket token is returned only on the order-token path) and waits for 12b to land
(its `0012_support_tickets` must follow 12b's 0015; move its guest-customer insert behind a customers service; the audit
'unassigned ticket' vs the demo's 'assigned ticket' to none; seed nt4 template; B-entry); **18** started early on main
(`wf_13a23d14-575`, Redis 11): it exposes the risk screening and the lead wires it into 16's capture at the merge, plus
anonymize clearing 17's ticket token. Still running: 16 fixes (`wf_27c5b76d-222`), 19 finish (`wf_1c12d204-b6b`).

**Walk of the day-2 merges (2026-11-08 16:00, Playwright, real sign-in with TOTP, `.lead/walk/walk-day2.cjs`):** Settings
(notification templates, notification log, tax and currencies), Storefront (services on sale, landing pages, content and
legal, help centre, TAC catalogue), Customers (list, suspended, a customer's detail), Commissions (accruals, agents, plans),
Finance reports: 133 real API calls, no failure, no page or console error; only `GET /admin/data-requests` (feature 18)
mocked. The commission strip's amounts show a dash by design (frontend MISMATCHES M154: no summary route in the map).

**11 merged** (`93bab9b`, B173; check 4399 pass, 0 fail with the batched runner; console live routes 211, frontend
`07c5074`). 16 merged main (`7cf5e8c`: migrations joined as `0013_b2c_payments`, to renumber after 11's `0013`; retailNet
keeps 15's floor and rounds up to cents) and its merge-fix run `wf_27c5b76d-222` wires the customer emails through 12a, the
receipt job, refund retry keys, autoRefundFailed, the approve/reject lock order and the seed. Running too: 17 review
(`wf_9bbe47ba-2ea`), 19 finish (`wf_1c12d204-b6b`), 12b fixes (`wf_5440cc29-e86`). A usage-limit pause stopped work
from about 14:05 to 15:50.

**14b merged** (`f3a8341`, B172; 4181 pass, the real-worker test refused a connection once under load and passes alone; console
live routes 193, frontend `6af4286`). Test batches are now 12 files (a 25-file integration batch reached 3 GB) with a 4 GB
runaway limit (main `e96f051`). 11 took main again (migration renumbered `0013`, B173 written) and its full check runs.

**Root cause of the three crashes (found 13:30):** not the suite size alone: 12b's interrupted fix changed the alert notifier
to take the transaction as its first argument, and `alert-evaluator.test.ts` still asserted on that argument as the notice;
the failing assertion made Bun print the whole transaction object graph, synchronously, to 13 GB. Guards now in main
(`a2edc3a`) and every worktree: the test preload starts a watcher process that kills its test process past 3 GB
(`GSM_TEST_MAX_RSS_MB`) with a clear message, and refuses a direct one-process run of more than 40 test files; all test
scripts run batched behind the two machine-wide slots. 12b's fix run was relaunched fresh with this cause as item 0
(`wf_5440cc29-e86`). `.lead/run-capped.sh <MB> <cmd>` runs any command under a memory cap.

**Day 2 (2026-11-08, from 10:55; the user asked for six agents at once).** Docker started clean (no recovery). Running:
**12b** (`wf_be974e75-abf`) and **16** (`wf_bc19eab4-9c0`) through `gsm-backend-continue` (finishing their partial work,
then review and fix); the merges of **12a**, **14b**, **15** and **11** are prepared by the lead (main merged into each
branch, conflicts resolved, migrations renumbered: 12a and 11 both regenerated as `0011` against main's 0010, so the second
to land is renumbered again; 11 started from feature 6's branch commit, so its conflicts were re-merged with that commit as
the base and checked against a proper three-way merge) and each has a `gsm-merge-fixes` run (Sonnet applies the lead's
merge-time list, Opus reviews the delta, one refix; script copy `.lead/workflows/gsm-merge-fixes.js`): 12a `wf_b3a9c5ca-6d5`
(log masking and search, stuck mail rows, digest delay, audit phrases), 14b `wf_eac9ec43-f94` (Turnstile flags, signed-in
checkout and marketing through `authenticateOptional` + CSRF, the hourly `fx_refresh` job, minors), 15 `wf_889ecd96-608`
(the storefront files 14a and 15 both built, one legal-document read, the x1.10 retail floor everywhere, canonicalUrl,
publish time, minors), 11 `wf_518b4ee4-1d8` (the client statement PDF, the accrual-before-wallet lock order, zero accruals,
one consistent report read, audit phrases). Lead integration already committed: 12a routes `invoice.paid` to
`notifications` too (no producer for `deposit.approved`: a credited top-up already writes `invoice.paid`), provides the
`mail` health probe (`MailHealthProbeModule`, global symbol `gsm.MAIL_PROBE`) and redacts `x-telegram-bot-api-secret-token`.
**12a merged** (`4af39e9`, B170; check 3823 pass, the migrations test timed out once under load and passes alone; console live routes 162, frontend `78c3f18`). 14b took main again (`750d79b`) and its second merge-fix run `wf_63e76295-1c5` routes the four customer account mails through 12a's delivery (token rotated in the job, default templates in a new migration) plus the first run's review notes. **17** support started early (`wf_a44f3524-a84`, worktree from `4af39e9`, Redis 8): it needs 12a (merged) and reads `customers` through a foreign read until 14b lands. After each run: full check, squash-merge, B-entry, and the dependent launches (17 after 12a and 14b, 19 after 12a and 15,
18 after 16 and 14b).

**Merge notes from the reviews of 2026-11-07 (B-entry material; the items already sent to the merge-fix runs are done there):**
- **14b** customers and accounts (`wf_4b060a2c-6a7`): **pass after fix, ready to merge** (23 routes, about 153 tests; the
  review's blocking finding fixed: create and a country change need a current tax rate for the country, else 422 on
  `country` 'Choose a country.', and the currency is the country's active storefront currency, else USD; its check: 3053
  pass, 0 fail). At the merge: set `turnstile: true` on its three store auth routes; the checkout items of 14a above (link a
  signed-in customer, let a signed-in account holder record marketing, `withoutModules` for the link-token tests, one
  `findCustomer`); make 14a's `GET /store/v1/config` use the same tax window `[valid_from, valid_to)` as 14b's
  `hasCurrentTaxRate`; compare the country against the locked row in PATCH (customer-admin.service.ts:225); the review
  minors (b2c-account e2e step 3: assert the `customer.invited` outbox event; store-account.test.ts:113 assert the IP equals
  the request address; READMEs: the `customers:sign-in-failures` cache key and identity's new exports; the unused
  `CustomerSignInLimiter.enforceLink`; the B148 allowlist wording); decide who builds the hourly `fx_refresh` job (not built).
  B-entry: sign-in lockout in cache Redis keyed by the email hash (10 failures lock 15 minutes, an unknown email locks the same
  way) instead of the DB columns; magic-link self-signup turns an unknown email into a nameless guest (limited per email+IP,
  plus Turnstile at the merge); TAC audit `added TAC entry` / `edited TAC entry` on a new entity type `tac_entry`; B148
  allowlist entries for `currency: null` on four customer routes; PATCH checks the country only when it changes; the FX
  audit phrase `refreshed exchange rate`; `GET /store/v1/me/orders` reads orders through a documented foreign read.
- **12a** notifications (`wf_4cd665ad-733`): **pass after fix, ready to merge** (12 routes; the review's two blocking findings
  fixed and re-reviewed: a queued or digest row re-checks suspension and the merchant's current choice when it is sent, and
  the log detail masks `payload.chatId`; its check: 3050 pass, 0 fail). At the merge: renumber
  `0009_notifications_delivery` after main's migrations; route `invoice.paid` (main's `InvoiceOutbox` sends `{invoiceId,
  clientId}`, which its planner expects) to `notifications` as well as `merchant-webhooks`; `deposit.approved` has no producer
  on main yet (decide: emit it from 8's deposit approval); point feature 9's `mail` health check at `MailTransport.verify()`;
  add `x-telegram-bot-api-secret-token` to the redacted log headers; mask a `chatId` nested in `variables` too; the review
  minors (the log's `q` search matches the unmasked address: use an exact match or drop `recipient` from it; a merchant-mail
  row stays `queued` when a retry ends skipped: mark it failed; give the digest send job a minimum delay of about 10 s;
  the audit phrases 'turned on/off notification template' vs the demo's 'turned on/off notification'; a stale comment at
  client-admin.service.ts:234). B-entry: `notification.send` is an outbox event; the `url-secret` access kind gained
  `header` and `refusal: 'not_found'`; the digest day runs 06:00 to 06:00 UTC; a suspended merchant (and a suspended staff
  member, for 12b's alerts) gets only transactional messages; customer events are registered for the Customer emails tab;
  Telegram's `retry_after` is not read (the queue's backoff applies); the send-time re-check (B165) and the `chatId` mask.
- **15** storefront content (`wf_c039bfd4-270`): **pass, ready to merge** (20 routes, 144 tests). At the merge: re-run the
  full check on a quiet machine (its last run had 3 `db-schema` timeouts under load; the file passes alone) and drop the
  leftover `gsm_mig_*` scratch databases; **make 14a's checkout and listings take the floor from 15's new
  `RetailPrices.quotes`** (catalog; `PriceResolver.floor` alone misses the x1.10 term of b2c-7) and resolve the catalog
  overlap with 14a (module providers, index); fix the review minors (listing-admin.service.ts:239 audit `before` from the
  locked row; :265 skip a row without a quote instead of a 500; reuse catalog's `dollars()` in listing-rules.ts; the
  foreign-reads header; two test names); decide `canonicalUrl` on admin page rows (ANSWERS storefront Q8 asks for it, the
  implementer dropped it for shape parity: allowlist it with Q8 as the reason or amend Q8). B-entry: legal slugs `terms`,
  `privacy`, `refund`, `cookies` reserved and served at `/store/v1/pages/:slug` in their version in force; help slug
  `<id>-<words>` (only the id counts); `SERVICE_DISABLED` checked before `LISTING_LOCKED`; `NOT_A_DRAFT` for a replaced
  version; `publishedAt` kept when a live page is published again (the doc says now: decide); `RetailPrices` provider in
  catalog; storefront's foreign-reads file (decision 016 deviation).
- **11** commissions and reports (`wf_a50bf7cb-24e`): **pass, ready to merge** (19 of 20 routes, about 161 tests). At the
  merge: renumber its migration `0009_commission_accrual_reversed_at` after main's 0010; re-run the full check (4 timeouts
  under load, each passes alone); add `GET /admin/reports/client-statement/:clientId` with `PdfRenderer`; merge 11 before 16
  (both edit `order-placement.ts` / `order-transitions.ts`); consider the review minors (a rare deadlock between a refund or
  reopen and an approval: lock the order's live accruals before `ledger.move` in `OrderTransitions.apply` or retry on
  40P01; `CHECK (amount > 0)` on `commission_accruals`; the reports' "one consistent read" claim). B-entry: audit verbs
  (`approved commissions for` is the demo's, the brief's "of" is a typo; plan verbs partly invented); business time zone
  UTC; an accrual paid back after approval stays approved with `reversed_at`; approval key
  `commission:<agent>:<lowest accrual id>`; amounts rounding to zero accrue nothing; a switched-off plan stops accruals for
  agents still assigned (confirm); `clients.referral_code` is NOT NULL so B164's "generate on read" never happens; the portal
  does not send `reversedAt`; `report.repository.ts` reads other modules' tables (decision 016 deviation, decide).

**Next, in order:** merge each running feature as it finishes (commit its work, merge `main` in, resolve, regenerate, full
check, squash-merge, B-entry, walk what the console can show, `npm run mocks:live` in the frontend); start **17** support
(after 12a and 14b), **18** risk and privacy (after 16) and **19** content generation and reports (after 9, 12a, 14a and 15)
as their dependencies merge, keeping six agents busy. After every merge: `bun run db:migrate && bun run db:seed` on the
development database before a walk.

**Local run:** `docker compose up -d`; `bun run db:migrate && bun run db:seed`; `bun src/main.ts` and `bun src/worker.ts`; in
the frontend `VITE_API_MOCKS=unbuilt VITE_DEV_PROXY_TARGET=http://localhost:3000 VITE_API_BASE_URL= npx vite` (port 5173: the
sign-in origin must be in `CORS_ORIGINS`); sign in as README "Local sign-in" says.

How a feature runs: a brief in `docs/briefs/` written from `_feature.md` (routes from `docs/slices/<module>.json`, user
rules from the table below; `_common.md` first). Parallel implementers work in sibling worktrees of this repo (`git worktree
add ../backend-<name> -b feat/backend-<name>`, then `bun install` there; a sibling path keeps the relative `reference`
symlink working; the workflow tool's worktree isolation targets the frontend repo, not this one). Each worktree gets its own
test database through an untracked `.env.test` (`DATABASE_URL_TEST=.../gsm_<name>_test`, created with `CREATE DATABASE`,
plus its own Redis DB numbers), so parallel test runs never truncate each other's tables. The lead commits the
implementer's output on the feature branch, merges `main` into it, fixes, runs `bun run check`, and squash-merges into
`main`. Under load (several suites at once) the migrations test in `test/integration/db-schema.test.ts` can pass its 60 s
timeout; it passes alone in about 5 s.

Read before briefing any implementer: `docs/contract/ALIGNMENT.md`, the feature's `docs/contract/endpoints/<module>.md`
and `docs/slices/<module>.json`, `docs/contract/RULES.md` for its frontend features, decisions 008-028.

## Status (2026-10-31)

- Backend repo: `/home/saifi/gsm-project/backend`, branch `feat/backend` (from the NestJS 12 starter, `master`).
  Frontend: `/home/saifi/gsm-project/frontend-admin` (read-only; `FRONTEND_DIR` default `../frontend-admin`).
- Map verified: **274 rows, 382 endpoints, 9 surfaces, 66 tables, 13 scenarios, 13 money events, 14 ledger
  accounts**. `docs/route-manifest.json` holds all endpoints; the frontend's **269 `@route` tags** all exist in it.
- Module map reviewed in Phase 1 (no change): 12 modules, table ownership = map domains (system health takes 5
  tables from domain G). Endpoints: identity 59, money 57, catalog 43, orders 40, platform 33, health 33, customers 28,
  storefront 25, suppliers 18, risk 17, commissions 15, support 14.
- Contract (Phase 1): `docs/contract/ALIGNMENT.md` (conventions), `frontend-endpoints.json` (exact shapes of the 269
  console endpoints, extracted from the frontend's TypeScript), `extraction/*.json` (per-endpoint semantics, 6 Opus
  analysts, all validated), `endpoints/<module>.md`, `error-codes.md` (119 codes), `MISMATCHES.md` (B1-B116),
  `ANSWERS.md` (201), `RULES.md` (216), `OPEN-QUESTIONS.md` (8), `TESTS.md` (contract-test design).
- Local stack (`compose.yaml`): Postgres 18.6 (`gsm`, `gsm_test`), queue Redis 8.10 (noeviction + AOF), cache Redis
  8.10 (allkeys-lru), MinIO (Chainguard image). Prometheus is added in Phase 2 (decision 015).
- Bun spike: **27/27 pass** on Bun 1.4.4 (decision 001). `bun run check` green (typecheck, routes:check,
  contract:check, `bun test ./src ./test`: 290 tests after P2.1).

## Phases

| Phase | Status | Commit | Agents used |
|---|---|---|---|
| 0 Setup + Bun spike | done | `25282af` | 0 |
| 1 Architecture + contract | done | see `git log` (`docs: phase 1 ...`) | 6 (Opus analysts, one workflow, 3 at once) |
| 2 Foundation | done | per feature, see below | 28 |
| 3 Feature loop (by stage) | | | |
| 4 Frontend integration | done 2026-11-08 (the console runs on the real API with no mocks; final walk 290 real calls, no failure) | frontend `169ddb9` … `df99600` | 1 (frontend Sonnet implementer) |

## Business rules answered by the user (2026-10-31)

All questions of `docs/contract/OPEN-QUESTIONS.md` are answered (eight from Phase 1, a ninth raised by the user) (recorded in `docs/contract/lead-decisions.json`;
full rules in the cited ANSWERS/MISMATCHES entries). The feature that implements each rule must follow it:

| # | Rule | Feature |
|---|---|---|
| 1 | Group promotion: cumulative completed-order spend in USD since account creation; `earn_threshold` set per group by the admin; nightly job promotes, never demotes; manual group change any time (ANSWERS merchants Q7) | 4a (client groups + promotion job) |
| 2 | Credit limit: lowering below the credit in use allowed (new orders refused until a top-up); a limit > 0 on a group without `overdraft_allowed` is 422 (merchants Q13) | 3 |
| 3 | Manual invoice = top-up (paying credits the wallet, `invoice.paid`); no B2B VAT for now but the rate stays a setting (default 0); due in 14 days (B41, finance Q6) | 8 |
| 4 | Deposit approval: manual gateways (bank, Wise) debit `bank`; automatic gateways `gateway_clearing` until payout (B38, finance Q8) | 8 |
| 5 | Commission on refunds: reversed before approval, reversing entry after approval (commissions Q8) | 11 |
| 6 | Automatic gateways credit by themselves 10 min after confirmation (setting `payments.auto_credit_delay_minutes`) when the gateway API still says confirmed and risk has not flagged it (flagged → staff review); crypto only after the gateway's required confirmations; manual gateways keep staff review; `hold_hours` only lengthens the wait (settings Q9) | 8 (+ 18 risk flags) |
| 7 | Refund `processing` between approval and the gateway result; the console now knows it (B82 resolved, console M258) | 16 |
| 8 | Pricing: exactly the demo's resolver (services Q6) | 4b |
| 9 | Price protection (MISMATCHES B117): order-time floor on max(service cost, latest synced supplier cost); dashboard alert; real prices in every price list (catalog version bumped by the sync); an order more than `pricing.price_change_tolerance_percent` (default 10, no console field yet) above the merchant's last listed price is refused with `409 PRICE_CHANGED` (Dhru: "Price changed. Please refresh the service list and order again."), within it the raise is recorded in `pricing_snapshot`; merchants who ordered a service in the last 30 days get a digest (email, Telegram, webhook `service.price_changed`) when its price changes; lead default: no dispatch failover to a link costlier than the charged price | 4b, 6 (+ 7a, 7b, 9, 12a) |

## Feature plan (Phase 2 and 3)

Each feature: ≤ 6 agent calls (≤ 2 implementer, ≤ 3 reader, 1 Opus review + 1 re-review), one commit. Scenario e2e
tests are added by the feature that completes the scenario. Endpoint counts from `docs/slices/index.json`.

| # | Feature | Scope | Scenarios completed | Status |
|---|---|---|---|---|
| P2.1 | runtime-core | config, logging, request id, problem+json + catalog, contract layer (defineRoute, @Route, lists), money helper, /health, /metrics, api + worker bootstrap, bunfig + tests (brief `docs/briefs/P2.1-runtime-core.md`) | | done (`feat(runtime-core)` commit) |
| P2.2 | docs-tooling | OpenAPI 3.1 generation (internal + public), Scalar `/docs` and `/reference`, `/openapi.json`, ESLint (jsdoc, boundaries, env rule) + prettier, module READMEs, CONTRIBUTING, CI script | | done (`feat(docs-tooling)` commit) |
| P2.3 | data | Drizzle schema for all 66 tables (per module) + schema additions (MISMATCHES), constraints, indexes, ledger triggers, first migration, migrator, resetDb, Postgres health indicator, seed from the frontend demo state | | done (`feat(data)` commit) |
| P2.4a | infra-core | two Redis clients + health indicators, CacheService + CacheKeys, RateLimitService + semaphore, crypto (AES-GCM keyring, token hashing, argon2, webhook signatures), S3 storage, outbound http + SSRF guard (brief P2.4 items 1-5) | | done (`feat(infra-core)` commit) |
| P2.4b | queues-outbox | BullMQ base (queues, worker registry, schedulers), job runs (health module), outbox + relay (platform module), Prometheus in compose; retire `spike/` (brief P2.4 items 6-10) | | done (`feat(queues-outbox)` commit) |
| P2.5a | sessions-guards | contract fields, session service + cookies + CSRF token, guard dispatcher, staff/merchant/customer session guards, CSRF guard, permission guard + catalog + Owner helpers, audit service + enforcement, `/reference` staff gate (brief P2.5 split) | admin-team (part) | done (`feat(sessions-guards)` commit) |
| P2.5b | pipeline-hooks | IP rules hook + hit-counter flush, maintenance hook, per-IP rate-limit hook, ordered hook registry (brief P2.5 split; parallel with P2.5a) | ip-rules (part) | done (`pipeline-hooks` commits) |
| P2.5c | machine-auth | capability-token guard registry, API key guard, Dhru credentials guard, webhook signature registry (brief P2.5 split; after P2.5a, parallel with P2.6) | | done (`feat(machine-auth)` commit) |
| P2.6 | staff-sign-in | `POST /admin/auth/login`, `/2fa`, `/2fa/setup`, `/logout`, `/password/set`, `GET /admin/auth/me` (6) | | done (`feat(staff-sign-in)` commit) |
| P2.7 | contract-tests | route/shape/error parity tests, fixture harvest from the frontend mocks, allowlist, `pending.ts` | | done (`test(contract)` commit) |
| 2a | identity-staff-access | staff, roles, permissions, sessions, IP rules, access restriction, merchants, audit logs, settings (st2 admin, 31; brief `docs/briefs/2a-identity-staff-access.md`) | admin-team, ip-rules | done (`ed74e0b`) |
| 2b | identity-merchant-auth | merchant portal sign-in, security, sessions (st2 client, 15; brief `docs/briefs/2b-identity-merchant-auth.md`) | | done (`446fd46`) |
| 3 | money-wallets-ledger | postTransaction, money events, wallets, statement, adjust, credit limit (user rule 2), ledger, reconcile, currencies (st3, 14) (brief `docs/briefs/3-money-wallets-ledger.md`) | | done (`c332201`) |
| 4a | catalog-structure | client groups + nightly promotion job (user rule 1), categories, services, fields, options, inventory (st4/5) (brief `docs/briefs/4a-catalog-structure.md`) | | done (`7c012d2`) |
| 4b | catalog-pricing | group/client prices, pricing rules (user rule 8: the demo's resolver), price protection (user rule 9: effective-cost floor, listed-price memory, PRICE_CHANGED guard, raise in the snapshot), bulk price, resolve, merchant catalog and price export (brief `docs/briefs/4b-catalog-pricing.md`) | | done (`3838d27`) |
| 5 | orders-engine | state machine, placement + hold, admin order actions, bulk reply, export, merchant orders, files (st5) | manual | done (`e6de28a`) |
| 6 | suppliers | suppliers admin, Dhru supplier client, dispatch/poll jobs, dispatch/fetch/change-supplier, sync (user rule 9: recompute the effective cost, bump the price version, no failover above the charged price), import (st6) | success, reject, timeout | done (`bbf84f4`) |
| 7a | dhru-and-rest-v1 | Dhru surface (8 actions), REST v1 (12), idempotency, PRICE_CHANGED message and listed-price memory on the list actions (user rule 9) (st7) | | done (`13cdb12`, B166 `c73a0b8`) |
| 7b | merchant-api-webhooks | API keys, webhook endpoints, deliveries, outgoing events incl. `service.price_changed` (user rule 9, route-parity allowance B117), public docs (st7) | | done (`e9322de`) |
| 8 | billing | gateways, invoices (user rule 3), payments, approve/reject (user rule 4), automatic credit after the verification delay (user rule 6), KYC, payment webhook (B2B), invoice.paid (st8) | | done (`8f8f4b0`, B167 `56f48f7`) |
| 9 | health-dashboard | system health routes, dashboard (services_below_floor on the effective cost, user rule 9), queues board (st9) | | done (`6826959`, B168 `815313d`) |
| 11 | commissions-reports | plans, assignments, accruals (user rule 5 on refunds), approve, reports (st11) | | done (`93bab9b`) |
| 12a | notifications | templates, notifications, preferences, Telegram link + webhook, price-change digest (user rule 9) (st12) | | done (`4af39e9`) |
| 12b | alerts-integrity | alert rules, alerts, incidents, integrity job (st12) | system-alert, system-integrity | done (`320404c`) |
| 14a | storefront-checkout | store config, listings, IMEI check (checksum + TAC), checkout sessions, consents (st14) | | done (`ae1dc07`) |
| 14b | customers-accounts | store sign-in, account, admin customers, tax rates (done early: `23dc5d5`), TAC catalog, FX refresh (st14) | b2c-account | done (`f3a8341`) |
| 15 | storefront-content | listings admin, content pages, help, legal documents (st15) | | done (`a9301be`) |
| 16 | b2c-payments-refunds | pay, receipt, B2C payment webhook, refunds (user rule 7: `processing`), disputes, VAT/payments reports, storefront settings (st16) | b2c-paid, b2c-refund, b2c-chargeback | done (`8085f59`) |
| 17 | support | tickets (store + admin), replies, notes, templates, CSAT (st17) | b2c-ticket | done (`3e5e775`) |
| 18 | risk-privacy | IMEI checks via supplier, blocklist, risk queue and rules, data requests, export/anonymize (st18) | | done (`35dfcde`) |
| 19 | growth | abandoned checkouts, recovery, funnel, content generation (st19) | | done (`9df68a8`) |

## Agent budget

Limits (CLAUDE.md): 3 agents at once, depth 1, per feature ≤ 6 calls (≤ 2 implementer, ≤ 3 reader, 1 review + 1
re-review), max 2 review rounds.

| Step | Calls |
|---|---|
| Phase 0 | 0 (lead only) |
| Phase 1 | 6 (contract extraction: Opus analysts, max 3 at once) |
| P2.1 runtime-core | 2 (Sonnet implementer, Opus review: pass, no blocking) |
| P2.2 docs-tooling | 4 (implementer, review: 1 blocking, fix, re-review: pass) |
| P2.3 data | 2 (implementer, review: pass, no blocking) |
| P2.4a infra-core | 2 (implementer, review: pass, no blocking) |
| P2.7 contract-tests | 4 (implementer, review: 1 blocking, fix, re-review: pass) |
| P2.4b queues-outbox | 2 (implementer, review: pass, no blocking) |
| P2.5a sessions-guards | 4 (implementer, review: 1 blocking, fix, re-review: pass) |
| P2.5b pipeline-hooks | 2 (implementer, review: pass, no blocking) |
| P2.5c machine-auth | 4 (implementer, review: 1 blocking, fix, re-review: pass) |
| P2.6 staff-sign-in | 2 (implementer, review: pass, no blocking) |
| P2.8 clock | 4 (implementer, review: 1 blocking, fix, re-review: pass) |
| Wave 1, first run (2026-11-01) | 3 (Sonnet implementers 2a, 2b, 3; cut off before finishing, no review) |
| Session 2026-11-07 | limit set by the user: 4 calls in all, 2 at once. All 4 used: 2a finish (Sonnet), frontend partial mocks (Sonnet), 4a (Sonnet), 4b (Sonnet). Reviews, fixes and merges of 3, 2b and 2a by the lead (Opus). |
| Session 2026-11-07, second budget | approved by the user: 4 more calls, 2 at once. 7b and 5 (Sonnet) done and merged; 6 (Sonnet) running; 7a next. |
| Session 2026-11-07, third budget | approved by the user: a much larger budget and as much parallelism as is technically safe for waves 4-7 (it supersedes the "max 3 at once" of CLAUDE.md for this phase; inform the user before other significant spending). Plan: one workflow per feature (Sonnet implementer, Opus read-only review, Sonnet fix of blocking findings, Opus re-review), about 5 implementers at once (machine: 16 cores, 15 GB; Postgres raised to 300 connections, `cf06f09`). Merged under it: 7a, 8, 9, 14a. After the reboot the user asked for 3 agents at once, then 6 (2026-11-07 night). Running: 12a, 14b, 15, 11, 12b, 16 (each run's agent calls are in its workflow journal). |
| **Total** | **47** |

## Decisions

001 runtime Bun · 002 package manager bun · 003 TypeScript 6.0 · 004 local S3 = Chainguard MinIO · 005 pg driver ·
006 two Redis roles · 007 argon2id via @node-rs/argon2 · 008 zod contract layer · 009 contract sync tests ·
010 ids and tokens · 011 money · 012 logging · 013 config · 014 testing · 015 observability (+ Prometheus) ·
016 repo layout · 017 API docs exposure · 018 auth, sessions, CSRF, pipeline · 019 encryption and token hashing ·
020 outbox and queues · 021 rate limiting · 022 caching · 023 outbound HTTP · 024 ledger · 025 order state machine ·
026 Dhru compatibility · 027 database conventions · 028 error format · 029 FX provider · 030 PDF rendering · 031 clock ·
032 module import cycles (identity exports its principal layer first; `test/unit/module-load.test.ts`). 033 mail delivery (SMTP through nodemailer 10.2.1, Telegram Bot API over OutboundHttp, Mailpit locally on 1025/8025). 034 Turnstile (`X-Turnstile-Token`, one guard, `turnstile: true` on the six store routes, a dummy verifier without a secret).

## Blockers

None.

## Notes for later phases

- Tests (2026-11-07): bunfig has no `timeout` key, so the old `timeout = 15000` was ignored and the suite ran on Bun's 5 s
  default; the 15 s now comes from `--timeout 15000` in the `test` scripts (a heavy file sets `setDefaultTimeout`, as the
  seed tests do). The seed opens accounts for the 20 demo merchants and leaves the credit limit at 0 where the group allows
  none (user rule 2 wins over the demo data: the mock's Standard group has credit limits but no overdraft). Merchant mail
  events have one owner, `MerchantMailOutbox` (2a's duplicate registration of `merchant.invited` would have stopped the API
  and the worker at boot). The dev default of `CORS_ORIGINS` has no merchant-portal origin (`PORTAL_BASE_URL` defaults to
  `http://localhost:5174`): add it when the portal frontend exists.
- 5 merge notes (2026-11-07): ledger keys `order:<id>:hold`, `order:<id>:settle` (`:settle:2` after a reopen),
  `order:<id>:release`, `order:<id>:refund` (B2C) and `reverse:<settlement id>` for a reopen or a B2B refund (the brief
  said `order:<id>:refund` for B2B; `MerchantSpend` reads `reverse:`). `accept` on a non-manual order answers
  `NOT_MANUAL`. Not built: merchant cancel and verify in practice (the service flags, 7a), `POST /client/files` (7a),
  stock delivery (the lead), the B2C refunds row and gateway job (16). File downloads log but write no audit row. The
  seed's order timelines name suppliers that 6 seeds (supplier fields stay null until then). 7b's webhook event data and
  price change scan still read `orders` through their documented foreign read: switch them to `OrderReadService` when
  someone touches them. Migration 0008 was regenerated with drizzle-kit after 7b's 0007 (a worktree DB that applied the
  old 0007 must be recreated: the migrator compares timestamps only).
- 9 merge notes (2026-11-07): the Opus review found four blocking issues (manual runs of the schedulers that write no
  `job_runs` left a phantom running row; attention severities and filters against RULES dashboard 3; missing tests for the
  locked-rate money and most attention kinds; the supplier balance verdict without the runway), fixed and re-reviewed.
  Lead fixes at the merge: failed-job texts lose URL credentials and are capped at 500; a zero balance with no alert
  amount is not critical; the database-creating schema tests get 5 minutes; decisions 015, 020 and 032 amended. Open
  (B168): the `gateway:<id>` checks need a definition of a gateway's health and feature 8's call outcomes; an idle
  supplier reads unknown, so the dashboard shows it degraded. Walked with Prometheus off (the outage state works).
- 8 merge notes (2026-11-07): the Opus review found three blocking issues (a gateway confirming another amount or
  currency was credited the invoice's amount; the gateway on/off audit phrases; the deleted group left in the gateways),
  fixed and re-reviewed. Lead fixes at the merge: a gateway only the deleted group could use is turned off instead of
  opening to every group (B167), `webhookSecret` redacted in logs, approve documents its 409s; migration renumbered to 0010
  after 7a's 0009 (8's test database recreated). Open: the invoice PDF still renders inside the request (a job would be
  better); a mismatched payment rejected and adjusted by hand never passes through `gateway_clearing` (gateway payouts will
  not reconcile for it); the merchant notifications of approve, reject and KYC decisions come with 12a. Walked: a bank
  deposit approved from the console, an invoice, the payment methods, a KYC request approved. The dev servers are stopped
  after each walk (the user's machine is busy).
- 7a merge notes (2026-11-07): the Opus review passed; the lead fixed three security minors before the merge (a per-IP
  `upload` limiter for large bodies read before the credentials, decision 021 amended; a hidden service answered like an
  unknown one in the Dhru actions; upload names lose control, bidi and zero-width characters) and gave the tests that seed
  the whole demo a minute. Open (B166): `idempotency_keys` rows never expire and keep the answer (delivered codes too: an
  expiry job must also clear `orders.idempotency_key`); a refused file order leaves its stored file; Dhru `FILEDATA` in a
  form body is bound by the 1 MiB form limit; bulk items run in key order (integer-like ids first).
- 6 merge notes (2026-11-07): the three order moves live in the suppliers module (they read the supplier tables) and move
  orders through orders' `OrderSupplierMoves` (guarded updates) or `OrderTransitions.apply`; a supplier completion or
  rejection goes through `apply` and then sets `result_code` / `completed_at`, so the state machine's `columnsFor` still has no
  hook for supplier results (folding it in would remove that split). Money's `foreign-directory.repository.ts` still reads
  `suppliers` directly: switching it to `SupplierDirectory` would close an import cycle (money, suppliers, orders, money).
  A new supplier with balance 0 reads `lowBalance: true`. The seeded suppliers point at placeholder hosts, so a dispatch in
  development ends in Needs review ("Connection failed"); the dev database's 760 older orders keep no supplier (the orders
  seed only inserts).
- Stock delivery notes (2026-11-07): a stocked order keeps the service's effective cost as its `total_cost` (the drawer
  shows it as the supplier cost) while the settlement books no cost: codes carry no purchase cost (no column), so the
  stock's cost stays outside the ledger until someone decides to track it.
- 7b merge notes (2026-11-07): the portal webhook controller lives in identity (`merchant-webhook-routes.module.ts`)
  because platform imports no module; the engine stays in `platform/webhooks`. The merchant low-balance threshold is
  `clients.notification_prefs.lowBalanceThreshold` (a money string; none = no alert): 12a should expose it. B155 gained the
  `services:read` scope (`GET /v1/services` needs it); `*` is never offered to a merchant. Not built: re-queueing a pending
  delivery whose job was lost with the queue Redis, and auto-disabling an endpoint after many failures (9 or 12b). The
  admin delivery list rows carry `payload`, `responseBody` and `error` (the console fixtures need them); the portal says
  `succeeded` where the console says `delivered` (B156). A worktree has no `.env`, so `bun run db:migrate` / `db:seed`
  there use the dev database (`gsm`, the config default): 7b seeded it before its merge (harmless here: it matched);
  briefs say to touch only the feature's test database. (`db:migrate` prints "Migrations are up to date." after applying.) The schema tests that create a database get
  180 s (checkpoints under load: they timed out at 60 s at the end of full runs while another worktree tested).
- Wave 1 merge notes (2026-11-07): money's `infra/foreign-directory.repository.ts` reads `clients`, `client_groups`,
  `suppliers`, `customers` and `staff_users` with plain selects (documented deviation from decision 016): replace its bodies
  with the owners' public reads as they appear (identity after 2a, catalog 4a, suppliers 6, customers 14b). Merchant mail
  (2b) for 12a: the outbox row carries only `tokenId` and `auth_tokens` stores only the hash, so real delivery cannot rebuild
  the link: store the clear token AES-GCM-encrypted next to the row (short TTL, wiped when sent) or issue the token inside the
  mail job. Money routes live in `MoneyAdminModule` (database-less test apps leave it out); the global `MoneyModule` keeps
  `MerchantAccounts` and `LedgerPoster`.

- Phase 2 tests still to write for the Redis rules: Redis down at startup, Redis restart during processing (shutdown
  with an active job is proven by the spike).
- Retire `spike/` and the `postgres` and `argon2` dependencies once Phase 2 integration tests cover the spike checks.
- zod's JSON Schema output carries `$schema`; strip it when building OpenAPI components.
- The spike's validation answered 400; the real contract layer answers `422 VALIDATION_FAILED` (decision 028).
- Fixture harvest runs under Node with the frontend's own Vitest (ALIGNMENT § 8), not under Bun.
- CI needs the frontend checkout next to this repo (contract:check runs the frontend's TypeScript).
- The `origin` remote still points at `nestjs/typescript-starter` (never pushed; the user may change it).
- P2.1 review leftovers (accepted, non-blocking): Fastify router-level errors (malformed URL) skip the request hooks,
  so they carry no CORS headers, access-log line or duration sample; upstream failures must throw `AppError`
  (a Nest `HttpException` 502/504 becomes `500 INTERNAL_ERROR`); the worker's metrics listener sends no
  `X-Request-Id` on its problem answers; if the code ever runs on Node instead of Bun, re-enter the request context in
  a `preValidation` hook as `@fastify/request-context` does.
- OpenAPI: tags get a surface prefix only when two surfaces share them (lead decision: always prefixing would give
  names like `system: system`); the internal document should also list `webhooks` once events exist (feature 7b), so
  it stays a superset of the public one (decision 017).
- `scripts/ci.sh` runs `docker compose up -d`: never run it (or compose) from a worktree, it re-creates the shared
  containers with the worktree's bind paths.
- Data (P2.3) notes for Phase 3: `ip_rules.cidr` is the Postgres `cidr` type (normalise on write, drop `/32` on read:
  the wire omits it; host bits are rejected); `support_tickets.status` stores the map values (`pending_customer`,
  `closed`) that the support feature maps to the wire; columns left as plain `text` and every guessed type are listed
  in `src/infra/db/README.md` ("Open vocabularies and type guesses") for the owning feature to settle; audit entries
  without a numeric entity use `entity_id = 0` (frontend type requires a number).
- The seed (`bun run db:seed`, development only) maps demo ids like the frontend mocks (`'m3'` → 3); each Phase 3
  feature adds its module's seeder in `scripts/seed/`.
- Infra (P2.4a) notes: outbound calls go through `OutboundHttp` (the bare `httpRequest` is internal); https is
  required in production unless the call sets `allowPrivateNetwork` (internal services) or an explicit `httpsOnly`
  (a supplier on plain http needs an admin-visible opt-out in feature 6); the SSRF guard resolves DNS once, so a
  DNS-rebinding window remains (documented; https in production mostly closes it); stream uploads are buffered in
  memory up to 25 MiB; tune `ARGON2_*` on the production host (`scripts/bench-argon2.ts`, target 50-150 ms);
  `GET /health?strict=1` answers 503 only when Postgres is down (lead decision, decision 015 updated); the sign-in
  limiter key is an unsalted SHA-256 of email + IP (HMAC with `TOKEN_PEPPER` would be stronger: revisit in P2.6);
  the local queue Redis has no `maxmemory`, so the 90 % memory warning cannot fire locally.
- For P2.4b: BullMQ producers should use `skipWaitingForReady` (queue option) to fail fast while Redis is down,
  instead of the check-then-act `RedisService.assertQueueReady()`.
- Contract tests (P2.7): `test/contract/pending.ts` lists every unbuilt manifest key (378 after Phase 2's first four
  routes); a feature that builds routes removes them there. Known gaps for later features (`test/contract/README.md`
  "Known limits"): `GET /admin/permissions` needs a B-entry (`Permission[]` vs `string[]`, feature 2a);
  `GET /admin/files/:id` is a 302 that `defineRoute` cannot declare yet; route parity needs an allowance for the Dhru
  transport `POST /api/index.php` (feature 7a); `fixtures.test` does not notice a vanished mutation fixture.
- Queues (P2.4b) notes: BullMQ refuses `:` in custom job ids, so ids are `<kind>-<id>` (`outbox-<id>`,
  `manual-<run id>`; decision 020 updated); the outbox relay's one-second tick writes no `job_runs` (decision 020);
  an event type must be registered in a module the worker loads; for the health feature (9): schedule
  `JobRunsService.failStuck`, test Bull Board under Bun again, enqueue manual runs as `manual-<run id>`; when the worker
  runs in a container, give it `stop_grace_period: 30s` (its shutdown grace is 25 s); Prometheus (compose,
  `prom/prometheus:v3.15.1`) is running and scrapes `host.docker.internal:3000` and `:9464` (check the targets turn up
  once the API and the worker run).
- Sessions and guards (P2.5a) notes: customer sessions answer 401 until the customers module registers its
  `SessionSubjects` resolver (feature 14b); `PermissionsCatalog.list()` leaves out `x:*` wildcards, so role validation
  (feature 2a) accepts `x:*` by area prefix; ended sessions are never purged yet (add a purge job with feature 2a);
  revoke and suspension clear the session cache after commit, but another instance can re-cache a live view for up to
  about 60 s (cache-aside, decisions 018/022): sensitive actions in P2.6 and 2a re-check the database; P2.6's password
  set on a `pending_password` session must call `CsrfService.assert` itself (the CSRF guard ran before the optional
  session was read).
- Pipeline hooks (P2.5b) notes: the seed adds loopback allow rules (ids 8, 9) so a local console can sign in; signed
  `/webhooks/*` are never judged by IP rules (B118); sign-in steps (`/admin|client/auth/login|2fa|password`) count per IP
  whatever their access; MAINTENANCE logs at warn; still open: rate-limit keys hold the raw IP (hash them, P2.6), the IP
  rule snapshot stops caching above 100 KB (~1000 rules), an unparseable client IP is not reported (add a metric).
- Machine auth (P2.5c) notes: API-key scopes follow the permission grammar (`area:*`, `*`), but Dhru needs the exact
  `dhru` scope; key revocation (7b) and merchant status changes must call `ApiKeyDirectory.invalidate` /
  `invalidateClient` (else up to 60 s); `RateLimit-*` headers on v1 and multipart Dhru credentials are left to 7a;
  consider checking `allowed_ips` before the merchant status (a stolen key used elsewhere learns the status).
- Staff sign-in (P2.6) notes: local sign-in uses the seeded staff with password `demo-password` and the TOTP secrets
  listed in README "Local sign-in"; the 2FA and setup attempt limits count per account (stricter than per session:
  someone with the password can lock the owner out of the code step for 15 minutes); migration 0002 adds
  `staff_users.totp_last_step` (B116); `StaffAuthTokens` creates invite/reset links for feature 2a.
- Merge procedure (lead): commit the implementer's output on the feature branch, `git merge --squash` it into
  `feat/backend`, apply the review fixes, then stage only paths that still exist: a deleted directory in the `git add`
  list makes the whole command fail and leaves the later edits out of the commit (happened once: P2.4b, fixed by
  e504599). Run `bun install` after a merge that changed the lockfile.
- Run Bun entry points from the repo root: Bun reads `tsconfig.json` (decorator flags) from the working directory.
- `TRUST_PROXY` as a hop count becomes a trust function (Fastify 5.12 ignores numbers); use it only when the app port
  is reachable solely through the proxy chain, otherwise list the proxy addresses.
