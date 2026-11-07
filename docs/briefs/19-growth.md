# 19 growth

Phase 3, map stage 19 (abandoned checkouts, recovery, funnel, generated content). Read `_common.md` and `_feature.md` first:
this brief only names the scope. Modules: customers and storefront. Wave 7, after 14a (checkout sessions), 12a (recovery
emails), 15 (content pages) and 9 (`storefrontFunnel`). Decisions 020 (jobs), 031 (clock).

## Routes (4; remove them from `test/contract/pending.ts`)
- `GET /admin/checkouts/abandoned`, `POST /admin/checkouts/recover` (customers).
- `GET /admin/reports/funnel` (customers).
- `POST /admin/content-pages/generate` (storefront).

Per-route semantics: `docs/contract/endpoints/customers.md` and `storefront.md`; shapes: `docs/contract/frontend-endpoints.json`;
console callers (read-only): `FRONTEND_DIR/src/features/checkouts/{api,types,mocks}` and the storefront content pages.

## Rules that matter (beyond the endpoint docs)
- **Recovery (RULES checkouts 4).** Decides per id: `not_found`, `already_emailed`, `already_paid`, `no_marketing_consent`;
  sends only to eligible checkouts through 12a, sets `recovery_emailed_at`, writes the notifications and one audit row for the
  batch.
- **Funnel (b2c-10).** Reuse `storefrontFunnel(days)` from the customers index (built by 9); the window `[now - days, now]`
  from the clock.
- **Generated pages (b2c-15).** At most 50 new drafts per run (`STOREFRONT_GENERATE_MAX_PER_RUN`); existing combinations are
  skipped and counted; more than 50 refuses the whole run with 422 and no field.

## Resolutions of your routes (`docs/contract/RESOLUTIONS.md`; they win over older text)
b2c-10, b2c-15. Migration 0003 ships their schema changes; add a migration only for what it lacks.

## Out of scope
The checkout (14a), content pages admin (15), notification delivery (12a).
