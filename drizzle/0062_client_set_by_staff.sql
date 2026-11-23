-- Two marks on a merchant account: its password was set by staff (cleared when the merchant chooses one from a mailed link), and its
-- email address was set by staff. While a mark holds, the account's portal sessions make no API key and no webhook endpoint.
-- Additive; an account that is waiting to change a password staff gave it starts with the first mark.
ALTER TABLE "clients" ADD COLUMN "password_set_by_staff" boolean DEFAULT false NOT NULL;--> statement-breakpoint
UPDATE "clients" SET "password_set_by_staff" = true WHERE "must_change_password";--> statement-breakpoint
ALTER TABLE "clients" ADD COLUMN "email_set_by_staff" boolean DEFAULT false NOT NULL;
