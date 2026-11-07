# 032: Import cycles between modules (identity's export order)

Status: accepted, 2026-11-07 (lead, while merging wave 1: features 2b and 3 met in one tree for the first time).

**Context.** Modules import each other only through `src/modules/<id>/index.ts` (decision 016). Identity is both a provider
and a consumer: every module's controllers use its param decorators (`CurrentStaff`, `CurrentMerchant`) and principal
helpers, and identity's own use cases call other modules' public services (`MerchantAccounts.open` of money when a merchant
is created, `ClientGroupDirectory` of catalog for the merchant's group). So `identity/index.ts` → … → `money/index.ts` →
money's controllers → `identity/index.ts` is a cycle. ES modules allow cycles, but a decorator runs when its class is
defined: `@CurrentStaff()` on a money controller read the binding while `identity/index.ts` was still evaluating its
services, and Bun stopped with `ReferenceError: Cannot access 'CurrentStaff' before initialization` (OpenAPI generation and
every app boot). Whether it fails depends on which file is imported first.

**Decision.**
- `src/modules/identity/index.ts` re-exports its request-principal layer first: `security/access-state` (the param
  decorators, `accessStateOf`, `principalOf`), `security/permission-grammar` and the runtime helpers of `security/principal`.
  These files depend only on `@nestjs/common`, `src/common` and types, so they are fully evaluated before any identity service
  starts the chain into another module. ES modules evaluate a file's import and re-export requests in source order, and a
  re-exported binding points at the original file's binding, so a controller that reaches identity through the cycle finds
  the decorators initialised.
- A module that identity calls keeps its own leaves (classes its services are injected with) ahead of anything that imports
  identity: money's `money.module.ts` imports `MerchantAccounts` and `LedgerPoster` before `MoneyAdminModule` (its
  controllers).
- `test/unit/module-load.test.ts` imports every module index, `app.module.ts` and `worker.module.ts`, each in a fresh Bun
  process, so a new cycle that reads a binding too early fails in CI whatever the entry order.

**Rejected.**
- Moving the decorators to `src/common`: they return identity's principal types, and `src/common` may not import modules
  (decision 016); a generic version would lose the types every controller relies on.
- Ports (identity defines an interface and a token, money provides it): the cleanest direction, but it changes the public
  API the wave 1 briefs and resolution identity-platform-1 fixed (`MerchantAccounts.open` from `money/index.ts`). Revisit if
  identity starts calling more modules.
- Deep imports from `app.module.ts`: the boundary lint refuses them for every file under `src/`.

**Consequences.** New exports of `identity/index.ts` that controllers of other modules use at class-definition time go into
the first block. Other modules follow the same rule if they become part of a cycle; the load test tells.
