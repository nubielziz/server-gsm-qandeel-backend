# 003: TypeScript 6.0.x for type-checking

Status: accepted, 2026-10-31.

**Context.** `typescript@latest` is 7.0, the native compiler. typescript-eslint 8.72 supports `typescript <6.1`;
@nestjs/swagger 12 peers `^5.5 || ^6.0`. Type-aware lint (doc lint, Nest-safe import rules) needs the compiler API
that typescript-eslint drives.

**Options.** TS 7.0 (fast, but breaks type-aware lint today); TS 6.0.x (last JS-based release, full tooling).

**Decision.** Pin `typescript ~6.0.3`, used only for `tsc --noEmit`; Bun transpiles at runtime, so tsc never emits.
Strict flags: `strict`, `noUncheckedIndexedAccess`, `noImplicitOverride`, `noFallthroughCasesInSwitch`.

**Consequences.** Revisit when typescript-eslint and @nestjs/swagger support 7.x (a one-line bump plus a lint run).
