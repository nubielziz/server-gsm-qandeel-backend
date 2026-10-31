# 022: Caching

Status: accepted, 2026-10-31.

**Decision.** Our own `CacheService` in `src/infra/cache` on the cache Redis (no cache-manager):
- `getOrLoad(key, ttl, loader, { lock?, staleWhileRevalidate?, negativeTtl? })`: cache-aside; TTL jitter ±15%;
  in-process coalescing of concurrent loads plus a `SET NX PX` lock across instances for hot keys; optional
  stale-while-revalidate; short negative caching for hammered misses (unknown TAC).
- Keys come only from `CacheKeys` builders (`gsm:{env}:{module}:{entity}:{id}[:v{n}]`); a test checks every builder
  is listed in `docs/cache-keys.md` (owner, TTL, invalidation). Bulk invalidation uses version keys
  (`catalog:version`).
- Invalidation runs after commit (unit-of-work post-commit hooks; for async writers through the outbox).
- Never cached as truth: balances, ledger, holds, payment and order status used for decisions, risk decisions,
  idempotency results.

**Consequences.** Hot reads (Dhru `imeiservicelist`, price lists, settings, permissions, IP rules) stay off
Postgres without risking stale money decisions.
