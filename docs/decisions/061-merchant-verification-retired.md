# 061: Merchant verification by documents is retired

Status: accepted, 2026-11-23. Builds on decisions 047 (who may open a file), 053 (upload quotas) and 035 (routes beyond the map).

**Context.** A merchant account is made by the owner, and nobody submits papers, so verification by documents served no one. It also
gated nothing: no order, wallet or API call read `clients.kyc_status`, the error code `KYC_REQUIRED` was never thrown, and a decision on
a request never changed `clients.status`. The approval of a merchant (the status `pending`, its guard and its mail) is a separate rule
and is not touched by this decision.

**Decision.**

- **The five routes are retired**: `GET /client/kyc`, `POST /client/kyc`, `GET /admin/kyc-submissions`, `GET /admin/kyc-submissions/:id`
  and `POST /admin/kyc-submissions/:id/decide`. They are rows of the read-only map, so they stay in the route manifest and are listed in
  `test/contract/retired.ts` (a retired key must be a map row and must not be built); `test/contract/pending.ts` keeps its meaning and
  stays empty. The module that served them (controller, use case, queries, rules, contracts, `KycModule`) is deleted.
- **The wire loses `kycStatus`** on the merchant row of `GET /admin/clients` and `GET /admin/clients/:id` and on `GET /client/auth/me`.
  No field replaces it.
- **The two staff permissions `kyc:read` and `kyc:decide` leave the catalog** (it is built from the routes). Migration
  `0064_merchant_verification_retired.sql`, data only and safe to run twice, removes `kyc:read`, `kyc:decide` and `kyc:*` from every
  stored role, so a role that held one can still be saved, and deletes the stored templates of the two mail events.
- **The mails go**: the events `merchant.kyc_approved` and `merchant.kyc_rejected`, `MerchantLifecycleMails.kycDecided` and the two
  shipped templates.
- **Error codes**: `KYC_REQUIRED` and `ALREADY_DECIDED` leave the catalog (nothing else used `ALREADY_DECIDED`); the contract documents
  stop listing them.
- **Files**: an upload that no record uses yet and that a merchant owns needs `clients:read` where it needed `kyc:read`. The file kind
  `identity_document` stays for the rows stored earlier; opening one is still audited and needs `clients:read`.
- **Seeds and demo data**: no verification rows, and no `kyc` area in the seeded role matrix.

**What stays in the database, and until when.** The table `kyc_submissions` and the column `clients.kyc_status` stay in the database and in
the Drizzle schema, unread and unwritten (the column keeps its default), each marked with this decision. A drop is not additive, and the
map tooling has no seam yet for a retired table. The migration of the accounts model drops them. One statement keeps naming the
table: the files module's reference SQL reads `kyc_submissions.file_ids`, so the documents stored earlier stay referenced and the
unreferenced-file janitor does not delete them before the owner decides how long to keep them. Whoever drops the table decides that
retention first.

**Consequences.** The console and the shop stop reading `kycStatus` and stop calling the five routes before the backend release that
removes them; each works against both the old and the new backend meanwhile. Roles saved after the migration no longer carry the
retired permissions; a role cached before it (300 seconds) still grants them, and nothing checks them any more.

**Retired routes.** `GET /client/kyc`, `POST /client/kyc`, `GET /admin/kyc-submissions`, `GET /admin/kyc-submissions/:id`,
`POST /admin/kyc-submissions/:id/decide`.
