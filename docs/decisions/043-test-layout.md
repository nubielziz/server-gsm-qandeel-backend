# 043: Test layout

Status: accepted, 2026-11-19. Replaces where decision 014 put the unit tests (`src/**/*.spec.ts`) and the `test/` line of
decision 016.

**Context.** 296 unit specs sat next to the code under `src/`, so the production image (`COPY src ./src`) carried them;
`test/integration/` held 269 files in one folder; `test/lint`, `test/schema`, `test/search` and `test/publish` held one file
each; `test/unit/` held tests of scripts and module wiring, not unit tests. Tests reached the code with paths such as
`../../src/...`. The owner asked for the tests to be kept apart from the code and chose this layout (the first of three
proposals) on 2026-11-19.

**Decision.**
- No test file under `src/`. `test/tooling/test-layout.test.ts` fails when one is added, when a unit test's folder has no
  matching folder under `src/`, or when a file sits loose at the top of `test/integration/`.
- `test/unit/` mirrors `src/`: the unit test of `src/<path>/<name>.ts` is `test/unit/<path>/<name>.spec.ts`. Pure, no I/O, no
  Docker (`bun run test:unit`). The lint rules of the code apply there too: no wall clock (031), no `process.env` (013), no
  console; `test/unit/config/` and `test/unit/common/clock.test.ts` keep the exceptions of the code they test.
- `test/integration/<module>/`: one folder per module of `src/modules`, plus `infra/` for `src/infra`, `src/common`,
  `src/config` and the two processes. A file goes to the module that owns the routes or the code it tests.
- `test/e2e/` (was `test/scenarios/`): one `<scenario id>.e2e.test.ts` per map scenario.
- `test/tooling/`: tests of the repository's own tools (scripts, deploy files, lint rules, schema structure, module loading,
  this layout). `test/contract/`, `test/dhru/`, `test/load/`, `test/support/`, `test/fixtures/` are unchanged.
- File names are unchanged: `.spec.ts` for unit tests, `.test.ts` elsewhere, `.e2e.test.ts` for scenarios.
- Tests import production code as `@src/...` (`compilerOptions.paths` in `tsconfig.json`; Bun reads it at run time).
  Code under `src/` keeps relative imports and a lint rule refuses `@src` there, because the module boundary rule (016)
  judges relative specifiers only. The boundary rule does not apply to tests, as before for `test/`: a test may reach into
  the module it tests.

**Consequences.** Moving a source file means moving its spec to the matching folder; the layout test catches a folder left
behind. The image no longer carries tests. `git log --follow` keeps each file's history across the move.
