-- Sign-up with details (backend decision 079). The owner's order of 2026-11-27: a shop account is made with an email, a password, a first
-- and a last name, a country and a phone. The details wait beside the one-time link the sign-up mails (one row per link, the link's row
-- deletes its details by cascade) until the link proves the mailbox; the exchange deletes the row in its own transaction and the daily purge
-- removes the rows whose link expired or was used. No plain password is stored: password_hash is argon2id. Additive: one new table, written
-- as drizzle-kit generated it; no other table, row, cache key or search document is touched, and the API of the release before never reads
-- the new table.
CREATE TABLE "account_signups" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "account_signups_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"auth_token_id" bigint NOT NULL,
	"password_hash" text NOT NULL,
	"first_name" text NOT NULL,
	"last_name" text NOT NULL,
	"country" text NOT NULL,
	"phone" text NOT NULL,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "account_signups" ADD CONSTRAINT "account_signups_auth_token_id_auth_tokens_id_fk" FOREIGN KEY ("auth_token_id") REFERENCES "public"."auth_tokens"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "account_signups_auth_token_uq" ON "account_signups" USING btree ("auth_token_id");