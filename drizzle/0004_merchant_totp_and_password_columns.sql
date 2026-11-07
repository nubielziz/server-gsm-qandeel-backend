-- Merchant portal sign-in (feature 2b, MISMATCHES B116/B121): optional two-factor state and the password-change time on clients.
-- twofa_enabled is false while the secret is only pending; totp_last_step is the replay guard of the TOTP step (like staff_users).
ALTER TABLE "clients" ADD COLUMN "twofa_enabled" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "clients" ADD COLUMN "totp_last_step" bigint;--> statement-breakpoint
ALTER TABLE "clients" ADD COLUMN "password_changed_at" timestamp (3) with time zone;