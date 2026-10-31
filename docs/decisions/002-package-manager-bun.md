# 002: Package manager: bun install

Status: accepted, 2026-10-31.

**Context.** Bun is the runtime. npm 11 and Bun both block dependency install scripts by default.

**Options.** npm (package-lock.json); pnpm; `bun install` (text `bun.lock`).

**Decision.** `bun install` with `bun.lock` committed, `packageManager: bun@1.4.4` and `engines.bun` in
package.json. Prefer dependencies that need no install script (napi-rs or bundled prebuilds). A dependency that needs
one goes into `trustedDependencies` with the reason in the commit body.

**Consequences.** One tool installs, runs and tests. `bun pm untrusted` must stay empty or justified. CI runs
`bun install --frozen-lockfile`. The starter's package-lock.json is removed.
