-- The bank reference of a transfer receipt: payments_gateway_txn_uq keeps a gateway's own reference (a payment without a receipt file)
-- unique for good, and a bank reference typed on a receipt only while its payment is pending or approved, so a rejected claim releases it.
-- The new index covers a part of the rows the old one covered, so it cannot fail on the rows that exist; no row is changed (a reference
-- stored before keeps the form it was typed in, and the receipt routes compare it in their stored form).
DROP INDEX "payments_gateway_txn_uq";--> statement-breakpoint
CREATE UNIQUE INDEX "payments_gateway_txn_uq" ON "payments" USING btree ("gateway_id","gateway_txn_id") WHERE "payments"."gateway_txn_id" is not null and ("payments"."receipt_file_id" is null or "payments"."status" in ('pending', 'approved'));