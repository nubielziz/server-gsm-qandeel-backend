# 007: Password hashing: argon2id with @node-rs/argon2

Status: accepted, 2026-10-31.

**Context.** Passwords must use argon2id. The spike passed `argon2` (node-gyp-build prebuilds), `@node-rs/argon2`
(napi-rs, per-platform optional packages) and could use `Bun.password` (built in, Bun-only).

**Decision.** `@node-rs/argon2`: no install script, runs on Bun and Node, standard PHC strings (cross-verified with
`argon2` in the spike). Start from the OWASP baseline (m = 19 MiB, t = 2, p = 1); Phase 2 tunes it with a benchmark to
50–150 ms per hash on the target host and stores the parameters in each PHC string, so they can be raised later.

**Consequences.** Only human-chosen secrets (passwords) use argon2. High-entropy random secrets (session tokens, API
keys, invite and reset tokens) are stored as keyed SHA-256 hashes for constant-time lookup; recorded with the
security decisions of Phase 1. The `argon2` dependency was dropped with the spike (P2.4b).

Note: `@node-rs/argon2` exports `Algorithm` as an ambient const enum, which `isolatedModules` rejects; rely on
its default (argon2id) and assert the `$argon2id$` prefix in a unit test.
