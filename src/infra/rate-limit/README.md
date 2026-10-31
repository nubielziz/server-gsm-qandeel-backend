# Rate limits and semaphores (`src/infra/rate-limit`)

`rate-limiter-flexible` on the cache Redis (decision 021). The numbers live in one place: `limiters.ts`.

| Limiter    | Key                                                  | Budget                                              |
| ---------- | ---------------------------------------------------- | --------------------------------------------------- |
| `ip`       | client IP                                            | 300 per minute                                      |
| `api-key`  | API key id                                           | 60 per minute, or `api_keys.rate_limit_per_min`     |
| `sign-in`  | `RateLimitService.compositeKey(email, ip)`           | 5 attempts per 15 minutes, then locked for 15 min   |
| `token`    | client IP                                            | 30 per minute                                       |
| `supplier` | supplier id                                          | 60 per minute, or `suppliers.rate_limit_per_min`    |

```ts
// A pipeline guard or a use case:
await this.limits.enforce('ip', request.ip); // throws 429 RATE_LIMITED with Retry-After

// A per-key limit (the console shows it as "requests per minute"):
await this.limits.enforce('api-key', String(apiKey.id), 1, { limit: apiKey.rateLimitPerMin });

// Sign-in: count every attempt, clear the counter on success.
const key = RateLimitService.compositeKey(email, ip);
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
- Counters are `gsm:{env}:ratelimit:{limiter}:{key}`, shared by every limit of one limiter, so raising a key's limit
  mid-window keeps its count. Keys with personal data (email) go through `compositeKey`, which hashes them.
- **Redis down:** each process falls back to an in-memory limiter with the same numbers (per instance), so limits and
  sign-in lock-outs keep working. `acquire` throws instead: a place that cannot be counted is not handed out.
- **Semaphore:** a sorted set of leases on Redis's own clock. A lease expires after `ttlMs` (a crashed holder frees its
  place), and `release` only removes its own lease. Make `ttlMs` longer than the longest call it covers.
- Metric: `rate_limit_denied_total{limiter}`.
