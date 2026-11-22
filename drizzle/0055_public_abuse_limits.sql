-- Feature 43 (decision 053): limits of the public surfaces.
-- support_tickets.requester_proven_at: when the requester's address was proven. Every ticket that exists keeps showing where it shows
-- today, so it gets its created_at; the application inserts NULL only for a ticket of the public form opened with a typed email.
-- webhook_endpoints.consecutive_failed_deliveries: deliveries in a row that ended failed; 20 switch the endpoint off. 0 for every endpoint.
-- The default email of the merchant event webhook.endpoint_disabled (templatesInsertSql of DEFAULT_TEMPLATES; a spec keeps them equal).
-- The receipt of a new ticket repeats nothing a visitor typed: the shipped text is replaced where it was not edited
-- (supportReceiptTextSql; a spec keeps them equal).
ALTER TABLE "support_tickets" ADD COLUMN "requester_proven_at" timestamp (3) with time zone DEFAULT now();--> statement-breakpoint
ALTER TABLE "webhook_endpoints" ADD COLUMN "consecutive_failed_deliveries" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
UPDATE "support_tickets" SET "requester_proven_at" = "created_at";--> statement-breakpoint
INSERT INTO "notification_templates" ("event", "channel", "audience", "subject", "body", "is_active") VALUES
  ('webhook.endpoint_disabled', 'email', 'merchant', 'A webhook endpoint was switched off', 'Hi {{merchantName}},

Your webhook endpoint {{url}} did not accept the last {{count}} deliveries, so it was switched off and no more events are sent to it.

Check the endpoint, then turn it on again in the merchant portal; its count of failed deliveries starts again from zero.', true)
ON CONFLICT ("event", "channel", "audience") DO NOTHING;--> statement-breakpoint
UPDATE "notification_templates" SET "body" = 'Hello,

We received your message and opened ticket {{ticketNumber}}. Our team will answer by email.

You can follow the ticket and add details here: {{link}}

Please keep this email: the link is private to you.'
WHERE "event" = 'support.ticket_received' AND "channel" = 'email' AND "audience" = 'customer' AND "body" = 'Hi {{customerName}},

We received your message "{{subject}}" and opened ticket {{ticketNumber}}. Our team will answer by email.

You can follow the ticket and add details here: {{link}}

Please keep this email: the link is private to you.';
