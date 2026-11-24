-- Merchant verification by documents was retired (decision 061). Data only: the table "kyc_submissions" and the column
-- "clients"."kyc_status" stay, unread and unwritten, until the migration of the accounts model drops them. Every statement can run
-- twice and on an empty database (a statement that finds nothing changes nothing).
--
-- 1. The permissions of the five retired routes leave every stored role: the role catalog is built from the routes, so a role that
--    still held one of them could no longer be saved (422 on "permissions"). The wildcard of their area goes with them; "*" stays.
UPDATE "roles"
   SET "permissions" = array_remove(array_remove(array_remove("permissions", 'kyc:read'), 'kyc:decide'), 'kyc:*'),
       "updated_at" = now()
 WHERE "permissions" && ARRAY['kyc:read', 'kyc:decide', 'kyc:*']::text[];--> statement-breakpoint
-- 2. The stored templates of the two retired mail events (the code no longer sends them; staff edits of them go too).
DELETE FROM "notification_templates"
 WHERE "event" IN ('merchant.kyc_approved', 'merchant.kyc_rejected');
