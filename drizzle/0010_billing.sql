ALTER TABLE "invoices" ADD COLUMN "checkout_url" text;--> statement-breakpoint
ALTER TABLE "kyc_submissions" ADD COLUMN "submitted_note" text DEFAULT '' NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "kyc_submissions_one_pending_uq" ON "kyc_submissions" USING btree ("client_id") WHERE "kyc_submissions"."status" = 'pending';