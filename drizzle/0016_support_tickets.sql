-- Feature 17 (support): what the storefront ticket page and the ticket numbers need, and the default templates of the support events.
--   * support_tickets gains `token` (the capability token of the ticket page, decision 010) with a unique index over the non-null ones,
--     and `survey_sent_at` (when the one satisfaction survey of a ticket was queued; null until then).
--   * the ticket id sequence starts at 1001, so numbers read `T-1001` and up (the number is `T-<id>`); a database that has tickets keeps
--     counting after its largest id.
--   * the default templates of the support events are inserted at the end (a missing template sends nothing).
ALTER TABLE "support_tickets" ADD COLUMN "token" text;--> statement-breakpoint
ALTER TABLE "support_tickets" ADD COLUMN "survey_sent_at" timestamp (3) with time zone;--> statement-breakpoint
CREATE UNIQUE INDEX "support_tickets_token_uq" ON "support_tickets" USING btree ("token") WHERE "support_tickets"."token" is not null;
--> statement-breakpoint
SELECT setval(pg_get_serial_sequence('support_tickets', 'id'), GREATEST(1000, COALESCE((SELECT max("id") FROM "support_tickets"), 0)));
--> statement-breakpoint

-- ===== support: the default templates of the support events (feature 17) =====
-- Staff edit them in the console afterwards; a row that exists (same event, channel, audience and language) is left as it is.
-- Generated from SUPPORT_DEFAULT_TEMPLATES (src/modules/support/application/support-templates.ts); a test keeps the two equal.
INSERT INTO "notification_templates" ("event", "channel", "audience", "locale", "subject", "body", "is_active") VALUES
  ('support.reply', 'email', 'customer', 'en', 'Re: {{subject}} ({{ticketNumber}})', 'Hi {{customerName}},

{{message}}

Ticket {{ticketNumber}}: {{subject}}
Read the whole conversation or reply here: {{link}}', true),
  ('support.ticket_received', 'email', 'customer', 'en', 'We got your message ({{ticketNumber}})', 'Hi {{customerName}},

We received your message "{{subject}}" and opened ticket {{ticketNumber}}. Our team will answer by email.

You can follow the ticket and add details here: {{link}}

Please keep this email: the link is private to you.', true),
  ('support.csat_survey', 'email', 'customer', 'en', 'How did we do? ({{ticketNumber}})', 'Hi {{customerName}},

We marked your ticket {{ticketNumber}} "{{subject}}" as resolved. Please tell us how we did, it takes five seconds:

{{link}}

If your problem is not solved, write on the same page and we will reopen the ticket.', true),
  ('support.reply', 'email', 'merchant', 'en', 'Re: {{subject}} ({{ticketNumber}})', 'Hi {{merchantName}},

{{message}}

Ticket {{ticketNumber}}: {{subject}}', true),
  ('support.reply', 'telegram', 'merchant', 'en', '', 'Support replied on {{ticketNumber}} ({{subject}}):
{{message}}', true)
ON CONFLICT ("event", "channel", "audience", "locale") DO NOTHING;
