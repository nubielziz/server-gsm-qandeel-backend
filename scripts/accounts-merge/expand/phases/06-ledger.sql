-- Phase 6 of the expand migration of one account type (backend decision 064): ledger accounts are owned by the account. The generated
-- statements before this file dropped the two owner checks (they name the old owner words); the ones after add them back with
-- ('account', 'supplier') and the wallet kinds of an account, and let either wallet kind be frozen.

-- The owner of every merchant wallet, hold and store wallet. No entry, journal or balance changes: entries point at the ledger account
-- by its id. version is not touched (it counts balance changes, and this is none).
UPDATE "ledger_accounts" AS la
   SET "owner_type" = 'account', "owner_id" = l."account_id", "updated_at" = now()
  FROM "account_legacy_ids" l
 WHERE la."owner_type" IN ('client', 'customer') AND l."legacy_type" = la."owner_type" AND l."legacy_id" = la."owner_id";
--> statement-breakpoint
-- A refund a customer asked for names the account (the requester check is narrowed after this file).
UPDATE "refunds" AS r
   SET "requested_by_type" = 'account', "requested_by_id" = l."account_id"
  FROM "account_legacy_ids" l
 WHERE r."requested_by_type" = 'customer' AND l."legacy_type" = 'customer' AND l."legacy_id" = r."requested_by_id";
