ALTER TABLE "payments" ADD COLUMN "checkout_session_id" bigint;--> statement-breakpoint
ALTER TABLE "payments" ADD COLUMN "idempotency_key" text;--> statement-breakpoint
ALTER TABLE "payments" ADD COLUMN "checkout_url" text;--> statement-breakpoint
ALTER TABLE "payments" ADD COLUMN "request_fingerprint" text;--> statement-breakpoint
ALTER TABLE "refunds" ADD COLUMN "send_attempt" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_checkout_session_id_checkout_sessions_id_fk" FOREIGN KEY ("checkout_session_id") REFERENCES "public"."checkout_sessions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "payments_checkout_session_id_idx" ON "payments" USING btree ("checkout_session_id");--> statement-breakpoint
CREATE UNIQUE INDEX "payments_session_key_uq" ON "payments" USING btree ("checkout_session_id","idempotency_key") WHERE "payments"."idempotency_key" is not null;--> statement-breakpoint
ALTER TABLE "refunds" ADD CONSTRAINT "refunds_send_attempt_check" CHECK ("refunds"."send_attempt" >= 1);