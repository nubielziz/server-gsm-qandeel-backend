# 6b — supplier call contracts (the last four manifest keys)

Stage 6 (feature 6 built the Dhru supplier client). Phase 4: after this feature every key of `docs/route-manifest.json` has a
contract (`docs/COVERAGE.md` 382 of 382).

## Keys

`SUPPLIER accountinfo`, `SUPPLIER imeiservicelist`, `SUPPLIER placeimeiorder+placeimeiorderbulk`,
`SUPPLIER getimeiorder+getimeiorderbulk` (`docs/contract/endpoints/suppliers.md`, sections "SUPPLIER ..."; the manifest rows of
kind `supplier-call`, surface `supplier`, auth `outbound-supplier-account`). These are calls this backend makes to a supplier's
Dhru Fusion API (decision 026), not routes it serves.

## What exists

- The client: `src/modules/suppliers/domain/dhru-protocol.ts` (pure: the request each call sends, how each answer is read;
  `DHRU_ACTIONS`), `application/supplier-client.ts`, `application/supplier-driver.ts` (the call, the `supplier_api_logs` record),
  used by the connection test, the sync, the dispatch job and the poll job. The tests run a fake Dhru supplier
  (`test/support/suppliers.ts`) and walk `test/scenarios/{success,reject,timeout}.e2e.test.ts`.
- The two other non-HTTP contract kinds to copy: `defineDhruAction` (`src/common/dhru/define-dhru-action.ts`, the registry
  `dhruActionRegistry`, the contracts in `src/modules/orders/contracts/dhru.contracts.ts`) and `defineEvent`
  (`src/common/contract/define-event.ts`).
- The contract tests: `test/contract/route-parity.test.ts` already has a `supplier-call` row in `built` (empty, with the
  comment "supplier calls have no registry yet: the feature that adds one lists its keys here"), the snapshot
  (`test/contract/lib/snapshot.ts`, `dump-app.ts`), `test/contract/pending.ts` (the four keys are the only ones left).
- The OpenAPI builder: `src/modules/platform/docs/openapi-documents.ts` (it already describes the Dhru actions).

## Build

1. `defineSupplierCall` (in `src/common/contract/` or next to `define-dhru-action.ts`, whichever fits the existing layout)
   with a registry, like `defineDhruAction`: the manifest key (`SUPPLIER <action>` or `SUPPLIER <action>+<action>bulk`), a
   summary and description, the Dhru `action` name(s), the schema of the parameters this backend sends, the schema of the
   answer it accepts (the success shape and the Dhru error shape), and examples validated against the schemas. A key that is
   not of that form throws at load, like the other kinds. The bulk variant is described but marked unused when the client
   never sends it (say so in the description).
2. The four contracts in `src/modules/suppliers/contracts/supplier-calls.contracts.ts`, from what `dhru-protocol.ts` sends and
   reads today (the contract follows the code, not a guess about the standard): `accountinfo` (credit, currency), `imeiservicelist`
   (the groups and services with their credit and delivery time as the sync reads them), `placeimeiorder` (`REFERENCEID`),
   `getimeiorder` (`STATUS` 0, 1, 3, 4 and `CODE`).
3. The client reads each answer through its contract's schema (one place, in `dhru-protocol.ts` or the driver), so a change to
   the code without the contract fails a test. Keep the current tolerance: extra fields are ignored, a missing or malformed
   field is the same error the client gives today (the supplier call is logged as failed; no new throw reaches a job that did
   not throw before). The fake supplier's answers must pass the schemas.
4. The snapshot lists the registered supplier calls; `route-parity.test.ts` fills `built['supplier-call']` from it; the four keys
   leave `pending.ts`; `bun run coverage:build` gives 382 of 382.
5. OpenAPI: if the builder has a natural place (an `x-supplier-calls` extension or the internal document's description, like
   the Dhru actions), list the four calls there; the public document stays as it is. `bun run docs:openapi`.
6. Docs: `src/modules/suppliers/README.md` "Supplier calls (outgoing)" names the contracts file; the common contract README
   names the new kind.

## Tests

Unit: `defineSupplierCall` (key forms, examples validated, the registry); each contract parses the fake supplier's answers and
refuses a malformed one. The existing supplier unit and integration tests and the three scenarios stay green. The contract tests
pass with no allowlist entry.

## Out of scope

No new route, no migration, no change to what the jobs do.
