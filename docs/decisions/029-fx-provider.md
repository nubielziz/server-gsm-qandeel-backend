# 029: Exchange-rate provider (FX refresh)

Status: accepted, 2026-11-01 (lead resolution money-9). Routes: `POST /admin/currencies/refresh-fx`, the hourly `fx_refresh`
maintenance job (`docs/queues.md`).

**Decision.**
- One driver interface `FxProvider` in the money module returns the latest rates for a list of currency codes against the base
  currency (USD). The default driver is `openexchangerates` (USD base, a wide currency list including JOD, SAR and AED,
  `latest.json`). A second driver, `manual`, fetches nothing: it is the development default and makes a refresh answer
  `502 FX_PROVIDER_DOWN`.
- Configuration (`src/config`, read nowhere else): `FX_PROVIDER` (`openexchangerates | manual`, default `manual` in development),
  `FX_API_KEY` (secret, optional, never logged) and `FX_TIMEOUT_MS` (default 5000). Add the three keys to `.env.example`.
- Calls go through `OutboundHttp` (decision 023): explicit timeout, no automatic retry; the `fx_refresh` job and the manual
  route are the only callers, and each owns its retry policy.
- The answer of `POST /admin/currencies/refresh-fx` is `{refreshed, failed, source}` where `source` is the driver name. A
  currency missing from the provider's answer goes to `failed[]` with the message 'Not offered by the provider' and the route
  still answers `200`. When no rate could be fetched at all, or the provider is not configured (`manual`, or no key), the
  route answers `502 FX_PROVIDER_DOWN` with the detail 'No exchange-rate provider is configured.' (or the provider's failure).
  The catalog code `FX_PROVIDER_DOWN` is used; `FX_PROVIDER_UNAVAILABLE` was an analyst spelling and is not a code.
- Refreshed rows get `rate_updated_at = now()`; `isStale` is age only (non-base currency, `rate_updated_at` older than 24 h).
  Every refresh writes `audit_logs`.

**Consequences.** Rates stay in Postgres as the single source for pricing and the ledger; a provider outage leaves the old
rates in place and the dashboard's `fx_stale` item and the currencies panel show them as stale after 24 hours.
