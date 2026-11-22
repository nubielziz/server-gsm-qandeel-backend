-- Decision 049: a staff-issued invoice records who issued it; a currency whose refreshed rate was held is marked until a rate is confirmed;
-- one receipt file backs one pending or approved payment. Every change is additive. The check stops the migration and names the files
-- when existing payments break the receipt rule; docs/OPERATIONS.md ("One receipt, one payment") says what to do. Nothing changes when it stops.
ALTER TABLE "currencies" ADD COLUMN "rate_held_at" timestamp (3) with time zone;--> statement-breakpoint
ALTER TABLE "invoices" ADD COLUMN "issued_by" bigint;--> statement-breakpoint
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_issued_by_staff_users_id_fk" FOREIGN KEY ("issued_by") REFERENCES "public"."staff_users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "invoices_issued_by_idx" ON "invoices" USING btree ("issued_by");--> statement-breakpoint
-- The check: no receipt file may back two pending or approved payments before the unique index is built.
DO $$
DECLARE
  shared text;
BEGIN
  SELECT string_agg(receipt_file_id::text, ', ' ORDER BY receipt_file_id) INTO shared
  FROM (
    SELECT receipt_file_id FROM payments
    WHERE receipt_file_id IS NOT NULL AND status IN ('pending', 'approved')
    GROUP BY receipt_file_id HAVING count(*) > 1
    ORDER BY receipt_file_id LIMIT 20
  ) AS duplicated;
  IF shared IS NOT NULL THEN
    RAISE EXCEPTION 'payments_receipt_live_uq: receipt files that back more than one pending or approved payment: %. See docs/OPERATIONS.md, "One receipt, one payment", then migrate again.', shared;
  END IF;
END $$;--> statement-breakpoint
CREATE UNIQUE INDEX "payments_receipt_live_uq" ON "payments" USING btree ("receipt_file_id") WHERE "payments"."receipt_file_id" is not null and "payments"."status" in ('pending', 'approved');