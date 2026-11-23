-- The count of wrong authenticator codes of an account inside 24 hours, when its window began and when the code step was closed for the
-- rest of it (staff and merchants). Additive: every existing row starts with a count of zero and no window.
ALTER TABLE "clients" ADD COLUMN "totp_failures" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "clients" ADD COLUMN "totp_failures_since" timestamp (3) with time zone;--> statement-breakpoint
ALTER TABLE "clients" ADD COLUMN "totp_locked_at" timestamp (3) with time zone;--> statement-breakpoint
ALTER TABLE "staff_users" ADD COLUMN "totp_failures" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "staff_users" ADD COLUMN "totp_failures_since" timestamp (3) with time zone;--> statement-breakpoint
ALTER TABLE "staff_users" ADD COLUMN "totp_locked_at" timestamp (3) with time zone;