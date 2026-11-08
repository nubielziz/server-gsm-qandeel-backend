# 021: Rate limiting

Status: accepted, 2026-10-31.

**Decision.** `rate-limiter-flexible` (RateLimiterRedis) on the cache Redis, through one `RateLimitService`:
- per API key (`api_keys.rate_limit_per_min`) for Dhru and REST v1; per IP on the public store routes (plus Turnstile
  where the map says); per email + IP on every sign-in route (staff, merchant, customer) with a temporary lock after
  consecutive failures; per IP on token routes (tracking, checkout, tickets).
- Outbound per supplier: `suppliers.rate_limit_per_min` through the same service and `max_concurrency` through a
  Redis semaphore; a limited dispatch job is delayed, not failed.
- Manual retries of a webhook delivery by staff (`POST /admin/webhook-deliveries/:id/retry`): one a minute per delivery
  (limiter `webhook-retry`, feature 7b).
- The public ticket form (`POST /store/v1/tickets`, feature 17): besides Turnstile and the per-IP limit, at most 3 new tickets
  per email address per hour (limiter `ticket-email`, keyed by the hashed lower-case address), because the receipt email
  repeats the visitor's subject to any address and the form could relay spam.
- Large bodies before authentication (amended 2026-11-07, feature 7a review): a multipart body or one declaring more than
  1 MiB on Dhru, REST v1 or the merchant portal is buffered and parsed (up to 25 MiB, B157) before its credentials are read,
  so it is also counted per client IP in the pipeline's limit stage (limiter `upload`, 20 a minute) before the body is read;
  other Dhru and REST v1 calls stay on their per-key limit only.
- A refusal is `429 RATE_LIMITED` problem+json with `Retry-After` (seconds), which the frontend reads.
- Counters live on the cache instance: an evicted counter only loosens a limit briefly; nothing here is a source of
  truth.

**Consequences.** Limits are consistent across API instances; the pipeline order (decision 018) puts IP rules
before the limiter and the limiter before authentication.
