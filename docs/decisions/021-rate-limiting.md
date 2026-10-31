# 021: Rate limiting

Status: accepted, 2026-10-31.

**Decision.** `rate-limiter-flexible` (RateLimiterRedis) on the cache Redis, through one `RateLimitService`:
- per API key (`api_keys.rate_limit_per_min`) for Dhru and REST v1; per IP on the public store routes (plus Turnstile
  where the map says); per email + IP on every sign-in route (staff, merchant, customer) with a temporary lock after
  consecutive failures; per IP on token routes (tracking, checkout, tickets).
- Outbound per supplier: `suppliers.rate_limit_per_min` through the same service and `max_concurrency` through a
  Redis semaphore; a limited dispatch job is delayed, not failed.
- A refusal is `429 RATE_LIMITED` problem+json with `Retry-After` (seconds), which the frontend reads.
- Counters live on the cache instance: an evicted counter only loosens a limit briefly; nothing here is a source of
  truth.

**Consequences.** Limits are consistent across API instances; the pipeline order (decision 018) puts IP rules
before the limiter and the limiter before authentication.
