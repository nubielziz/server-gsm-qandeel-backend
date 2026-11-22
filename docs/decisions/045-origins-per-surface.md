# 045: Browser origins per surface

Status: accepted, 2026-11-20 (feature 35, security fixes after the audit of 2026-11-20). Amends decision 018 (the Origin checks of the
CSRF guard) and decision 036 (topology A). Configuration rules: decision 013.

**Context.** The API had one list of browser origins (`CORS_ORIGINS`), granted with credentials on every route. In production the list
held the shop host and the console host, so the pages of either host could read the answers of every surface and pass every Origin
check. The session cookies are host-only and `SameSite=Lax`, but `SameSite` separates registrable domains, not hosts: when the shop
and the console share a registrable domain, requests that a shop page sends to the console host carry the staff cookie. The
`originCheck` GETs also accepted any request a browser marked `same-site`. Neither the console nor the storefront needs a page of one
audience to call the routes of the other.

**Decision.**
- **Two lists, one per audience.** `CONSOLE_ORIGINS`: the exact origins of the admin console. `SHOP_ORIGINS`: the exact origins of the
  storefront and the merchant portal. Same format as before (comma-separated `scheme://host[:port]`). In production a list that is not
  set is derived: the console's from `CONSOLE_BASE_URL`, the shop's from `STORE_BASE_URL` and `PORTAL_BASE_URL`. Outside production
  they default to the development origins (console `http://localhost:5173` and `http://127.0.0.1:5173`, shop `http://localhost:5174`
  and `http://localhost:5175`); under `NODE_ENV=test` to none. **A list that is set replaces the derived one; it does not add to it**,
  so `CONSOLE_ORIGINS` must include the origin of `CONSOLE_BASE_URL` and `SHOP_ORIGINS` those of `STORE_BASE_URL` and
  `PORTAL_BASE_URL`, and an operator leaves both unset unless another origin must be trusted.
- **Boot warnings in production** (the API and the worker log them; neither refuses the start, and the list stays as given): a given
  `CONSOLE_ORIGINS` that leaves out the origin of `CONSOLE_BASE_URL`, or a given `SHOP_ORIGINS` that leaves out the origin of
  `STORE_BASE_URL` or of `PORTAL_BASE_URL`, is reported with the missing origin, because sign-in from that page is refused; and an
  origin that is in both lists (given or derived) is reported, because a page of that origin is trusted on both the staff and the shop
  surfaces, while one origin per audience is the point of this decision. Development and tests set short lists on purpose and get no
  such warning.
- **`CORS_ORIGINS` is deprecated.** Outside production it stands in for each of the two lists that is not set, and the API and the
  worker log a warning at boot. Production refuses to start with it and names the two settings that replace it.
- **Production is https only**: every origin of the two lists, and `CONSOLE_BASE_URL`, `STORE_BASE_URL`, `PORTAL_BASE_URL` and
  `ERRORS_BASE_URL`.
- **CORS follows the surface of the path.** `/admin/**` (the queues board and the live stream included) and `/reference*` answer the
  console's origins; `/client/**` and `/store/v1/**` the shop's; every other path (`/v1/**`, `/api/index.php`, `/webhooks/**`,
  `/health`, `/metrics`, `/docs*`, `/openapi.json`, unknown paths) none. A request whose `Origin` is not on the list of its path gets
  no CORS header at all: no `Access-Control-Allow-Origin`, no `Access-Control-Allow-Credentials`, no exposed headers. Every answer keeps
  `Vary: Origin`. A preflight from a listed origin is answered first, as before; any other `OPTIONS` request is not a preflight: it
  passes the IP rules, maintenance and the per-IP limit like any request and ends as `404`.
- **The Origin checks use the list of the route's surface.** A mutation without a session on `/admin` needs an `Origin` of the
  console, on `/client` one of the shop. On `/store/v1` the routes that sign a visitor in without a session
  (`POST /store/v1/auth/verify`, `POST /store/v1/auth/login`) declare `originCheck` and need an `Origin` of the shop; the other public
  storefront writes keep their rules (some of their callers, such as mail providers, send no `Origin`). A GET with `originCheck` (the
  live streams, the customer data export, the order export, the merchant statement) needs `Sec-Fetch-Site: same-origin` or an `Origin`
  on the list of its surface; `same-site` alone no longer passes. A refusal is `403 CSRF_FAILED`, as before.
- **Page headers at the edge** (`deploy/Caddyfile`), on the pages of the console and of the shop only (the API's answers keep the API's
  own headers): `Content-Security-Policy` with `frame-ancestors 'none'`, `base-uri 'self'` and `object-src 'none'` (and
  `form-action 'self'` for the console), `X-Frame-Options: DENY`, `X-Content-Type-Options: nosniff`, and a `Referrer-Policy`
  (`same-origin` for the console; the shop keeps its own, `strict-origin-when-cross-origin` when it sends none). HSTS as before. No
  script policy is set at the edge: the console's page runs an inline script, and the storefront's policy belongs to the storefront.
- **The console host also serves the shop's pictures.** `/store/v1/media/*` (and only that part of `/store/v1`) is routed to the API on
  the console's host, so the console's listing pictures and payment logos load from its own origin. A picture request needs no CORS
  grant, and the console's origins stay off the shop's list.
- **The CSRF cookies keep their names and scope.** The console reads the cookie before the header token, and the storefront recognises
  a signed-in visitor by the cookie names, so a host-locked name needs a change in both applications first.

**Consequences.** A page of one audience can neither read the answers of the other audience's routes nor pass their Origin checks, and
no browser page can read the machine routes. The console and the storefront need no change: each calls only its own routes, from its
own origin, and in production from the API's own host. Operators remove `CORS_ORIGINS` from `.env.production` before the upgrade
(`docs/OPERATIONS.md`); development keeps working with it, with a warning. A console served from another origin must be listed in
`CONSOLE_ORIGINS` and cannot read `/health` across origins. The strongest separation is still a console host on a registrable domain of
its own; the configuration supports it, nothing requires it. Rejected: one global list with exceptions (two rules to keep in step);
keeping `same-site` for `originCheck` GETs (it accepts every host of the registrable domain); an Origin check on every public
storefront write (it would refuse callers that send no `Origin`); a script policy for the console at the edge now (it would block the
console's inline script, or tie the edge to a hash of the console's page).
