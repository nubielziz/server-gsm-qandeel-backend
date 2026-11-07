# 034: Turnstile on the public storefront writes

Status: accepted, 2026-11-07 (lead, before features 14a, 14b and 17). Builds on decisions 018 (pipeline, trusted proxy),
021 (per-IP limits), 023 (outbound HTTP) and 013 (configuration).

**Context.** The map marks six storefront routes with Turnstile (`turnstile: true` in the route manifest:
`POST /store/v1/imei/check`, `POST /store/v1/checkout-sessions`, `POST /store/v1/auth/magic-link`, `POST /store/v1/auth/login`,
`POST /store/v1/auth/password/forgot`, `POST /store/v1/tickets`) and ALIGNMENT § 7 answers a failed check with
`403 TURNSTILE_FAILED`. Nothing in the code verified a token yet, and three features (14a, 14b, 17) need the same check, so it
is built once.

**Decision.**
- **Transport.** The storefront copies the widget's token (`cf-turnstile-response`) into the request header
  `X-Turnstile-Token`. JSON bodies stay free of it and every method works the same way.
- **Contract.** `defineRoute` gains `turnstile?: boolean`, allowed only on `/store/v1` routes (a contract error otherwise);
  `true` adds `TURNSTILE_FAILED` to the route's errors and the header to its OpenAPI parameters, and the route-parity contract
  test compares the flag with the manifest.
- **Check.** One guard after authentication (`APP_GUARD` order; the per-IP limit hook of decision 021 runs first, so an
  outbound check only happens inside the limits): for a `turnstile` route, a missing token, an empty one or one longer than
  2048 characters is `403 TURNSTILE_FAILED` without any outbound call; otherwise `TurnstileVerifier.verify(token, clientIp)`
  decides (the client IP is the trusted-proxy address of decision 018). A refusal never says why beyond the problem's detail
  'The anti-bot check failed. Refresh the page and try again.'; the log has the request id and Cloudflare's error codes, never
  the token.
- **Verifier.** An interface behind the injection token `TURNSTILE_VERIFIER`.
  - `SiteverifyTurnstileVerifier` (production): `POST https://challenges.cloudflare.com/turnstile/v0/siteverify` as JSON
    `{secret, response, remoteip, idempotency_key}` through `OutboundHttp` (target `turnstile`, timeout 5 s, no automatic
    retry, a fresh UUID as the idempotency key); passes only when the answer has `success: true` and, when
    `TURNSTILE_HOSTNAMES` is set, a `hostname` in that list. A timeout, a network failure or an unreadable answer fails
    closed (`403`), with a warning log and a counter (`turnstile_failures_total{reason}`).
  - `DummyTurnstileVerifier` (development and tests without a secret): no network; accepts exactly Cloudflare's dummy
    token `XXXX.DUMMY.TOKEN.XXXX` (what the test sitekeys produce) and refuses anything else, so a local storefront can use
    the test sitekey `1x00000000000000000000AA` and the tests send that token.
- **Configuration (decision 013).** `TURNSTILE_SECRET_KEY` (secret): required when `NODE_ENV=production` (the config refuses to
  start without it); without it the dummy verifier is used. `TURNSTILE_HOSTNAMES` (optional, comma-separated). Cloudflare's
  test secrets (`1x...AA` always passes, `2x...AA` always fails, `3x...AA` answers `timeout-or-duplicate`) work with the
  siteverify verifier for manual checks against the real API.

**Consequences.** The three storefront features never handle tokens themselves: they set `turnstile: true` on their routes
and their tests send `X-Turnstile-Token: XXXX.DUMMY.TOKEN.XXXX` (one helper in `test/support/`). A token is single use and
valid five minutes, so a client that retries a refused write must get a new token from the widget.

**Built (feature 14a, 2026-11-07).** `src/infra/turnstile` (README there): the guard is called by `AccessGuard` after
authentication, CSRF and permission (an explicit call, not a second `APP_GUARD`, so the order is a line of code and not module
registration order); `defineRoute` rejects `turnstile: true` outside `/store/v1`, appends `TURNSTILE_FAILED` to the route's errors
and the OpenAPI header is `x-turnstile-token` (lower case like the other documented headers) with the extension `x-gsm-turnstile`;
the route-parity test compares the flag with the manifest both ways. Counter: `turnstile_failures_total{reason}`. Routes flagged
today: `POST /store/v1/imei/check` and `POST /store/v1/checkout-sessions`.

