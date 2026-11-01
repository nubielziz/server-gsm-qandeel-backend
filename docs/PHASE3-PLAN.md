# Phase 3 plan: the feature loop

Phase 2 (foundation) is done: 10 of 382 map endpoints are built (health, metrics, docs, the six staff sign-in routes),
372 are pending (`test/contract/pending.ts`). Phase 3 builds them feature by feature, by map stage, following
`docs/briefs/_feature.md` (recipe and definition of done). Nothing starts until the user says so.

## Before wave 1: resolve the audit
`docs/contract/AUDIT-PHASE3.md` lists 102 differences between the console and the backend plan (9 high, 56 medium,
37 low) over the 262 console endpoints still to build. The lead resolves them first (docs, decisions, schema
migration, briefs); each feature brief then cites the findings of its routes.

## How each feature runs
1. The lead writes its brief (`docs/briefs/<id>-<name>.md`): routes, rules, scenarios, user rules, out of scope.
2. One Sonnet implementer per feature in its own worktree (own Postgres and Redis test databases in `.env.test`).
3. One Opus review; one fix round and a re-review only if something blocks.
4. The lead squash-merges, fixes leftovers, runs `bun run check`, commits once per feature, updates PROGRESS.
5. At most 3 features at once; a wave ends when all its features are merged and green.

## Waves (dependencies first; features inside a wave run in parallel)

| Wave | Features | Stage | Pending routes | Needs |
|---|---|---|---|---|
| 1 | **2a** identity-staff-access, **2b** identity-merchant-auth, **3** money-wallets-ledger | 2, 3 | 60 | Phase 2 (briefs written) |
| 2 | **4a** catalog-structure (groups + nightly promotion, user rule 1), then **4b** catalog-pricing (user rules 8, 9) ∥ **5** orders-engine | 4, 5 | 59 | 2a, 3 |
| 3 | **6** suppliers (sync, dispatch, user rule 9 failover) ∥ **7b** merchant API keys and webhooks; then **7a** Dhru + REST v1 (PRICE_CHANGED) | 6, 7 | 57 | 4b, 5 |
| 4 | **8** billing (user rules 3, 4, 6) ∥ **9** health-dashboard | 8, 9 | 42 | 3, 5, 7b |
| 5 | **11** commissions-reports (user rule 5) ∥ **12a** notifications (price digest) ∥ **12b** alerts-integrity | 11, 12 | 46 | 5, 8 |
| 6 | **14a** storefront-checkout ∥ **14b** customers-accounts ∥ **15** storefront-content; then **16** b2c payments and refunds (user rule 7) | 14-16 | 70 | 5, 8 |
| 7 | **17** support ∥ **18** risk-privacy ∥ **19** growth | 17-19 | 38 | 14-16 |

Scenario e2e tests are written by the feature that completes the scenario (PROGRESS feature table: admin-team,
ip-rules, manual, success, reject, timeout, system-alert, system-integrity, b2c-account, b2c-paid, b2c-refund,
b2c-chargeback, b2c-ticket).

## Rules the features must carry
- User business rules 1-9 (PROGRESS "Business rules answered by the user"; OPEN-QUESTIONS.md; MISMATCHES B117, B118).
- Feature notes collected in Phase 2 (PROGRESS "Notes for later phases"): API-key cache invalidation (7b), the
  customers session resolver (14b), the price-change event route-parity allowance (7b), Dhru multipart under
  maintenance and RateLimit headers (7a), failStuck scheduling and Bull Board (9), the 302 file route and permissions
  B-entry (2a, files), hashing raw IPs in rate-limit keys.

## Then Phase 4
Point the console at the real API (mocks off), re-run the fixture harvest and the contract tests, walk the 13
scenarios end to end, and write `COVERAGE.md` (every map row: built, tested, or deliberately left out with a reason).

## Rough size
About 1 to 1.5 hours per wave with 3 features in parallel: 7 waves, roughly 8 to 10 hours of agent time, plus the
lead's merges. The user is asked before each wave starts.
