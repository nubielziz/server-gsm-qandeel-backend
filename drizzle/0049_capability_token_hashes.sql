-- Feature 44 (decision 054): the shop's link tokens get a keyed hash for the lookup and an encrypted copy. Additive: new nullable columns,
-- partial unique indexes on columns that are still empty, and checks every existing row meets (a session has its plain token and no hash;
-- orders and tickets have no hash). The plain columns stay until a later release; the seal pass of migration capability_tokens_seal
-- converts the rows.
ALTER TABLE "checkout_sessions" ALTER COLUMN "token" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "checkout_sessions" ADD COLUMN "token_hash" text;--> statement-breakpoint
ALTER TABLE "checkout_sessions" ADD COLUMN "token_enc" text;--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "public_token_hash" text;--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "public_token_enc" text;--> statement-breakpoint
ALTER TABLE "support_tickets" ADD COLUMN "token_hash" text;--> statement-breakpoint
ALTER TABLE "support_tickets" ADD COLUMN "token_enc" text;--> statement-breakpoint
CREATE UNIQUE INDEX "checkout_sessions_token_hash_uq" ON "checkout_sessions" USING btree ("token_hash") WHERE "checkout_sessions"."token_hash" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "orders_public_token_hash_uq" ON "orders" USING btree ("public_token_hash") WHERE "orders"."public_token_hash" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "support_tickets_token_hash_uq" ON "support_tickets" USING btree ("token_hash") WHERE "support_tickets"."token_hash" is not null;--> statement-breakpoint
ALTER TABLE "checkout_sessions" ADD CONSTRAINT "checkout_sessions_token_form_check" CHECK (("checkout_sessions"."token" is null) <> ("checkout_sessions"."token_hash" is null));--> statement-breakpoint
ALTER TABLE "checkout_sessions" ADD CONSTRAINT "checkout_sessions_token_enc_check" CHECK (("checkout_sessions"."token_hash" is null) = ("checkout_sessions"."token_enc" is null));--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_public_token_form_check" CHECK ("orders"."public_token" is null or "orders"."public_token_hash" is null);--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_public_token_enc_check" CHECK (("orders"."public_token_hash" is null) = ("orders"."public_token_enc" is null));--> statement-breakpoint
ALTER TABLE "support_tickets" ADD CONSTRAINT "support_tickets_token_form_check" CHECK ("support_tickets"."token" is null or "support_tickets"."token_hash" is null);--> statement-breakpoint
ALTER TABLE "support_tickets" ADD CONSTRAINT "support_tickets_token_enc_check" CHECK (("support_tickets"."token_hash" is null) = ("support_tickets"."token_enc" is null));