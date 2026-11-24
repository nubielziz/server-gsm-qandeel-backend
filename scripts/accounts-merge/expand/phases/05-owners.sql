-- Phase 5 of the expand migration of one account type (backend decision 064): one buyer column per table, account_id. Each backfill
-- fills only rows that do not have it yet, in the order the later ones read the earlier ones (payments read invoices, disputes and
-- refunds read payments). Then the five columns that every row needs become NOT NULL, and the generated statements add the new checks.
-- The old columns stay (orders.client_id is still written for the merchant doors; the contract release drops the rest).

-- Orders: the merchant of a merchant order, or the account of the customer of a shop order (exactly one is set: orders_buyer_check).
UPDATE "orders" SET "account_id" = "client_id" WHERE "account_id" IS NULL AND "client_id" IS NOT NULL;
--> statement-breakpoint
UPDATE "orders" AS o SET "account_id" = l."account_id"
  FROM "account_legacy_ids" l
 WHERE o."account_id" IS NULL AND l."legacy_type" = 'customer' AND l."legacy_id" = o."customer_id";
--> statement-breakpoint
-- Invoices: the same, and the wallet a top-up credits: a merchant top-up and a manual invoice the merchant wallet, a shop top-up the
-- store wallet; receipts and statements credit nothing.
UPDATE "invoices" SET "account_id" = "client_id" WHERE "account_id" IS NULL AND "client_id" IS NOT NULL;
--> statement-breakpoint
UPDATE "invoices" AS i SET "account_id" = l."account_id"
  FROM "account_legacy_ids" l
 WHERE i."account_id" IS NULL AND l."legacy_type" = 'customer' AND l."legacy_id" = i."customer_id";
--> statement-breakpoint
UPDATE "invoices"
   SET "wallet_kind" = CASE WHEN "kind" = 'topup' AND "client_id" IS NULL THEN 'customer_wallet' ELSE 'client_wallet' END
 WHERE "wallet_kind" IS NULL AND "kind" IN ('topup', 'manual');
--> statement-breakpoint
-- Payments: the customer's account, else the account of the invoice the payment pays (a merchant top-up).
UPDATE "payments" AS p SET "account_id" = l."account_id"
  FROM "account_legacy_ids" l
 WHERE p."account_id" IS NULL AND l."legacy_type" = 'customer' AND l."legacy_id" = p."customer_id";
--> statement-breakpoint
UPDATE "payments" AS p SET "account_id" = i."account_id"
  FROM "invoices" i
 WHERE p."account_id" IS NULL AND i."id" = p."invoice_id";
--> statement-breakpoint
-- Disputes: the customer's account, else the account of the disputed payment.
UPDATE "disputes" AS d SET "account_id" = l."account_id"
  FROM "account_legacy_ids" l
 WHERE d."account_id" IS NULL AND l."legacy_type" = 'customer' AND l."legacy_id" = d."customer_id";
--> statement-breakpoint
UPDATE "disputes" AS d SET "account_id" = p."account_id"
  FROM "payments" p
 WHERE d."account_id" IS NULL AND p."id" = d."payment_id";
--> statement-breakpoint
-- Refunds, after payments: every refund that names a payment carries the account of that payment, an orderless return of a held
-- payment included; a refund without a payment (an old merchant row) has no account (refunds_account_refs_check).
UPDATE "refunds" AS r SET "account_id" = p."account_id"
  FROM "payments" p
 WHERE r."account_id" IS NULL AND p."id" = r."payment_id";
--> statement-breakpoint
-- Checkout sessions (paid ones included: a paid session proves an address), risk assessments, blocklist entries and data requests: the
-- account of their customer.
UPDATE "checkout_sessions" AS t SET "account_id" = l."account_id"
  FROM "account_legacy_ids" l
 WHERE t."account_id" IS NULL AND l."legacy_type" = 'customer' AND l."legacy_id" = t."customer_id";
--> statement-breakpoint
UPDATE "risk_assessments" AS t SET "account_id" = l."account_id"
  FROM "account_legacy_ids" l
 WHERE t."account_id" IS NULL AND l."legacy_type" = 'customer' AND l."legacy_id" = t."customer_id";
--> statement-breakpoint
UPDATE "blocklist_entries" AS t SET "account_id" = l."account_id"
  FROM "account_legacy_ids" l
 WHERE t."account_id" IS NULL AND l."legacy_type" = 'customer' AND l."legacy_id" = t."customer_id";
--> statement-breakpoint
UPDATE "data_requests" AS t SET "account_id" = l."account_id"
  FROM "account_legacy_ids" l
 WHERE t."account_id" IS NULL AND l."legacy_type" = 'customer' AND l."legacy_id" = t."customer_id";
--> statement-breakpoint
-- Every order, invoice, payment, dispute and data request has its account now (phase 0 stopped on any that could not get one).
ALTER TABLE "orders" ALTER COLUMN "account_id" SET NOT NULL;
ALTER TABLE "invoices" ALTER COLUMN "account_id" SET NOT NULL;
ALTER TABLE "payments" ALTER COLUMN "account_id" SET NOT NULL;
ALTER TABLE "disputes" ALTER COLUMN "account_id" SET NOT NULL;
ALTER TABLE "data_requests" ALTER COLUMN "account_id" SET NOT NULL;
