# Anti-bot check (`src/infra/turnstile`)

Decision 034: the public storefront writes the map marks with Turnstile are protected by Cloudflare Turnstile (or a stand-in in
development). One guard, driven by the route contract, serves every storefront feature.

| What | Where |
| --- | --- |
| `TurnstileVerifier` (the interface), the header name, the dummy token | `turnstile-verifier.ts` |
| `SiteverifyTurnstileVerifier` (production: Cloudflare's siteverify through `OutboundHttp`) | `siteverify-turnstile.verifier.ts` |
| `DummyTurnstileVerifier` (no secret: accepts only `XXXX.DUMMY.TOKEN.XXXX`) | `dummy-turnstile.verifier.ts` |
| `TurnstileGuard`: the check, called by `AccessGuard` after authentication, CSRF and permission | `turnstile.guard.ts` |
| `TurnstileModule` (global): picks the verifier from the config | `turnstile.module.ts` |

## Using it on a route

```ts
export const openCheckoutSession = defineRoute({
  key: 'POST /store/v1/checkout-sessions',
  surface: 'store',
  access: 'public',
  turnstile: true, // only on /store/v1 routes (else defineRoute throws)
  // ...
});
```

`turnstile: true` adds `TURNSTILE_FAILED` to the route's errors and the `x-turnstile-token` header (required) and the
`x-gsm-turnstile` extension to its OpenAPI operation. The route-parity contract test compares the flag with the manifest's
`turnstile` column in both directions, so a route cannot be flagged or forgotten silently.

## Behaviour

- The storefront copies the widget's token (`cf-turnstile-response`) into the request header `X-Turnstile-Token`; bodies stay free
  of it. A missing, empty, repeated or longer-than-2048-character token is `403 TURNSTILE_FAILED` without any outbound call.
- Otherwise `verify(token, request.ip)` decides (`request.ip` is the trusted-proxy address of decision 018). The siteverify
  verifier posts `{secret, response, remoteip, idempotency_key}` as JSON with a 5 s timeout and no retry, and passes only
  `success: true` plus, when `TURNSTILE_HOSTNAMES` is set, a `hostname` in that list. A timeout, a network failure, a non-2xx
  status or an unreadable answer fails closed.
- Every refusal answers `403 TURNSTILE_FAILED` with the one detail "The anti-bot check failed. Refresh the page and try again."
  The log has the request id, the reason and Cloudflare's error codes; never the token. `turnstile_failures_total{reason}` counts
  them (`missing`, `too_long`, `rejected`, `hostname`, `timeout`, `network`, `bad_response`).
- A token is single use and valid five minutes: a client that retries a refused write needs a new token from the widget.
- Order in the pipeline: IP rules, maintenance, per-IP limit (decision 021), authentication, CSRF, permission, then this check, so
  an outbound verification only happens inside the limits.

## Configuration (decision 013)

| Variable | Meaning |
| --- | --- |
| `TURNSTILE_SECRET_KEY` | Required when `NODE_ENV=production` (the config refuses to start without it). Unset elsewhere: the dummy verifier. |
| `TURNSTILE_HOSTNAMES` | Optional, comma-separated host names a token may be issued for (no scheme, port or path). |

Cloudflare's test secrets work with the siteverify verifier for a manual check against the real API (`1x...AA` always passes,
`2x...AA` always fails, `3x...AA` answers `timeout-or-duplicate`); the test sitekey `1x00000000000000000000AA` makes the widget
produce the dummy token, which the dummy verifier accepts.

## Tests

Tests send the dummy token through `TURNSTILE_HEADERS` / `withTurnstile()` of `test/support/storefront.ts`. Unit tests of the
verifiers and the guard: `turnstile.spec.ts`; wiring and the real routes: `test/integration/turnstile.test.ts`,
`imei-check.test.ts`, `checkout-sessions.test.ts`.
