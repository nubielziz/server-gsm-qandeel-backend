# 15 storefront-content

Phase 3, map stage 15 (admin content and the public pages). Read `_common.md` and `_feature.md` first: this brief only names
the scope. Module: storefront. Wave 6 or 7, after 4b (the b2c floor) and 14a (the public catalog reads the listings).
Decisions 017 (docs), 031 (clock).

## Routes (20; remove them from `test/contract/pending.ts`)
- Public: `GET /store/v1/pages/:slug`, `GET /store/v1/help`, `GET /store/v1/help/:slug`.
- Listings: `GET|POST /admin/service-listings`, `GET|PATCH /admin/service-listings/:id`.
- Content pages: `GET|POST /admin/content-pages`, `GET|PATCH /admin/content-pages/:id`, `POST /admin/content-pages/:id/publish`.
- Help: `GET|POST /admin/help-articles`, `GET|PATCH /admin/help-articles/:id`.
- Legal: `GET|POST /admin/legal-documents`, `GET /admin/legal-documents/:id`, `POST /admin/legal-documents/:id/publish`.

Per-route semantics: `docs/contract/endpoints/storefront.md`; shapes: `docs/contract/frontend-endpoints.json`; console callers
(read-only): `FRONTEND_DIR/src/features/storefront/{api,types,mocks}` (listings, content pages, help articles, legal documents).

## Rules that matter (beyond the endpoint docs)
- **Listings (b2c-7, catalog-12).** `floorPrice` is the b2c effective floor from 4b's resolver function; a retail price under it
  is 422; one listing per service (`LISTING_EXISTS`), `LISTING_LOCKED` as the endpoint doc says; archived services vanish
  (catalog-3).
- **Pages, help, legal.** Unique slugs (`SLUG_TAKEN`); drafts and published versions; a legal document is versioned
  (`VERSION_EXISTS`), publishing makes it the version new consents reference (b2c-14 types); the public routes serve only the
  published version; HTML is stored as sent and rendered only by the storefront.
- Staff writes audited with the demo's verb phrases (ANSWERS audit Q3).

## Resolutions of your routes (`docs/contract/RESOLUTIONS.md`; they win over older text)
catalog-3, catalog-12, b2c-7, b2c-14. Migration 0003 ships their schema changes; add a migration only for what it lacks.

## Out of scope
Generated landing pages (19), storefront settings (16), the checkout (14a).
