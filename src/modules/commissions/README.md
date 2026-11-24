# Commissions & referrals (`commissions`), retired

Map domain F. The feature is gone (decision 062): no routes, no module, no engine, no jobs, no mails, no permissions. The 15 map routes
(`/admin/commission-*` and the merchant's `GET /client/commissions` and `GET /client/referrals`) are listed in `test/contract/retired.ts`.

What is left is the schema only, `db/schema.ts` (re-exported by `index.ts`, which `test/tooling/module-load.test.ts` loads, and by
`src/infra/db/schema.ts`):

| Table | Status |
|---|---|
| `commission_plans` | Unread and unwritten; dropped by the contract release of the one account type (decision 064). |
| `commission_assignments` | Unread and unwritten; dropped by the contract release. |
| `commission_accruals` | Unread and unwritten; dropped by the contract release. |

A drop is not additive, so the tables stay through the expand release of decision 064. The module map has a `retiredTables` seam (a subset of a module's own tables, empty in the expand release and filled by the contract release, which also marks the slice `retired: true`); this module's three tables join it there.

**Money history stays valid.** The journals that approved commissions posted remain in the ledger: the ledger kind `commission`, the
reference type `accrual` and the account kind `commission_expense` are still accepted by every constraint and read by every statement and
journal view. Nothing posts them any more: the money event `commission` and its reversal have no builder.

The two columns of the referral link, `clients.referred_by_id` and `clients.referral_code`, belong to the identity module's table (the accounts
table); they are retired the same way, and `referral_code` is nullable since the one account type (see the identity module's schema).
