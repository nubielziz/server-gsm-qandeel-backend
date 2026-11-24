# Map additions: routes beyond the map

The API design map (`reference/gsm-map/data/*.mjs`) lives in the console repository and is read-only. A backend feature
that needs a route the map does not have adds a **row** here instead (decision 035,
`docs/decisions/035-routes-beyond-the-map.md`). One file per feature: `scripts/map-additions/<feature id>.mjs`
(`20.mjs`, `21.mjs`, `48-accounts.mjs`; the name matches `^[a-z0-9][a-z0-9-]*\.mjs$`). This README is the only other file allowed here.

Every tool that reads the map loads these files too: `routes:build`, `routes:check`, the module slices, route parity,
Turnstile parity, access and permission parity, the console-tag check, `pending.ts`, `COVERAGE.md`, the contract documents
`docs/contract/endpoints/<module>.md` and OpenAPI (which reads the contract registry, so a built route appears by itself).
The map's own numbers stay pinned (`EXPECTED` in `scripts/lib/map.mjs`); additions are counted on top
(`counts.additions` in `docs/route-manifest.json`), so no shared number is edited.

## A file

```js
// scripts/map-additions/<feature id>.mjs (the row of feature 20, as a new row is written since decision 039)
import { R } from '../lib/map-additions.mjs';

export const rows = [
  R('admin', 'clients', 'POST', '/admin/clients/:id/password-link', undefined, 'clients:security', 20,
    ['clients', 'auth_tokens', 'audit_logs'],
    { en: 'Send the merchant a link to set a password.', module: 'identity', spec: 'B-TBD merchant-password-link', successStatus: 204 }),
];
```

`R(s, g, m, p, f, a, st, t, extra)` is the map's helper. A plain object with the same keys is equal to an `R()` call.

**English only (decision 039).** A new row is English: it passes `undefined` as `f` (the map's Arabic sentence) and writes its
auth text as the access name (`public`, `staff-session`, ...; next section). The rows of features 20 to 29 keep their Arabic
sentence and words, and the generated documents keep them byte for byte; the map's own rows are the owner's specification and
stay as they are.

| Field           | Meaning                                  | Rule (a violation is an error naming the file, the row number and the row key)                                                                                                                                                                                                                                      |
| --------------- | ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `s`             | surface                                  | `admin`, `client`, `store`, `hooks` or `system` (HTTP only; the REST API v1 surface is retired, decision 062; Dhru actions, supplier calls and outgoing events are not additions: events keep `BACKEND_EVENTS` in `test/contract/route-parity.test.ts`)                                                                                                          |
| `g`             | map group of the surface                 | an id of `groups[s]` of the map (`admin`, `client`, `store` have groups); `null` on `hooks`, `system`. No new groups                                                                                                                                                                                          |
| `m`             | method                                   | `GET`, `POST`, `PUT`, `PATCH`, `DELETE`, or `CRUD` with `ops`                                                                                                                                                                                                                                                       |
| `ops`           | CRUD letters                             | only with `CRUD`: one or more of `L S C U D`, none twice (L = `GET path`, S = `GET path/:id`, C = `POST path`, U = `PATCH path/:id`, D = `DELETE path/:id`)                                                                                                                                                          |
| `p`             | path                                     | starts with `/`; segments are a fixed name or `:name`; no repeated parameter; starts with the prefix of the surface (`/admin`, `/client`, `/store/v1`, `/webhooks`; `system` = none of them and not `/api/index.php`); a `CRUD` path ends in a fixed segment and has no `:id`                              |
| `f`             | the sentence in Arabic (the map's language) | optional (decision 039): leave it out (`undefined` or `null`) in a new row; when given, non-empty and one line. A row without it carries `en` in its place (`descriptionAr` of the manifest), and `docs/contract/endpoints/<module>.md` prints the bracket after the English sentence only when the two differ |
| `a`             | auth text in the map's vocabulary        | see the next section; unknown text is an error                                                                                                                                                                                                                                                                      |
| `st`            | stage                                    | whole number >= 0. **Use your feature number** (20, 21, ...): it becomes a row of COVERAGE "By map stage". 99 belongs to the tooling test (`test/tooling/fixtures/map-additions/sample.mjs`)                                                                                                                            |
| `t`             | tables touched                           | names of map tables or of any module's `additionalTables` in `scripts/module-map.mjs`, never a table of a module's `retiredTables` (a table the contract release drops); none twice; may be empty                                                                                                    |
| `en`            | the English sentence                     | non-empty, one line (what `scripts/route-descriptions.en.mjs` holds for map rows)                                                                                                                                                                                                                                   |
| `module`        | owning module                            | an id of `scripts/module-map.mjs`. It decides alone: the matchers of that file are not consulted for an addition                                                                                                                                                                                                    |
| `spec`          | spec decision                            | `B<n>`, or `B-TBD <slug>` (`^B-TBD [a-z0-9]+(-[a-z0-9]+)*$`) until the lead numbers it at merge                                                                                                                                                                                                                     |
| `successStatus` | success status the console is promised   | optional, but **required as soon as the console calls the route**. Non-CRUD: one of 200, 201, 202, 204, 302 (302 only on `GET`). CRUD: an object keyed by ops letters, e.g. `{ L: 200, S: 200, C: 201, U: 200, D: 204 }` (keys must be in `ops`)                                                                      |

Any other key is an error (it catches a typo such as `sucessStatus`).

## Auth text per surface

`a` must be one of these (copied from `ACCESS` in `scripts/lib/map.mjs`); a combination the map never used needs a new line there,
named in that feature's plan. `Turnstile` in the text sets the Turnstile flag of the route (decision 034), `Idempotency-Key` sets
the idempotency flag. **A new row writes the English column** (decision 039): the access name itself, on the surfaces where the
map has the word; the map's words (the middle column of the second table) stay valid for the map's rows and the rows of features
20 to 29.

| Surface  | Text                                                                                                | Access                                                                                              |
| -------- | --------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| `admin`  | `area:action` or `area:*` (e.g. `clients:security`, `settings:*`)                                   | `staff-permission` with that permission (a CRUD row with `area:*` means `area:read\|create\|update\|delete` per endpoint) |
| `admin`  | `عام` / `جلسة`                                                                                      | `public` / `staff-session`                                                                          |
| `client` | `عام`, `عام + Turnstile` / `جلسة`                                                                     | `public` / `merchant-session`                                                                       |
| `store`  | `عام`, `عام + Turnstile`                                                                            | `public`                                                                                            |
| `store`  | `رمز الجلسة`, `رمز الجلسة + Idempotency-Key`                                                        | `checkout-token`                                                                                    |
| `store`  | `رمز التتبع (لا يُخمَّن)`, `رمز التتبع`                                                              | `tracking-token`                                                                                    |
| `store`  | `رمز الرابط` / `جلسة الزبون` / `رمز التذكرة`                                                        | `link-token` / `customer-session` / `ticket-token`                                                  |
| `hooks`  | `توقيع البوابة` / `secret بالرابط`                                                                  | `gateway-signature` / `url-secret`                                                                  |
| `system` | `عام` / `شبكة داخلية أو token`                                                                      | `public` / `internal-or-token`                                                                      |

The English words (decision 039), each giving the access of the same name:

| Surface  | Text                                                                                                                                              |
| -------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| `admin`  | `public`, `staff-session` (and `area:action` as above)                                                                                            |
| `client` | `public`, `public + Turnstile`, `merchant-session`                                                                                                |
| `store`  | `public`, `public + Turnstile`, `checkout-token`, `checkout-token + Idempotency-Key`, `tracking-token`, `link-token`, `customer-session`, `ticket-token` |
| `hooks`  | `gateway-signature`, `url-secret`                                                                                                                 |
| `system` | `public`, `internal-or-token`                                                                                                                     |

## Row flags (feature 24A)

The map is read-only, but a feature may need a **stricter** rule on a route the map already has. An additions file may export, beside
`rows`, an array `rowFlags`:

```js
export const rowFlags = [
  { row: 'client POST /client/auth/login', turnstile: true, spec: 'B-TBD merchant-auth-turnstile' },
];
```

| Field       | Rule                                                                                                                  |
| ----------- | --------------------------------------------------------------------------------------------------------------------- |
| `row`       | the key of a **map** row (`<surface> <method> <path>`, as `origin.row` in `docs/route-manifest.json`), never an addition |
| `turnstile` | `true`: the only flag. A flag adds protection to a row, it never removes any                                           |
| `spec`      | `B<n>` or `B-TBD <slug>`, like a row                                                                                  |

The row must be on surface `client` or `store`, not `CRUD`, `public`, and not already Turnstile in the map; a row is flagged by one
file at most; any other key is an error (`map additions problems: <file> flag <n> (<row>): …`). The manifest then gives the row's
endpoint `turnstile: true` and `rowFlag: { file, spec }` (every other endpoint is unchanged), and `route-manifest.md` ends its
description with `(Turnstile added, <spec>)`; route parity then expects `turnstile: true` on the contract. A route whose callers do not
send the token yet adds `turnstileRollout` to its contract (`src/infra/turnstile/README.md`).

## Guards

The loader (`scripts/lib/map-additions.mjs`) stops every tool that loads the map, naming the file, the row number and the row key:

- a row that repeats a **map row** (`repeats the map row`);
- a row with an **endpoint the map already has**, even with another parameter name (`GET /admin/clients/:clientId/api-keys`
  against the map's `:id`), and a CRUD row whose letters expand to a map endpoint;
- an endpoint added by two rows or two files (`is also added by <file> row <n>`);
- any malformed field of the table above, an unknown key, an unknown module, table, group or surface, a stray file in this folder.

Not guarded: a **static segment where a map route has a parameter** (`GET /admin/clients/export` beside the map's
`GET /admin/clients/:id`). Fastify prefers the static route, so the map route can no longer be reached for that one value. That
is harmless for numeric ids (`export` is never an id) but would hide a real slug (`/store/v1/pages/:slug`). Before adding such a
path, check the map route's parameter type; prefer a path with another segment count or a different prefix.

The manifest script adds: the console calls an addition (an `@route` tag) but the row has no `successStatus`.
The contract tests add: a contract must carry the access and permission of its row (`test/contract/lib/manifest-parity.ts`).

## Retired tables

`retiredTables` in `scripts/module-map.mjs` lists, per module, the map tables the contract release drops (decision 064; empty until
then). The module still owns such a table, because the map names it, and its slice carries `retired: true`; the loader refuses a list
that is not an array, names a table the module does not own, repeats a table, or names an `additionalTables` entry or a table another
module retires (`retired tables problems:`), and a row that touches a retired table is refused like a row that touches an unknown one.
The database and Drizzle schema tests expect the live tables only (`liveTablesOf` in `scripts/lib/map.mjs`).

## The accounts file

`48-accounts.mjs` holds the routes the one account type adds (decision 064): the admin counts, the legacy lookup, the rank change,
make an account, block, the privacy read, export, anonymize, freeze and unfreeze (each with its `successStatus`, the console calls
them), and the three two-step routes of a retail account in the shop. The routes that change but already have a row (the one
sign-in, the list and the detail, the wallet routes, the old customer routes that answer 410 until the contract release) keep their
row, and none is added a second time here.

## What to run

1. Add the row, then `bun run routes:build` (manifest and slices).
2. Build the route like any endpoint (`CONTRIBUTING.md`): the contract key is the row's endpoint key; `surface`, `access`,
   `permission` and `turnstile` must equal the row. A new table goes into `additionalTables` of its module in
   `scripts/module-map.mjs`; a new error code into the catalog and `BACKEND_CODES` of `scripts/build-contract-docs.mjs`.
3. `bun run contract:docs`, `bun run docs:openapi`, `bun run coverage:build`, `bun run format`.
4. The files here are formatted by Prettier (they are not in `.prettierignore`): `bun run format` rewrites them.

## When the console calls the route

Give the row `successStatus`. Once the console change is on the console's main checkout:
`bun run routes:build && bun run contract:extract && bun run contract:docs`, then `bun run contract:harvest` for a console `GET`
route (or an entry in `test/contract/harvest/known-gaps.json`). The console's own manifest stays the map's; its coverage report
lists the tag as unknown, which is accepted.

## What the lead does at merge

Replace each `B-TBD <slug>` by the B-number of the feature's `extra` entry in `docs/contract/lead-decisions.json`, then regenerate
(`bun run routes:build && bun run contract:docs && bun run docs:openapi && bun run coverage:build`). Generated files
(`route-manifest.*`, `slices/*`, `COVERAGE.md`, `contract/endpoints/*.md`, `openapi*.json`) are never hand-merged: take `main`'s
copy and regenerate.
