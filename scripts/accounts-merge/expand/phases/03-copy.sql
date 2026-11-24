-- Phase 3 of the expand migration of one account type (backend decision 064): the copy. Every customer that is not part of an approved
-- pair becomes a row of the accounts table (clients) with the id the map gave it; an approved pair fills blanks of the merchant's row.
-- The old customers table is not changed (phase 10 freezes it; the contract release drops it).

-- The copy. A customer keeps its status (blocked and anonymized ones pass the wide check of phase 1), its email (an anonymized one gets the
-- erasure address of its new id, the pattern of every erasure from now on), its login flag (a customer without a login stays a guest row
-- even when a merchant uses its email: guests have their own email partition), and its password only when it has a login (a guest never
-- holds one). It takes the one retail rank and no username. Columns of the old row that nothing reads are not moved.
INSERT INTO "clients" (
  "id", "username", "email", "password_hash", "name", "phone", "country", "group_id", "status",
  "email_verified_at", "suspended_at", "suspended_reason", "suspended_by", "internal_notes", "last_login_at",
  "must_change_password", "password_changed_at", "password_set_by_staff",
  "has_account", "currency", "marketing_opt_in", "anonymized_at", "created_by", "created_at", "updated_at")
OVERRIDING SYSTEM VALUE
SELECT m.account_id,
       NULL,
       CASE WHEN c."status" = 'anonymized' THEN 'deleted-account-' || m.account_id || '@redacted.invalid' ELSE c."email" END,
       CASE WHEN c."has_account" THEN cc."password_hash" END,
       c."name", c."phone", c."country",
       (SELECT g."id" FROM "client_groups" g WHERE g."kind" = 'b2c_retail'),
       c."status",
       c."email_verified_at", c."suspended_at", c."suspended_reason", c."suspended_by", c."internal_notes", c."last_login_at",
       c."has_account" AND coalesce(cc."must_change_password", false),
       CASE WHEN c."has_account" THEN cc."password_changed_at" END,
       -- staff set the password when the credentials row was last written by a staff member (a customer's own write clears updated_by)
       c."has_account" AND cc."updated_by" IS NOT NULL AND cc."password_hash" IS NOT NULL,
       c."has_account", c."currency", c."marketing_opt_in",
       CASE WHEN c."status" = 'anonymized' THEN coalesce(c."anonymized_at", c."updated_at") END,
       c."created_by", c."created_at", c."updated_at"
  FROM accounts_merge_map m
  JOIN "customers" c ON c."id" = m.customer_id
  LEFT JOIN "customer_credentials" cc ON cc."customer_id" = c."id"
 WHERE NOT m.merged
 ORDER BY m.account_id;
--> statement-breakpoint
-- An approved pair is one account with the merchant's row as the base: its id, username, password, two-factor setup, rank, status and
-- suspension stay. Blank name, phone and country are filled from the customer, the later sign-in time is kept, currency, marketing choice
-- and creator come from the customer, and both internal notes are kept. The customer's email verification is never copied: the
-- merchant's own address proof stays what it was.
UPDATE "clients" AS a
   SET "name" = CASE WHEN a."name" = '' THEN c."name" ELSE a."name" END,
       "phone" = CASE WHEN a."phone" = '' THEN c."phone" ELSE a."phone" END,
       "country" = CASE WHEN a."country" = '' THEN c."country" ELSE a."country" END,
       "last_login_at" = greatest(a."last_login_at", c."last_login_at"),
       "currency" = c."currency",
       "marketing_opt_in" = c."marketing_opt_in",
       "created_by" = c."created_by",
       "internal_notes" = CASE
         WHEN a."internal_notes" <> '' AND c."internal_notes" <> '' THEN left(a."internal_notes" || E'\n' || c."internal_notes", 2000)
         WHEN a."internal_notes" = '' THEN c."internal_notes"
         ELSE a."internal_notes" END,
       "updated_at" = now()
  FROM accounts_merge_map m
  JOIN "customers" c ON c."id" = m.customer_id
 WHERE m.merged AND a."id" = m.account_id;
--> statement-breakpoint
-- One map row per customer, merged or not: every later phase (and every reader of old pairs) resolves an old customer id through it.
INSERT INTO "account_legacy_ids" ("legacy_type", "legacy_id", "account_id", "merged")
SELECT 'customer', m.customer_id, m.account_id, m.merged FROM accounts_merge_map m ORDER BY m.customer_id;
