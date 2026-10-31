# Cache (`src/infra/cache`)

Cache-aside on the cache Redis (decision 022). `docs/cache-keys.md` lists every key family.

| What                                                     | Where                                                           |
| -------------------------------------------------------- | --------------------------------------------------------------- |
| `CacheService`: `getOrLoad`, `del`, `delByPrefix`, `bumpVersion`, `versioned` | `cache.service.ts`                               |
| `CacheKeys`: the only way to build a key, `CACHE_KEY_FAMILIES` | `cache-keys.ts`                                           |
| Entry envelope, TTL jitter, the 100 KB limit             | `cache-entry.ts`                                                |

## Using it

```ts
const key = this.keys.settings(); // a builder you added to CacheKeys
const settings = await this.cache.getOrLoad(key, 300, () => this.repository.loadSettings(), {
  staleWhileRevalidate: 600, // optional: serve an old value while one refresh runs
});

// in a use case, after the change is committed:
await this.db.runInTransaction(async ({ tx, afterCommit }) => {
  await this.repository.saveSettings(tx, input);
  afterCommit(() => this.cache.del(this.keys.settings()));
});
```

## Behaviour

- **TTL always set, +-15 % jitter**, at most 30 days. Values are JSON (a `Date` comes back as a string) and under 100 KB: a
  bigger value is returned but not cached, and counted in `cache_errors_total{operation="too_large"}`.
- **Stampede protection:** concurrent calls for one key in a process share one load. `lockMs` adds a `SET NX PX` lock across
  processes: the others wait for the holder's result (they load themselves if it fails or is slower than `lockMs`).
- **Negative caching:** `negativeTtlSeconds` remembers "nothing there" (an unknown TAC) for a short time; the call returns
  `null`. Without it a `null`/`undefined` result is never cached.
- **Stale-while-revalidate:** the key outlives its freshness by the stale window; a stale read answers at once and starts
  one background refresh (a failing refresh keeps the old value).
- **Redis down:** a read or write failure is a miss (the loader runs, `cache_errors_total` counts it). `del`,
  `delByPrefix` and `bumpVersion` throw instead, because a missed invalidation leaves old data until the TTL.
- **Invalidate after the commit.** A `del` while a load of the same key runs in this process stops that load from storing its
  older value; across processes the TTL bounds the race.
- **Version keys** (`bumpVersion('catalog')`, `versioned('catalog', key)`) invalidate a whole group with one write. The
  counter is at least the current time in milliseconds, so an evicted and re-created counter never repeats a number.
- **Never cache as truth:** balances, ledger rows, holds, payment or order status used for decisions, risk decisions,
  idempotency results.

Metrics: `cache_hits_total{family}`, `cache_misses_total{family}`, `cache_errors_total{family,operation}`.
