# 009: Keeping backend and frontend in sync: contract tests in CI

Status: accepted, 2026-10-31.

**Context.** The frontend is finished and typed against assumed shapes; the map defines what exists. Drift on either
side must fail CI, not production.

**Decision.** The zod contracts (decision 008) are the single backend source. CI runs `test/contract/`:
1. **Route parity.** Backend HTTP routes (from the contract registry and Nest's router) = the HTTP endpoints of
   `docs/route-manifest.json` (all surfaces); Dhru actions = `DHRU …` keys; supplier client methods = `SUPPLIER …`;
   outgoing event schemas = `EVENT …`; every frontend `@route` tag (269) is a backend route.
2. **Shape parity.** (a) Every response shape in `docs/contract/frontend-endpoints.json` (extracted from the
   frontend's TypeScript by `scripts/extract-frontend-contract.mjs`) is structurally compatible with the backend
   response schema: same required fields, compatible types, same enums, same nullability, Money/IsoDateTime/Id
   formats. (b) One harvested example per route from the frontend mock layer validates against the backend schema.
   (c) Every OpenAPI example validates against its schema.
3. **Error parity.** The backend error catalog = `docs/contract/error-codes.md`; every code the frontend references
   is in the catalog; backend codes the frontend never handles are reported (listed, not failing).
4. **Drift.** `routes:check` and `extract-frontend-contract --check` fail when the map or the frontend changed and the
   committed docs were not regenerated, so every change is re-aligned on purpose.
`docs/contract/openapi.json` (full) and `openapi.public.json` (REST v1) are generated and committed; a PR diff shows
every contract change. Accepted deviations live in `docs/contract/MISMATCHES.md` and in an explicit allowlist read
by the tests (each entry names its mismatch id).

**Consequences.** A red contract test blocks the commit. A TypeScript-level check (types generated from OpenAPI,
assigned to the frontend types with `tsc`) is not added: the structural comparison in 2a covers the same ground
directly from the frontend's own types.
