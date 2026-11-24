# Rate limits and semaphores (`src/infra/rate-limit`)

`rate-limiter-flexible` on the cache Redis (decision 021). The numbers live in one place: `limiters.ts`.

| Limiter    | Key                                                  | Budget                                              |
| ---------- | ---------------------------------------------------- | --------------------------------------------------- |
| `ip`       | client IP                                            | 300 per minute                                      |
| `api-key`  | API key id                                           | 60 per minute, or `api_keys.rate_limit_per_min`     |
| `sign-in`  | `RateLimitService.compositeKey(email, network)`: the network is `RequestMeta.limitKey` (the IPv4 address or the IPv6 /64) | 5 attempts per 15 minutes, then locked for 15 min (sign-in, forgot password, sign-in link) |
| `sign-in-code` | the account (a staff member or an account of any rank, hashed) | 5 authenticator codes per 15 minutes, then locked for 15 min; `failClosed`: never counted in process memory (decision 052) |
| `sign-in-familiar` | scope (console, or shop for every account) + email + network (the IPv4 /24 or IPv6 /64), keyed hash | 5 attempts per 15 minutes (no lock-out of its own): the password attempts of a network the account signed in from that are let through while the email is locked (`SignInLock`, decision 052) |
| `account-mail` | `compositeKey(subject, id, kind)` with the subject `account` or `staff` | 5 an hour per account and kind: staff-sent links, verification, email change, and the mails a visitor asks for (`sign_in_link`, `forgot_password`; beyond the budget nothing is sent and the answer is the usual one, decision 052) |
| `token`    | client IP                                            | 30 per minute                                       |
| `supplier` | supplier id                                          | 60 per minute, or `suppliers.rate_limit_per_min`    |
| `broadcast-email` | `all` (system-wide) | 5 per second, or the setting `notifications.broadcast_email_per_second` (feature 23) |
| `help-vote` | `RateLimitService.compositeKey(address key, articleId)` (the IPv4 address, or the IPv6 /64) | 1 per day: one counted help vote per visitor network and published article (`POST /store/v1/help/:slug/vote`; repeats are ignored with the same `204`, an unknown article is `404` and leaves no counter, decision 053) |
| `media`    | client IP                                            | 1200 per minute: the public service pictures (`GET /store/v1/media/:name`), apart from `ip` |
| `upload`   | client IP                                            | 20 per minute: large bodies (multipart or over 1 MiB) on Dhru, the portal, the admin console and the store (the receipt upload, feature 21) |
| `wallet-topup` | the account (`a:<accountId>`)                    | 10 per 10 minutes (feature 21: a hint; the top-up limits are SQL) |
| `stream-connect` | the first cap key of the stream (`session:<id>`) | 20 per minute: opening a live event stream (`GET /admin/stream`, `/client/stream`, `/store/v1/me/stream`, decision 037), and the ticket stream (`ticket:<id>`, feature 28) |
| `ticket-chat` | client IP | 120 per minute: the read marks of a ticket page (`POST /store/v1/tickets/:token/read`), instead of `token` (feature 28) |
| `ticket-message` | ticket id | 20 per minute: the messages a requester writes on one ticket (feature 28) |
| `ticket-open` | the account (`account:<id>`) | 5 per hour: tickets a signed-in account of either rank opens without Turnstile (feature 28; a counter lives one hour, so the keys of the earlier words expired by themselves) |
| `ticket-email` | `compositeKey(email)`: the typed address, or with an order link the address of the order's customer (`compositeKey('order', <id>)` when it has none) | 3 per hour: new tickets of the public form per address, so the receipt email cannot be sent to one address without bound (decision 053) |
| `webhook-intake` | client IP (the address key) | 600 per minute: every request under `/webhooks`, matched or not, counted by the per-IP stage before the route reads the gateway row (decision 053) |

```ts
// A pipeline guard or a use case:
await this.limits.enforce('ip', request.ip); // throws 429 RATE_LIMITED with Retry-After

// A per-key limit (the console shows it as "requests per minute"):
await this.limits.enforce('api-key', String(apiKey.id), 1, { limit: apiKey.rateLimitPerMin });

// Sign-in: count every attempt per email and network, clear the counter on success.
const key = RateLimitService.compositeKey(email, meta.limitKey);
await this.limits.enforce('sign-in', key);
if (await this.verify(email, password)) await this.limits.reset('sign-in', key);

// A supplier job: delay (do not fail) when the supplier is busy.
const lease = await this.limits.acquire(`supplier-${id}`, supplier.maxConcurrency, 60_000);
if (!lease) return delayJob();
try {
  await callSupplier();
} finally {
  await this.limits.release(lease);
}
```

## Behaviour

- `consume(name, key, points?, { limit? })` returns `{ allowed, remaining, limit, retryAfterSeconds }` and never throws for
  a refusal; `enforce` throws `AppError('RATE_LIMITED')` (429), whose `retryAfterSeconds` the exception filter sends as
  `Retry-After`. A refused call still counts against the budget; a window never grows longer because of it.
- `peek(name, key, { limit? })` (decision 053) reads a budget **without spending a point**: `{ allowed: false, retryAfterSeconds }` when the points are used up, the whole
  limit left for a key nobody counted. A caller that must not do work for an address whose budget of failed attempts is used up (unknown session cookies,
  unknown API keys) peeks before the lookup and charges a point with `consume` only when the attempt fails. With the cache Redis down the library answers from its
  in-memory limiter; a `failClosed` limiter answers "used up".
- Counters are `gsm:{env}:ratelimit:{limiter}:{key}`, shared by every limit of one limiter, so raising a key's limit
  mid-window keeps its count. Keys with personal data (email) go through `compositeKey`, which hashes them.
- **Redis down:** each process falls back to an in-memory limiter with the same numbers (per instance), so limits and
  sign-in lock-outs keep working. Except limiters marked `failClosed` in `limiters.ts` (`sign-in-code`, decision 052): they have no
  in-memory insurance and refuse (`retryAfterSeconds` 60, a throttled warning) until Redis answers again, and their `reset` only logs.
  `acquire` throws instead: a place that cannot be counted is not handed out.
- **Semaphore:** a sorted set of leases on Redis's own clock. A lease expires after `ttlMs` (a crashed holder frees its
  place), and `release` only removes its own lease. Make `ttlMs` longer than the longest call it covers.
- Metric: `rate_limit_denied_total{limiter}`.

## The per-IP stage of the request pipeline

`public-ip-limit.hook.ts` (`PublicIpLimitModule`, imported by the API's root module only) is the third stage of the request
pipeline (`src/common/pipeline/README.md`), after the IP rules and maintenance and before authentication. It charges one point per
request to the **client address** (the IPv4 address, or the /64 network of an IPv6 address; an IPv4-mapped address shares the key of
its IPv4 address) on these routes (`publicLimiterFor`, decision 021):

| Request | Limiter |
|---|---|
| anything under `/store/v1` (matched or not), except routes with a capability token and the pictures | `ip` (300 a minute) |
| anything under `/store/v1/media/` (the public service pictures, matched or not) | `media` (1200 a minute) |
| routes with `access` `checkout-token`, `tracking-token`, `ticket-token` or `link-token` | `token` (30 a minute) |
| routes with `access: 'public'` under `/admin` and `/client` (sign-in and password routes) | `ip` |
| a large body (multipart, or a declared length over 1 MiB) on Dhru, `/client` and `/admin` session routes | `upload` (20 a minute) |
| anything under `/webhooks` (matched or not, with or without a large body; decision 053) | `webhook-intake` (600 a minute) |

Unknown API keys are counted per client address by the API key guard itself (identity module), with the `ip` limiter under the key
`api-key-failures:<address key>`, because Dhru has no per-IP stage here and an unknown key has no per-key limit; the guard peeks that budget
before the key is looked up (decision 053), so an address that used it up costs no database lookup (only a key whose view is cached is still served). A known key is limited by its own `rate_limit_per_min` after every
other check (`api-key` limiter, key = key id); a bulk placement costs one point per item, at most the key's whole limit. The failed session lookups of each
audience (staff, and one budget for every account: the portal and the shop family share it, because one cookie serves both) use the same limiter under `session-failures:<subject>:<address key>` with the subject `staff` or `account` (300 a minute), read before the lookup by the session authenticator and by the
`upload-session` stage (decision 053); once it is used up only a session whose view is cached is still served.

Not counted here: session-authenticated admin and portal routes without a large body (per-principal limits come after authentication), Dhru
(a limit per API key), `/health`, `/metrics` (the health answer is memoised for 3 seconds instead, decision 053), the documentation. The numbers live in `limiters.ts` only. A
refusal is `429 RATE_LIMITED` with `Retry-After` and the CORS headers; with the cache Redis down the limiter counts in memory.
The route's `access` comes from its contract (`contractRegistry`), so new routes are covered by declaring the right `access`.
