ALTER TABLE "ledger_accounts" DROP CONSTRAINT "ledger_accounts_kind_check";--> statement-breakpoint
ALTER TABLE "ledger_accounts" DROP CONSTRAINT "ledger_accounts_kind_owner_check";--> statement-breakpoint
ALTER TABLE "ledger_transactions" DROP CONSTRAINT "ledger_transactions_ref_type_check";--> statement-breakpoint
ALTER TABLE "payments" DROP CONSTRAINT "payments_method_type_check";--> statement-breakpoint
ALTER TABLE "payments" ALTER COLUMN "gateway_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "checkout_sessions" ADD COLUMN "opened_signed_in" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "invoices" ADD COLUMN "idempotency_key" text;--> statement-breakpoint
ALTER TABLE "invoices" ADD COLUMN "request_fingerprint" text;--> statement-breakpoint
ALTER TABLE "ledger_accounts" ADD COLUMN "frozen_at" timestamp (3) with time zone;--> statement-breakpoint
ALTER TABLE "ledger_accounts" ADD COLUMN "frozen_reason" text DEFAULT '' NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "invoices_customer_key_uq" ON "invoices" USING btree ("customer_id","idempotency_key") WHERE "invoices"."idempotency_key" is not null;--> statement-breakpoint
CREATE INDEX "ledger_accounts_customer_wallet_idx" ON "ledger_accounts" USING btree ("balance") WHERE "ledger_accounts"."kind" = 'customer_wallet';--> statement-breakpoint
CREATE INDEX "ledger_accounts_frozen_idx" ON "ledger_accounts" USING btree ("frozen_at") WHERE "ledger_accounts"."frozen_at" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "payments_balance_session_uq" ON "payments" USING btree ("checkout_session_id") WHERE "payments"."method_type" = 'balance';--> statement-breakpoint
ALTER TABLE "ledger_accounts" ADD CONSTRAINT "ledger_accounts_frozen_check" CHECK ("ledger_accounts"."frozen_at" is null or "ledger_accounts"."kind" = 'customer_wallet');--> statement-breakpoint
ALTER TABLE "ledger_accounts" ADD CONSTRAINT "ledger_accounts_overdraft_kind_check" CHECK ("ledger_accounts"."overdraft_limit" = 0 or "ledger_accounts"."kind" = 'client_wallet');--> statement-breakpoint
ALTER TABLE "ledger_accounts" ADD CONSTRAINT "ledger_accounts_kind_check" CHECK ("ledger_accounts"."kind" in ('fee_income', 'vat_payable', 'chargeback_loss', 'bank', 'gateway_fees', 'gateway_clearing', 'customer_funds', 'revenue', 'cogs', 'adjustments', 'commission_expense', 'owner_capital', 'client_wallet', 'client_hold', 'supplier_prepaid', 'customer_wallet'));--> statement-breakpoint
ALTER TABLE "ledger_accounts" ADD CONSTRAINT "ledger_accounts_kind_owner_check" CHECK (("ledger_accounts"."kind" in ('client_wallet', 'client_hold') and "ledger_accounts"."owner_type" is not distinct from 'client')
 or ("ledger_accounts"."kind" = 'supplier_prepaid' and "ledger_accounts"."owner_type" is not distinct from 'supplier')
 or ("ledger_accounts"."kind" = 'customer_wallet' and "ledger_accounts"."owner_type" is not distinct from 'customer')
 or ("ledger_accounts"."kind" not in ('client_wallet', 'client_hold', 'supplier_prepaid', 'customer_wallet') and "ledger_accounts"."owner_type" is null));--> statement-breakpoint
ALTER TABLE "ledger_transactions" ADD CONSTRAINT "ledger_transactions_ref_type_check" CHECK ("ledger_transactions"."ref_type" in ('order', 'payment', 'invoice', 'refund', 'dispute', 'accrual', 'supplier', 'client', 'customer', 'system'));--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_gateway_check" CHECK (("payments"."method_type" = 'balance') = ("payments"."gateway_id" is null));--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_method_type_check" CHECK (("payments"."purpose" = 'topup' and "payments"."method_type" in ('bank', 'card', 'usdt', 'wise'))
 or ("payments"."purpose" = 'order' and "payments"."method_type" in ('card', 'wallet', 'crypto', 'balance')));