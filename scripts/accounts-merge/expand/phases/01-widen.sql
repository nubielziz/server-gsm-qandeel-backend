-- Phase 1 of the expand migration of one account type (backend decision 064), the hand-written part; it runs after the generated
-- statements of the phase (the three new tables, the new columns with every account_id still nullable, their foreign keys and indexes,
-- the two email indexes that replace clients_email_uq, and the wide checks of the append-only vocabularies). Nothing here moves a row.

-- The legacy id map, the rank history and the wallet action keys are append-only: no row is ever updated or deleted (the application
-- role has no UPDATE or DELETE on them either). forbid_update_delete() exists since migration 0001 and guards the ledger and the audit log.
DROP TRIGGER IF EXISTS "account_legacy_ids_append_only" ON "account_legacy_ids";
CREATE TRIGGER "account_legacy_ids_append_only" BEFORE UPDATE OR DELETE ON "account_legacy_ids"
  FOR EACH ROW EXECUTE FUNCTION "forbid_update_delete"();
--> statement-breakpoint
DROP TRIGGER IF EXISTS "account_rank_changes_append_only" ON "account_rank_changes";
CREATE TRIGGER "account_rank_changes_append_only" BEFORE UPDATE OR DELETE ON "account_rank_changes"
  FOR EACH ROW EXECUTE FUNCTION "forbid_update_delete"();
--> statement-breakpoint
DROP TRIGGER IF EXISTS "wallet_action_keys_append_only" ON "wallet_action_keys";
CREATE TRIGGER "wallet_action_keys_append_only" BEFORE UPDATE OR DELETE ON "wallet_action_keys"
  FOR EACH ROW EXECUTE FUNCTION "forbid_update_delete"();
--> statement-breakpoint
-- The status check takes every status of both old tables for the time of the copy, so blocked and anonymized customers can be copied
-- in phase 3; phase 8 converts the last pending rows and narrows it to the final four statuses.
ALTER TABLE "clients" DROP CONSTRAINT IF EXISTS "clients_status_check";
ALTER TABLE "clients" ADD CONSTRAINT "clients_status_check"
  CHECK ("clients"."status" in ('active', 'suspended', 'pending', 'blocked', 'anonymized'));
--> statement-breakpoint
-- Every mutable (type, id) vocabulary takes the word 'account' next to the old ones, so phase 4 (and phase 6 for the refund requester)
-- can rewrite the rows; the generated statements of those phases narrow each check to the new words afterwards. The ledger owner checks
-- are not widened: phase 6 drops them before its update. files had no check: phase 4 adds one after its rewrite.
ALTER TABLE "sessions" DROP CONSTRAINT IF EXISTS "sessions_subject_type_check";
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_subject_type_check"
  CHECK ("sessions"."subject_type" in ('staff', 'client', 'customer', 'account'));
ALTER TABLE "auth_tokens" DROP CONSTRAINT IF EXISTS "auth_tokens_subject_type_check";
ALTER TABLE "auth_tokens" ADD CONSTRAINT "auth_tokens_subject_type_check"
  CHECK ("auth_tokens"."subject_type" in ('staff', 'client', 'customer', 'account'));
ALTER TABLE "notifications" DROP CONSTRAINT IF EXISTS "notifications_recipient_type_check";
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_recipient_type_check"
  CHECK ("notifications"."recipient_type" in ('staff', 'client', 'customer', 'account'));
ALTER TABLE "notification_inbox" DROP CONSTRAINT IF EXISTS "notification_inbox_recipient_type_check";
ALTER TABLE "notification_inbox" ADD CONSTRAINT "notification_inbox_recipient_type_check"
  CHECK ("notification_inbox"."recipient_type" in ('staff', 'client', 'customer', 'account'));
ALTER TABLE "support_tickets" DROP CONSTRAINT IF EXISTS "support_tickets_requester_type_check";
ALTER TABLE "support_tickets" ADD CONSTRAINT "support_tickets_requester_type_check"
  CHECK ("support_tickets"."requester_type" in ('client', 'customer', 'account'));
ALTER TABLE "ticket_messages" DROP CONSTRAINT IF EXISTS "ticket_messages_author_type_check";
ALTER TABLE "ticket_messages" ADD CONSTRAINT "ticket_messages_author_type_check"
  CHECK ("ticket_messages"."author_type" in ('staff', 'client', 'customer', 'system', 'account'));
ALTER TABLE "consent_records" DROP CONSTRAINT IF EXISTS "consent_records_subject_type_check";
ALTER TABLE "consent_records" ADD CONSTRAINT "consent_records_subject_type_check"
  CHECK ("consent_records"."subject_type" in ('customer', 'client', 'account'));
ALTER TABLE "alert_events" DROP CONSTRAINT IF EXISTS "alert_events_subject_type_check";
ALTER TABLE "alert_events" ADD CONSTRAINT "alert_events_subject_type_check"
  CHECK ("alert_events"."subject_type" in ('system', 'supplier', 'queue', 'gateway', 'ledger_account', 'client', 'account'));
ALTER TABLE "refunds" DROP CONSTRAINT IF EXISTS "refunds_requested_by_type_check";
ALTER TABLE "refunds" ADD CONSTRAINT "refunds_requested_by_type_check"
  CHECK ("refunds"."requested_by_type" in ('staff', 'customer', 'system', 'account'));
--> statement-breakpoint
-- The support form files a ticket under the account of the typed address whatever its rank, and its receipt is worded by the rank kind:
-- the merchant text of the receipt joins the customer text of migration 0016. A text staff already wrote is kept (ON CONFLICT DO NOTHING).
-- The statement is the output of supportMerchantReceiptSql() (src/modules/support/application/support-templates.ts), word for word.
INSERT INTO "notification_templates" ("event", "channel", "audience", "subject", "body", "is_active") VALUES
  ('support.ticket_received', 'email', 'merchant', 'We got your message ({{ticketNumber}})', 'Hello,

We received your message and opened ticket {{ticketNumber}}. Our team will answer by email.

You can follow the ticket and add details here: {{link}}

Please keep this email: the link is private to you.', true)
ON CONFLICT ("event", "channel", "audience") DO NOTHING;
--> statement-breakpoint
-- The retail half of migration 0005 again: every copied customer and every guest takes the one retail rank, so a database where that
-- row was deleted gets it back here instead of the copy guessing a rank. A database that has the row is not touched.
DO $$
DECLARE
  chosen_name text := 'Storefront retail';
BEGIN
  IF NOT EXISTS (SELECT 1 FROM "client_groups" WHERE "kind" = 'b2c_retail') THEN
    IF EXISTS (SELECT 1 FROM "client_groups" WHERE lower("name") = lower(chosen_name)) THEN
      chosen_name := 'Storefront retail (storefront)';
    END IF;
    INSERT INTO "client_groups"
      ("name", "kind", "discount_percent", "is_default", "earn_threshold", "deposit_limit", "overdraft_allowed", "sort")
    VALUES (chosen_name, 'b2c_retail', 0, false, 0, 0, false,
            (SELECT coalesce(max("sort"), 0) + 1 FROM "client_groups"));
  END IF;
END
$$;
