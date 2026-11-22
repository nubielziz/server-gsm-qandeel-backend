-- Decision 050: the visitor's country is kept on the checkout, and a blocklist entry can be limited to guest checkouts. Additive: existing rows get null and false, which keep today's behaviour.
ALTER TABLE "blocklist_entries" ADD COLUMN "guest_only" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "checkout_sessions" ADD COLUMN "ip_country" text;--> statement-breakpoint
ALTER TABLE "checkout_sessions" ADD CONSTRAINT "checkout_sessions_ip_country_check" CHECK ("checkout_sessions"."ip_country" is null or "checkout_sessions"."ip_country" ~ '^[A-Z]{2}$');