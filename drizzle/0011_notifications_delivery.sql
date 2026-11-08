-- Feature 12a (notifications): what the delivery path and the Telegram link need, and the default templates.
--   * auth_tokens.purpose gains `telegram_link` (the token of POST /client/telegram/link, MISMATCHES B165).
--   * notifications gains `attempts` (the attempt is on the row, decision 020) and `dedupe_key` (one row per occurrence: a job that runs
--     twice or an update Telegram repeats makes no second message), plus an index for the 30-day count of sent messages per template.
--   * clients.telegram_chat_id is unique: a chat belongs to one merchant (B165: linking a chat that another merchant has moves it).
--   * the default templates of the merchant events are inserted at the end (a missing template sends nothing).
ALTER TABLE "auth_tokens" DROP CONSTRAINT "auth_tokens_purpose_check";--> statement-breakpoint
ALTER TABLE "notifications" ADD COLUMN "attempts" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "notifications" ADD COLUMN "dedupe_key" text;--> statement-breakpoint
CREATE UNIQUE INDEX "clients_telegram_chat_uq" ON "clients" USING btree ("telegram_chat_id") WHERE "clients"."telegram_chat_id" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "notifications_dedupe_key_uq" ON "notifications" USING btree ("dedupe_key") WHERE "notifications"."dedupe_key" is not null;--> statement-breakpoint
CREATE INDEX "notifications_sent_idx" ON "notifications" USING btree ("event","channel","recipient_type","sent_at") WHERE "notifications"."status" = 'sent';--> statement-breakpoint
ALTER TABLE "auth_tokens" ADD CONSTRAINT "auth_tokens_purpose_check" CHECK ("auth_tokens"."purpose" in ('invite', 'reset', 'verify_email', 'magic_link', 'telegram_link'));
--> statement-breakpoint

-- ===== platform: the default templates of the merchant events (feature 12a) =====
-- Without them the merchant mails (verification, reset, invitation) would send nothing: a missing template sends nothing. Staff edit them
-- in the console afterwards; a row that exists (same event, channel, audience and language) is left as it is.
-- Generated from DEFAULT_TEMPLATES (src/modules/platform/notifications/default-templates.ts); a test keeps the two equal.
INSERT INTO "notification_templates" ("event", "channel", "audience", "locale", "subject", "body", "is_active") VALUES
  ('merchant.email_verification', 'email', 'merchant', 'en', 'Confirm your email address', 'Hi {{merchantName}},

Please confirm your email address to finish creating your GSM account:

{{link}}

The link works once and stops working at {{expiresAt}}. If you did not create an account, you can ignore this email.', true),
  ('merchant.password_reset', 'email', 'merchant', 'en', 'Reset your password', 'Hi {{merchantName}},

Use this link to choose a new password:

{{link}}

The link works once and stops working at {{expiresAt}}. If you did not ask for a new password, you can ignore this email: your password stays as it is.', true),
  ('merchant.invited', 'email', 'merchant', 'en', 'Your GSM merchant account is ready', 'Hi {{merchantName}},

Our team created a GSM merchant account for you. Choose your password here to sign in:

{{link}}

The link works once and stops working at {{expiresAt}}.', true),
  ('wallet.low_balance', 'email', 'merchant', 'en', 'Your wallet balance is low', 'Hi {{merchantName}},

Your available balance is {{available}} {{currency}}, below your alert level of {{threshold}} {{currency}}. Top up your wallet to keep your orders going.', true),
  ('wallet.low_balance', 'telegram', 'merchant', 'en', '', 'Low balance: {{available}} {{currency}} available (your alert level is {{threshold}} {{currency}}).', true),
  ('service.price_changed', 'email', 'merchant', 'en', 'Price changes on services you ordered', 'Hi {{merchantName}},

The price of {{count}} service(s) you ordered in the last 30 days changed:

{{changes}}

Your catalog and price list already show the new prices.', true),
  ('service.price_changed', 'telegram', 'merchant', 'en', '', 'Price changes on services you ordered ({{count}}):
{{changes}}', true),
  ('deposit.approved', 'email', 'merchant', 'en', 'Your deposit of {{amount}} {{currency}} was approved', 'Hi {{merchantName}},

Your deposit of {{amount}} {{currency}} was approved and your wallet is topped up.', true),
  ('deposit.approved', 'telegram', 'merchant', 'en', '', 'Deposit approved: {{amount}} {{currency}} was added to your wallet.', true),
  ('invoice.paid', 'email', 'merchant', 'en', 'Invoice {{invoiceNumber}} is paid', 'Hi {{merchantName}},

Invoice {{invoiceNumber}} ({{amount}} {{currency}}) was paid and the amount is in your wallet.', true),
  ('invoice.paid', 'telegram', 'merchant', 'en', '', 'Invoice {{invoiceNumber}} is paid: {{amount}} {{currency}} was added to your wallet.', true),
  ('order.completed', 'email', 'merchant', 'en', 'Order {{orderId}} is complete', 'Hi {{merchantName}},

Order {{orderId}} ({{service}}) is complete. {{resultComment}}

The result is in your panel.', true),
  ('order.completed', 'telegram', 'merchant', 'en', '', 'Order {{orderId}} is complete. The result is in your panel.', true),
  ('order.failed', 'email', 'merchant', 'en', 'Order {{orderId}} was rejected', 'Hi {{merchantName}},

Order {{orderId}} ({{service}}) was rejected. {{resultComment}}

The amount went back to your wallet.', true),
  ('order.failed', 'telegram', 'merchant', 'en', '', 'Order {{orderId}} was rejected. {{resultComment}}', true),
  ('telegram.linked', 'telegram', 'merchant', 'en', '', 'Linked to {{merchantName}}.', true),
  ('telegram.unlinked', 'telegram', 'merchant', 'en', '', 'Telegram notifications for {{merchantName}} are off. Create a new link in the portal to connect this chat again.', true)
ON CONFLICT ("event", "channel", "audience", "locale") DO NOTHING;
